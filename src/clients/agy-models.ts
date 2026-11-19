import type { LaunchOption } from "./base";
import type { Provider } from "../providers/types";
import { PROXY_BASE_URL } from "../config";
import { filterChatModels, getTakoModels } from "../models/tako";

export type AgyProviderLike = {
  type?: string;
  baseUrl?: string;
  agyApiKey?: string;
  apiKey?: string;
};

/**
 * 规范化 Antigravity 网关地址：
 * 去掉末尾 `/` 以及末尾 `/v1` 或 `/v1beta`（agy 会自行拼接 `/v1beta/models...`）。
 */
export function normalizeAgyGatewayUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(/\/v1(?:beta)?$/i, "").replace(/\/+$/, "");
}

/**
 * 计算 AGY_LLM_GATEWAY_URL：
 * 优先级：env.TAKO_AGY_GATEWAY_URL > provider baseUrl > PROXY_BASE_URL
 */
export function resolveAgyGatewayUrl(
  baseUrl?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.TAKO_AGY_GATEWAY_URL?.trim();
  if (override) return normalizeAgyGatewayUrl(override);
  const candidate = baseUrl?.trim() || PROXY_BASE_URL;
  return normalizeAgyGatewayUrl(candidate);
}

/**
 * 计算 AGY_LLM_GATEWAY_API_KEY：
 * 优先级：env.TAKO_AGY_API_KEY > providerOrConfig.agyApiKey > apiKey
 */
export function resolveAgyApiKey(
  providerOrConfig?: { agyApiKey?: string; apiKey?: string },
  fallbackApiKey?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.TAKO_AGY_API_KEY?.trim() ||
    providerOrConfig?.agyApiKey?.trim() ||
    providerOrConfig?.apiKey?.trim() ||
    fallbackApiKey?.trim() ||
    ""
  );
}

export const DEFAULT_AGY_GATEWAY_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
] as const;

export const GEMINI_38_FLASH_EFFORT_VARIANTS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
] as const;

export const AGY_EFFORT_LEVEL_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;
const AGY_EFFORT_SUFFIX_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

/**
 * 为 agy 网关模式展开官方 Effort 滑块变体（按 max -> minimal 降序）：
 * 已带后缀或存在同 base 显式后缀变体的模型原样保留；优先按 `effortByModel` 动态展开，
 * 未配置时仅对 `gemini-3.8-flash` 回退默认 `high/medium/low` 变体。
 */
export function expandAgyGatewayModelsWithEffort(
  models: readonly string[],
  effortByModel?: ReadonlyMap<string, readonly string[]>,
): string[] {
  const explicitEffortBases = new Set<string>();
  for (const raw of models) {
    const base = normalizeAgyModelId(raw).toLowerCase().match(AGY_EFFORT_SUFFIX_RE)?.[1];
    if (base) explicitEffortBases.add(base);
  }
  const effortLookup = new Map<string, readonly string[]>();
  if (effortByModel) {
    for (const [k, v] of effortByModel) {
      const key = normalizeAgyModelId(k).toLowerCase();
      if (key && !effortLookup.has(key)) effortLookup.set(key, v);
    }
  }

  const seen = new Set<string>();
  const expanded: string[] = [];
  const pushUnique = (id: string) => {
    const key = id.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    expanded.push(id);
  };

  for (const raw of models) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeAgyModelId(trimmed).toLowerCase();
    if (AGY_EFFORT_SUFFIX_RE.test(normalized) || explicitEffortBases.has(normalized)) {
      pushUnique(trimmed);
      continue;
    }
    const configured = effortLookup.get(normalized);
    if (configured !== undefined) {
      const present = new Set(configured.filter((l): l is string => typeof l === "string").map((l) => l.trim().toLowerCase()));
      const ordered = AGY_EFFORT_LEVEL_ORDER.filter((tier) => present.has(tier));
      if (ordered.length > 0) for (const level of ordered) pushUnique(`${normalized}-${level}`);
      else pushUnique(trimmed);
    } else if (normalized === "gemini-3.8-flash") {
      for (const variant of GEMINI_38_FLASH_EFFORT_VARIANTS) pushUnique(variant);
    } else {
      pushUnique(trimmed);
    }
  }
  return expanded;
}

const AGY_NON_CHAT_MODEL_RE = /(?:^|-)(?:image|video|audio|tts|asr|embedding|veo|lyria|aqa)(?:$|-)/i;
const AGY_GEMMA_MODEL_RE = /^gemma-/i;
const AGY_SUPPORTED_MODEL_PATTERNS = [
  /^claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)*(?:-(?:thinking|low|medium|high|minimal|xhigh|max))?$/,
  /^gemini-3\.\d+-flash(?:-(?:low|medium|high|minimal|xhigh|max))?$/,
  /^gemini-3\.5-flash-lite(?:-(?:low|medium|high|minimal|xhigh|max))?$/,
  /^gemini-4-[a-z0-9-]+$/,
  /^gpt-oss-\d+[a-z0-9-]*$/,
] as const;

/** 剥离可能残留的 `models/` 前缀（例如 `models/claude-opus-4-6` -> `claude-opus-4-6`） */
export function normalizeAgyModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return /^models\//i.test(trimmed) ? trimmed.slice("models/".length) : trimmed;
}

export function isAgySupportedModelId(modelId: string): boolean {
  const id = normalizeAgyModelId(modelId).toLowerCase();
  if (!id || id.includes("/")) return false;
  if (AGY_NON_CHAT_MODEL_RE.test(id) || AGY_GEMMA_MODEL_RE.test(id)) return false;
  return AGY_SUPPORTED_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

export function getCachedAgyChatEntries(
  providerOrConfig?: AgyProviderLike,
  fallbackApiKey?: string,
  env: Record<string, string | undefined> = process.env,
) {
  const key = resolveAgyApiKey(providerOrConfig, fallbackApiKey, env);
  const gatewayUrl = resolveAgyGatewayUrl(providerOrConfig?.baseUrl, env);
  const raw =
    (gatewayUrl ? getTakoModels(gatewayUrl, "gemini", key) : null) ??
    (providerOrConfig?.baseUrl && gatewayUrl !== providerOrConfig.baseUrl
      ? getTakoModels(providerOrConfig.baseUrl, "gemini", key)
      : null);
  return raw ? filterChatModels(raw).filter((entry) => isAgySupportedModelId(entry.id)) : null;
}

export function resolveAgyGatewayModels(
  providerOrConfig?: AgyProviderLike,
  fallbackApiKey?: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const entries = getCachedAgyChatEntries(providerOrConfig, fallbackApiKey, env);
  if (entries?.length) {
    const filtered = [...new Set(entries.map((entry) => normalizeAgyModelId(entry.id).toLowerCase()))];
    if (filtered.length > 0) return filtered;
  }
  return [...DEFAULT_AGY_GATEWAY_MODELS];
}

export function resolveAgyGatewayEffortMap(
  providerOrConfig?: AgyProviderLike,
  fallbackApiKey?: string,
  env: Record<string, string | undefined> = process.env,
): Map<string, readonly string[]> | undefined {
  const entries = getCachedAgyChatEntries(providerOrConfig, fallbackApiKey, env);
  if (!entries?.length) return undefined;
  const effortMap = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const levels = entry.supportedEffortLevels;
    if (!Array.isArray(levels) || levels.length === 0) continue;
    const normalized = normalizeAgyModelId(entry.id).toLowerCase();
    if (!effortMap.has(normalized)) effortMap.set(normalized, levels);
  }
  return effortMap.size > 0 ? effortMap : undefined;
}

export function resolveAgyTierModels(
  models: readonly string[],
): { pro: string; flash: string; flashLite: string } {
  const list = models.length > 0 ? models : DEFAULT_AGY_GATEWAY_MODELS;
  const pro = list.find((m) => /^claude-opus-|^gemini-4-/.test(m)) ?? list[0];
  const flash = list.find((m) => /^claude-sonnet-|^gemini-3\.\d+-flash(?!-lite)/.test(m)) ?? list[0];
  const flashLite = list.find((m) => /flash-lite|^gpt-oss-/.test(m)) ?? flash;
  return { pro, flash, flashLite };
}

export function computeAgyGatewayEnvVars(
  providerOrConfig?: AgyProviderLike,
  fallbackApiKey?: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const gatewayUrl = resolveAgyGatewayUrl(providerOrConfig?.baseUrl, baseEnv);
  const gatewayKey = resolveAgyApiKey(providerOrConfig, fallbackApiKey, baseEnv);
  const models = resolveAgyGatewayModels(providerOrConfig, fallbackApiKey, baseEnv);
  const tiers = resolveAgyTierModels(models);
  const effortMap = resolveAgyGatewayEffortMap(providerOrConfig, fallbackApiKey, baseEnv);
  const gatewayModels = expandAgyGatewayModelsWithEffort(models, effortMap);

  const envVars: Record<string, string> = {};
  if (gatewayUrl) envVars.AGY_LLM_GATEWAY_URL = gatewayUrl;
  envVars.AGY_LLM_GATEWAY_API_KEY = gatewayKey;
  envVars.AGY_LLM_GATEWAY_MODELS = baseEnv.AGY_LLM_GATEWAY_MODELS?.trim() || gatewayModels.join(",");
  envVars.AGY_LLM_GATEWAY_TIER_PRO = baseEnv.AGY_LLM_GATEWAY_TIER_PRO?.trim() || tiers.pro;
  envVars.AGY_LLM_GATEWAY_TIER_FLASH = baseEnv.AGY_LLM_GATEWAY_TIER_FLASH?.trim() || tiers.flash;
  envVars.AGY_LLM_GATEWAY_TIER_FLASH_LITE = baseEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE?.trim() || tiers.flashLite;
  return envVars;
}

export function buildAgyModelOptions(provider?: Provider): LaunchOption[] {
  if (!provider || (provider.type !== "tako" && provider.type !== "custom") || !provider.baseUrl) {
    return [];
  }
  if (!resolveAgyApiKey(provider)) return [];
  const filtered = getCachedAgyChatEntries(provider) ?? [];
  const entries: Array<{ id: string; displayName: string; description: string }> =
    filtered.length > 0
      ? filtered
      : DEFAULT_AGY_GATEWAY_MODELS.map((id) => ({ id, displayName: id, description: "" }));

  const seen = new Set<string>();
  const options: LaunchOption[] = [];
  for (const entry of entries) {
    const modelId = normalizeAgyModelId(entry.id).toLowerCase();
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    options.push({
      id: `model-${modelId}`,
      label: { en: entry.displayName, zh: entry.displayName },
      shortLabel: entry.displayName,
      description: {
        en: entry.description || `Use ${entry.displayName}`,
        zh: entry.description || `使用 ${entry.displayName}`,
      },
      flag: `--model ${modelId}`,
      args: ["--model", modelId],
      group: "model",
    });
  }
  return options;
}
