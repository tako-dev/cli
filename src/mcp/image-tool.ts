import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  TAKO_DEFAULT_IMAGE_MODEL,
  TAKO_IMAGE_ASPECT_RATIOS,
  type McpToolDeps,
  type McpToolResult,
} from "./schemas";
import {
  detectImageFormatFromBytes,
  detectImageMimeType,
  errorResult,
  extensionForMimeType,
  fetchApiNoRedirect,
  fetchCdnBytes,
  resolveOutputFilePath,
  resolveTakoMcpCredentials,
  resolveUserPath,
  truncateText,
  writeOutputFileAtomic,
} from "./shared";

const VALID_ASPECT_RATIO_SET = new Set<string>(TAKO_IMAGE_ASPECT_RATIOS);

type ImageRequestMode = "gemini-native" | "json-generation" | "multipart-edit" | "json-edits";

function aspectRatioForGemini(aspectRatio?: string, size?: string): string | undefined {
  if (aspectRatio) return aspectRatio;
  switch (size) {
    case "1024x1024":
      return "1:1";
    case "1536x1024":
      return "3:2";
    case "1024x1536":
      return "2:3";
    case "1792x1024":
      return "16:9";
    case "1024x1792":
      return "9:16";
    default:
      return undefined;
  }
}

function sizeForOpenAiImage(size?: string, aspectRatio?: string): string | undefined {
  if (size && size !== "auto") return size;
  switch (aspectRatio) {
    case "16:9":
      return "1792x1024";
    case "9:16":
      return "1024x1792";
    case "3:2":
    case "4:3":
      return "1536x1024";
    case "2:3":
    case "3:4":
      return "1024x1536";
    case "1:1":
      return "1024x1024";
    default:
      return undefined;
  }
}

function collectReferenceImages(args: Record<string, unknown>, deps?: McpToolDeps): { paths: string[]; error?: string } {
  const collected: string[] = [];
  const seen = new Set<string>();

  if (args.input_image_path !== undefined && args.input_image_path !== null && args.input_image_path !== "") {
    if (typeof args.input_image_path !== "string" || !args.input_image_path.trim()) {
      return { paths: [], error: "'input_image_path' must be a non-empty file path string." };
    }
    const resolvedPath = resolveUserPath(args.input_image_path, deps);
    if (!seen.has(resolvedPath)) {
      seen.add(resolvedPath);
      collected.push(resolvedPath);
    }
  }

  if (args.input_image_paths !== undefined && args.input_image_paths !== null) {
    if (!Array.isArray(args.input_image_paths)) {
      return { paths: [], error: "'input_image_paths' must be an array of file path strings." };
    }
    for (const item of args.input_image_paths) {
      if (typeof item !== "string" || !item.trim()) continue;
      const resolvedPath = resolveUserPath(item, deps);
      if (!seen.has(resolvedPath)) {
        seen.add(resolvedPath);
        collected.push(resolvedPath);
      }
    }
  }

  return { paths: collected };
}

function imageRequestMode(model: string, refCount: number): { mode?: ImageRequestMode; error?: string } {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith("gemini-")) return { mode: "gemini-native" };
  if (refCount === 0) return { mode: "json-generation" };
  if (lower.startsWith("grok-")) {
    if (refCount > 3) return { error: "Grok image editing supports at most 3 reference images." };
    return { mode: "json-edits" };
  }
  return { mode: refCount > 1 ? "json-edits" : "multipart-edit" };
}

export async function readImageRef(filePath: string): Promise<{ bytes: Buffer; mimeType: string; dataUri: string }> {
  const bytes = await readFile(filePath);
  if (bytes.length === 0) throw new Error(`Input image file is empty: ${filePath}`);
  const mimeType = detectImageMimeType(filePath, bytes);
  return { bytes, mimeType, dataUri: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

export async function executeTakoGenerateImage(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return errorResult("'prompt' is required and must be a non-empty string.");

  const rawModel = typeof args?.model === "string" ? args.model.trim() : "";
  const model = (rawModel ? rawModel.replace(/^models\//i, "") : TAKO_DEFAULT_IMAGE_MODEL).trim();
  if (!model || /[\\/]/.test(model)) return errorResult(`Invalid model ID "${rawModel}".`);

  let aspectRatio: string | undefined;
  if (args?.aspect_ratio !== undefined && args.aspect_ratio !== null && args.aspect_ratio !== "") {
    if (typeof args.aspect_ratio !== "string" || !VALID_ASPECT_RATIO_SET.has(args.aspect_ratio.trim())) {
      return errorResult(`Invalid aspect_ratio "${String(args.aspect_ratio)}". Supported values: ${TAKO_IMAGE_ASPECT_RATIOS.join(", ")}.`);
    }
    aspectRatio = args.aspect_ratio.trim();
  }
  const sizeArg = typeof args?.size === "string" && args.size.trim() ? args.size.trim() : undefined;

  const refCollected = collectReferenceImages(args, deps);
  if (refCollected.error) return errorResult(refCollected.error);
  const { mode, error: modeErr } = imageRequestMode(model, refCollected.paths.length);
  if (modeErr || !mode) return errorResult(modeErr ?? "Unsupported image request mode.");

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) return errorResult("Tako API key is not configured. Set TAKO_MCP_API_KEY or configure ~/.tako/config.json.");
  if (!creds.baseUrl) return errorResult("Tako base URL is not configured.");

  const fetchFn = deps?.fetch ?? globalThis.fetch;

  if (mode === "gemini-native") {
    const parts: Array<Record<string, unknown>> = [];
    for (const refPath of refCollected.paths) {
      try {
        const ref = await readImageRef(refPath);
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.bytes.toString("base64") } });
      } catch (err) {
        return errorResult(`Failed to read reference image "${refPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    parts.push({ text: prompt });

    const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
    const geminiAspect = aspectRatioForGemini(aspectRatio, sizeArg);
    if (geminiAspect) generationConfig.imageConfig = { aspectRatio: geminiAspect };

    let res: Response;
    try {
      res = await fetchApiNoRedirect(
        fetchFn,
        `${creds.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": creds.apiKey },
          body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
        },
      );
    } catch (err) {
      return errorResult(`Request to Tako image API failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return errorResult(`Tako image API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      return errorResult(`Failed to parse Tako image API JSON response: ${err instanceof Error ? err.message : String(err)}`);
    }

    const candidates = Array.isArray(payload?.candidates) ? (payload.candidates as Array<Record<string, unknown>>) : [];
    const firstParts = Array.isArray((candidates[0]?.content as Record<string, unknown> | undefined)?.parts)
      ? ((candidates[0].content as Record<string, unknown>).parts as Array<Record<string, unknown>>)
      : [];

    let imageData = "";
    let mimeType = "image/jpeg";
    let hasExplicitMime = false;
    const captions: string[] = [];
    for (const part of firstParts) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string" && part.text.trim()) captions.push(part.text.trim());
      if (!imageData) {
        const inline = (part.inlineData ?? part.inline_data) as Record<string, unknown> | undefined;
        if (inline && typeof inline.data === "string" && inline.data.trim()) {
          imageData = inline.data.trim();
          const rawMime = inline.mimeType ?? inline.mime_type;
          if (typeof rawMime === "string" && rawMime.trim()) {
            mimeType = rawMime.trim();
            hasExplicitMime = true;
          }
        }
      }
    }

    if (!imageData) {
      const detail = captions.length > 0 ? ` Model response: ${truncateText(captions.join(" "))}` : "";
      return errorResult(`No image data returned by model "${model}".${detail}`);
    }

    const imageBytes = Buffer.from(imageData, "base64");
    if (imageBytes.length === 0) return errorResult("Decoded image data is empty.");

    const detected = detectImageFormatFromBytes(imageBytes);
    const finalMime = hasExplicitMime ? mimeType : (detected?.mimeType ?? mimeType);
    const ext = hasExplicitMime ? extensionForMimeType(finalMime) : (detected?.ext ?? extensionForMimeType(finalMime));
    const outputPath = resolveOutputFilePath(args?.output_path, "tako-image", ext, deps);

    try {
      await writeOutputFileAtomic(outputPath, imageBytes);
    } catch (err) {
      return errorResult(`Failed to write generated image to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
    }

    const summaryLines = [
      `Image saved to: ${outputPath}`,
      `Model: ${model}`,
      `MIME type: ${finalMime}`,
      `Size: ${imageBytes.length} bytes`,
      ...(captions.length > 0 ? [`Caption: ${captions.join("\n")}`] : []),
    ];
    return {
      content: [
        { type: "text", text: summaryLines.join("\n") },
        { type: "image", data: imageBytes.toString("base64"), mimeType: finalMime },
      ],
    };
  }

  // OpenAI / Grok / WAN via /v1/images/generations or /v1/images/edits
  const resolvedSize = sizeForOpenAiImage(sizeArg, aspectRatio);
  let res: Response;
  try {
    if (mode === "multipart-edit") {
      const refPath = refCollected.paths[0]!;
      const ref = await readImageRef(refPath);
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("n", "1");
      form.append("response_format", "b64_json");
      if (resolvedSize) form.append("size", resolvedSize);
      form.append("image", new Blob([new Uint8Array(ref.bytes)], { type: ref.mimeType }), basename(refPath) || "input.png");

      res = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        body: form,
      });
    } else if (mode === "json-edits") {
      const images: Array<{ image_url: string }> = [];
      for (const refPath of refCollected.paths) {
        const ref = await readImageRef(refPath);
        images.push({ image_url: ref.dataUri });
      }
      res = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/images/edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          response_format: "b64_json",
          images,
          ...(resolvedSize ? { size: resolvedSize } : {}),
        }),
      });
    } else {
      res = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          response_format: "b64_json",
          ...(resolvedSize ? { size: resolvedSize } : {}),
        }),
      });
    }
  } catch (err) {
    return errorResult(`Image request failed (do NOT auto-retry): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return errorResult(`Tako image API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`);
  }

  let body: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  } catch (err) {
    return errorResult(`Failed to parse image response JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const first = Array.isArray(body?.data) ? body.data[0] : undefined;
  let imageBytes: Buffer;
  try {
    if (typeof first?.b64_json === "string" && first.b64_json.trim()) {
      imageBytes = Buffer.from(first.b64_json.trim(), "base64");
    } else if (typeof first?.url === "string" && first.url.trim()) {
      imageBytes = await fetchCdnBytes(fetchFn, first.url.trim());
    } else {
      return errorResult(`Image response contained neither b64_json nor url: ${truncateText(JSON.stringify(body))}`);
    }
  } catch (err) {
    return errorResult(`Failed to obtain image bytes (do NOT auto-retry): ${err instanceof Error ? err.message : String(err)}`);
  }

  const detected = detectImageFormatFromBytes(imageBytes);
  if (!detected) {
    return errorResult("Downloaded image bytes failed PNG/JPEG/WebP header check; do NOT auto-retry.");
  }

  const outputPath = resolveOutputFilePath(args?.output_path, "tako-image", detected.ext, deps);
  try {
    await writeOutputFileAtomic(outputPath, imageBytes);
  } catch (err) {
    return errorResult(`Failed to write generated image to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const summary = JSON.stringify({
    saved_path: outputPath,
    model,
    mime_type: detected.mimeType,
    bytes: imageBytes.length,
    references_used: refCollected.paths.length,
  }, null, 2);
  return {
    content: [
      { type: "text", text: summary },
      { type: "image", data: imageBytes.toString("base64"), mimeType: detected.mimeType },
    ],
  };
}
