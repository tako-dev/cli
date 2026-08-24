/**
 * 模型目录：内存索引 + 磁盘缓存 + 网络刷新。
 *
 * 启动顺序：
 *   1. loadCatalog() 同步初始化（先磁盘 24h 内 → 否则 bundled）
 *   2. refreshCatalog() 异步刷新（fire-and-forget；失败保留旧数据）
 *
 * 查询：getModelEntry(modelId) — 自动处理 [1m] / :1m 后缀和 provider 前缀。
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelEntry, CatalogSnapshot } from "./types";
import { fetchModelsDev } from "./source";
import { BUNDLED_ENTRIES, BUNDLED_AT } from "./bundled";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Tako 实测：Pi catalog 把 grok-4.6 登记为 500K（changelog/2026-08-17.md）。 */
export const LOCAL_MODEL_OVERRIDES: Record<string, Partial<ModelEntry>> = {
  "grok-4.6": {
    id: "grok-4.6",
    displayName: "Grok 4.6",
    provider: "xai",
    contextWindow: 500000,
    outputLimit: 16384,
  },
};

let cachePathOverride: string | null = null;
function cachePath(): string {
  return cachePathOverride ?? join(homedir(), ".tako", "models-cache.json");
}

/** 仅供测试：覆盖缓存文件路径，传 null 恢复默认 */
export function _setCachePathForTest(p: string | null): void {
  cachePathOverride = p;
}

const memory = new Map<string, ModelEntry>();
let initialized = false;

function rebuildIndex(entries: ModelEntry[]): void {
  memory.clear();
  for (const e of entries) {
    if (!memory.has(e.id)) memory.set(e.id, e);
  }
  for (const [id, override] of Object.entries(LOCAL_MODEL_OVERRIDES)) {
    const current = memory.get(id);
    memory.set(id, {
      id,
      displayName: override.displayName ?? current?.displayName ?? id,
      provider: override.provider ?? current?.provider ?? "xai",
      contextWindow: override.contextWindow ?? current?.contextWindow ?? 0,
      outputLimit: override.outputLimit ?? current?.outputLimit,
    });
  }
}

function readDiskCache(): CatalogSnapshot | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const text = fs.readFileSync(cachePath(), "utf-8");
    const data = JSON.parse(text) as CatalogSnapshot;
    if (typeof data?.fetchedAt !== "number" || !Array.isArray(data?.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeDiskCache(snapshot: CatalogSnapshot): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const path = cachePath();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
    await fs.writeFile(path, JSON.stringify(snapshot), "utf-8");
  } catch {
    // 写不进就算了
  }
}

/**
 * 同步初始化内存目录。
 * 先尝试 24h 内的磁盘缓存；否则用 bundled 快照。
 * 重复调用幂等（init 之后不会重新加载）。
 */
export function loadCatalog(): void {
  if (initialized) return;
  initialized = true;

  const cached = readDiskCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    rebuildIndex(cached.entries);
    return;
  }
  rebuildIndex(BUNDLED_ENTRIES);
}

/**
 * 测试用：重置内存状态。
 */
export function _resetCatalog(): void {
  memory.clear();
  initialized = false;
}

/**
 * 异步从 models.dev 拉新快照。失败静默。
 */
export async function refreshCatalog(): Promise<void> {
  try {
    const entries = await fetchModelsDev();
    if (!entries.length) return;
    rebuildIndex(entries);
    await writeDiskCache({ fetchedAt: Date.now(), entries });
    initialized = true;
  } catch {
    // 网络失败 — 保留现有数据
  }
}

/**
 * 解析 model id：去 [1m] / :1m 后缀，去 provider/ 前缀。
 */
export function normalizeModelId(modelId: string): { lookupId: string; is1m: boolean } {
  const m1 = modelId.match(/^(.+?)(?:\[1m\]|:1m)$/i);
  const stripped = m1 ? m1[1] : modelId;
  const m2 = stripped.match(/^[^\/]+\/(.+)$/);
  return { lookupId: m2 ? m2[1] : stripped, is1m: !!m1 };
}

/**
 * 同步查询单个模型。若内存为空自动 lazy-init。
 * 找不到返回 undefined。
 * `[1m]` 变体在命中后强制覆盖 contextWindow 为 1_000_000。
 */
export function getModelEntry(modelId: string): ModelEntry | undefined {
  if (!initialized) loadCatalog();
  const { lookupId, is1m } = normalizeModelId(modelId);
  const base = memory.get(lookupId);
  if (!base) return undefined;
  if (is1m) return { ...base, contextWindow: 1_000_000 };
  return base;
}

export { BUNDLED_AT };
