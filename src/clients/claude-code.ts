import { homedir } from "os";
import { dirname, join } from "path";
import { ClientConfig, LaunchOption, registerClient } from "./base";
import type { ProviderContext, Provider } from "../providers/types";
import { DEEPSEEK_ANTHROPIC_URL, resolveXiaomiBaseUrl } from "../providers/types";
import { log } from "../logger";
import { t } from "../i18n";
import { loadCatalog, getTakoModels } from "../models";
import { BUNDLED_ENTRIES } from "../models/bundled";
import { TAKO_DIR } from "../config";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const TAKO_CLAUDE_SETTINGS_PATH = join(TAKO_DIR, "claude-code", "settings.json");

const CONFLICTING_ENV_EXACT = [
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "API_TIMEOUT_MS",
];

function isConflictingEnvKey(key: string): boolean {
  if (key.startsWith("ANTHROPIC_")) return true;
  return CONFLICTING_ENV_EXACT.includes(key);
}

export function sanitizeClaudeSettingsForTako(settings: Record<string, any>): {
  settings: Record<string, any>;
  cleanedFields: string[];
} {
  const sanitized: Record<string, any> = { ...settings };
  const cleanedFields: string[] = [];
  const env = settings.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const sanitizedEnv = { ...env };
    for (const key of Object.keys(sanitizedEnv)) {
      if (isConflictingEnvKey(key)) {
        cleanedFields.push(key);
        delete sanitizedEnv[key];
      }
    }
    if (cleanedFields.length > 0) {
      if (Object.keys(sanitizedEnv).length === 0) {
        delete sanitized.env;
      } else {
        sanitized.env = sanitizedEnv;
      }
    }
  }

  return { settings: sanitized, cleanedFields };
}

export interface ClaudeSettingsLaunchSetup {
  args: string[];
  cleanedFields: string[];
  settingsPath: string;
}

export async function prepareTakoClaudeSettingsForLaunch(opts: {
  sourcePath?: string;
  targetPath?: string;
  logConflicts?: boolean;
} = {}): Promise<ClaudeSettingsLaunchSetup | null> {
  const fs = await import("fs/promises");
  const sourcePath = opts.sourcePath ?? CLAUDE_SETTINGS_PATH;
  const targetPath = opts.targetPath ?? TAKO_CLAUDE_SETTINGS_PATH;

  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf-8");
  } catch {
    return null;
  }

  let settings: Record<string, any>;
  try {
    settings = JSON.parse(content);
  } catch {
    return null;
  }

  const { settings: sanitized, cleanedFields } = sanitizeClaudeSettingsForTako(settings);

  if (cleanedFields.length === 0) return null;

  if (opts.logConflicts !== false) {
    log.warn(t("claudeCode.settingsDetected", { fields: cleanedFields.join(", ") }));
    log.info(t("claudeCode.usingIsolatedSettings", { path: targetPath }));
  }

  await fs.mkdir(dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(sanitized, null, 2) + "\n");

  return {
    args: ["--setting-sources", "project,local", "--settings", targetPath],
    cleanedFields,
    settingsPath: targetPath,
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

  async setupConfigFiles(provider: ProviderContext, _selectedOptionIds?: string[], context?: { forLaunch?: boolean }) {
    let launchArgs: string[] = [];

    // Claude Code 的 user settings 里若写死 ANTHROPIC_*，会覆盖 Tako 启动时注入的 provider。
    // 这里不修改用户原文件，而是生成 Tako 托管的清理副本，并在本次启动中排除原 user settings。
    if (context?.forLaunch) {
      const isolatedSettings = await prepareTakoClaudeSettingsForLaunch();
      if (isolatedSettings) {
        launchArgs = isolatedSettings.args;
      }
    }

    // 多账号切换：把目标账号的 OAuth tokens 还原到 Claude Code 的存储位置
    if (provider.type === "claude-subscription") {
      await syncClaudeSubscription(provider);
    }

    return launchArgs.length > 0 ? { args: launchArgs } : undefined;
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
    defaultOn: true,
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
export function appendOneMTagIfNeeded(modelId: string): string {
  if (!modelId) return modelId;
  if (modelId.endsWith("[1m]") || /:1m$/i.test(modelId)) return modelId;
  // 支持 claude、deepseek、kimi (moonshotai)、mimo (小米) 系列
  if (!/^(claude|deepseek|kimi|mimo)[-_]/i.test(modelId)) return modelId;
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
  return raw.map((e) => {
    const modelArg = appendOneMTagIfNeeded(e.id);
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
      envVars: { ANTHROPIC_MODEL: modelArg },
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
