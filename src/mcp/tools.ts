import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { PROXY_BASE_URL, type TakoConfig } from "../config";
import type { Provider } from "../providers/types";

export const TAKO_DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image" as const;

export const TAKO_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;

const VALID_ASPECT_RATIO_SET = new Set<string>(TAKO_IMAGE_ASPECT_RATIOS);

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentItem[];
  isError?: boolean;
}

export interface McpToolDeps {
  fetch?: typeof fetch;
  cwd?: string;
  env?: Record<string, string | undefined>;
  takoHome?: string;
  now?: () => Date;
}

export interface TakoMcpCredentials {
  baseUrl: string;
  apiKey: string;
}

export const TAKO_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "tako_generate_image",
    description:
      "Generate or edit an image using Tako's Gemini image model (default: gemini-3.1-flash-image) and save it to disk. Use this tool whenever the user asks to generate, draw, illustrate, or edit an image, especially in gateway mode where built-in image generation is unavailable.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Detailed prompt describing the image to generate or edit.",
        },
        output_path: {
          type: "string",
          description:
            "Optional file path where the generated image will be saved (defaults to <cwd>/tako-image-<YYYYMMDD-HHMMSS>.<ext>).",
        },
        aspect_ratio: {
          type: "string",
          enum: [...TAKO_IMAGE_ASPECT_RATIOS],
          description: "Optional aspect ratio for the generated image.",
        },
        model: {
          type: "string",
          description: `Optional Gemini image model ID (default: ${TAKO_DEFAULT_IMAGE_MODEL}).`,
        },
        input_image_path: {
          type: "string",
          description: "Optional local file path of an input image to edit or use as reference.",
        },
      },
    },
  },
  {
    name: "tako_web_search",
    description:
      "Search the live web via Tako /v1/search and return ranked web results with titles, URLs, and snippets. Use this tool when you need current online information or live web search.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of results to return (1-20, default: 5).",
        },
        provider: {
          type: "string",
          description: "Optional search provider override.",
        },
      },
    },
  },
];

function errorResult(message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message.startsWith("Error:") ? message : `Error: ${message}` }],
  };
}

/**
 * 规范化 Tako MCP 网关基址：去尾部 `/` 以及 `/v1`、`/v1beta`，便于安全拼接 `/v1beta/...` 与 `/v1/search`。
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
 *   （主 apiKey 严格优先于 agyApiKey，因为生图与搜索渠道挂在主 Tako 分组上）
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

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  return ".jpg";
}

function detectImageMimeType(filePath: string, bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function truncateText(text: string, maxLen = 500): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}

export async function executeTakoGenerateImage(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return errorResult("'prompt' is required and must be a non-empty string.");
  }

  const rawModel = typeof args?.model === "string" ? args.model.trim() : "";
  const model = (rawModel ? rawModel.replace(/^models\//i, "") : TAKO_DEFAULT_IMAGE_MODEL).trim();
  if (!model || /[\\/]/.test(model)) {
    return errorResult(`Invalid model ID "${rawModel}".`);
  }

  let aspectRatio: string | undefined;
  if (args?.aspect_ratio !== undefined && args.aspect_ratio !== null && args.aspect_ratio !== "") {
    if (typeof args.aspect_ratio !== "string" || !VALID_ASPECT_RATIO_SET.has(args.aspect_ratio.trim())) {
      return errorResult(
        `Invalid aspect_ratio "${String(args.aspect_ratio)}". Supported values: ${TAKO_IMAGE_ASPECT_RATIOS.join(", ")}.`,
      );
    }
    aspectRatio = args.aspect_ratio.trim();
  }

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) {
    return errorResult("Tako API key is not configured. Set TAKO_MCP_API_KEY or configure ~/.tako/config.json.");
  }
  if (!creds.baseUrl) {
    return errorResult("Tako base URL is not configured.");
  }

  const cwd = deps?.cwd || process.cwd();
  const parts: Array<Record<string, unknown>> = [];

  if (args?.input_image_path !== undefined && args.input_image_path !== null && args.input_image_path !== "") {
    if (typeof args.input_image_path !== "string" || !args.input_image_path.trim()) {
      return errorResult("'input_image_path' must be a non-empty file path string.");
    }
    const resolvedInputPath = resolve(cwd, args.input_image_path.trim());
    try {
      const inputBytes = await readFile(resolvedInputPath);
      if (inputBytes.length === 0) {
        return errorResult(`Input image file is empty: ${resolvedInputPath}`);
      }
      parts.push({
        inlineData: {
          mimeType: detectImageMimeType(resolvedInputPath, inputBytes),
          data: inputBytes.toString("base64"),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to read input_image_path "${resolvedInputPath}": ${reason}`);
    }
  }

  parts.push({ text: prompt });

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  if (aspectRatio) {
    generationConfig.imageConfig = { aspectRatio };
  }

  const url = `${creds.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const fetchFn = deps?.fetch ?? globalThis.fetch;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": creds.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Request to Tako image API failed: ${reason}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return errorResult(
      `Tako image API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to parse Tako image API JSON response: ${reason}`);
  }

  const candidates =
    payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).candidates)
      ? ((payload as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
      : [];

  const firstParts = Array.isArray((candidates[0]?.content as Record<string, unknown> | undefined)?.parts)
    ? ((candidates[0].content as Record<string, unknown>).parts as Array<Record<string, unknown>>)
    : [];

  let imageData = "";
  let mimeType = "image/jpeg";
  const captions: string[] = [];

  for (const part of firstParts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) {
      captions.push(part.text.trim());
    }
    if (!imageData) {
      const inline = (part.inlineData ?? part.inline_data) as Record<string, unknown> | undefined;
      if (inline && typeof inline === "object" && typeof inline.data === "string" && inline.data.trim()) {
        imageData = inline.data.trim();
        const rawMime = inline.mimeType ?? inline.mime_type;
        if (typeof rawMime === "string" && rawMime.trim()) {
          mimeType = rawMime.trim();
        }
      }
    }
  }

  if (!imageData) {
    const detail = captions.length > 0 ? ` Model response: ${truncateText(captions.join(" "))}` : "";
    return errorResult(`No image data returned by model "${model}".${detail}`);
  }

  const ext = extensionForMimeType(mimeType);
  const rawOutputPath = typeof args?.output_path === "string" ? args.output_path.trim() : "";
  const now = deps?.now ? deps.now() : new Date();
  const outputPath = rawOutputPath
    ? resolve(cwd, rawOutputPath)
    : join(cwd, `tako-image-${formatTimestamp(now)}${ext}`);

  const imageBytes = Buffer.from(imageData, "base64");
  if (imageBytes.length === 0) {
    return errorResult("Decoded image data is empty.");
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, imageBytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to write generated image to "${outputPath}": ${reason}`);
  }

  const summaryLines = [
    `Image saved to: ${outputPath}`,
    `Model: ${model}`,
    `MIME type: ${mimeType}`,
    `Size: ${imageBytes.length} bytes`,
  ];
  if (captions.length > 0) {
    summaryLines.push(`Caption: ${captions.join("\n")}`);
  }

  return {
    content: [
      { type: "text", text: summaryLines.join("\n") },
      { type: "image", data: imageData, mimeType },
    ],
  };
}

export async function executeTakoWebSearch(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorResult("'query' is required and must be a non-empty string.");
  }

  let count = 5;
  if (typeof args?.count === "number" && Number.isFinite(args.count)) {
    count = Math.max(1, Math.min(20, Math.floor(args.count)));
  }

  const provider = typeof args?.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined;

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) {
    return errorResult("Tako API key is not configured. Set TAKO_MCP_API_KEY or configure ~/.tako/config.json.");
  }
  if (!creds.baseUrl) {
    return errorResult("Tako base URL is not configured.");
  }

  const url = `${creds.baseUrl}/v1/search`;
  const fetchFn = deps?.fetch ?? globalThis.fetch;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        query,
        count,
        ...(provider ? { provider } : {}),
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Request to Tako search API failed: ${reason}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return errorResult(
      `Tako search API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to parse Tako search API JSON response: ${reason}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResult("Tako search API returned an unexpected response payload.");
  }

  const data = payload as {
    query?: unknown;
    provider?: unknown;
    results?: unknown;
  };

  const resultQuery = typeof data.query === "string" && data.query.trim() ? data.query.trim() : query;
  const resultProvider = typeof data.provider === "string" && data.provider.trim() ? data.provider.trim() : undefined;
  const results = Array.isArray(data.results) ? data.results : [];

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: `No web search results found for "${resultQuery}".` }],
    };
  }

  const header = resultProvider
    ? `Web search results for "${resultQuery}" (provider: ${resultProvider}):`
    : `Web search results for "${resultQuery}":`;

  const formatted = results.map((entry, index) => {
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "(untitled)";
    const itemUrl = typeof item.url === "string" ? item.url.trim() : "";
    const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
    const lines = [`${index + 1}. ${title}`];
    if (itemUrl) lines.push(`   URL: ${itemUrl}`);
    if (snippet) lines.push(`   ${snippet}`);
    return lines.join("\n");
  });

  return {
    content: [{ type: "text", text: `${header}\n\n${formatted.join("\n\n")}` }],
  };
}
