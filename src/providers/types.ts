/**
 * Provider 类型和接口定义
 */

export type ProviderType =
  | "claude-subscription"
  | "codex-subscription"
  | "tako"
  | "anthropic"
  | "deepseek"
  | "xiaomi"
  | "custom";

/**
 * Provider 配置
 */
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  apiId?: string;
  supportedClients?: string[];
  createdAt: string;
  /** subscription 专属 */
  email?: string;
  subscriptionType?: string;
  /** 内置服务商（如 Tako），不可删除 */
  builtin?: boolean;
  /** 订阅认证数据（OAuth tokens 等），切换账号时恢复到客户端 auth 文件 */
  authData?: Record<string, any>;
  /** 指定使用的模型（不同服务商有不同默认模型） */
  model?: string;
  /** 当 model 不在内置 catalog 时，由用户提供的 context window（单位 token），
   *  用于 Codex 等需要 metadata 的客户端，避免 fallback metadata 警告 */
  modelContextWindow?: number;
  /** 最近一次被绑定到某客户端的时间（用于列表按最近使用排序） */
  lastUsedAt?: string;
}

/**
 * 传给客户端的精简 Provider 上下文
 */
export interface ProviderContext {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  /** 订阅认证数据，客户端启动时恢复 */
  authData?: Record<string, any>;
  /** 指定模型 */
  model?: string;
  /** 用户为自定义 model 录入的 context window（catalog 没有时用） */
  modelContextWindow?: number;
}

/**
 * Provider 类型显示名称
 */
export const PROVIDER_TYPE_NAMES: Record<ProviderType, { en: string; zh: string }> = {
  "claude-subscription": { en: "Claude Subscription", zh: "Claude 订阅直连" },
  "codex-subscription": { en: "Codex Subscription", zh: "Codex 订阅直连" },
  tako: { en: "Tako Proxy", zh: "Tako 代理" },
  anthropic: { en: "Anthropic Direct", zh: "Anthropic 直连" },
  deepseek: { en: "DeepSeek", zh: "DeepSeek" },
  xiaomi: { en: "Xiaomi MiMo", zh: "小米 MiMo" },
  custom: { en: "Custom Proxy", zh: "自定义代理" },
};

/**
 * 每个 Provider 类型默认支持的客户端
 * undefined = 全部支持
 */
export function getDefaultSupportedClients(type: ProviderType): string[] | undefined {
  switch (type) {
    case "claude-subscription":
      return ["claude-code"];
    case "codex-subscription":
      return ["codex"];
    case "anthropic":
      return ["claude-code"];
    case "deepseek":
      return ["claude-code", "codex"];
    case "xiaomi":
      return ["claude-code"];
    case "custom":
      return ["claude-code", "codex", "grok"];
    case "tako":
    default:
      return undefined; // 全部
  }
}

/**
 * 每个 Provider 类型的默认模型
 */
export function getDefaultModel(type: ProviderType): string | undefined {
  switch (type) {
    case "deepseek":
      return "deepseek-v4-flash";
    case "xiaomi":
      return "mimo-v2.5-pro";
    case "tako":
      return undefined; // 由各客户端自行决定
    default:
      return undefined;
  }
}

/**
 * 每个 Provider 类型的预设 Base URL（undefined 表示需要用户输入）
 * DeepSeek 对 Codex(OpenAI 格式) 和 Claude Code(Anthropic 格式) 使用不同的 URL
 */
export function getDefaultBaseUrl(type: ProviderType): string | undefined {
  switch (type) {
    case "deepseek":
      return "https://api.deepseek.com";
    case "xiaomi":
      return XIAOMI_ANTHROPIC_URL;
    default:
      return undefined;
  }
}

/** DeepSeek Anthropic 兼容 URL（Claude Code 用） */
export const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";

/**
 * Xiaomi MiMo Anthropic 兼容 URL（Claude Code 用）
 *  - 按量付费：`sk-` 开头的 key，走 api.xiaomimimo.com
 *  - Token Plan 订阅：`tp-` 开头的 key，走 token-plan-cn.xiaomimimo.com
 */
export const XIAOMI_ANTHROPIC_URL = "https://api.xiaomimimo.com/anthropic";
export const XIAOMI_TOKEN_PLAN_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";

/** 根据 API Key 前缀选择 Xiaomi MiMo 的 Base URL：`tp-` → Token Plan，其余 → 按量付费 */
export function resolveXiaomiBaseUrl(apiKey?: string): string {
  return apiKey?.startsWith("tp-") ? XIAOMI_TOKEN_PLAN_URL : XIAOMI_ANTHROPIC_URL;
}

/**
 * Claude 系列模型 — 只在 Tako 官方 / Anthropic 官方直连中暴露
 * 默认 Sonnet 走 Claude Code 自身策略，仅显式列出 Opus 4.6 / 4.7
 */
const CLAUDE_MODEL_CHOICES = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
];

/** Xiaomi MiMo 可选模型（mimo-v2.5-pro 支持 1M 上下文，launcher 自动补 [1m] 后缀） */
const XIAOMI_MODEL_CHOICES = ["mimo-v2.5-pro"];

/**
 * 某些 Provider 预设的可选模型列表（用于 UI 选择）
 * 返回 undefined 表示自由输入
 */
export function getModelChoices(type: ProviderType): string[] | undefined {
  switch (type) {
    case "deepseek":
      return ["deepseek-v4-flash", "deepseek-v4-pro"];
    case "xiaomi":
      return XIAOMI_MODEL_CHOICES;
    case "tako":
    case "anthropic":
      return CLAUDE_MODEL_CHOICES;
    default:
      return undefined;
  }
}

/**
 * 检查 Provider 是否支持指定客户端
 */
export function isProviderCompatible(provider: Provider, clientId: string): boolean {
  const supported = provider.supportedClients;
  if (!supported || supported.length === 0) return true;
  return supported.includes(clientId);
}
