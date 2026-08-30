/**
 * Provider 管理模块
 *
 * CRUD 操作、自动检测、旧配置迁移
 */

import { loadConfig, saveConfig, PROXY_BASE_URL } from "../config";
import type { Provider, ProviderContext, ProviderType } from "./types";
import { getDefaultSupportedClients, isProviderCompatible } from "./types";

export * from "./types";

export function insertSupportedClient(clients: string[], clientId: string, before?: string): string[] {
  if (clients.includes(clientId)) return clients;
  const index = before ? clients.indexOf(before) : -1;
  if (index >= 0) return [...clients.slice(0, index), clientId, ...clients.slice(index)];
  return [...clients, clientId];
}

// --- CRUD ---

export async function getProviders(): Promise<Provider[]> {
  const config = await loadConfig();
  return config.providers ?? [];
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const providers = await getProviders();
  return providers.find((p) => p.id === id);
}

export async function getDefaultProvider(): Promise<Provider | undefined> {
  const config = await loadConfig();
  const providers = config.providers ?? [];
  if (providers.length === 0) return undefined;
  if (config.defaultProviderId) {
    const found = providers.find((p) => p.id === config.defaultProviderId);
    if (found) return found;
  }
  return providers[0];
}

export async function getProvidersForClient(clientId: string): Promise<Provider[]> {
  const providers = await getProviders();
  const compatible = providers.filter((p) => isProviderCompatible(p, clientId));
  // 按最近使用时间降序排（未用过的 provider 按 createdAt 降序排在后面）
  return compatible.sort((a, b) => {
    const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    if (at !== bt) return bt - at;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function addProvider(
  data: Omit<Provider, "id" | "createdAt">
): Promise<Provider> {
  const config = await loadConfig();
  const provider: Provider = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  config.providers = [...(config.providers ?? []), provider];
  if (!config.defaultProviderId) {
    config.defaultProviderId = provider.id;
  }
  await saveConfig(config);
  return provider;
}

export async function updateProvider(
  id: string,
  updates: Partial<Omit<Provider, "id" | "createdAt">>
): Promise<void> {
  const config = await loadConfig();
  const providers = config.providers ?? [];
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) return;
  providers[idx] = { ...providers[idx], ...updates };
  config.providers = providers;
  await saveConfig(config);
}

export async function deleteProvider(id: string): Promise<void> {
  const config = await loadConfig();
  const target = (config.providers ?? []).find((p) => p.id === id);
  if (target?.builtin) return; // 内置服务商不可删除
  config.providers = (config.providers ?? []).filter((p) => p.id !== id);
  if (config.defaultProviderId === id) {
    config.defaultProviderId = config.providers[0]?.id;
  }
  // 清理 clientProviderMap 中引用此 provider 的绑定
  if (config.clientProviderMap) {
    for (const [k, v] of Object.entries(config.clientProviderMap)) {
      if (v === id) delete config.clientProviderMap[k];
    }
  }
  await saveConfig(config);
}

export async function setDefaultProvider(id: string): Promise<void> {
  const config = await loadConfig();
  const exists = (config.providers ?? []).some((p) => p.id === id);
  if (!exists) return;
  config.defaultProviderId = id;
  await saveConfig(config);
}

// --- 客户端绑定 ---

/** 获取某个客户端绑定的 Provider */
export async function getClientProvider(clientId: string): Promise<Provider | undefined> {
  const config = await loadConfig();
  const providerId = config.clientProviderMap?.[clientId];
  if (providerId) {
    const found = (config.providers ?? []).find((p) => p.id === providerId);
    if (found && isProviderCompatible(found, clientId)) return found;
  }
  // 没绑定或绑定失效 → 走默认
  return undefined;
}

/** 绑定客户端到 Provider */
export async function setClientProvider(clientId: string, providerId: string): Promise<void> {
  const config = await loadConfig();
  config.clientProviderMap = { ...config.clientProviderMap, [clientId]: providerId };
  // 同时更新 provider.lastUsedAt，用于 UI 按最近使用排序
  const providers = config.providers ?? [];
  const idx = providers.findIndex((p) => p.id === providerId);
  if (idx !== -1) {
    providers[idx] = { ...providers[idx], lastUsedAt: new Date().toISOString() };
    config.providers = providers;
  }
  await saveConfig(config);
}

// --- ProviderContext 解析 ---

export function resolveProviderContext(provider: Provider): ProviderContext {
  return {
    type: provider.type,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    authData: provider.authData,
    model: provider.model,
    modelContextWindow: provider.modelContextWindow,
  };
}

// --- 自动检测 ---

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  email?: string;
  subscriptionType?: string;
}

async function detectClaudeSubscription(): Promise<Provider | null> {
  try {
    const proc = Bun.spawn(["claude", "auth", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;

    const status: ClaudeAuthStatus = JSON.parse(text.trim());
    if (!status.loggedIn || status.authMethod !== "claude.ai") return null;

    const subType = status.subscriptionType || "pro";
    const email = status.email || "";
    const name = `Claude ${subType.charAt(0).toUpperCase() + subType.slice(1)}${email ? ` (${email})` : ""}`;

    // 抓取当前 OAuth 凭据 + 身份，多账号切换时恢复到 keychain / .credentials.json
    const { readClaudeAuth } = await import("../clients/claude-credentials");
    const snapshot = await readClaudeAuth();
    const authData = snapshot.credentials || snapshot.oauthAccount
      ? { credentials: snapshot.credentials, oauthAccount: snapshot.oauthAccount }
      : undefined;

    return {
      id: crypto.randomUUID(),
      name,
      type: "claude-subscription",
      supportedClients: getDefaultSupportedClients("claude-subscription"),
      createdAt: new Date().toISOString(),
      email,
      subscriptionType: subType,
      authData,
    };
  } catch {
    return null;
  }
}

/**
 * 读取 Codex auth.json 并提取订阅信息
 */
async function readCodexAuth(): Promise<{ auth: Record<string, any>; email: string } | null> {
  try {
    const { homedir } = await import("os");
    const { join } = await import("path");
    const fs = await import("fs/promises");
    const authPath = join(homedir(), ".codex", "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf-8"));
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) return null;
    let email = "";
    try {
      const payload = JSON.parse(atob(auth.tokens.id_token.split(".")[1]));
      email = payload.email || "";
    } catch { /* ignore */ }
    return { auth, email };
  } catch {
    return null;
  }
}

async function detectCodexSubscription(): Promise<Provider | null> {
  const result = await readCodexAuth();
  if (result) {
    const { auth, email } = result;
    return {
      id: crypto.randomUUID(),
      name: email ? `Codex Plus (${email})` : "Codex Subscription",
      type: "codex-subscription",
      email: email || undefined,
      supportedClients: getDefaultSupportedClients("codex-subscription"),
      authData: auth, // 保存完整 OAuth tokens，多账号切换时恢复
      createdAt: new Date().toISOString(),
    };
  }
  // fallback: CLI 命令（无法获取 tokens，仅标记存在）
  try {
    const proc = Bun.spawn(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0 || !text.includes("Logged in") || text.includes("cr_")) return null;
    return {
      id: crypto.randomUUID(),
      name: "Codex Subscription",
      type: "codex-subscription",
      supportedClients: getDefaultSupportedClients("codex-subscription"),
      createdAt: new Date().toISOString(),
    };
  } catch { return null; }
}

/**
 * 检测所有可用的认证方式，返回新发现的 Provider 列表
 */
export async function detectProviders(): Promise<Provider[]> {
  const detected: Provider[] = [];

  const [claude, codex] = await Promise.all([
    detectClaudeSubscription(),
    detectCodexSubscription(),
  ]);

  if (claude) detected.push(claude);
  if (codex) detected.push(codex);

  return detected;
}

/**
 * 将新检测到的 Provider 合并到配置中
 * 用 type+email 去重（支持同类型多账号）
 */
export async function mergeDetectedProviders(detected: Provider[]): Promise<number> {
  const config = await loadConfig();
  const existing = config.providers ?? [];

  // 构建 "type:email" 的去重 key
  const existingKeys = new Set(existing.map((p) => `${p.type}:${p.email || ""}`));

  let added = 0;
  for (const p of detected) {
    const key = `${p.type}:${p.email || ""}`;
    if (!existingKeys.has(key)) {
      existing.push(p);
      existingKeys.add(key);
      added++;
    } else if (p.authData) {
      // 已有同账号 — 更新 authData（tokens 可能刷新了）
      const match = existing.find((e) => e.type === p.type && e.email === p.email);
      if (match) match.authData = p.authData;
    }
  }

  if (added > 0) {
    config.providers = existing;
    if (!config.defaultProviderId && existing.length > 0) {
      config.defaultProviderId = existing[0].id;
    }
    await saveConfig(config);
  }

  return added;
}

// --- 旧配置迁移 ---

/**
 * 如果存在旧 apiKey 且无 providers，自动迁移
 * 在 loadConfig 后调用
 */
export async function migrateIfNeeded(): Promise<boolean> {
  const config = await loadConfig();

  if (!config.apiKey || (config.providers && config.providers.length > 0)) {
    return false;
  }

  const takoProvider: Provider = {
    id: crypto.randomUUID(),
    name: "Tako 官方",
    type: "tako",
    apiKey: config.apiKey,
    baseUrl: PROXY_BASE_URL,
    apiId: config.apiId,
    supportedClients: getDefaultSupportedClients("tako"),
    createdAt: new Date().toISOString(),
    builtin: true,
  };

  config.providers = [takoProvider];
  config.defaultProviderId = takoProvider.id;
  await saveConfig(config);

  return true;
}

/**
 * 启动时修复 Provider 配置
 * - Tako provider 缺失 builtin 标记 → 补上
 * - 有 apiKey 但无 Tako provider（被用户误删）→ 自动重建
 */
export async function fixupProviders(): Promise<void> {
  const config = await loadConfig();
  const providers = config.providers ?? [];
  let changed = false;

  for (const p of providers) {
    if (p.type === "tako" && !p.builtin) {
      p.builtin = true;
      changed = true;
    }
    if (
      (p.type === "tako" || p.type === "custom")
      && Array.isArray(p.supportedClients)
      && p.supportedClients.length > 0
      && !p.supportedClients.includes("grok")
    ) {
      p.supportedClients = insertSupportedClient(p.supportedClients, "grok", "gemini");
      changed = true;
    }
  }

  // 有 apiKey 但 Tako provider 不存在 → 自动重建
  if (config.apiKey && !providers.some((p) => p.type === "tako")) {
    providers.push({
      id: crypto.randomUUID(),
      name: "Tako 官方",
      type: "tako",
      apiKey: config.apiKey,
      baseUrl: PROXY_BASE_URL,
      apiId: config.apiId,
      supportedClients: getDefaultSupportedClients("tako"),
      createdAt: new Date().toISOString(),
      builtin: true,
    });
    if (!config.defaultProviderId) {
      config.defaultProviderId = providers[providers.length - 1].id;
    }
    changed = true;
  }

  if (changed) {
    config.providers = providers;
    await saveConfig(config);
  }
}
