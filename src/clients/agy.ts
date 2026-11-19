import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { ClientConfig, type ClientLaunchSetupContext, LaunchOption, registerClient } from "./base";
import type { Provider, ProviderContext } from "../providers/types";
import { PROXY_BASE_URL } from "../config";
import { installAgy } from "../installer";
import { filterChatModels, getTakoModels } from "../models/tako";
import { buildAgyStatusLineConfig, hasCustomNonTakoStatusLine } from "../statusline/inject";

export const AGY_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions" as const;

export const AGY_CONFLICTING_ENV_KEYS = [
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AICODE_ENDPOINT_URL",
] as const;

export function agyBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agy.exe" : "agy";
}

function joinPlatformPath(platform: NodeJS.Platform, base: string, ...parts: string[]): string {
  if (/^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\")) {
    return win32Path.join(base, ...parts);
  }
  if (base.startsWith("/")) {
    return posixPath.join(base, ...parts);
  }
  return (platform === "win32" ? win32Path : posixPath).join(base, ...parts);
}

/**
 * 拆分 PATH 环境变量，同时兼容在 Windows 上模拟 POSIX 平台时带盘符（如 C:\...）的路径。
 */
export function splitAgyPathEnv(
  pathVar: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!pathVar) return [];
  if (platform === "win32" || pathVar.includes(";")) {
    return pathVar.split(";").map((s) => s.trim()).filter(Boolean);
  }
  const parts: string[] = [];
  const raw = pathVar.split(":");
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (/^[A-Za-z]$/.test(cur) && i + 1 < raw.length && /^[\\/]/.test(raw[i + 1])) {
      parts.push(`${cur}:${raw[i + 1]}`.trim());
      i++;
    } else if (cur.trim()) {
      parts.push(cur.trim());
    }
  }
  return parts;
}

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

const GEMINI_38_FLASH_EFFORT_RE = /^gemini-3\.8-flash-(?:low|medium|high)$/;

/**
 * 为 agy 1.5.12 网关模式展开官方 Effort 滑块变体：
 * 当模型列表包含 `gemini-3.8-flash` 且未显式声明任意 `gemini-3.8-flash-(low|medium|high)` 时，
 * 将其就地替换为 `high / medium / low` 三个变体，使 `/model` 与 `/effort` 显示 `←/→` 滑块；
 * 其余模型保持原样，按首次出现顺序去重。
 */
export function expandAgyGatewayModelsWithEffort(models: readonly string[]): string[] {
  const hasExplicitEffort = models.some((m) =>
    GEMINI_38_FLASH_EFFORT_RE.test(normalizeAgyModelId(m).toLowerCase()),
  );
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
    if (normalized === "gemini-3.8-flash" && !hasExplicitEffort) {
      for (const variant of GEMINI_38_FLASH_EFFORT_VARIANTS) {
        pushUnique(variant);
      }
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
  /^gemini-3\.8-flash(?:-(?:low|medium|high|minimal|xhigh|max))?$/,
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

export function resolveAgyGatewayModels(
  providerOrConfig?: { type?: string; baseUrl?: string; agyApiKey?: string; apiKey?: string },
  fallbackApiKey?: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const key = resolveAgyApiKey(providerOrConfig, fallbackApiKey, env);
  const gatewayUrl = resolveAgyGatewayUrl(providerOrConfig?.baseUrl, env);
  const raw =
    (gatewayUrl ? getTakoModels(gatewayUrl, "gemini", key) : null) ??
    (providerOrConfig?.baseUrl && gatewayUrl !== providerOrConfig.baseUrl
      ? getTakoModels(providerOrConfig.baseUrl, "gemini", key)
      : null);

  if (raw) {
    const seen = new Set<string>();
    const filtered: string[] = [];
    for (const entry of filterChatModels(raw)) {
      if (!isAgySupportedModelId(entry.id)) continue;
      const normalized = normalizeAgyModelId(entry.id).toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        filtered.push(normalized);
      }
    }
    if (filtered.length > 0) return filtered;
  }

  return [...DEFAULT_AGY_GATEWAY_MODELS];
}

export function resolveAgyTierModels(
  models: readonly string[],
): { pro: string; flash: string; flashLite: string } {
  const list = models.length > 0 ? models : DEFAULT_AGY_GATEWAY_MODELS;
  const pro = list.find((m) => /^claude-opus-|^gemini-4-/.test(m)) ?? list[0];
  const flash = list.find((m) => /^claude-sonnet-|^gemini-3\.8-flash/.test(m)) ?? list[0];
  const flashLite = list.find((m) => /flash-lite|^gpt-oss-/.test(m)) ?? flash;
  return { pro, flash, flashLite };
}

function computeAgyGatewayEnvVars(
  providerOrConfig?: { type?: string; baseUrl?: string; agyApiKey?: string; apiKey?: string },
  fallbackApiKey?: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const gatewayUrl = resolveAgyGatewayUrl(providerOrConfig?.baseUrl, baseEnv);
  const gatewayKey = resolveAgyApiKey(providerOrConfig, fallbackApiKey, baseEnv);
  const models = resolveAgyGatewayModels(providerOrConfig, fallbackApiKey, baseEnv);
  const tiers = resolveAgyTierModels(models);
  const gatewayModels = expandAgyGatewayModelsWithEffort(models);

  const envVars: Record<string, string> = {};
  if (gatewayUrl) envVars.AGY_LLM_GATEWAY_URL = gatewayUrl;
  envVars.AGY_LLM_GATEWAY_API_KEY = gatewayKey;
  envVars.AGY_LLM_GATEWAY_MODELS = baseEnv.AGY_LLM_GATEWAY_MODELS?.trim() || gatewayModels.join(",");
  envVars.AGY_LLM_GATEWAY_TIER_PRO = baseEnv.AGY_LLM_GATEWAY_TIER_PRO?.trim() || tiers.pro;
  envVars.AGY_LLM_GATEWAY_TIER_FLASH = baseEnv.AGY_LLM_GATEWAY_TIER_FLASH?.trim() || tiers.flash;
  envVars.AGY_LLM_GATEWAY_TIER_FLASH_LITE = baseEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE?.trim() || tiers.flashLite;
  return envVars;
}

/**
 * 克隆子进程环境变量，删除所有冲突的 Gemini / Google / AICode 变量，
 * 并注入 AGY_LLM_GATEWAY_URL、AGY_LLM_GATEWAY_API_KEY、AGY_LLM_GATEWAY_MODELS 及 TIER_*。
 */
export function prepareAgyEnv(
  baseEnv: Record<string, string | undefined>,
  providerOrConfig?: { type?: string; baseUrl?: string; agyApiKey?: string; apiKey?: string },
  fallbackApiKey?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of AGY_CONFLICTING_ENV_KEYS) {
    delete env[key];
  }

  Object.assign(env, computeAgyGatewayEnvVars(providerOrConfig, fallbackApiKey, baseEnv));
  return env;
}

export function buildAgyArgs(opts?: {
  model?: string;
  skipPermissions?: boolean;
  extraArgs?: string[];
}): string[] {
  const args: string[] = [];
  if (opts?.skipPermissions) {
    args.push(AGY_SKIP_PERMISSIONS_FLAG);
  }
  if (opts?.model?.trim()) {
    args.push("--model", normalizeAgyModelId(opts.model));
  }
  if (opts?.extraArgs?.length) {
    args.push(...opts.extraArgs);
  }
  return args;
}

function readAgySettingsObject(agyHome?: string): Record<string, unknown> | null {
  const dir = agyHome?.trim() || process.env.AGY_HOME?.trim() || join(homedir(), ".gemini", "antigravity-cli");
  try {
    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable settings.json is ignored; disk file is never modified.
  }
  return null;
}

export function buildAgySkipPermissionsSettings(
  workingDir: string,
  agyHome?: string,
): string {
  const parsed = readAgySettingsObject(agyHome);
  const seen = new Set<string>();
  const trustedWorkspaces: string[] = [];
  const pushUnique = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    trustedWorkspaces.push(candidate);
  };

  const existing = parsed?.trustedWorkspaces;
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item === "string") pushUnique(item);
    }
  }

  pushUnique(workingDir);
  if (workingDir) {
    try {
      pushUnique(realpathSync(workingDir));
    } catch {
      // Non-existent or inaccessible workingDir realpath is ignored.
    }
  }

  const payload: Record<string, unknown> = {
    trustedWorkspaces,
    allowNonWorkspaceAccess: true,
    toolPermission: "always-proceed",
  };
  if (!hasCustomNonTakoStatusLine(parsed)) {
    payload.statusLine = buildAgyStatusLineConfig();
  }

  return JSON.stringify(payload);
}

/**
 * 标准安装路径候选（不含 AGY_PATH 与 PATH）：
 * - macOS/Linux: ~/.local/bin/agy, ~/.gemini/bin/agy, /usr/local/bin/agy, /opt/homebrew/bin/agy
 * - Windows: %LOCALAPPDATA%\agy\bin\agy.exe, %LOCALAPPDATA%\Programs\Antigravity\bin\agy.exe, ~/.local/bin/agy.exe
 */
export function agyStandardCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const customInstallDir = env.AGY_INSTALL_DIR?.trim();
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || joinPlatformPath("win32", home, "AppData", "Local");
    const list = [
      joinPlatformPath("win32", localAppData, "agy", "bin", "agy.exe"),
      joinPlatformPath("win32", localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
      joinPlatformPath("win32", home, ".local", "bin", "agy.exe"),
    ];
    return customInstallDir
      ? [joinPlatformPath("win32", customInstallDir, "agy.exe"), ...list]
      : list;
  }

  const list = [
    joinPlatformPath(platform, home, ".local", "bin", "agy"),
    joinPlatformPath(platform, home, ".gemini", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ];
  return customInstallDir
    ? [joinPlatformPath(platform, customInstallDir, "agy"), ...list]
    : list;
}

async function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return false;
    if (platform !== "win32" && process.platform !== "win32") {
      await fs.access(filePath, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export interface FindAgyBinaryOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** 可选自定义文件可执行检测（便于跨平台单测） */
  checkFile?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
}

/**
 * 解析 agy 二进制路径，严格按以下优先级：
 * 1. env.AGY_PATH（存在且可执行）
 * 2. env.PATH 中的可执行文件
 * 3. 平台标准安装位置
 */
export async function findAgyBinary(opts?: FindAgyBinaryOptions): Promise<string | null> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home || env.HOME || env.USERPROFILE || homedir();
  const check = opts?.checkFile ?? isExecutableFile;

  // 1. AGY_PATH 优先
  const explicitPath = env.AGY_PATH?.trim();
  if (explicitPath && (await check(explicitPath, platform))) {
    return explicitPath;
  }

  // 2. PATH 搜索
  const pathVar = env.PATH ?? env.Path ?? "";
  if (pathVar) {
    const names = platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
    for (const dir of splitAgyPathEnv(pathVar, platform)) {
      for (const name of names) {
        const candidate = joinPlatformPath(platform, dir, name);
        if (await check(candidate, platform)) {
          return candidate;
        }
      }
    }
  }

  // 3. 标准安装目录
  for (const candidate of agyStandardCandidates(home, platform, env)) {
    if (await check(candidate, platform)) {
      return candidate;
    }
  }

  return null;
}

export function parseAgyVersion(output: string): string | null {
  const match = output.trim().match(/\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9.+]+)?)\b/);
  return match?.[1] ?? null;
}

export async function readAgyVersion(binPath?: string): Promise<string | null> {
  const resolved = binPath ?? (await findAgyBinary());
  if (!resolved) return null;
  try {
    const proc = Bun.spawn([resolved, "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = `${await new Response(proc.stdout).text()} ${await new Response(proc.stderr).text()}`;
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return parseAgyVersion(text);
  } catch {
    return null;
  }
}

export function buildAgyModelOptions(provider?: Provider): LaunchOption[] {
  if (!provider || (provider.type !== "tako" && provider.type !== "custom") || !provider.baseUrl) {
    return [];
  }
  const key = resolveAgyApiKey(provider);
  if (!key) return [];
  const gatewayUrl = resolveAgyGatewayUrl(provider.baseUrl);
  const raw =
    getTakoModels(gatewayUrl, "gemini", key) ??
    (gatewayUrl !== provider.baseUrl ? getTakoModels(provider.baseUrl, "gemini", key) : null);

  const filtered = raw
    ? filterChatModels(raw).filter((entry) => isAgySupportedModelId(entry.id))
    : [];
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

const AGY_BASE_FLAGS: LaunchOption[] = [
  {
    id: "skip-permissions",
    label: { en: "Skip Permissions", zh: "跳过权限确认" },
    shortLabel: "Skip Perms",
    description: {
      en: "Auto-approve all tool permission requests without prompting",
      zh: "自动批准所有工具权限请求，无需确认",
    },
    flag: AGY_SKIP_PERMISSIONS_FLAG,
    args: [AGY_SKIP_PERMISSIONS_FLAG],
    defaultOn: true,
  },
];

export function buildAgyLaunchOptions(provider?: Provider): LaunchOption[] {
  return [...AGY_BASE_FLAGS, ...buildAgyModelOptions(provider)];
}

export const agyClient: ClientConfig = {
  id: "agy",
  name: "Antigravity (agy)",
  package: "system:agy",
  command: "agy",
  runtime: "native",
  install: "system",
  oneClickInstall: true,
  continueArg: "--continue",
  brandColor: "green",
  unsetEnvVars: AGY_CONFLICTING_ENV_KEYS,
  resolveBin: () => findAgyBinary(),
  readSystemVersion: () => readAgyVersion(),
  installSystem: (version?: string) => installAgy({ version }),

  getEnvVars(provider: ProviderContext) {
    return {
      AGY_LLM_GATEWAY_URL: resolveAgyGatewayUrl(provider.baseUrl, process.env),
      ...computeAgyGatewayEnvVars(provider, undefined, process.env),
    };
  },

  async setupConfigFiles(
    _provider: ProviderContext,
    selectedOptionIds?: string[],
    context?: ClientLaunchSetupContext,
  ) {
    if (context?.forLaunch !== true) return undefined;
    const launchArgs = context.launchArgs ?? [];
    const skipActive =
      launchArgs.includes(AGY_SKIP_PERMISSIONS_FLAG) ||
      Boolean(selectedOptionIds?.includes("skip-permissions"));
    if (!skipActive) return undefined;
    if (launchArgs.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
      return undefined;
    }
    return {
      args: ["--settings", buildAgySkipPermissionsSettings(context.workingDir || process.cwd())],
    };
  },

  launchOptions: (provider?: Provider) => buildAgyLaunchOptions(provider),
};

export const AgyClient = agyClient;

registerClient(agyClient);
