import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { randomUUID } from "node:crypto";
import { ClientConfig, type ClientLaunchSetupContext, LaunchOption, registerClient } from "./base";
import type { Provider, ProviderContext } from "../providers/types";
import { checkAgyManagedUpdate, installAgy } from "../installer";
import { buildAgyStatusLineConfig, hasCustomNonTakoStatusLine } from "../statusline/inject";
import {
  type AgyProviderLike,
  buildAgyModelOptions,
  computeAgyGatewayEnvVars,
  normalizeAgyModelId,
  resolveAgyGatewayUrl,
} from "./agy-models";

export {
  AGY_EFFORT_LEVEL_ORDER,
  buildAgyModelOptions,
  DEFAULT_AGY_GATEWAY_MODELS,
  expandAgyGatewayModelsWithEffort,
  GEMINI_38_FLASH_EFFORT_VARIANTS,
  isAgySupportedModelId,
  normalizeAgyGatewayUrl,
  normalizeAgyModelId,
  resolveAgyApiKey,
  resolveAgyGatewayEffortMap,
  resolveAgyGatewayModels,
  resolveAgyGatewayUrl,
  resolveAgyTierModels,
} from "./agy-models";

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
 * 克隆子进程环境变量，删除所有冲突的 Gemini / Google / AICode 变量，
 * 并注入 AGY_LLM_GATEWAY_URL、AGY_LLM_GATEWAY_API_KEY、AGY_LLM_GATEWAY_MODELS 及 TIER_*。
 */
export function prepareAgyEnv(
  baseEnv: Record<string, string | undefined>,
  providerOrConfig?: AgyProviderLike,
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

/** 惰性解析（config.TAKO_DIR 在 import 时绑定，测试需要 TAKO_HOME 后改生效） */
function agyLaunchSettingsDir(): string {
  const takoDir = process.env.TAKO_HOME?.trim() || join(homedir(), ".tako");
  return join(takoDir, "agy", "launch-settings");
}

/**
 * 把 session-only settings JSON 落到临时文件并返回文件路径。
 *
 * agy 的 `--settings` 同时接受内联 JSON 与文件路径；这里一律用文件路径——
 * 内联 JSON 里的 `"` 经 Windows PowerShell 5.1 handoff（`& exe @argv` 重新拼接
 * 原生命令行）会被拆碎成多个 token，agy 严格校验 settings 键直接拒启动。
 * 文件路径不含引号，可安全穿越所有 shell 交接路径。
 * 返回的文件随启动 cleanupFiles 在客户端退出后删除。
 */
export async function writeAgySessionSettingsFile(
  workingDir: string,
  agyHome?: string,
  dir: string = agyLaunchSettingsDir(),
): Promise<string> {
  const fs = await import("node:fs/promises");
  const targetPath = join(dir, `${process.pid}-${Date.now()}-${randomUUID()}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(targetPath, buildAgySkipPermissionsSettings(workingDir, agyHome) + "\n", {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return targetPath;
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
  installSystem: (version?: string, opts?: { force?: boolean }) =>
    installAgy({ version, force: opts?.force }),
  checkSystemUpdate: async (opts?: { forceRefresh?: boolean }) => {
    const localVersion = await readAgyVersion();
    return checkAgyManagedUpdate({
      localVersion,
      forceRefresh: opts?.forceRefresh,
    });
  },

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
    // --settings 传文件路径而非内联 JSON：内联 JSON 的引号会被 Windows
    // PowerShell 5.1 handoff 拆碎，agy 严格校验即拒启动（0.3.57 Windows 回归）。
    const settingsPath = await writeAgySessionSettingsFile(context.workingDir || process.cwd());
    return {
      args: ["--settings", settingsPath],
      cleanupFiles: [settingsPath],
    };
  },

  launchOptions: (provider?: Provider) => buildAgyLaunchOptions(provider),
};

export const AgyClient = agyClient;

registerClient(agyClient);
