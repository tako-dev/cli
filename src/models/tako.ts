/**
 * Par 服务器模型目录：拉 `/v1/models` 拿到该 par 实例真实暴露的模型列表
 * （比客户端写死的 whitelist 更准确，且支持任意自定义 par 部署）。
 *
 * 结构：内存索引（按 baseUrl + apiType 分桶）+ 磁盘缓存 + 1h TTL 后台刷新。
 *
 * 关键决策：用 `?client_version=tako-cli` 让 par 走 Codex 形态返回，
 * 这是唯一带 `context_window` 的形态——Codex 客户端的 model_context_window
 * 配置依赖它。再叠加 `?api_type=openai|claude` 过滤客户端能用的子集。
 */
import { join } from "node:path";
import { TAKO_DIR } from "../config";
import { getModelEntry, loadCatalog } from "./catalog";
import type { Provider } from "../providers/types";

export type TakoApiType = "openai" | "claude";

export interface TakoModelEntry {
  id: string;
  displayName: string;
  description: string;
  contextWindow: number;
  sortOrder: number;
  /**
   * 模型类别，来自 par 的 model_category 字段：'chat' | 'image' | 'video' | 'audio' | …
   * 缺省（旧 par / 旧缓存）按 'chat' 处理。非 chat 的是纯生图/视频/音频模型，
   * 不能在 Claude Code / Codex 里跑 chat，由 filterChatModels 在 UI 层过滤掉。
   */
  category: string;
}

interface CacheBucket {
  fetchedAt: number;
  entries: TakoModelEntry[];
}

interface DiskSnapshot {
  version: 1;
  buckets: Record<string, CacheBucket>;
}

const REFRESH_TTL_MS = 60 * 60 * 1000; // 1h
const FETCH_TIMEOUT_MS = 8_000;

let cachePathOverride: string | null = null;
function cachePath(): string {
  return cachePathOverride ?? join(TAKO_DIR, "tako-models-cache.json");
}
export function _setCachePathForTest(p: string | null): void {
  cachePathOverride = p;
}

const memory = new Map<string, CacheBucket>();
let diskLoaded = false;
const inflight = new Map<string, Promise<void>>();

function bucketKey(baseUrl: string, apiType: TakoApiType): string {
  return `${baseUrl.replace(/\/+$/, "")}#${apiType}`;
}

function loadDiskOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const snap = JSON.parse(fs.readFileSync(cachePath(), "utf-8")) as DiskSnapshot;
    if (snap?.version !== 1 || typeof snap.buckets !== "object") return;
    for (const [k, v] of Object.entries(snap.buckets)) {
      if (typeof v?.fetchedAt === "number" && Array.isArray(v.entries)) {
        memory.set(k, v);
      }
    }
  } catch {
    // no cache yet
  }
}

async function writeDisk(): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const path = cachePath();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const snap: DiskSnapshot = { version: 1, buckets: Object.fromEntries(memory) };
    await fs.writeFile(path, JSON.stringify(snap), "utf-8");
  } catch {
    // 写不进就算了
  }
}

interface CodexModelDTO {
  slug?: string;
  display_name?: string;
  description?: string;
  context_window?: number | null;
  priority?: number;
  model_category?: string;
}

export function parseCodexResponse(json: unknown, apiType?: TakoApiType): TakoModelEntry[] {
  const arr = (json as { models?: unknown })?.models;
  if (Array.isArray(arr)) {
    const out: TakoModelEntry[] = [];
    for (const raw of arr as CodexModelDTO[]) {
      const id = raw?.slug;
      if (typeof id !== "string" || !id) continue;
      out.push({
        id,
        displayName: raw.display_name || id,
        description: raw.description || "",
        contextWindow: typeof raw.context_window === "number" ? raw.context_window : 0,
        sortOrder: typeof raw.priority === "number" ? raw.priority : 0,
        category: typeof raw.model_category === "string" && raw.model_category
          ? raw.model_category
          : "chat",
      });
    }
    out.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return out;
  }
  return parseOpenAIResponse(json, apiType ?? "openai");
}

interface OpenAIModelDTO {
  id?: string;
  object?: string;
  owned_by?: string;
  supported_endpoint_types?: string[];
}

/**
 * new-api (Tako 后端) 标准 OpenAI 形态 /v1/models 响应。
 * 没有 context_window —— 从 bundled catalog 按 id 查补；
 * 没有 model_category —— 按模型名前缀推断生图/视频类模型；
 * supported_endpoint_types 用来过滤 apiType 客户端能用的子集。
 */
function parseOpenAIResponse(json: unknown, apiType: TakoApiType): TakoModelEntry[] {
  const arr = (json as { data?: unknown })?.data;
  if (!Array.isArray(arr)) return [];
  const want = apiType === "claude" ? "anthropic" : "openai";
  const out: TakoModelEntry[] = [];
  for (const raw of arr as OpenAIModelDTO[]) {
    const id = raw?.id;
    if (typeof id !== "string" || !id) continue;
    const endpoints = raw.supported_endpoint_types;
    if (Array.isArray(endpoints) && endpoints.length > 0 && !endpoints.includes(want)) {
      continue;
    }
    const meta = getModelEntry(id);
    out.push({
      id,
      displayName: meta?.displayName || id,
      description: "",
      contextWindow: meta?.contextWindow ?? 0,
      sortOrder: 0,
      category: /^gpt-image|^grok-imagine|-image($|-)|-video($|-)|-tts($|-)|-audio($|-)/i.test(id)
        ? "image"
        : "chat",
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * 只保留 chat 模型，把纯生图/视频/音频模型（par model_category=image|video|audio|…）
 * 从 Claude Code / Codex 的模型下拉里剔除。category 缺省（旧 par/旧缓存）按 chat 放行。
 */
export function filterChatModels(entries: TakoModelEntry[]): TakoModelEntry[] {
  return entries.filter((e) => !e.category || e.category === "chat");
}

/**
 * 同步读取一个 (baseUrl, apiType) 桶的当前缓存。
 * 没有缓存返回 null —— 调用方走自己的 whitelist fallback。
 */
export function getTakoModels(baseUrl: string, apiType: TakoApiType): TakoModelEntry[] | null {
  loadDiskOnce();
  return memory.get(bucketKey(baseUrl, apiType))?.entries ?? null;
}

/**
 * 异步刷新一个桶。同时只跑一份相同 (baseUrl, apiType) 的请求。
 * 失败静默（保留旧数据）。
 */
export async function refreshTakoModels(
  baseUrl: string,
  apiKey: string,
  apiType: TakoApiType,
): Promise<void> {
  loadDiskOnce();
  const key = bucketKey(baseUrl, apiType);

  const existing = inflight.get(key);
  if (existing) return existing;

  const job = (async () => {
    try {
      const url =
        baseUrl.replace(/\/+$/, "") +
        `/v1/models?client_version=tako-cli&api_type=${apiType}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const json = await res.json();
      const entries = parseCodexResponse(json, apiType);
      if (entries.length === 0) return;
      memory.set(key, { fetchedAt: Date.now(), entries });
      await writeDisk();
    } catch {
      // 网络/解析失败 — 保留旧缓存
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

/**
 * 扫描 providers 里所有 tako/custom 项，按需刷新。
 * 仅对超过 TTL 的桶发请求；启动时调用一次即可。
 *
 * 返回的 Promise 只 await 冷桶（从未拉过的）——这样首次启动能保证 LauncherView
 * 渲染时能拿到 par 服务端真实模型；热桶（有数据只是 >1h 过期）继续后台刷新，
 * 不阻塞 UI（用户先看到旧数据，下次启动反映新数据）。
 */
export function refreshAllTakoCatalogs(providers: Provider[]): Promise<void> {
  loadDiskOnce();
  const now = Date.now();
  const coldJobs: Promise<void>[] = [];
  for (const p of providers) {
    if (p.type !== "tako" && p.type !== "custom") continue;
    if (!p.apiKey || !p.baseUrl) continue;
    for (const apiType of ["openai", "claude"] as TakoApiType[]) {
      const bucket = memory.get(bucketKey(p.baseUrl, apiType));
      if (bucket && now - bucket.fetchedAt < REFRESH_TTL_MS) continue;
      const job = refreshTakoModels(p.baseUrl, p.apiKey, apiType);
      if (!bucket) coldJobs.push(job);
    }
  }
  return Promise.all(coldJobs).then(() => undefined);
}

/** 测试用 */
export function _resetTakoCatalog(): void {
  memory.clear();
  diskLoaded = false;
  inflight.clear();
}
