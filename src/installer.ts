import { join } from "path";
import { log, createSpinner } from "./logger";
import { confirmPrompt } from "./ui/shared/terminal";
import { ClientConfig, getClientDir } from "./clients/base";
import { loadConfig, updateConfig, TAKO_DIR, TAKO_BUN_DIR, TAKO_BUN_BIN, TAKO_BUN_CACHE_DIR } from "./config";
import { getNpmRegistry, getBunInstallCommand, detectRegion, showRegionInfo, getBunMirrorDownloadUrl } from "./region";
import { track } from "./analytics";
import { streamBunInstall } from "./bun-progress";
import { summarizeInstallError } from "./error-format";

// Tako 专属 Bun 路径（完全隔离，不使用系统 Bun）
// 重要：永远不要使用系统 Bun，只使用 Tako 专属的
let bunPath: string | null = null;

// PTY 功能需要的最低 Bun 版本
const MINIMUM_BUN_VERSION_FOR_PTY = "1.3.5";

/**
 * 验证路径是否在 Tako 目录下（安全检查）
 */
function isPathInTakoDir(path: string): boolean {
  return path.startsWith(TAKO_BUN_DIR);
}

/**
 * 构造 tako 安装 client 包时的 bun env。
 * INV-INST-02：注入独立 BUN_INSTALL_CACHE_DIR，与全局 ~/.bun/install/cache 隔离，
 * 避免全局 bun 操作（卸载 / bun pm cache rm）波及 tako 隔离目录的 node_modules。
 */
export function buildBunInstallEnv(registry: string): Record<string, string> {
  return {
    ...process.env,
    BUN_CONFIG_REGISTRY: registry,
    BUN_INSTALL_CACHE_DIR: TAKO_BUN_CACHE_DIR,
  };
}

/**
 * 比较版本号
 * 返回: -1 (a < b), 0 (a == b), 1 (a > b)
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * 获取 Tako 专属 Bun 的版本
 */
async function getTakoBunVersion(): Promise<string | null> {
  try {
    const file = Bun.file(TAKO_BUN_BIN);
    if (!(await file.exists())) return null;

    const proc = Bun.spawn([TAKO_BUN_BIN, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    if (proc.exitCode !== 0) return null;

    const version = (await new Response(proc.stdout).text()).trim();
    return version;
  } catch {
    return null;
  }
}

/**
 * 检查 Tako 专属 Bun 是否已安装
 * 注意：只检查 Tako 目录，永远不检查系统 Bun
 */
async function isTakoBunInstalled(): Promise<boolean> {
  const version = await getTakoBunVersion();
  return version !== null;
}

/**
 * 检查并安装系统依赖
 */
async function ensureSystemDeps(): Promise<boolean> {
  // Windows 不需要 unzip（PowerShell 内置解压功能）
  if (process.platform === "win32") {
    return true;
  }

  // Unix: 检查 unzip 是否存在
  try {
    const proc = Bun.spawn(["which", "unzip"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    if (proc.exitCode === 0) return true;
  } catch {}

  log.warn("正在安装系统依赖 (unzip)...");

  // 尝试安装 unzip
  const installCmds = [
    "apt-get update -qq && apt-get install -y -qq unzip",
    "yum install -y -q unzip",
    "dnf install -y -q unzip",
    "pacman -S --noconfirm unzip",
    "apk add --quiet unzip",
  ];

  for (const cmd of installCmds) {
    try {
      const proc = Bun.spawn(["bash", "-c", `sudo ${cmd} 2>/dev/null || ${cmd}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode === 0) return true;
    } catch {}
  }

  return false;
}

/**
 * 从 npmmirror 直接下载安装 Bun（国内专用，跨平台）
 */
async function installBunFromMirror(targetDir: string): Promise<boolean> {
  const fs = await import("fs/promises");
  const { join } = await import("path");

  const isWindows = process.platform === "win32";
  const bunName = isWindows ? "bun.exe" : "bun";

  const downloadUrl = await getBunMirrorDownloadUrl();
  log.info(`从 npmmirror 下载: ${downloadUrl}`);

  // 下载 zip
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`下载失败: ${response.status}`);

  const zipPath = join(targetDir, "bun-download.zip");
  await Bun.write(zipPath, response);

  // 解压
  const binDir = join(targetDir, "bin");
  await fs.mkdir(binDir, { recursive: true });

  if (isWindows) {
    // Windows: 用 PowerShell 解压
    const psCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${targetDir}" -Force`;
    const proc = Bun.spawn(["powershell", "-Command", psCmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error("解压失败");
  } else {
    // Unix: 用 unzip
    const proc = Bun.spawn(["unzip", "-oq", zipPath, "-d", targetDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error("解压失败");
  }

  // 找到解压后的 bun 二进制并移动到 bin/
  const entries = await fs.readdir(targetDir);
  for (const entry of entries) {
    const entryPath = join(targetDir, entry);
    const stat = await fs.stat(entryPath);
    if (stat.isDirectory() && entry.startsWith("bun-")) {
      const bunBinary = join(entryPath, bunName);
      try {
        await fs.access(bunBinary);
        await fs.rename(bunBinary, join(binDir, bunName));
        if (!isWindows) {
          await fs.chmod(join(binDir, bunName), 0o755);
        }
        await fs.rm(entryPath, { recursive: true, force: true });
        break;
      } catch {}
    }
  }

  // 清理 zip
  await fs.rm(zipPath, { force: true });

  return true;
}

/**
 * 自动安装 Bun
 */
async function installBun(): Promise<boolean> {
  const s = createSpinner();

  // 先确保系统依赖
  if (!(await ensureSystemDeps())) {
    log.error("请先手动安装 unzip: apt install unzip / yum install unzip");
    return false;
  }

  // 显示地区信息
  await showRegionInfo();

  s.start("正在安装 Tako 专属 Bun 运行时...");

  try {
    // 确保 Tako Bun 目录存在
    const fs = await import("fs/promises");
    await fs.mkdir(TAKO_BUN_DIR, { recursive: true });

    const region = await detectRegion();

    if (region === "cn") {
      // 国内用户：直接从 npmmirror 下载，不经过 bun.sh/GitHub（全平台统一）
      await installBunFromMirror(TAKO_BUN_DIR);
    } else if (process.platform === "win32") {
      // 海外 Windows：使用 PowerShell 官方脚本
      const psCmd = `$env:BUN_INSTALL="${TAKO_BUN_DIR}"; irm bun.sh/install.ps1 | iex`;
      const proc = Bun.spawn(["powershell", "-Command", psCmd], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) {
        s.stop("Bun 安装失败");
        return false;
      }
    } else {
      // 海外 Unix：使用官方安装脚本
      const installCmd = `BUN_INSTALL="${TAKO_BUN_DIR}" ${getBunInstallCommand()}`;
      const proc = Bun.spawn(["bash", "-c", installCmd], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) {
        s.stop("Bun 安装失败");
        return false;
      }
    }

    // 设置 bun 路径为 Tako 专属路径
    bunPath = TAKO_BUN_BIN;

    s.stop("Tako 专属 Bun 安装完成");
    log.info(`安装位置: ${TAKO_BUN_DIR}`);
    return true;
  } catch (error) {
    s.stop("Bun 安装失败");
    return false;
  }
}

/**
 * 升级 Tako 专属 Bun 到最新版本
 */
async function upgradeBun(): Promise<boolean> {
  const s = createSpinner();
  s.start("正在升级 Tako 专属 Bun 运行时...");

  try {
    const fs = await import("fs/promises");

    // 删除旧版本
    try {
      await fs.rm(TAKO_BUN_DIR, { recursive: true, force: true });
    } catch {
      // 忽略删除失败
    }

    // 重新安装
    await fs.mkdir(TAKO_BUN_DIR, { recursive: true });

    const region = await detectRegion();

    if (region === "cn") {
      // 国内：直接从 npmmirror 下载（全平台统一）
      await installBunFromMirror(TAKO_BUN_DIR);
    } else if (process.platform === "win32") {
      const psCmd = `$env:BUN_INSTALL="${TAKO_BUN_DIR}"; irm bun.sh/install.ps1 | iex`;
      const proc = Bun.spawn(["powershell", "-Command", psCmd], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) {
        s.stop("Bun 升级失败");
        return false;
      }
    } else {
      const installCmd = `BUN_INSTALL="${TAKO_BUN_DIR}" ${getBunInstallCommand()}`;
      const proc = Bun.spawn(["bash", "-c", installCmd], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) {
        s.stop("Bun 升级失败");
        return false;
      }
    }

    bunPath = TAKO_BUN_BIN;
    s.stop("Tako 专属 Bun 升级完成");

    const newVersion = await getTakoBunVersion();
    if (newVersion) {
      log.info(`新版本: ${newVersion}`);
    }

    return true;
  } catch (error) {
    s.stop("Bun 升级失败");
    return false;
  }
}

/**
 * 确保 Tako 专属 Bun 已安装
 */
export async function ensureBunInstalled(): Promise<boolean> {
  if (await isTakoBunInstalled()) {
    bunPath = TAKO_BUN_BIN;
    return true;
  }

  log.warn("未检测到 Tako 专属 Bun，正在自动安装...");
  log.info("（不会影响您系统中已安装的 Node.js 或 Bun）");
  return await installBun();
}

/**
 * 确保 Tako Bun 版本支持 PTY 功能（远程模式需要）
 * 如果版本过低，自动升级到最新版本
 * 注意：Windows 不支持 PTY，使用 pipe fallback，跳过版本检查
 */
export async function ensureBunVersionForPTY(): Promise<boolean> {
  // 先确保已安装
  if (!(await ensureBunInstalled())) {
    return false;
  }

  // Windows 不支持 PTY，使用 pipe fallback，跳过版本检查
  if (process.platform === "win32") {
    return true;
  }

  const currentVersion = await getTakoBunVersion();
  if (!currentVersion) {
    log.error("无法获取 Tako Bun 版本");
    return false;
  }

  // 检查版本是否满足要求
  if (compareVersions(currentVersion, MINIMUM_BUN_VERSION_FOR_PTY) >= 0) {
    return true;
  }

  // 版本过低，需要升级
  log.warn(`当前 Tako Bun 版本 (${currentVersion}) 不支持远程模式`);
  log.info(`需要升级到 ${MINIMUM_BUN_VERSION_FOR_PTY} 或更高版本...`);

  return await upgradeBun();
}

/**
 * 获取 Tako 专属 Bun 路径
 * 重要：只返回 Tako 目录下的 Bun，绝不使用系统 Bun
 */
export async function getBunPath(): Promise<string> {
  // 如果已缓存，验证后返回
  if (bunPath) {
    // 安全检查：确保缓存的路径在 Tako 目录下
    if (!isPathInTakoDir(bunPath)) {
      bunPath = TAKO_BUN_BIN; // 强制重置为 Tako 路径
    }
    return bunPath;
  }

  // 检查 Tako 专属 Bun 是否已安装
  if (await isTakoBunInstalled()) {
    bunPath = TAKO_BUN_BIN;
    return TAKO_BUN_BIN;
  }

  // 未安装时返回 Tako 专属路径（调用方应先调用 ensureBunInstalled）
  return TAKO_BUN_BIN;
}

/**
 * 获取 npm 包的最新版本
 */
async function getLatestVersion(packageName: string): Promise<string | null> {
  try {
    const registry = await getNpmRegistry();
    const response = await fetch(
      `${registry}/${packageName}/latest`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.version;
  } catch {
    return null;
  }
}

/**
 * 获取本地安装的版本
 */
async function getLocalVersion(client: ClientConfig): Promise<string | null> {
  const config = await loadConfig();
  return config.installedClients[client.id]?.version || null;
}

/**
 * 判断一个 client 安装目录是否真正装好了包（纯函数，便于测试）。
 *
 * INV-INST-01：判定"已安装"必须看真正的包入口
 *   node_modules/<package>/package.json，而不是 tako 自己在 bun add 之前
 *   写的占位 <clientDir>/package.json。
 *
 * 背景（2026-06-15 事故）：旧实现只检查占位 package.json 是否存在。但
 * installClient 在 `bun add` 之前就先落盘了占位 package.json（含 name/private/
 * dependencies）。一旦更新流程"先删 node_modules 再 bun add"中途失败，就会留下
 * "有壳无实"状态——占位文件在、node_modules 没了。旧实现据此误判为"已安装"，
 * 导致永不重装，并在启动时 fallback 到全局安装（codex/claude-code 同时中招）。
 *
 * @param clientDir 客户端安装目录（~/.tako/tools/<id>）
 * @param packageName npm 包名（如 @openai/codex）
 */
export async function isPackageInstalledAt(
  clientDir: string,
  packageName: string,
): Promise<boolean> {
  const pkgEntryPath = join(clientDir, "node_modules", packageName, "package.json");
  try {
    return await Bun.file(pkgEntryPath).exists();
  } catch {
    return false;
  }
}

/**
 * 检查客户端是否已安装
 */
export async function isClientInstalled(client: ClientConfig): Promise<boolean> {
  const clientDir = getClientDir(client.id);
  return isPackageInstalledAt(clientDir, client.package);
}

/**
 * 检查是否需要更新
 */
export async function needsUpdate(client: ClientConfig): Promise<boolean> {
  const localVersion = await getLocalVersion(client);
  if (!localVersion) return true;

  const latestVersion = await getLatestVersion(client.package);
  if (!latestVersion) return false;

  return localVersion !== latestVersion;
}

/**
 * 检测当前平台对应的 optional dependency 包名
 * 用于 Claude Code 等使用平台原生二进制的包
 */
function detectPlatformOptionalDep(
  optionalDeps: Record<string, string>
): { pkg: string; version: string } | null {
  const platform = process.platform; // darwin, linux, win32
  const architecture = process.arch;   // arm64, x64

  // 匹配规则：包名以 -{platform}-{arch} 结尾
  const suffix = `${platform}-${architecture}`;
  for (const [pkg, version] of Object.entries(optionalDeps)) {
    if (pkg.endsWith(suffix)) {
      return { pkg, version };
    }
  }
  return null;
}

/**
 * 确保平台对应的 optional dependency 已安装
 * Bun 不会自动安装 optionalDependencies，需要显式安装
 */
async function ensurePlatformDep(
  client: ClientConfig,
  clientDir: string,
  bunPath: string,
  registry: string
): Promise<void> {
  const packageJsonPath = join(clientDir, "node_modules", client.package, "package.json");
  try {
    const file = Bun.file(packageJsonPath);
    if (!(await file.exists())) return;

    const packageJson = await file.json();
    const optDeps = packageJson.optionalDependencies;
    if (!optDeps || typeof optDeps !== "object") return;

    const dep = detectPlatformOptionalDep(optDeps);
    if (!dep) return;

    // 检查平台包的二进制是否真正存在（不只看 package.json，Bun 可能装了目录但没提取二进制）
    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? `${client.command}.exe` : client.command;
    const depPkgPath = join(clientDir, "node_modules", dep.pkg, "package.json");
    let depVersionMatches = false;
    try {
      const depPkgFile = Bun.file(depPkgPath);
      if (await depPkgFile.exists()) {
        const depPkgJson = await depPkgFile.json();
        depVersionMatches = depPkgJson.version === dep.version;
      }
    } catch {
      depVersionMatches = false;
    }

    const depBinPath = join(clientDir, "node_modules", dep.pkg, binaryName);
    const depBinFile = Bun.file(depBinPath);
    if (depVersionMatches && await depBinFile.exists() && depBinFile.size > 1024) return;

    // 未安装，显式安装平台包
    log.info(`正在安装平台包 ${dep.pkg}...`);

    // 先尝试精确版本，失败则降级为 @latest（镜像源可能未同步特定版本）
    for (const version of [dep.version, "latest"]) {
      const proc = Bun.spawn(
        [bunPath, "add", `${dep.pkg}@${version}`],
        {
          cwd: clientDir,
          stdout: "pipe",
          stderr: "pipe",
          env: buildBunInstallEnv(registry),
        }
      );
      const output = await streamBunInstall(proc, `正在安装平台包 ${dep.pkg}`, () => {});
      const exitCode = await proc.exited;
      if (exitCode === 0) break;
      if (version === "latest") {
        log.warn(`平台包安装失败: ${output.slice(0, 200)}`);
      }
    }
  } catch (e) {
    log.warn(`平台包检查异常: ${e instanceof Error ? e.message : "未知错误"}`);
  }
}

/**
 * 直接从 npm registry 下载平台原生二进制并放置到目标位置
 * 不依赖 bun add（bun 可能不完整提取 200MB 大二进制），直接下载 tarball 解压
 */
async function placeNativeBinary(client: ClientConfig, clientDir: string): Promise<boolean> {
  const fs = await import("fs/promises");

  const packageJsonPath = join(clientDir, "node_modules", client.package, "package.json");
  try {
    const pkgFile = Bun.file(packageJsonPath);
    if (!(await pkgFile.exists())) return false;

    const packageJson = await pkgFile.json();
    const optDeps = packageJson.optionalDependencies;
    if (!optDeps) return true;

    const dep = detectPlatformOptionalDep(optDeps);
    if (!dep) { log.warn(`未找到匹配的平台包 (${process.platform}-${process.arch})`); return false; }

    // 目标路径
    const binField = packageJson.bin;
    const entryFile = typeof binField === "string" ? binField : binField?.[client.command];
    if (!entryFile) return false;
    const destPath = join(clientDir, "node_modules", client.package, entryFile);
    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? `${client.command}.exe` : client.command;

    // 先尝试从已安装的平台包复制（如果 bun 已正确安装）
    const srcPath = join(clientDir, "node_modules", dep.pkg, binaryName);
    const srcFile = Bun.file(srcPath);
    if (await srcFile.exists() && srcFile.size > 1024) {
      await Bun.write(destPath, srcFile);
      if (!isWindows) await fs.chmod(destPath, 0o755);
      return true;
    }

    // bun 没有正确提取二进制
    // 方案 A：用 Tako Bun 运行 install.cjs（不依赖系统 node）
    const postinstallScript = join(clientDir, "node_modules", client.package, "install.cjs");
    if (await Bun.file(postinstallScript).exists()) {
      log.info("正在通过 postinstall 安装原生二进制...");
      const bunPath = await getBunPath();
      const proc = Bun.spawn([bunPath, postinstallScript], {
        cwd: join(clientDir, "node_modules", client.package),
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await streamBunInstall(proc, "正在通过 postinstall 安装原生二进制", () => {});
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log.warn(`postinstall 失败: ${output.slice(0, 200)}`);
      }
      // 检查是否成功
      const destFile = Bun.file(destPath);
      if (await destFile.exists() && destFile.size > 1024) {
        if (!isWindows) await fs.chmod(destPath, 0o755);
        return true;
      }
    }

    // 方案 B：用 curl | tar 流式下载并提取二进制（不依赖 Bun fetch 处理大文件）
    log.info("正在从 registry 下载原生二进制...");
    const registry = await getNpmRegistry();
    for (const ver of [dep.version, "latest"]) {
      try {
        const metaRes = await fetch(`${registry}/${dep.pkg}/${ver}`);
        if (!metaRes.ok) continue;
        const meta = await metaRes.json() as any;
        const tarballUrl = meta.dist?.tarball;
        if (!tarballUrl) continue;

        // 1. 用 curl 下载 tarball 到临时文件
        const tmpDir = join(TAKO_DIR, ".tmp-extract-" + Date.now());
        await fs.mkdir(tmpDir, { recursive: true });
        const tgzPath = join(tmpDir, "pkg.tgz");

        const dlProc = Bun.spawn(
          ["curl", "-fsSL", "-o", tgzPath, tarballUrl],
          { stdout: "pipe", stderr: "pipe" }
        );
        await dlProc.exited;

        if (dlProc.exitCode !== 0) {
          const dlErr = await new Response(dlProc.stderr).text();
          log.warn(`curl 下载失败: ${dlErr.slice(0, 200)}`);
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          continue;
        }

        const tgzSize = Bun.file(tgzPath).size;
        if (tgzSize < 1024) {
          log.warn(`下载文件异常 (${tgzSize} bytes, url: ${tarballUrl.slice(0, 100)})`);
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          continue;
        }

        // 2. 用 tar 只提取二进制文件
        const tarProc = Bun.spawn(
          ["tar", "xzf", tgzPath, "-C", tmpDir, `package/${binaryName}`],
          { stdout: "pipe", stderr: "pipe" }
        );
        await tarProc.exited;

        const extractedBin = join(tmpDir, "package", binaryName);
        const extractedFile = Bun.file(extractedBin);
        if (await extractedFile.exists() && extractedFile.size > 1024) {
          await Bun.write(destPath, extractedFile);
          if (!isWindows) await fs.chmod(destPath, 0o755);
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          return true;
        }

        // 提取失败
        const tarErr = await new Response(tarProc.stderr).text();
        log.warn(`tar 提取失败 (tgz=${tgzSize} bytes, exit=${tarProc.exitCode}): ${tarErr.slice(0, 200)}`);
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      } catch (e) {
        log.warn(`下载失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
    }

    // 方案 C：所有 registry 都失败，尝试 npmjs.org 直连
    if (registry !== "https://registry.npmjs.org") {
      try {
        const npmjsUrl = `https://registry.npmjs.org/${dep.pkg}/-/${dep.pkg.split("/").pop()}-${dep.version}.tgz`;
        log.info("正在从 npmjs.org 直连下载...");
        const tmpDir = join(TAKO_DIR, ".tmp-extract-" + Date.now());
        await fs.mkdir(tmpDir, { recursive: true });
        const tgzPath = join(tmpDir, "pkg.tgz");

        const dlProc = Bun.spawn(["curl", "-fsSL", "-o", tgzPath, npmjsUrl], { stdout: "pipe", stderr: "pipe" });
        await dlProc.exited;

        if (dlProc.exitCode === 0 && Bun.file(tgzPath).size > 1024) {
          const tarProc = Bun.spawn(["tar", "xzf", tgzPath, "-C", tmpDir, `package/${binaryName}`], { stdout: "pipe", stderr: "pipe" });
          await tarProc.exited;
          const extractedFile = Bun.file(join(tmpDir, "package", binaryName));
          if (await extractedFile.exists() && extractedFile.size > 1024) {
            await Bun.write(destPath, extractedFile);
            if (!isWindows) await fs.chmod(destPath, 0o755);
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            return true;
          }
        }
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      } catch { /* final fallback failed */ }
    }

    return false;
  } catch (e) {
    log.warn(`安装原生二进制失败: ${e instanceof Error ? e.message : "未知错误"}`);
    return false;
  }
}


/**
 * 安装或更新客户端
 */
export async function installClient(
  client: ClientConfig,
  forceUpdate = false
): Promise<{ success: boolean; error?: string; skippedUpdate?: boolean }> {
  const s = createSpinner();
  const clientDir = getClientDir(client.id);

  try {
    // 确保 Bun 已安装
    if (!(await ensureBunInstalled())) {
      return { success: false, error: "Tako 专属 Bun 安装失败，请检查网络或手动删除 ~/.tako/bun 目录后重试" };
    }
    const isInstalled = await isClientInstalled(client);
    const shouldUpdate = forceUpdate || (await needsUpdate(client));

    if (isInstalled && !shouldUpdate) {
      return { success: true };
    }

    const action = isInstalled ? "更新" : "安装";
    const prefix = `正在${action} ${client.name}`;
    s.start(prefix);

    // 确保目录存在
    const fs = await import("fs/promises");
    await fs.mkdir(clientDir, { recursive: true });

    // 初始化 package.json（如果不存在）
    const packageJsonPath = join(clientDir, "package.json");
    const packageJsonFile = Bun.file(packageJsonPath);
    if (!(await packageJsonFile.exists())) {
      await Bun.write(
        packageJsonPath,
        JSON.stringify(
          {
            name: `tako-${client.id}`,
            private: true,
            dependencies: {},
          },
          null,
          2
        )
      );
    }

    // 获取 bun 路径
    const bun = await getBunPath();

    // 根据地区选择 npm registry
    const registry = await getNpmRegistry();
    const region = await detectRegion();
    log.info(`网络环境: ${region === "cn" ? "国内（npmmirror）" : "海外"} | registry: ${registry}`);

    // 更新时只删 lockfile（强制 bun 重解析以拿到 optional deps 新版本），
    // 保留 node_modules。
    // INV-INST-03：更新过程不破坏现有可用安装——bun add 会原地更新 node_modules，
    // 即使失败旧版本仍在，避免"先删后装失败"留下半残状态（2026-06-15 事故缺陷 B）。
    if (isInstalled) {
      const lockfilePath = join(clientDir, "bun.lock");
      await fs.rm(lockfilePath, { force: true }).catch(() => {});
    }

    // 使用 bun 安装包（指定 @latest 确保获取最新版本）
    const proc = Bun.spawn(
      [bun, "add", `${client.package}@latest`],
      {
        cwd: clientDir,
        stdout: "pipe",
        stderr: "pipe",
        env: buildBunInstallEnv(registry),
      }
    );

    // 流式解析 bun 输出，按阶段更新 spinner 文案
    const output = await streamBunInstall(proc, prefix, (msg) => s.update(msg));
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      s.stop();
      // INV-INST-03：失败不留半残状态。
      // - 全新安装失败：清掉刚写的占位 package.json，让目录回到"未初始化"。
      // - 更新失败：保留 node_modules（已保留，未删），旧版本仍可用。
      if (!isInstalled) {
        await fs.rm(packageJsonPath, { force: true }).catch(() => {});
      }
      return { success: false, error: summarizeInstallError(output) };
    }

    // 确保平台原生二进制就位（Bun 不自动安装 optionalDependencies）
    await ensurePlatformDep(client, clientDir, bun, registry);
    await placeNativeBinary(client, clientDir);

    // 获取安装的版本并保存到配置
    const latestVersion = await getLatestVersion(client.package);
    const previousVersion = (await loadConfig()).installedClients[client.id]?.version;

    if (latestVersion) {
      const config = await loadConfig();
      config.installedClients[client.id] = {
        version: latestVersion,
        installedAt: new Date().toISOString(),
      };
      await updateConfig(config);

      // 埋点：区分安装和更新
      if (isInstalled && previousVersion) {
        track("client_updated", {
          client_id: client.id,
          from_version: previousVersion,
          to_version: latestVersion,
        });
      } else {
        track("client_installed", {
          client_id: client.id,
          client_version: latestVersion,
        });
      }
    }

    s.stop(`${client.name} ${action}完成`);
    return { success: true };
  } catch (error) {
    s.stop();
    return {
      success: false,
      error: summarizeInstallError(error instanceof Error ? error.message : undefined),
    };
  }
}

/**
 * 检查文件是否为 stub（shell 脚本占位符）而非真正的原生二进制
 * 原生二进制的头部是 ELF (Linux)、MZ (Windows PE) 或 Mach-O (macOS)，不会以文本开头
 */
async function isStubBinary(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return true; // 文件不存在也视为需要修复

    const size = file.size;
    if (size < 100) return true; // 太小不可能是原生二进制

    // 读取头部字节判断文件类型
    const headerBytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());

    // ELF: 0x7F 'E' 'L' 'F'
    if (headerBytes[0] === 0x7f && headerBytes[1] === 0x45 && headerBytes[2] === 0x4c && headerBytes[3] === 0x46) return false;
    // Mach-O: 0xFEEDFACE, 0xFEEDFACF, 0xCFFAEDFE, 0xCEFAEDFE
    if (headerBytes[0] === 0xfe || headerBytes[0] === 0xcf || headerBytes[0] === 0xce || headerBytes[0] === 0xca) return false;
    // Windows PE: 'M' 'Z'
    if (headerBytes[0] === 0x4d && headerBytes[1] === 0x5a) return false;

    // 其他情况视为 stub（文本文件）
    return true;
  } catch {
    return true;
  }
}

/**
 * 确保客户端的原生二进制已就位
 * 解决 Bun 不运行 postinstall + 不安装 optionalDependencies 的问题
 */
export async function ensureNativeBinary(
  client: ClientConfig,
  options: { reinstallOnFailure?: boolean; forcePlace?: boolean } = {},
): Promise<void> {
  if (client.runtime !== "native") return;
  const reinstallOnFailure = options.reinstallOnFailure ?? true;
  const forcePlace = options.forcePlace ?? false;

  const clientDir = getClientDir(client.id);
  const packageJsonPath = join(clientDir, "node_modules", client.package, "package.json");

  try {
    const file = Bun.file(packageJsonPath);
    if (!(await file.exists())) return;

    const packageJson = await file.json();
    const binField = packageJson.bin;
    if (!binField) return;

    const entryFile = typeof binField === "string"
      ? binField
      : binField[client.command];
    if (!entryFile) return;

    const binPath = join(clientDir, "node_modules", client.package, entryFile);

    // 用二进制头部检测是否为真正的原生二进制。指定版本安装会强制重放置，
    // 避免 package.json 已切到新版本但旧 claude.exe 仍留在 bin 里。
    if (!forcePlace && !(await isStubBinary(binPath))) return;

    // 是 stub，需要修复：先确保平台包已安装，再直接复制二进制
    log.info("正在安装原生二进制...");

    const bun = await getBunPath();
    const registry = await getNpmRegistry();
    await ensurePlatformDep(client, clientDir, bun, registry);
    const placed = await placeNativeBinary(client, clientDir);

    if (!placed || await isStubBinary(binPath)) {
      if (!reinstallOnFailure) {
        log.warn("原生二进制修复失败");
        return;
      }
      // 修复失败，删掉整个工具目录强制重装
      log.warn("原生二进制修复失败，正在重新安装...");
      const fs = await import("fs/promises");
      await fs.rm(clientDir, { recursive: true, force: true });
      const result = await installClient(client);
      if (result.success) {
        // 重装后再次确认二进制就位
        await placeNativeBinary(client, clientDir);
        if (await isStubBinary(binPath)) {
          log.warn("重新安装后仍无法安装原生二进制");
        } else {
          log.success("重新安装完成");
        }
      }
    } else {
      log.success("原生二进制安装完成");
    }
  } catch {
    // 静默失败
  }
}

/**
 * 确保客户端已安装并是最新版本
 */
export async function ensureClientReady(
  client: ClientConfig
): Promise<{ success: boolean; error?: string; skippedUpdate?: boolean }> {
  const isInstalled = await isClientInstalled(client);

  if (!isInstalled) {
    // 未安装，需要安装
    const result = await installClient(client);
    if (result.success) {
      await ensureNativeBinary(client);
    }
    return result;
  }

  // 确保原生二进制就位（修复已安装但 postinstall 未运行的情况）
  await ensureNativeBinary(client);

  // 已安装，检查更新
  const shouldUpdate = await needsUpdate(client);
  if (shouldUpdate) {
    const latestVersion = await getLatestVersion(client.package);
    const localVersion = (await loadConfig()).installedClients[client.id]?.version || "未知";
    const versionInfo = latestVersion
      ? `${localVersion} → ${latestVersion}`
      : "有新版本可用";

    log.info(`${client.name} 发现更新: ${versionInfo}`);

    // 一天只弹一次更新确认
    if (await wasUpdateDismissedToday(client.id)) {
      log.info("今日已跳过更新，使用当前版本");
      return { success: true };
    }

    const shouldDoUpdate = await confirmPrompt({
      message: `是否更新 ${client.name}？`,
      defaultValue: false,
    });

    if (!shouldDoUpdate) {
      await recordUpdateDismissed(client.id);
      log.info("跳过更新，使用当前版本");
      return { success: true };
    }

    const result = await installClient(client, true);
    if (result.success) {
      await ensureNativeBinary(client);
      return result;
    }
    log.warn(`更新 ${client.name} 失败：${result.error ?? "未知错误"}`);
    log.info("继续使用当前已安装版本");
    return { success: true, skippedUpdate: true, error: result.error };
  }

  return { success: true };
}

// ─── 更新弹窗节流（一天一次）───────────────────────────

const UPDATE_DISMISS_FILE = join(TAKO_DIR, ".update-dismissed.json");

async function wasUpdateDismissedToday(clientId: string): Promise<boolean> {
  try {
    const file = Bun.file(UPDATE_DISMISS_FILE);
    if (!(await file.exists())) return false;
    const data = await file.json() as Record<string, string>;
    const dismissedAt = data[clientId];
    if (!dismissedAt) return false;
    const today = new Date().toISOString().slice(0, 10);
    return dismissedAt === today;
  } catch {
    return false;
  }
}

async function recordUpdateDismissed(clientId: string): Promise<void> {
  try {
    let data: Record<string, string> = {};
    const file = Bun.file(UPDATE_DISMISS_FILE);
    if (await file.exists()) {
      try { data = await file.json(); } catch { /* reset */ }
    }
    data[clientId] = new Date().toISOString().slice(0, 10);
    await Bun.write(UPDATE_DISMISS_FILE, JSON.stringify(data));
  } catch { /* ignore */ }
}
