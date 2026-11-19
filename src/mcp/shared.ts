import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { PROXY_BASE_URL, type TakoConfig } from "../config";
import type { Provider } from "../providers/types";
import type { McpToolDeps, McpToolResult, TakoMcpCredentials } from "./schemas";

export function errorResult(message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message.startsWith("Error:") ? message : `Error: ${message}` }],
  };
}

export function truncateText(text: string, maxLen = 500): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 规范化 Tako MCP 网关基址：去尾部 `/` 以及 `/v1`、`/v1beta`，便于安全拼接 `/v1/*` 与 `/v1beta/*`。
 */
export function normalizeTakoMcpBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(/\/v1(?:beta)?$/i, "").replace(/\/+$/, "");
}

async function readTakoConfigFromHome(takoHome: string): Promise<Partial<TakoConfig> | null> {
  try {
    const raw = await readFile(join(takoHome, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<TakoConfig>;
    }
  } catch {
    // Missing or unreadable config.json is handled via env / defaults.
  }
  return null;
}

function pickActiveTakoProvider(config: Partial<TakoConfig> | null): Provider | undefined {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const takoProviders = providers.filter((p): p is Provider => Boolean(p && p.type === "tako"));
  if (takoProviders.length === 0) return undefined;

  const agyMappedId = config?.clientProviderMap?.agy;
  if (agyMappedId) {
    const mapped = takoProviders.find((p) => p.id === agyMappedId);
    if (mapped) return mapped;
  }

  if (config?.defaultProviderId) {
    const def = takoProviders.find((p) => p.id === config.defaultProviderId);
    if (def) return def;
  }

  return takoProviders.find((p) => p.apiKey?.trim()) ?? takoProviders[0];
}

/**
 * 动态解析 Tako MCP 凭据（每次调用按 TAKO_HOME 读取，支持测试隔离）：
 * - baseUrl: env.TAKO_MCP_BASE_URL > active Tako provider baseUrl > env.PROXY_BASE_URL > PROXY_BASE_URL
 * - apiKey:  env.TAKO_MCP_API_KEY > active Tako provider apiKey > config.apiKey > env.TAKO_API_KEY > provider agyApiKey > config.agyApiKey
 *   （主 apiKey 严格优先于 agyApiKey，因为生图/视频/语音/搜索挂在主 Tako 分组上）
 */
export async function resolveTakoMcpCredentials(opts?: {
  env?: Record<string, string | undefined>;
  takoHome?: string;
}): Promise<TakoMcpCredentials> {
  const env = opts?.env ?? process.env;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const takoHome = opts?.takoHome?.trim() || env.TAKO_HOME?.trim() || join(home, ".tako");

  const config = await readTakoConfigFromHome(takoHome);
  const activeProvider = pickActiveTakoProvider(config);

  const rawBaseUrl =
    env.TAKO_MCP_BASE_URL?.trim() ||
    activeProvider?.baseUrl?.trim() ||
    env.PROXY_BASE_URL?.trim() ||
    PROXY_BASE_URL;

  const apiKey =
    env.TAKO_MCP_API_KEY?.trim() ||
    activeProvider?.apiKey?.trim() ||
    config?.apiKey?.trim() ||
    env.TAKO_API_KEY?.trim() ||
    activeProvider?.agyApiKey?.trim() ||
    config?.agyApiKey?.trim() ||
    "";

  return {
    baseUrl: normalizeTakoMcpBaseUrl(rawBaseUrl),
    apiKey,
  };
}

export function resolveHomeDirFromDeps(deps?: McpToolDeps): string {
  const env = deps?.env ?? process.env;
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

export function resolveUserPath(rawPath: string, deps?: McpToolDeps): string {
  const trimmed = rawPath.trim();
  const cwd = deps?.cwd || process.cwd();
  if (trimmed === "~") return resolveHomeDirFromDeps(deps);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(resolveHomeDirFromDeps(deps), trimmed.slice(2));
  }
  return resolve(cwd, trimmed);
}

export function resolveOutputFilePath(
  rawOutputPath: unknown,
  prefix: string,
  extWithDot: string,
  deps?: McpToolDeps,
): string {
  const trimmed = typeof rawOutputPath === "string" ? rawOutputPath.trim() : "";
  if (trimmed) return resolveUserPath(trimmed, deps);
  const cwd = deps?.cwd || process.cwd();
  const now = deps?.now ? deps.now() : new Date();
  const normalizedExt = extWithDot.startsWith(".") ? extWithDot : `.${extWithDot}`;
  return join(cwd, `${prefix}-${formatTimestamp(now)}${normalizedExt}`);
}

export function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  return ".jpg";
}

export function detectImageFormatFromBytes(bytes: Uint8Array): { ext: string; mimeType: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: ".png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: ".jpg", mimeType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: ".webp", mimeType: "image/webp" };
  }
  return null;
}

export function detectImageMimeType(filePath: string, bytes: Uint8Array): string {
  const fromHeader = detectImageFormatFromBytes(bytes);
  if (fromHeader) return fromHeader.mimeType;
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
  ) {
    return "image/gif";
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

export function detectAudioMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "audio/wav";
}

export function isValidMp4Bytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

export async function writeOutputFileAtomic(outputPath: string, bytes: Uint8Array): Promise<void> {
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, outputPath);
}

/**
 * Authenticated Tako gateway fetch with redirects blocked so bearer/API keys cannot leak on 3xx.
 */
export async function fetchApiNoRedirect(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetchFn(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refused unexpected HTTP ${res.status} redirect from authenticated endpoint`);
  }
  return res;
}

/**
 * Download CDN media URL without sending any Tako API credentials.
 */
export async function fetchCdnBytes(fetchFn: typeof fetch, cdnUrl: string): Promise<Buffer> {
  const res = await fetchFn(cdnUrl, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Media CDN returned HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
