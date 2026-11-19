import { join, dirname } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

function getTakoDir(): string {
  return process.env.TAKO_HOME?.trim() || join(homedir(), ".tako");
}

function getTakoCliDir(): string {
  return join(getTakoDir(), "cli");
}

function getTakoBinPath(): string {
  return join(getTakoDir(), "bin", process.platform === "win32" ? "tako.cmd" : "tako");
}

function getClaudeSettingsPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "claude", "settings.json");
  }
  return join(homedir(), ".claude", "settings.json");
}

function getAgySettingsPath(agyHome?: string): string {
  const dir = agyHome?.trim() || process.env.AGY_HOME?.trim() || join(homedir(), ".gemini", "antigravity-cli");
  return join(dir, "settings.json");
}

const isWindows = process.platform === "win32";

// 支持 statusline 功能的最低 Tako 版本
const MIN_STATUSLINE_VERSION = "0.1.48";

/**
 * 比较版本号
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) {
      return numA - numB;
    }
  }
  return 0;
}

/**
 * 获取已安装的 Tako 版本
 */
async function getInstalledTakoVersion(): Promise<string | null> {
  const pkgPath = join(getTakoCliDir(), "node_modules", "tako-cli", "package.json");

  try {
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) return null;

    const pkg = await file.json();
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * 检查已安装的 Tako 版本是否支持 statusline
 */
async function isStatusLineSupported(): Promise<boolean> {
  // 开发模式下（VERSION=dev），直接支持
  if (process.env.VERSION === "dev") {
    return true;
  }

  const version = await getInstalledTakoVersion();
  if (!version) return false;

  return compareVersions(version, MIN_STATUSLINE_VERSION) >= 0;
}

/**
 * 获取 Tako 可执行文件路径（跨平台）
 * 开发模式下使用 bun + 当前入口脚本，生产模式下使用全局安装的 bin
 */
function getTakoExecutablePath(): string {
  if (process.env.VERSION === "dev") {
    return process.argv[1] || getTakoBinPath();
  }
  return getTakoBinPath();
}

/**
 * 将路径转换为命令行友好格式（Windows 需要处理反斜杠）
 */
function toCommandPath(filePath: string): string {
  if (isWindows) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

/**
 * 构建 statusline 命令（dev 模式需要 bun 前缀）
 */
export function buildStatusLineCommand(): string {
  if (process.env.VERSION === "dev") {
    const entryPath = process.argv[1];
    if (entryPath) {
      return `bun "${toCommandPath(entryPath)}" statusline`;
    }
  }
  const takoPath = toCommandPath(getTakoExecutablePath());
  return `"${takoPath}" statusline`;
}

export function buildAgyStatusLineConfig(): {
  type: "command";
  command: string;
  stack_with_default: true;
} {
  return {
    type: "command",
    command: buildStatusLineCommand(),
    stack_with_default: true,
  };
}

/**
 * 仅当命令指向 Tako 自己的 statusline（`[.../]tako[.cmd|.exe|.bat] statusline`，
 * 或与当前环境 buildStatusLineCommand() 产物完全相等）才判定为 Tako 自有。
 * 此前用 includes("statusline") 判别会把任何提及 statusline 的用户自定义
 * 命令误当自有配置，导致注入覆盖 / 移除误删。
 */
export function isTakoStatusLineCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (trimmed === buildStatusLineCommand().trim()) return true;
  return /(?:^|[\s"'/\\])tako(?:\.(?:cmd|exe|bat))?["']?\s+statusline(?:\s|$)/.test(trimmed);
}

/**
 * 判断 settings 对象中是否已有非 Tako 的用户自定义 statusLine。
 */
export function hasCustomNonTakoStatusLine(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const sl = (settings as Record<string, unknown>).statusLine;
  if (!sl) return false;
  if (typeof sl === "string") return !isTakoStatusLineCommand(sl);
  if (typeof sl === "object" && !Array.isArray(sl)) {
    const cmd = (sl as Record<string, unknown>).command;
    if (typeof cmd === "string") return !isTakoStatusLineCommand(cmd);
    return Object.keys(sl).length > 0;
  }
  return false;
}

/**
 * 注入状态栏配置到 Antigravity (agy) 的 settings.json
 * 若用户已配置非 Tako 自定义 statusLine，绝不覆盖。
 */
export async function injectAgyStatusLineConfig(agyHome?: string): Promise<void> {
  const explicitHome = agyHome?.trim() || process.env.AGY_HOME?.trim();
  if (!explicitHome && !(await isStatusLineSupported())) {
    return;
  }

  const settingsPath = getAgySettingsPath(agyHome);
  let settings: Record<string, unknown> = {};
  try {
    const file = Bun.file(settingsPath);
    if (await file.exists()) {
      const parsed = await file.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 文件不存在或解析失败，使用空对象
  }

  if (hasCustomNonTakoStatusLine(settings)) {
    return;
  }

  const desired = buildAgyStatusLineConfig();
  const current = settings.statusLine;
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    (current as Record<string, unknown>).type === desired.type &&
    (current as Record<string, unknown>).command === desired.command &&
    (current as Record<string, unknown>).stack_with_default === desired.stack_with_default
  ) {
    return;
  }

  settings.statusLine = desired;
  await mkdir(dirname(settingsPath), { recursive: true });
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * 移除 Antigravity (agy) 中由 Tako 注入的 statusLine（不影响用户的自定义非 Tako statusLine）
 */
export async function removeAgyStatusLineConfig(agyHome?: string): Promise<void> {
  const settingsPath = getAgySettingsPath(agyHome);
  try {
    const file = Bun.file(settingsPath);
    if (!(await file.exists())) return;

    const parsed = await file.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const settings = parsed as Record<string, unknown>;

    const currentCommand =
      typeof settings.statusLine === "object" && settings.statusLine !== null
        ? (settings.statusLine as Record<string, unknown>).command
        : null;

    if (isTakoStatusLineCommand(currentCommand)) {
      delete settings.statusLine;
      await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    // 静默失败
  }
}

/**
 * 注入状态栏配置到 Claude Code（并顺带同步 agy）的 settings.json
 *
 * 注意：只修改 statusLine 字段，保留用户其他配置
 * 只有当已安装的 Tako 版本支持 statusline 时才注入
 */
export async function injectStatusLineConfig(): Promise<void> {
  const supported = await isStatusLineSupported();
  if (!supported) {
    return;
  }

  await injectAgyStatusLineConfig().catch(() => {});

  const settingsPath = getClaudeSettingsPath();

  let settings: Record<string, unknown> = {};
  try {
    const file = Bun.file(settingsPath);
    if (await file.exists()) {
      settings = await file.json();
    }
  } catch {
    // 文件不存在或解析失败，使用空对象
  }

  const takoStatusLine = {
    type: "command",
    command: buildStatusLineCommand(),
    padding: 0,
  };

  const currentCommand =
    typeof settings.statusLine === "object" && settings.statusLine !== null
      ? (settings.statusLine as Record<string, unknown>).command
      : null;

  if (isTakoStatusLineCommand(currentCommand)) {
    return;
  }

  settings.statusLine = takoStatusLine;
  await mkdir(dirname(settingsPath), { recursive: true });
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * 移除状态栏配置（用户禁用时调用）
 *
 * 只移除 Tako 注入的配置，不影响用户手动配置的其他 statusLine
 */
export async function removeStatusLineConfig(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();

  try {
    const file = Bun.file(settingsPath);
    if (!(await file.exists())) return;

    const settings: Record<string, unknown> = await file.json();

    const currentCommand =
      typeof settings.statusLine === "object" && settings.statusLine !== null
        ? (settings.statusLine as Record<string, unknown>).command
        : null;

    if (isTakoStatusLineCommand(currentCommand)) {
      delete settings.statusLine;
      await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    // 静默失败
  }
}
