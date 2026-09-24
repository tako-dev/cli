import { randomUUID } from "node:crypto";
import type { ApprovalMode, Backend, Driver, SendHooks, SessionMeta, SessionStatus } from "./types";
import { claudeDriver, attachEnv as attachClaudeEnv } from "./drivers/claude";
import { codexDriver, attachEnv as attachCodexEnv } from "./drivers/codex";
import { initSession, listSessions, readMeta, removeSession, writeMeta, tailLog } from "./storage";
import { loadConfig } from "../config";
import { getProviders, getProvidersForClient, resolveProviderContext } from "../providers";
import { getClient, getClientLaunchOptions } from "../clients/base";
import { claudeCodeSessionPinEnv } from "../clients/claude-code";
import type { ProviderContext, Provider } from "../providers/types";

const DRIVERS: Record<Backend, Driver> = { claude: claudeDriver, codex: codexDriver };
const CLIENT_ID: Record<Backend, string> = { claude: "claude-code", codex: "codex" };

export interface StartArgs {
  backend: Backend;
  name?: string;
  model?: string;
  workdir?: string;
  providerId?: string;
  approvalMode?: ApprovalMode;
}

export async function startSession(args: StartArgs): Promise<SessionMeta> {
  const driver = DRIVERS[args.backend];
  const clientId = CLIENT_ID[args.backend];
  const client = getClient(clientId);
  if (!client) throw new Error(`client ${clientId} 未注册`);

  const provider = await resolveProvider(args.backend, args.providerId, args.model);
  if (!provider) throw new Error(`没找到 ${args.backend} 可用的 provider${args.model ? `（含模型 ${args.model}）` : ""}`);
  const providerCtx: ProviderContext = resolveProviderContext(provider);
  if (args.model) (providerCtx as any).model = args.model;
  // claude-code 的 subagent/别名钉不走 getEnvVars（启动选项要能撤钉），
  // 该 spawn 路径绕过 setupConfigFiles，这里按 provider 三态单独补钉。
  const env = {
    ...client.getEnvVars(providerCtx),
    ...(clientId === "claude-code" ? claudeCodeSessionPinEnv(providerCtx) : {}),
  };

  const sid = randomUUID();
  const placeholder: SessionMeta = {
    sid, backend: args.backend,
    name: args.name ?? `${args.backend}-${sid.slice(0, 8)}`,
    model: args.model, workdir: args.workdir ?? process.cwd(),
    status: "idle", approvalMode: args.approvalMode ?? "yolo",
    turnCount: 0, createdAt: Date.now(), lastActiveAt: Date.now(),
    providerId: provider.id,
  };
  await initSession(placeholder);

  const meta = await driver.start({
    sid, name: placeholder.name, model: args.model,
    workdir: placeholder.workdir, approvalMode: args.approvalMode ?? "yolo",
    env: env as Record<string, string>, providerId: provider.id,
    providerHint: { type: provider.type, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
  });
  await writeMeta(meta);
  return meta;
}

export async function sendToSession(sid: string, prompt: string, hooks?: SendHooks): Promise<SessionMeta> {
  const meta = await readMeta(sid);
  if (!meta) throw new Error(`session ${sid} 不存在`);
  if (meta.status === "closed") throw new Error(`session ${sid} 已关闭`);
  const driver = DRIVERS[meta.backend];
  const env = await rebuildEnv(meta);
  if (meta.backend === "claude") attachClaudeEnv(meta, env);
  else if (meta.backend === "codex") attachCodexEnv(meta, env);
  return driver.send(meta, prompt, hooks);
}

export async function cancelSession(sid: string): Promise<void> {
  const meta = await readMeta(sid);
  if (!meta) return;
  if (meta.backend === "codex") attachCodexEnv(meta, await rebuildEnv(meta));
  await DRIVERS[meta.backend].cancel(meta);
}

export async function closeSession(sid: string, purge = false): Promise<void> {
  const meta = await readMeta(sid);
  if (!meta) return;
  if (meta.backend === "codex") attachCodexEnv(meta, await rebuildEnv(meta));
  await DRIVERS[meta.backend].close(meta);
  if (purge) await removeSession(sid);
}

export async function listAllSessions(): Promise<SessionMeta[]> { return listSessions(); }

export interface SessionFilter {
  /** 状态过滤；缺省时默认隐藏 closed（除非 includeClosed/all） */
  status?: SessionStatus[];
  /** 显式包含 closed（配合 status 缺省时） */
  includeClosed?: boolean;
  namePrefix?: string;
  backend?: Backend;
  model?: string;
  /** turnCount 精确匹配（用于挑 0-turn idle） */
  turns?: number;
}

/**
 * 纯函数：按 filter 过滤 session 列表。抽出便于单测，不碰落盘/进程。
 *
 * 默认行为：status 未指定时隐藏 closed（除非 includeClosed=true），
 * 缓解“list 噪声大”的痛点。指定 status 时按 status 精确过滤。
 */
export function filterSessions(metas: SessionMeta[], filter: SessionFilter = {}): SessionMeta[] {
  return metas.filter((m) => {
    if (filter.status && filter.status.length > 0) {
      if (!filter.status.includes(m.status)) return false;
    } else if (!filter.includeClosed && m.status === "closed") {
      return false;
    }
    if (filter.namePrefix && !m.name.startsWith(filter.namePrefix)) return false;
    if (filter.backend && m.backend !== filter.backend) return false;
    if (filter.model && m.model !== filter.model) return false;
    if (filter.turns !== undefined && m.turnCount !== filter.turns) return false;
    return true;
  });
}

export async function listSessionsFiltered(filter: SessionFilter = {}): Promise<SessionMeta[]> {
  return filterSessions(await listSessions(), filter);
}

export async function showSession(sid: string, logLines = 50) {
  const meta = await readMeta(sid);
  if (!meta) return null;
  const log = await tailLog(sid, logLines);
  const alive = await DRIVERS[meta.backend].isAlive(meta);
  return { meta, log, alive };
}

export async function purgeDead(): Promise<number> {
  const all = await listSessions();
  let n = 0;
  for (const m of all) {
    if (m.status === "closed") { await removeSession(m.sid); n++; continue; }
    if (m.backend === "codex") {
      const alive = await DRIVERS.codex.isAlive(m);
      if (!alive) { m.status = "dead"; await writeMeta(m); }
    }
  }
  return n;
}

async function resolveProvider(backend: Backend, explicitId: string | undefined, model: string | undefined): Promise<Provider | undefined> {
  const config = await loadConfig();
  const all = await getProviders();
  const clientId = CLIENT_ID[backend];

  if (explicitId) { const p = all.find((x) => x.id === explicitId); if (p) return p; }

  const defaults = (config as any).agentDefaults as Record<string, string> | undefined;
  const cfgId = defaults?.[backend];
  if (cfgId) { const p = all.find((x) => x.id === cfgId); if (p) return p; }

  const compatible = await getProvidersForClient(clientId);
  if (model) {
    const client = getClient(clientId);
    if (client) {
      for (const p of compatible) {
        const opts = getClientLaunchOptions(client, p);
        if (opts.some((o) => o.id === `model-${model}`)) return p;
      }
    }
  }

  const boundId = config.clientProviderMap?.[clientId];
  if (boundId) { const p = all.find((x) => x.id === boundId); if (p) return p; }

  return compatible[0];
}

async function rebuildEnv(meta: SessionMeta): Promise<Record<string, string>> {
  const clientId = CLIENT_ID[meta.backend];
  const client = getClient(clientId);
  if (!client) return {};
  const all = await getProviders();
  let provider = meta.providerId ? all.find((p) => p.id === meta.providerId) : undefined;
  if (!provider) provider = await resolveProvider(meta.backend, undefined, meta.model);
  if (!provider) return {};
  const ctx = resolveProviderContext(provider);
  if (meta.model) (ctx as any).model = meta.model;
  (meta as any).__providerHint = { type: provider.type, apiKey: provider.apiKey, baseUrl: provider.baseUrl };
  // 同 startSession：claude-code 的钉在此路径单独补（见该处注释）。
  return {
    ...client.getEnvVars(ctx),
    ...(clientId === "claude-code" ? claudeCodeSessionPinEnv(ctx) : {}),
  } as Record<string, string>;
}

export async function setAgentDefault(backend: Backend, providerId: string): Promise<void> {
  const { saveConfig } = await import("../config");
  const config = await loadConfig();
  const cur = ((config as any).agentDefaults as Record<string, string>) ?? {};
  cur[backend] = providerId;
  (config as any).agentDefaults = cur;
  await saveConfig(config);
}

export async function getAgentDefaults(): Promise<Record<string, string>> {
  const config = await loadConfig();
  return ((config as any).agentDefaults as Record<string, string>) ?? {};
}
