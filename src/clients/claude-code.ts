import { homedir } from "os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "path";
import { ClientConfig, LaunchOption, registerClient } from "./base";
import type { ProviderContext, Provider } from "../providers/types";
import { DEEPSEEK_ANTHROPIC_URL, resolveXiaomiBaseUrl, SUBAGENT_MODEL_CC_DEFAULT } from "../providers/types";
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
// subagent、内置别名（opus/sonnet/haiku/fable）、标题/压缩等 utility 调用各自
// 走独立的模型解析路径，只钉 ANTHROPIC_MODEL 会让没钉的路径漏回 CC 内置默认
// 模型（用户选了 mimo/glm 却走成 opus 计费）。Kimi/DeepSeek 官方接入文档的
// 同款全家桶：选定模型后把全部解析路径钉到同一模型。
// 不开 CLAUDE_CODE_SUBAGENT_MODEL_FORCE：全家桶已覆盖内置默认漏出，FORCE 连
// 用户 agent 包 frontmatter 的显式选择也压掉，留作仍见漏时的后手。
// 旧版 CC 对不认识的 env 无害忽略；ANTHROPIC_SMALL_FAST_MODEL 自 CC v2.1.2
// 弃用，由 ANTHROPIC_DEFAULT_HAIKU_MODEL 取代，不再下发。
export const CLAUDE_SUBAGENT_MODEL_ENV_KEY = "CLAUDE_CODE_SUBAGENT_MODEL";
export const CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY = "ANTHROPIC_DEFAULT_OPUS_MODEL";
export const CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY = "ANTHROPIC_DEFAULT_SONNET_MODEL";
export const CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
export const CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY = "ANTHROPIC_DEFAULT_FABLE_MODEL";

/** subagent/别名/utility 五条解析路径（不含主模型 ANTHROPIC_MODEL 本身） */
function claudeSubagentPinEnvFor(model: string): Record<string, string> {
  return {
    [CLAUDE_SUBAGENT_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY]: model,
  };
}

/** 把主模型 + subagent/别名/utility 的全部解析路径钉到同一模型 */
export function claudeModelPinEnv(model: string): Record<string, string> {
  return { [CLAUDE_MODEL_ENV_KEY]: model, ...claudeSubagentPinEnvFor(model) };
}

/**
 * 子代理模型三态（provider.subagentModel）：
 *  - undefined ＝ 跟随主模型：五条路径钉到主模型（mainTagged，默认）
 *  - "cc-default" ＝ 不钉：Claude Code 按自己的规则解析（用户 settings.json / shell env 可接管）
 *  - 其他 ＝ 钉到指定模型 ID（自动补 [1m] 逻辑同主模型）
 * 主模型未设置且未指定子代理模型时无可钉，返回 {}。
 */
export function claudeSubagentPinEnv(
  provider: { subagentModel?: string },
  mainTagged?: string,
): Record<string, string> {
  const custom = provider.subagentModel?.trim();
  if (custom === SUBAGENT_MODEL_CC_DEFAULT) return {};
  if (custom) return claudeSubagentPinEnvFor(appendOneMTagIfNeeded(custom));
  return mainTagged ? claudeSubagentPinEnvFor(mainTagged) : {};
}

// ─── 子代理模型：启动选项组 + 合并后单点钉 ────────────────────────────
// 启动选项组只是「模式标记」（不带 envVars）：钉值依赖最终生效的主模型，而
// 主模型可能被同屏的模型选项覆盖，静态 envVars 表达不了「跟随最终模型」；且
// env 合并且增不删，「CC 默认」要撤掉已注入的钉也只能在合并后统一不算。
// 所以钉收敛到 setupConfigFiles（launchEnvVars 已是 getEnvVars+选项合并后的
// 终值）；tako agent 后台会话绕过 setupConfigFiles，由 agent/manager 用
// claudeCodeSessionPinEnv 单独补钉。
export const SUBAGENT_OPTION_GROUP = "subagent-model";
export const SUBAGENT_OPTION_FOLLOW_ID = "subagent-follow";
export const SUBAGENT_OPTION_CC_DEFAULT_ID = "subagent-cc-default";
export const SUBAGENT_OPTION_CUSTOM_ID = "subagent-custom";

type SubagentMode = "follow" | "cc-default" | "custom";

/** 启动选项选中优先，provider.subagentModel 是默认值来源。 */
function resolveSubagentMode(
  provider: { subagentModel?: string },
  selectedOptionIds?: string[],
): SubagentMode {
  if (selectedOptionIds?.includes(SUBAGENT_OPTION_CC_DEFAULT_ID)) return "cc-default";
  if (selectedOptionIds?.includes(SUBAGENT_OPTION_FOLLOW_ID)) return "follow";
  if (selectedOptionIds?.includes(SUBAGENT_OPTION_CUSTOM_ID)) {
    // 指定项只在 provider 配了指定模型时出现在选项里；配置被清掉则回退跟随（钉比漏安全）
    const custom = provider.subagentModel?.trim();
    return custom && custom !== SUBAGENT_MODEL_CC_DEFAULT ? "custom" : "follow";
  }
  const custom = provider.subagentModel?.trim();
  if (custom === SUBAGENT_MODEL_CC_DEFAULT) return "cc-default";
  if (custom) return "custom";
  return "follow";
}

/**
 * 启动合并后的单点钉计算。launchEnvVars 是 getEnvVars+选项 envVars 合并终值，
 * 跟随模式直接钉其 ANTHROPIC_MODEL（下发处已含 [1m] 后缀，不再二次补）。
 */
export function resolveLaunchPinEnv(
  provider: { subagentModel?: string },
  selectedOptionIds: string[] | undefined,
  launchEnvVars: Record<string, string>,
): Record<string, string> {
  const mode = resolveSubagentMode(provider, selectedOptionIds);
  if (mode === "cc-default") return {};
  if (mode === "custom") {
    return claudeSubagentPinEnvFor(appendOneMTagIfNeeded(provider.subagentModel!.trim()));
  }
  const main = launchEnvVars[CLAUDE_MODEL_ENV_KEY];
  return main ? claudeSubagentPinEnvFor(main) : {};
}

/** tako agent 后台会话的钉（该 spawn 路径绕过 setupConfigFiles），按 provider 三态。 */
export function claudeCodeSessionPinEnv(provider: ProviderContext): Record<string, string> {
  return claudeSubagentPinEnv(
    provider,
    provider.model ? appendOneMTagIfNeeded(provider.model) : undefined,
  );
}

export const CLAUDE_CONTEXT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const CLAUDE_MAX_CONTEXT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
export const TAKO_CONTEXT_WINDOW_ENV_KEY = "TAKO_MODEL_CONTEXT_WINDOW";
const CLAUDE_OPTION_ENV_KEYS = [
  CLAUDE_MODEL_ENV_KEY,
  CLAUDE_SUBAGENT_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY,
  CLAUDE_CONTEXT_WINDOW_ENV_KEY,
  CLAUDE_MAX_CONTEXT_ENV_KEY,
  TAKO_CONTEXT_WINDOW_ENV_KEY,
] as const;

export function claudeContextEnv(contextWindow?: number): Record<string, string> {
  if (!contextWindow || contextWindow <= 0) return {};
  const value = String(contextWindow);
  return {
    [CLAUDE_CONTEXT_WINDOW_ENV_KEY]: value,
    [CLAUDE_MAX_CONTEXT_ENV_KEY]: value,
    [TAKO_CONTEXT_WINDOW_ENV_KEY]: value,
  };
}

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
    // 注意：subagent/别名/utility 五条路径的钉不在此处下发——静态 getEnvVars
    // 无法支持启动选项的「CC 默认」撤钉（env 合并只增不删），钉收敛到
    // setupConfigFiles 合并后单点（resolveLaunchPinEnv）+ agent 会话的
    // claudeCodeSessionPinEnv，详见 SUBAGENT_OPTION_GROUP 上方注释。

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

  async setupConfigFiles(provider: ProviderContext, selectedOptionIds?: string[], context?: { forLaunch?: boolean; launchEnvVars?: Record<string, string> }) {
    // 多账号切换：把目标账号的 OAuth tokens 还原到 Claude Code 的存储位置
    if (provider.type === "claude-subscription") {
      await syncClaudeSubscription(provider);
    }

    if (!context?.forLaunch) return undefined;

    // 钉在 env 合并后单点计算（launchEnvVars 已是 getEnvVars+选项合并终值），
    // 跟随模式钉最终主模型；「CC 默认」不下发任何钉，让 CC/用户配置接管。
    const baseEnv = context.launchEnvVars ?? claudeCodeClient.getEnvVars(provider);
    const pinEnv = resolveLaunchPinEnv(provider, selectedOptionIds, baseEnv);

    // Keep all normal Claude configuration sources enabled. The CLI overlay has
    // higher precedence but contains only provider-owned env keys.
    const launchSettings = await prepareTakoClaudeSettingsForLaunch({
      launchEnvVars: { ...baseEnv, ...pinEnv },
    });
    return {
      args: launchSettings.args,
      cleanupFiles: launchSettings.cleanupFiles,
      envVars: pinEnv,
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
export function appendOneMTagIfNeeded(modelId: string, contextWindow?: number): string {
  if (!modelId) return modelId;
  if (modelId.endsWith("[1m]") || /:1m$/i.test(modelId)) return modelId;
  // Claude Code must recognize a 1M tier before its auto-compact window can be
  // raised above the normal ~200k ceiling. A server-advertised window above
  // 200k therefore opts eligible Anthropic-compatible model families into that
  // tier; CLAUDE_CODE_AUTO_COMPACT_WINDOW supplies the exact lower limit.
  if (!/^(?:full-)?(claude|deepseek|kimi|mimo|grok)[-_]/i.test(modelId)) return modelId;
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
    return {
      id: `model-${e.id}`,
      label: { en: e.displayName, zh: e.displayName },
      shortLabel: e.contextWindow > 0
        ? `${e.displayName} · ${ctxStrOf(e.contextWindow)} ctx`
        : e.displayName,
      description: {
        en: `Use ${e.displayName} (${ctxStrOf(e.contextWindow)} ctx)`,
        zh: `使用 ${e.displayName}（上下文 ${ctxStrOf(e.contextWindow)}）`,
      },
      flag: `--model ${modelArg}`,
      args: [],
      envVars: {
        ANTHROPIC_MODEL: modelArg,
        ...claudeContextEnv(e.contextWindow),
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
      shortLabel: ctx > 0 ? `${pretty} · ${ctxStr} ctx` : pretty,
      description: {
        en: `Use ${pretty} (${ctxStr} ctx)`,
        zh: `使用 ${pretty}（上下文 ${ctxStr}）`,
      },
      flag: `--model ${modelArg}`,
      args: [],
      envVars: {
        ANTHROPIC_MODEL: modelArg,
        ...claudeContextEnv(ctx),
      },
      group: "model",
    });
  }
  return out;
}

/**
 * 「子代理模型」启动选项组（互斥，与模型组并排）。
 * 选项只是模式标记、不带 envVars——真正的钉在 setupConfigFiles 合并后单点
 * 计算（resolveLaunchPinEnv）。defaultOn 镜像 provider.subagentModel 默认值，
 * 用户单次启动可偏离；项目记忆会记住选择。
 * 订阅 provider 不钉也不提供该组（走 OAuth + CC 自己的解析）。
 */
function buildSubagentModelOptions(provider?: Provider): LaunchOption[] {
  if (!provider || provider.type === "claude-subscription") return [];
  const custom = provider.subagentModel?.trim();
  const isCustom = !!custom && custom !== SUBAGENT_MODEL_CC_DEFAULT;
  const options: LaunchOption[] = [
    {
      id: SUBAGENT_OPTION_FOLLOW_ID,
      label: { en: "Subagent follows main model", zh: "子代理跟随主模型" },
      shortLabel: "子代理跟随",
      description: {
        en: "Pin subagent / builtin-alias / title & compaction calls to the selected main model",
        zh: "子代理、内置别名、标题/压缩等调用全部钉到选定的主模型",
      },
      flag: "",
      args: [],
      group: SUBAGENT_OPTION_GROUP,
      ...(!custom ? { defaultOn: true } : {}),
    },
    {
      id: SUBAGENT_OPTION_CC_DEFAULT_ID,
      label: { en: "Subagent uses Claude Code default", zh: "子代理用 Claude Code 默认" },
      shortLabel: "子代理 CC 默认",
      description: {
        en: "Don't pin; Claude Code resolves subagents by its own rules (your settings.json / shell env can take over)",
        zh: "不钉：Claude Code 按自己的规则解析（用户 settings.json / shell env 可接管）",
      },
      flag: "",
      args: [],
      group: SUBAGENT_OPTION_GROUP,
      ...(custom === SUBAGENT_MODEL_CC_DEFAULT ? { defaultOn: true } : {}),
    },
  ];
  if (isCustom) {
    options.push({
      id: SUBAGENT_OPTION_CUSTOM_ID,
      label: { en: `Subagent: ${custom}`, zh: `子代理指定：${custom}` },
      shortLabel: `子代理 ${custom}`,
      description: {
        en: `Pin subagent paths to ${custom} (configured in provider details)`,
        zh: `子代理等路径钉到 ${custom}（在服务商详情页配置）`,
      },
      flag: "",
      args: [],
      group: SUBAGENT_OPTION_GROUP,
      defaultOn: true,
    });
  }
  return options;
}

function buildClaudeCodeLaunchOptions(provider?: Provider): LaunchOption[] {
  return [...BASE_FLAGS, ...buildModelOptions(provider), ...buildSubagentModelOptions(provider)];
}

registerClient(claudeCodeClient);
