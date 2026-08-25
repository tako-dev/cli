/**
 * 客户端历史版本管理
 *
 * 提供两个能力：
 *   - listAvailableVersions(pkg): 列出 npm registry 上的所有版本
 *   - installAtVersion(client, version): 安装指定版本到 TOOLS_DIR/<client>
 *
 * 不依赖 installer.ts 内部细节，只复用最低层的 bun + registry 配置。
 */
import { join } from "node:path";
import type { ClientConfig } from "./clients/base";
import { getClientDir } from "./clients/base";
import { loadConfig, updateConfig } from "./config";
import {
  buildBunInstallEnv,
  ensureBunInstalled,
  ensureNativeBinary,
  getBunPath,
} from "./installer";
import { getNpmRegistry, detectRegion } from "./region";
import { streamBunInstall } from "./bun-progress";
import { createSpinner, log } from "./logger";

export interface VersionInfo {
  version: string;
  publishedAt?: string;
  isCurrent: boolean;
}

interface RegistryResponse {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
}

/**
 * 从 npm registry 拉取某 package 的所有发布版本，按发布时间倒序。
 * 失败抛错，调用方自己 try/catch。
 */
export async function listAvailableVersions(packageName: string): Promise<VersionInfo[]> {
  const registry = await getNpmRegistry();
  const url = `${registry}/${encodeURIComponent(packageName).replace("%40", "@")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`registry http ${res.status}`);
  const data = (await res.json()) as RegistryResponse;

  const versions = Object.keys(data.versions ?? {});
  if (!versions.length) throw new Error("no versions found");

  const time = data.time ?? {};
  const out: VersionInfo[] = versions.map((v) => ({
    version: v,
    publishedAt: time[v],
    isCurrent: false,
  }));

  // 按发布时间倒序
  out.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  return out;
}

/**
 * 在 TOOLS_DIR/<client> 下安装指定版本。
 * 流程：
 *   1. mkdir -p TOOLS_DIR/<client>
 *   2. 写入 package.json（如果不存在）
 *   3. bun add <package>@<version>
 *   4. 更新 ~/.tako/config.json 的 installedClients[client.id]
 */
export async function installAtVersion(client: ClientConfig, version: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const clientDir = getClientDir(client.id);

  if (!(await ensureBunInstalled())) {
    throw new Error("Tako 专属 Bun 安装失败，请检查网络或手动删除 ~/.tako/bun 目录后重试");
  }

  await fs.mkdir(clientDir, { recursive: true });

  // 清理 lockfile 让 Bun 重新解析依赖；保留 node_modules，避免更新失败后旧版本也不可用。
  const lockPath = join(clientDir, "bun.lock");
  await fs.rm(lockPath, { force: true }).catch(() => {});

  // 写 package.json
  const pkgPath = join(clientDir, "package.json");
  await Bun.write(pkgPath, JSON.stringify({ name: `tako-${client.id}-host`, version: "0.0.0", private: true }, null, 2));

  const registry = await getNpmRegistry();
  const region = await detectRegion();
  log.info(`网络环境: ${region === "cn" ? "国内" : "海外"} | registry: ${registry}`);
  const bun = await getBunPath();
  const proc = Bun.spawn([bun, "add", `${client.package}@${version}`], {
    cwd: clientDir,
    stdout: "pipe",
    stderr: "pipe",
    env: buildBunInstallEnv(registry),
  });

  const s = createSpinner();
  const prefix = `正在切换 ${client.name} 到 ${version}`;
  s.start(prefix);
  const output = await streamBunInstall(proc, prefix, (msg) => s.update(msg));
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    s.stop();
    throw new Error(`bun add ${client.package}@${version} failed: ${output.slice(0, 500).trim()}`);
  }

  await ensureNativeBinary(client, { reinstallOnFailure: false, forcePlace: true });
  s.stop(`${client.name} 已切换到 ${version}`);

  // 持久化记录
  const config = await loadConfig();
  await updateConfig({
    installedClients: {
      ...config.installedClients,
      [client.id]: { version, installedAt: new Date().toISOString() },
    },
  });
}

/**
 * 获取本地当前安装的版本（从配置读）。
 */
export async function getInstalledVersion(client: ClientConfig): Promise<string | null> {
  // 优先读实际 node_modules 里的版本（真实安装状态）
  const clientDir = getClientDir(client.id);
  const pkgPath = join(clientDir, "node_modules", client.package, "package.json");
  try {
    const file = Bun.file(pkgPath);
    if (await file.exists()) {
      const pkg = await file.json();
      if (pkg.version) return pkg.version;
    }
  } catch { /* fallback to config */ }
  // 回退到 config 记录
  const config = await loadConfig();
  return config.installedClients[client.id]?.version ?? null;
}
