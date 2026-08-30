import { join } from "path";
import { TOOLS_DIR, TAKO_DIR } from "../config";
import type { ProviderContext, Provider } from "../providers/types";

/**
 * 验证路径是否在 Tako 目录下（安全检查）
 */
function assertPathInTakoDir(path: string, description: string): void {
  if (!path.startsWith(TAKO_DIR)) {
    throw new Error(`安全检查失败: ${description} 路径 "${path}" 不在 Tako 目录下`);
  }
}

/**
 * Launch option for a client (e.g. --verbose, --full-auto)
 */
export interface LaunchOption {
  /** Unique option ID */
  id: string;
  /** Bilingual display label */
  label: { en: string; zh: string };
  /** Short label for collapsed view (e.g. "Skip Perms") */
  shortLabel: string;
  /** Bilingual description for expanded view */
  description: { en: string; zh: string };
  /** CLI flag text shown in expanded view (e.g. "--verbose") */
  flag: string;
  /** Actual CLI arguments to pass */
  args: string[];
  /** Environment variables to set (merged into process env at launch) */
  envVars?: Record<string, string>;
  /** Mutual exclusion group — options in the same group cannot be selected together */
  group?: string;
  /** Default-on when the user has no saved selection (首次/无记忆时默认勾选) */
  defaultOn?: boolean;
}

export interface ClientLaunchSetupContext {
  forLaunch?: boolean;
  /** Final launch env after provider and selected-option values are merged. */
  launchEnvVars?: Record<string, string>;
}

export interface ClientLaunchSetup {
  args?: string[];
  envVars?: Record<string, string>;
  /** Files owned by this launch and removed after the client exits. */
  cleanupFiles?: string[];
}

/**
 * 客户端配置接口
 * 所有客户端都需要实现这个接口
 */
export interface ClientConfig {
  /** 客户端 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** npm 包名 */
  package: string;
  /** 可执行命令名 */
  command: string;
  /** 运行时: native=直接执行, bun=用 Tako Bun 运行, node=用 Tako 专属 Node 跑（Pi / Next.js 不能走 bun） */
  runtime?: "native" | "bun" | "node";
  /** 安装方式。默认 npm（bun add）。system = 官方二进制 / PATH，不走 npm。 */
  install?: "npm" | "system";
  /** system 客户端解析真实二进制。返回值可以在 TAKO_DIR 外（如 ~/.grok/bin/grok）。 */
  resolveBin?: () => Promise<string | null>;
  /** system 客户端安装 / 切换版本。version 缺省或 latest 表示官方 latest。 */
  installSystem?: (version?: string) => Promise<{ success: boolean; error?: string }>;
  /** system 客户端读取当前版本号。 */
  readSystemVersion?: () => Promise<string | null>;
  /** 生成环境变量（根据 Provider 上下文） */
  getEnvVars: (provider: ProviderContext) => Record<string, string>;
  /** 生成配置文件（可选），可返回需要附加到客户端命令行的启动参数 */
  setupConfigFiles?: (
    provider: ProviderContext,
    selectedOptionIds?: string[],
    context?: ClientLaunchSetupContext,
  ) => Promise<void | ClientLaunchSetup>;
  /** 接续会话的命令行参数（如 "--continue"） */
  continueArg?: string;
  /** Launch options (toggleable flags). 可以是数组或 lazy 函数 — 后者用于运行时根据
   * 模型目录、当前绑定的服务商等动态数据生成（每次 getClientLaunchOptions 调用时执行）。 */
  launchOptions?: LaunchOption[] | ((provider?: Provider) => LaunchOption[]);
  /** Brand color for TUI display (Ink color name) */
  brandColor?: string;
  /** Hidden clients stay installable/launchable but do not appear as launcher tabs. */
  hidden?: boolean;
}

/**
 * 获取客户端的安装目录
 * 重要：始终返回 Tako 目录下的路径，确保与系统隔离
 */
export function getClientDir(clientId: string): string {
  const dir = join(TOOLS_DIR, clientId);
  // 安全检查：确保路径在 Tako 目录下
  assertPathInTakoDir(dir, "客户端安装目录");
  return dir;
}

/**
 * 从 package.json 中解析实际的入口文件路径
 * 这是跨平台兼容的方式，避免依赖 .bin 目录的符号链接
 */
export async function getClientEntryPath(client: ClientConfig): Promise<string | null> {
  if (client.resolveBin) {
    return client.resolveBin();
  }

  const clientDir = getClientDir(client.id);
  const packageJsonPath = join(clientDir, "node_modules", client.package, "package.json");

  try {
    const file = Bun.file(packageJsonPath);
    if (!(await file.exists())) {
      return null;
    }

    const packageJson = await file.json();
    const binField = packageJson.bin;

    if (!binField) {
      return null;
    }

    // bin 字段可能是字符串或对象
    let entryFile: string | null = null;

    if (typeof binField === "string") {
      // "bin": "cli.js"
      entryFile = binField;
    } else if (typeof binField === "object" && binField[client.command]) {
      // "bin": { "claude": "cli.js" }
      entryFile = binField[client.command];
    }

    if (!entryFile) {
      return null;
    }

    // 构建完整路径
    const fullPath = join(clientDir, "node_modules", client.package, entryFile);

    // 安全检查：确保路径在 Tako 目录下
    assertPathInTakoDir(fullPath, "客户端入口文件");

    return fullPath;
  } catch {
    return null;
  }
}

/**
 * 获取客户端的可执行文件路径
 * 重要：始终返回 Tako 目录下的路径，确保与系统隔离
 *
 * Windows 注意：.bin 下的 .cmd 文件是批处理脚本，不能用 bun 运行
 * 我们返回无扩展名的文件（shell 脚本），bun 可以执行它
 *
 * @deprecated 推荐使用 getClientEntryPath 来获取实际的入口文件
 */
export function getClientBinPath(client: ClientConfig): string {
  const clientDir = getClientDir(client.id);
  // 始终使用无扩展名的文件，bun 可以在所有平台上执行它
  const binPath = join(clientDir, "node_modules", ".bin", client.command);
  // 安全检查：确保路径在 Tako 目录下
  assertPathInTakoDir(binPath, "客户端可执行文件");
  return binPath;
}

/**
 * 获取客户端的完整 launchOptions 列表。
 * 函数式 launchOptions 在此处 invoke。
 */
export function getClientLaunchOptions(client: ClientConfig, provider?: Provider): LaunchOption[] {
  const raw = client.launchOptions;
  return typeof raw === "function" ? raw(provider) : (raw ?? []);
}

/**
 * 所有已注册的客户端
 */
export const clients: Map<string, ClientConfig> = new Map();

/**
 * 注册客户端
 */
export function registerClient(client: ClientConfig): void {
  clients.set(client.id, client);
}

/**
 * 获取所有客户端
 */
export function getAllClients(): ClientConfig[] {
  return Array.from(clients.values()).filter((client) => !client.hidden);
}

/**
 * 获取指定客户端
 */
export function getClient(id: string): ClientConfig | undefined {
  return clients.get(id);
}

export function parsePathLookup(output: string, platform: NodeJS.Platform): string | undefined {
  const candidates = output
    .split("\n")
    .map((line) => line.trim().replace(/\r$/, ""))
    .filter(Boolean);
  if (platform !== "win32") return candidates[0];
  return candidates.find((p) => p.toLowerCase().endsWith(".exe"))
    ?? candidates.find((p) => p.toLowerCase().endsWith(".cmd"))
    ?? candidates[0];
}

export function pathLookupCommand(command: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `where ${command}.exe 2>nul || where ${command}.cmd 2>nul || where ${command}`
    : `which ${command}`;
}

export function buildClientLaunchCommand(
  client: Pick<ClientConfig, "runtime">,
  binPath: string,
  bunPath: string,
  extraArgs: string[] = [],
  platform: NodeJS.Platform = process.platform,
  nodePath?: string,
): string[] {
  let command: string[];
  if (client.runtime === "node") {
    command = [nodePath || "node", binPath];
  } else if (client.runtime === "native") {
    if (platform === "win32" && binPath.toLowerCase().endsWith(".js")) {
      command = [bunPath, binPath];
    } else {
      command = [binPath];
    }
  } else {
    command = [bunPath, binPath];
  }
  return extraArgs.length > 0 ? [...command, ...extraArgs] : command;
}
