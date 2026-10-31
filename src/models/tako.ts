/**
 * Par 服务器模型目录：拉 `/v1/models` 拿到该 par 实例真实暴露的模型列表
 * （比客户端写死的 whitelist 更准确，且支持任意自定义 par 部署）。
 *
 * 结构：按 baseUrl + apiType + 鉴权指纹分桶，磁盘只保存指纹，1h TTL 后台刷新。
 *
 * 关键决策：用 `?client_version=tako-cli` 让 par 走 Codex 形态返回，
 * 这是唯一带 `context_window` 的形态——Codex 客户端的 model_context_window
 * 配置依赖它。再叠加 `?api_type=openai|claude` 过滤客户端能用的子集。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TAKO_DIR } from "../config";
import { getModelEntry, loadCatalog, LOCAL_MODEL_OVERRIDES } from "./catalog";
import type { Provider } from "../providers/types";

export type TakoApiType = "openai" | "claude" | "gemini";

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
  version: 2;
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

function bucketKey(baseUrl: string, apiType: TakoApiType, apiKey: string): string {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  return `${baseUrl.replace(/\/+$/, "")}#${apiType}#${fingerprint}`;
}

function loadDiskOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const snap = JSON.parse(fs.readFileSync(cachePath(), "utf-8")) as DiskSnapshot;
    // 旧缓存没有账号归属，不能跨凭据复用。
    if (snap?.version !== 2 || typeof snap.buckets !== "object") return;
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
    const snap: DiskSnapshot = { version: 2, buckets: Object.fromEntries(memory) };
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
        contextWindow: typeof raw.context_window === "number" && raw.context_window > 0
          ? raw.context_window
          : (LOCAL_MODEL_OVERRIDES[id]?.contextWindow ?? 0),
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

/** Parse only Gemini-native models that advertise generateContent support. */
export function parseGeminiModels(json: unknown): TakoModelEntry[] {
  if (!json || typeof json !== "object" || !Array.isArray((json as { models?: unknown }).models)) return [];
  const out: TakoModelEntry[] = [];
  for (const raw of (json as { models: unknown[] }).models) {
    if (!raw || typeof raw !== "object") continue;
    const model = raw as Record<string, unknown>;
    if (typeof model.name !== "string" || !model.name.startsWith("models/")) continue;
    const id = model.name.slice("models/".length);
    if (!id || id.includes("/")) continue;
    if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent")) continue;
    out.push({
      id,
      displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : id,
      description: typeof model.description === "string" ? model.description : "",
      contextWindow: typeof model.inputTokenLimit === "number" && Number.isFinite(model.inputTokenLimit) && model.inputTokenLimit > 0
        ? model.inputTokenLimit : 0,
      sortOrder: out.length,
      category: "chat",
    });
  }
  return out;
}

/** Read every page from the same Gemini endpoint without persisting keys in URLs. */
async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<TakoModelEntry[] | null> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1beta/models`;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const entries = new Map<string, TakoModelEntry>();
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("pageSize", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const response = await fetch(url, {
      headers: { "x-goog-api-key": apiKey }, signal, redirect: "error",
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    if (!json || typeof json !== "object") return null;
    const data = json as Record<string, unknown>;
    if (data.models !== undefined && !Array.isArray(data.models)) return null;
    for (const entry of parseGeminiModels(json)) entries.set(entry.id, entry);
    if (data.nextPageToken === undefined || data.nextPageToken === "") return [...entries.values()];
    if (typeof data.nextPageToken !== "string" || seen.has(data.nextPageToken)) return null;
    token = data.nextPageToken;
    seen.add(token);
  }
  return null;
}

/**
 * 只保留 chat 模型，把纯生图/视频/音频模型（par model_category=image|video|audio|…）
 * 从 Claude Code / Codex 的模型下拉里剔除。category 缺省（旧 par/旧缓存）按 chat 放行。
 */
export function filterChatModels(entries: TakoModelEntry[]): TakoModelEntry[] {
  return entries.filter((e) => !e.category || e.category === "chat");
}

/**
 * 同步读取当前地址、协议和凭据对应的缓存。
 * 没有凭据或缓存返回 null —— 调用方走自己的 whitelist fallback。
 */
export function getTakoModels(baseUrl: string, apiType: TakoApiType, apiKey?: string): TakoModelEntry[] | null {
  if (!apiKey) return null;
  loadDiskOnce();
  return memory.get(bucketKey(baseUrl, apiType, apiKey))?.entries ?? null;
}

/**
 * 异步刷新一个桶。同地址、协议和凭据的请求合并，不同凭据独立刷新。
 * 失败静默（保留旧数据）。
 */
export async function refreshTakoModels(
  baseUrl: string,
  apiKey: string,
  apiType: TakoApiType,
): Promise<void> {
  if (!apiKey) return;
  loadDiskOnce();
  const key = bucketKey(baseUrl, apiType, apiKey);

  const existing = inflight.get(key);
  if (existing) return existing;

  const job = (async () => {
    try {
      let entries: TakoModelEntry[] | null;
      if (apiType === "gemini") {
        entries = await fetchGeminiModels(baseUrl, apiKey);
      } else {
        const url = baseUrl.replace(/\/+$/, "") + `/v1/models?client_version=tako-cli&api_type=${apiType}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;
        entries = parseCodexResponse(await res.json(), apiType);
      }
      if (!entries || entries.length === 0) return;
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
    const apiTypes: TakoApiType[] = ["openai", "claude"];
    if (!p.supportedClients?.length || p.supportedClients.includes("gemini")) apiTypes.push("gemini");
    for (const apiType of apiTypes) {
      const bucket = memory.get(bucketKey(p.baseUrl, apiType, p.apiKey));
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
