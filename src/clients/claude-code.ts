import { homedir } from "os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "path";
import { ClientConfig, LaunchOption, registerClient } from "./base";
import type { ProviderContext, Provider } from "../providers/types";
import { DEEPSEEK_ANTHROPIC_URL, resolveXiaomiBaseUrl } from "../providers/types";
import { log } from "../logger";
import { t } from "../i18n";
import { loadCatalog, getTakoModels, filterChatModels } from "../models";
import { BUNDLED_ENTRIES } from "../models/bundled";
import { TAKO_DIR } from "../config";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const TAKO_CLAUDE_SETTINGS_DIR = join(TAKO_DIR, "claude-code", "launch-settings");

const CLAUDE_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

const CLAUDE_MODEL_ENV_KEY = "ANTHROPIC_MODEL";
export const CLAUDE_CONTEXT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const TAKO_CONTEXT_WINDOW_ENV_KEY = "TAKO_MODEL_CONTEXT_WINDOW";
const CLAUDE_OPTION_ENV_KEYS = [
  CLAUDE_MODEL_ENV_KEY,
  CLAUDE_CONTEXT_WINDOW_ENV_KEY,
  TAKO_CONTEXT_WINDOW_ENV_KEY,
] as const;

export function buildTakoClaudeSettingsOverlay(
  launchEnvVars: Record<string, string>,
): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_PROVIDER_ENV_KEYS) {
    // Empty strings neutralize credentials/routing left by another provider.
    env[key] = launchEnvVars[key] ?? "";
  }
  for (const key of CLAUDE_OPTION_ENV_KEYS) {
    if (launchEnvVars[key] !== undefined) {
      env[key] = launchEnvVars[key];
    }
  }
  return { env };
}

export function findClaudeSettingsConflicts(
  settings: Record<string, any>,
  overlay: Record<string, unknown>,
): string[] {
  const env = settings.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];

  const overlayEnv = overlay.env;
  if (!overlayEnv || typeof overlayEnv !== "object" || Array.isArray(overlayEnv)) return [];

  return Object.entries(overlayEnv)
    .filter(([key, value]) => Object.hasOwn(env, key) && String(env[key]) !== value)
    .map(([key]) => key);
}

export interface ClaudeSettingsLaunchSetup {
  args: string[];
  conflictingFields: string[];
  settingsPath: string;
  cleanupFiles: string[];
}

export async function prepareTakoClaudeSettingsForLaunch(opts: {
  launchEnvVars: Record<string, string>;
  sourcePath?: string;
  targetPath?: string;
  logConflicts?: boolean;
}): Promise<ClaudeSettingsLaunchSetup> {
  const fs = await import("fs/promises");
  const sourcePath = opts.sourcePath ?? CLAUDE_SETTINGS_PATH;
  const targetPath = opts.targetPath ?? join(
    TAKO_CLAUDE_SETTINGS_DIR,
    `${process.pid}-${Date.now()}-${randomUUID()}.json`,
  );
  const overlay = buildTakoClaudeSettingsOverlay(opts.launchEnvVars);
  let conflictingFields: string[] = [];

  try {
    const content = await fs.readFile(sourcePath, "utf-8");
    const settings: Record<string, any> = JSON.parse(content);
    conflictingFields = findClaudeSettingsConflicts(settings, overlay);
  } catch {
    // User settings are diagnostic only. Project/local settings may still conflict,
    // so the launch overlay is always created.
  }

  if (opts.logConflicts !== false && conflictingFields.length > 0) {
    log.warn(t("claudeCode.settingsDetected", { fields: conflictingFields.join(", ") }));
    log.info(t("claudeCode.usingIsolatedSettings", { path: targetPath }));
  }

  await fs.mkdir(dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(overlay, null, 2) + "\n", {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });

  return {
    args: ["--settings", targetPath],
    conflictingFields,
    settingsPath: targetPath,
    cleanupFiles: [targetPath],
  };
}

/**
 * 切换到 claude-subscription provider 时同步 keychain / .credentials.json
 *
 * 1. 把当前 keychain 里的 token 回存到匹配 provider，避免 token 刷新结果丢失
 * 2. 把目标 provider 的 authData 写回 Claude Code 的存储位置
 * 3. 目标 provider 没有 authData（旧记录）— 警告并跳过覆盖
 */
async function syncClaudeSubscription(provider: ProviderContext): Promise<void> {
  const { readClaudeAuth, writeClaudeAuth } = await import("./claude-credentials");
  const { getProviders, updateProvider } = await import("../providers");

  const targetCreds = provider.authData?.credentials as Record<string, any> | undefined;
  const targetIdentity = provider.authData?.oauthAccount as Record<string, any> | undefined;

  if (!targetCreds) {
    log.warn(t("claudeCode.subscriptionMissingAuth"));
    return;
  }

  const current = await readClaudeAuth();
  const currentEmail = current.oauthAccount?.emailAddress;
  if (currentEmail && current.credentials) {
    const all = await getProviders();
    const match = all.find(
      (p) => p.type === "claude-subscription" && p.email === currentEmail,
    );
    if (match) {
      const newAuthData = { credentials: current.credentials, oauthAccount: current.oauthAccount };
      if (JSON.stringify(match.authData) !== JSON.stringify(newAuthData)) {
        await updateProvider(match.id, { authData: newAuthData });
      }
    } else if (currentEmail !== targetIdentity?.emailAddress) {
      log.warn(t("claudeCode.unknownCurrentAccount", { email: currentEmail }));
    }
  }

  await writeClaudeAuth({ credentials: targetCreds, oauthAccount: targetIdentity });
  const targetEmail = targetIdentity?.emailAddress || "?";
  log.info(t("claudeCode.subscriptionSwitched", { email: targetEmail }));
}

export const claudeCodeClient: ClientConfig = {
  id: "claude-code",
  name: "Claude Code",
  package: "@anthropic-ai/claude-code",
  command: "claude",
  runtime: "native",
  continueArg: "--continue",
  brandColor: "yellow",

  getEnvVars(provider: ProviderContext) {
    const common = {
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: "1",
      DISABLE_AUTOUPDATER: "1",
    };

    // 1M 后缀：claude/deepseek/kimi 系列且 catalog >= 1M 的自动补 [1m]
    const tagged = provider.model ? appendOneMTagIfNeeded(provider.model) : undefined;

    switch (provider.type) {
      case "claude-subscription":
        // 不设 ANTHROPIC_*，让 Claude Code 用自己的 OAuth
        return common;

      case "tako":
        return {
          ...common,
          ANTHROPIC_BASE_URL: `${provider.baseUrl}/api`,
          ANTHROPIC_AUTH_TOKEN: provider.apiKey!,
          ...(tagged ? { ANTHROPIC_MODEL: tagged } : {}),
        };

      case "anthropic":
        return {
          ...common,
          ANTHROPIC_API_KEY: provider.apiKey!,
          ...(tagged ? { ANTHROPIC_MODEL: tagged } : {}),
        };

      case "deepseek":
        return {
          ...common,
          ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_URL,
          ANTHROPIC_AUTH_TOKEN: provider.apiKey!,
          ...(tagged ? { ANTHROPIC_MODEL: tagged } : {}),
        };

      case "xiaomi":
        // Base URL 按 key 前缀选（sk- 按量付费 / tp- Token Plan），忽略存储的 baseUrl
        return {
          ...common,
          ANTHROPIC_BASE_URL: resolveXiaomiBaseUrl(provider.apiKey),
          ANTHROPIC_AUTH_TOKEN: provider.apiKey!,
          ...(tagged ? { ANTHROPIC_MODEL: tagged } : {}),
        };

      case "custom":
        return {
          ...common,
          ANTHROPIC_BASE_URL: provider.baseUrl!,
          ANTHROPIC_AUTH_TOKEN: provider.apiKey!,
          ...(tagged ? { ANTHROPIC_MODEL: tagged } : {}),
        };

      default:
        return common;
    }
  },

  async setupConfigFiles(provider: ProviderContext, _selectedOptionIds?: string[], context?: { forLaunch?: boolean; launchEnvVars?: Record<string, string> }) {
    // 多账号切换：把目标账号的 OAuth tokens 还原到 Claude Code 的存储位置
    if (provider.type === "claude-subscription") {
      await syncClaudeSubscription(provider);
    }

    if (!context?.forLaunch) return undefined;

    // Keep all normal Claude configuration sources enabled. The CLI overlay has
    // higher precedence but contains only provider-owned env keys.
    const launchSettings = await prepareTakoClaudeSettingsForLaunch({
      launchEnvVars: context.launchEnvVars ?? claudeCodeClient.getEnvVars(provider),
    });
    return {
      args: launchSettings.args,
      cleanupFiles: launchSettings.cleanupFiles,
    };
  },

  launchOptions: (provider?: Provider) => buildClaudeCodeLaunchOptions(provider),
};

// ─── launchOptions 构造逻辑 ──────────────────────────────────────────

const BASE_FLAGS: LaunchOption[] = [
  {
    id: "skip-permissions",
    label: { en: "Skip Permissions", zh: "跳过权限确认" },
    shortLabel: "Skip Perms",
    description: {
      en: "Auto-execute all operations without confirmation",
      zh: "允许自动执行所有操作，无需确认",
    },
    flag: "--dangerously-skip-permissions",
    args: ["--dangerously-skip-permissions"],
  },
  {
    id: "worktree",
    label: { en: "Git Worktree", zh: "Git Worktree" },
    shortLabel: "Worktree",
    description: { en: "Run in an isolated worktree", zh: "在隔离的 worktree 中运行" },
    flag: "--worktree",
    args: ["--worktree"],
  },
];

/**
 * Claude Code 暴露的模型 —— 跟着 provider 走：
 *  - tako / anthropic / claude-subscription / custom：Claude 系列
 *  - deepseek：DeepSeek V4 系列（DeepSeek 通过 Anthropic-compat 网关）
 *  - xiaomi：MiMo 系列（小米 platform.xiaomimimo.com Anthropic-compat 网关）
 */
const CLAUDE_MODEL_WHITELIST = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
];

const DEEPSEEK_MODEL_WHITELIST = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

const XIAOMI_MODEL_WHITELIST = [
  "mimo-v2.5-pro",
];

function prettifyModelId(id: string): string {
  const m = id.match(/^claude-(haiku|sonnet|opus)-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  // 非 Claude id：用 catalog 的 displayName，否则原样返回
  const entry = BUNDLED_ENTRIES.find((e) => e.id === id);
  return entry?.displayName ?? id;
}

/**
 * Claude Code 通过 `[1m]` 后缀触发 1M context beta：
 *   --model claude-opus-4-7[1m]   → 走 1M 协议
 *   --model claude-opus-4-7        → Claude Code 仍按默认 ~200k 处理，会自动压缩
 *
 * 这里在 launcher 侧自动补上后缀，避免用户每次都得手动加。
 *
 * 规则：bundled catalog 标 `contextWindow >= 1_000_000` 的 claude-*、deepseek-*、
 * kimi-* 系列自动补 `[1m]`。
 */
export function appendOneMTagIfNeeded(modelId: string, contextWindow?: number): string {
  if (!modelId) return modelId;
  if (modelId.endsWith("[1m]") || /:1m$/i.test(modelId)) return modelId;
  // Claude Code must recognize a 1M tier before its auto-compact window can be
  // raised above the normal ~200k ceiling. A server-advertised window above
  // 200k therefore opts eligible Anthropic-compatible model families into that
  // tier; CLAUDE_CODE_AUTO_COMPACT_WINDOW supplies the exact lower limit.
  if (!/^(?:full-)?(claude|deepseek|kimi|mimo)[-_]/i.test(modelId)) return modelId;
  if (contextWindow !== undefined) {
    return contextWindow > 200000 ? `${modelId}[1m]` : modelId;
  }
  const entry = BUNDLED_ENTRIES.find((e) => e.id === modelId);
  if (!entry || entry.contextWindow < 1_000_000) return modelId;
  return `${modelId}[1m]`;
}

function ctxStrOf(ctx: number): string {
  if (ctx >= 1_000_000) return "1M";
  if (ctx > 0) return `${Math.round(ctx / 1000)}k`;
  return "?";
}

/**
 * 优先用 par 服务器返回的 claude 系模型目录（tako/custom provider）。
 * 没缓存（首次启动 / 网络失败）时回退到内置 whitelist。
 */
function buildDynamicClaudeModels(provider: Provider): LaunchOption[] | null {
  if (!provider.baseUrl) return null;
  const raw = getTakoModels(provider.baseUrl, "claude");
  if (!raw || raw.length === 0) return null;
  const chat = filterChatModels(raw);
  if (chat.length === 0) return null;
  return chat.map((e) => {
    const modelArg = appendOneMTagIfNeeded(e.id, e.contextWindow);
    const contextEnv = e.contextWindow > 0
      ? {
          [CLAUDE_CONTEXT_WINDOW_ENV_KEY]: String(e.contextWindow),
          [TAKO_CONTEXT_WINDOW_ENV_KEY]: String(e.contextWindow),
        }
      : {};
    return {
      id: `model-${e.id}`,
      label: { en: e.displayName, zh: e.displayName },
      shortLabel: e.displayName,
      description: {
        en: `Use ${e.displayName} (${ctxStrOf(e.contextWindow)} ctx)`,
        zh: `使用 ${e.displayName}（上下文 ${ctxStrOf(e.contextWindow)}）`,
      },
      flag: `--model ${modelArg}`,
      args: [],
      envVars: {
        ANTHROPIC_MODEL: modelArg,
        ...contextEnv,
      },
      group: "model",
    };
  });
}

function buildModelOptions(provider?: Provider): LaunchOption[] {
  loadCatalog();

  if (provider && (provider.type === "tako" || provider.type === "custom")) {
    const dynamic = buildDynamicClaudeModels(provider);
    if (dynamic) return dynamic;
  }

  const ids =
    provider?.type === "deepseek" ? DEEPSEEK_MODEL_WHITELIST
    : provider?.type === "xiaomi" ? XIAOMI_MODEL_WHITELIST
    : CLAUDE_MODEL_WHITELIST;
  const out: LaunchOption[] = [];
  for (const id of ids) {
    const entry = BUNDLED_ENTRIES.find((e) => e.id === id);
    const ctx = entry?.contextWindow ?? 0;
    const ctxStr = ctx >= 1_000_000 ? "1M" : ctx > 0 ? `${Math.round(ctx / 1000)}k` : "?";
    const pretty = prettifyModelId(id);
    // 1M 模型必须传 [1m] 后缀给 Claude Code，否则被按 200k 处理会自动压缩上下文。
    // option id 保留无后缀形式（model-claude-opus-4-7），让 selectedOptionIds
    // 持久化稳定不受规则变化影响。
    const modelArg = appendOneMTagIfNeeded(id);
    out.push({
      id: `model-${id}`,
      label: { en: pretty, zh: pretty },
      shortLabel: pretty,
      description: {
        en: `Use ${pretty} (${ctxStr} ctx)`,
        zh: `使用 ${pretty}（上下文 ${ctxStr}）`,
      },
      flag: `--model ${modelArg}`,
      args: [],
      envVars: { ANTHROPIC_MODEL: modelArg },
      group: "model",
    });
  }
  return out;
}

function buildClaudeCodeLaunchOptions(provider?: Provider): LaunchOption[] {
  return [...BASE_FLAGS, ...buildModelOptions(provider)];
}

registerClient(claudeCodeClient);
