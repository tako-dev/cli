/**
 * 官方用量 dispatcher：按 provider.type 路由到对应 fetcher。
 *
 * 双层缓存：
 *   - 内存（Map）：同进程内 60s 复用，最便宜
 *   - 磁盘（~/.tako/quota-cache.json）：跨进程 60s 复用，主要给 statusline
 *     用 — Claude Code 每次刷状态栏都 spawn 一个新进程，纯内存缓存无效。
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../providers/types";
import type { OfficialQuota } from "./types";
import { fetchTakoQuota, fetchTakoQuotaByApiId } from "./tako";
import { fetchClaudeSubscriptionQuota } from "./claude-subscription";
import { fetchCodexSubscriptionQuota } from "./codex-subscription";

export type { OfficialQuota, QuotaSlot, QuotaStatus } from "./types";
export { fetchTakoQuotaByApiId };

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, OfficialQuota>();

function cacheKey(provider: Provider): string {
  const authFingerprint = provider.type === "tako" && provider.apiKey
    ? createHash("sha256").update(provider.apiKey).digest("hex").slice(0, 12)
    : "";
  return `${provider.type}:${provider.id}${authFingerprint ? `:${authFingerprint}` : ""}`;
}

let diskCachePathOverride: string | null = null;
function diskCachePath(): string {
  return diskCachePathOverride ?? join(homedir(), ".tako", "quota-cache.json");
}

/** 仅供测试：覆盖磁盘缓存路径，传 null 恢复默认 */
export function _setQuotaDiskCachePathForTest(p: string | null): void {
  diskCachePathOverride = p;
}

function readDiskCache(): Record<string, OfficialQuota> {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const text = fs.readFileSync(diskCachePath(), "utf-8");
    const data = JSON.parse(text);
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

function writeDiskCache(map: Record<string, OfficialQuota>): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = diskCachePath();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    // 简单 atomic write：先写 tmp 再 rename
    const tmp = `${path}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, path);
  } catch {
    // 写不进就算了
  }
}

function unsupported(provider: Provider): OfficialQuota {
  return {
    provider: provider.type,
    status: "unsupported",
    fetchedAt: Date.now(),
  };
}

/**
 * 获取 provider 的官方用量。结果在 60 秒内缓存（内存 + 磁盘）。
 *
 * - tako                  → Tako 代理后端
 * - claude-subscription   → Anthropic OAuth /api/oauth/usage
 * - codex-subscription    → ChatGPT backend-api/wham/usage
 * - 其他类型              → 返回 unsupported（UI 不展示）
 */
export async function getOfficialQuota(provider: Provider): Promise<OfficialQuota> {
  const key = cacheKey(provider);
  const now = Date.now();

  // 1. 内存缓存
  const mem = cache.get(key);
  if (mem && now - mem.fetchedAt < CACHE_TTL_MS) return mem;

  // 2. 磁盘缓存（跨进程；statusline 用）
  const disk = readDiskCache();
  const diskHit = disk[key];
  if (diskHit && now - diskHit.fetchedAt < CACHE_TTL_MS) {
    cache.set(key, diskHit);
    return diskHit;
  }

  // 3. 网络
  let result: OfficialQuota;
  switch (provider.type) {
    case "tako":
      result = await fetchTakoQuota(provider);
      break;
    case "claude-subscription":
      result = await fetchClaudeSubscriptionQuota(provider);
      break;
    case "codex-subscription":
      result = await fetchCodexSubscriptionQuota(provider);
      break;
    default:
      result = unsupported(provider);
      break;
  }

  cache.set(key, result);
  // 只缓存"可用"和"明确错误"结果；unsupported 也缓存（避免重复 dispatch）
  disk[key] = result;
  writeDiskCache(disk);
  return result;
}

/**
 * 测试用：清空内存缓存
 */
export function _clearQuotaCache(): void {
  cache.clear();
}

function keyMatchesProviderId(key: string, providerId: string): boolean {
  return key.split(":")[1] === providerId;
}

/**
 * 失效一个 provider 的所有缓存（内存 + 磁盘）。
 * 在 provider authData 更新后调用，避免重新登录后还看到旧的 unauthorized 错误。
 */
export function invalidateQuotaCache(providerId: string, providerType?: string): void {
  // 内存
  for (const k of [...cache.keys()]) {
    if (keyMatchesProviderId(k, providerId)) cache.delete(k);
  }
  // 磁盘
  try {
    const disk = readDiskCache();
    let changed = false;
    for (const k of Object.keys(disk)) {
      if (keyMatchesProviderId(k, providerId)) {
        delete disk[k];
        changed = true;
      }
    }
    if (changed) writeDiskCache(disk);
  } catch { /* ignore */ }
  void providerType; // 当前用 id 即可去重，type 留作扩展
}
