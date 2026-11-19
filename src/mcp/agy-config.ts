import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix as posixPath, win32 as win32Path } from "node:path";

export const TAKO_MCP_SERVER_NAME = "tako" as const;
export const MIN_MCP_VERSION = "0.3.58" as const;

export interface AgyMcpPathOptions {
  home?: string;
  configDir?: string;
  env?: Record<string, string | undefined>;
}

export interface BuildTakoMcpServerConfigOptions {
  takoHome?: string;
  platform?: NodeJS.Platform;
  version?: string;
  argv1?: string;
  execPath?: string;
  env?: Record<string, string | undefined>;
}

export interface InjectAgyMcpConfigOptions extends AgyMcpPathOptions {
  takoHome?: string;
  platform?: NodeJS.Platform;
  version?: string;
  argv1?: string;
  execPath?: string;
}

export interface TakoMcpServerConfig {
  command: string;
  args: string[];
  disabled: false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const partsB = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolveHomeDir(opts?: { home?: string; env?: Record<string, string | undefined> }): string {
  const env = opts?.env ?? process.env;
  return opts?.home?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function resolveTakoHomeDir(
  takoHome: string | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home?: string,
): string {
  const explicit = takoHome?.trim() || env.TAKO_HOME?.trim();
  if (explicit) return explicit;
  return joinPlatformPath(platform, resolveHomeDir({ home, env }), ".tako");
}

async function getInstalledTakoVersion(takoHome: string): Promise<string | null> {
  const pkgPath = join(takoHome, "cli", "node_modules", "tako-cli", "package.json");
  try {
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

async function isMcpSupported(opts?: InjectAgyMcpConfigOptions): Promise<boolean> {
  const env = opts?.env ?? process.env;
  const version = opts?.version ?? opts?.env?.VERSION ?? process.env.VERSION;
  if (version === "dev") {
    return true;
  }

  const takoHome = resolveTakoHomeDir(opts?.takoHome, env, opts?.platform ?? process.platform, opts?.home);
  const installed = await getInstalledTakoVersion(takoHome);
  if (!installed) return false;
  return compareVersions(installed, MIN_MCP_VERSION) >= 0;
}

export function getAgyMcpConfigPath(opts?: AgyMcpPathOptions): string {
  const configDir = opts?.configDir?.trim();
  if (configDir) {
    return join(configDir, "mcp_config.json");
  }
  const home = resolveHomeDir(opts);
  return join(home, ".gemini", "config", "mcp_config.json");
}

/**
 * 构建写入 ~/.gemini/config/mcp_config.json 的 mcpServers.tako 条目。
 * 绝不写入任何 API Key 或密钥（运行时由 `tako mcp-server` 从 ~/.tako/config.json 与 env 动态读取）。
 */
export function buildTakoMcpServerConfig(
  opts?: BuildTakoMcpServerConfigOptions,
): TakoMcpServerConfig {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const version = opts?.version ?? opts?.env?.VERSION ?? process.env.VERSION;
  const argv1 = opts?.argv1?.trim() || (version === "dev" ? process.argv[1]?.trim() : undefined);
  const execPath = opts?.execPath?.trim() || process.execPath;

  if (version === "dev" && argv1) {
    return {
      command: execPath,
      args: [argv1, "mcp-server"],
      disabled: false,
    };
  }

  const takoHome = resolveTakoHomeDir(opts?.takoHome, env, platform);

  if (platform === "win32") {
    const takoBunExe = joinPlatformPath("win32", takoHome, "bun", "bin", "bun.exe");
    const takoEntry = joinPlatformPath(
      "win32",
      takoHome,
      "cli",
      "node_modules",
      "tako-cli",
      "dist",
      "index.js",
    );
    const command =
      process.platform === "win32" && !existsSync(takoBunExe) && execPath
        ? execPath
        : takoBunExe;
    return {
      command,
      args: [takoEntry, "mcp-server"],
      disabled: false,
    };
  }

  return {
    command: joinPlatformPath(platform, takoHome, "bin", "tako"),
    args: ["mcp-server"],
    disabled: false,
  };
}

function isSameServerConfig(existing: unknown, desired: TakoMcpServerConfig): boolean {
  if (!isPlainObject(existing)) return false;
  if (Object.keys(existing).length !== 3) return false;
  if (existing.command !== desired.command) return false;
  if (existing.disabled !== desired.disabled) return false;
  if (!Array.isArray(existing.args) || existing.args.length !== desired.args.length) return false;
  return desired.args.every((arg, i) => existing.args[i] === arg);
}

/**
 * 幂等注入 mcpServers.tako 到 Antigravity (agy) 的 ~/.gemini/config/mcp_config.json：
 * - 保留所有顶层字段与其他 mcpServers.* 配置
 * - 若用户已将 mcpServers.tako.disabled 设为 true（例如执行了 `agy mcp disable tako`），严格尊重并不覆盖
 * - 内容无变化时不重写磁盘文件
 */
export async function injectAgyMcpConfig(opts?: InjectAgyMcpConfigOptions): Promise<void> {
  const hasExplicitTarget = Boolean(opts?.home?.trim() || opts?.configDir?.trim());
  if (!hasExplicitTarget && !(await isMcpSupported(opts))) {
    return;
  }

  const configPath = getAgyMcpConfigPath(opts);
  let config: Record<string, unknown> = {};
  let rawExisting: string | null = null;

  try {
    rawExisting = await readFile(configPath, "utf8");
    const parsed = JSON.parse(rawExisting) as unknown;
    if (isPlainObject(parsed)) {
      config = parsed;
    }
  } catch {
    // Missing or invalid file starts from an empty object.
  }

  const existingServers = isPlainObject(config.mcpServers)
    ? { ...(config.mcpServers as Record<string, unknown>) }
    : {};

  const existingTako = existingServers[TAKO_MCP_SERVER_NAME];
  if (isPlainObject(existingTako) && existingTako.disabled === true) {
    return;
  }

  const desired = buildTakoMcpServerConfig({
    takoHome: opts?.takoHome,
    platform: opts?.platform,
    version: opts?.version,
    argv1: opts?.argv1,
    execPath: opts?.execPath,
    env: opts?.env,
  });

  if (isSameServerConfig(existingTako, desired)) {
    return;
  }

  const nextConfig: Record<string, unknown> = {
    ...config,
    mcpServers: {
      ...existingServers,
      [TAKO_MCP_SERVER_NAME]: desired,
    },
  };

  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (rawExisting === serialized) {
    return;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serialized, "utf8");
}

/**
 * 仅移除 mcpServers.tako，完整保留其余顶层键与其他 MCP Server 配置。
 */
export async function removeAgyMcpConfig(opts?: AgyMcpPathOptions): Promise<void> {
  const configPath = getAgyMcpConfigPath(opts);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return;
    if (!isPlainObject(parsed.mcpServers)) return;

    const servers = { ...(parsed.mcpServers as Record<string, unknown>) };
    if (!Object.prototype.hasOwnProperty.call(servers, TAKO_MCP_SERVER_NAME)) {
      return;
    }

    delete servers[TAKO_MCP_SERVER_NAME];
    const nextConfig: Record<string, unknown> = {
      ...parsed,
      mcpServers: servers,
    };
    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  } catch {
    // Missing or unreadable config is silently ignored.
  }
}
