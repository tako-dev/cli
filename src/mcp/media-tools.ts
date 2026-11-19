import { readFile } from "node:fs/promises";
import { readImageRef } from "./image-tool";
import {
  TAKO_DEFAULT_AUDIO_MODEL,
  TAKO_DEFAULT_VIDEO_MODEL,
  type McpToolDeps,
  type McpToolResult,
} from "./schemas";
import {
  detectAudioMimeType,
  errorResult,
  fetchApiNoRedirect,
  fetchCdnBytes,
  isValidMp4Bytes,
  resolveOutputFilePath,
  resolveTakoMcpCredentials,
  resolveUserPath,
  sleepMs,
  truncateText,
  writeOutputFileAtomic,
} from "./shared";

const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;

function normalizeVideoModel(raw: unknown): { model?: string; error?: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "grok-imagine-video-1.5" || trimmed.toLowerCase() === "grok-imagine-video") {
    return { model: TAKO_DEFAULT_VIDEO_MODEL };
  }
  return { error: `Unsupported video model "${trimmed}"; only ${TAKO_DEFAULT_VIDEO_MODEL} is supported.` };
}

function extractVideoTaskId(body: Record<string, unknown>): string | null {
  const candidates = [
    body.id,
    body.task_id,
    (body.task as Record<string, unknown> | undefined)?.id,
    (body.task as Record<string, unknown> | undefined)?.task_id,
    (body.data as Record<string, unknown> | undefined)?.id,
    (body.data as Record<string, unknown> | undefined)?.task_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function classifyVideoPollState(body: Record<string, unknown>): {
  status: string;
  progress: number;
  outcome: "completed" | "pending" | "failed";
  reason?: string;
} {
  const statusRaw = [
    body.status,
    body.state,
    body.task_status,
    (body.task as Record<string, unknown> | undefined)?.status,
    (body.task as Record<string, unknown> | undefined)?.state,
    (body.data as Record<string, unknown> | undefined)?.status,
    (body.data as Record<string, unknown> | undefined)?.state,
  ].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const status = statusRaw?.trim() || "unknown";

  const progressRaw = [
    body.progress,
    (body.task as Record<string, unknown> | undefined)?.progress,
    (body.data as Record<string, unknown> | undefined)?.progress,
  ].find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined;
  const progress = progressRaw ?? 0;

  const lower = status.toLowerCase();
  if (["success", "succeeded", "done", "completed", "finished", "ok"].includes(lower)) {
    return { status, progress, outcome: "completed" };
  }
  if (["failure", "failed", "error", "cancelled", "canceled", "rejected", "expired"].includes(lower)) {
    const errObj = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).message : body.error;
    const reason =
      [
        body.fail_reason,
        errObj,
        body.message,
        (body.task as Record<string, unknown> | undefined)?.fail_reason,
        (body.data as Record<string, unknown> | undefined)?.fail_reason,
      ].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    return { status, progress, outcome: "failed", reason: reason?.trim() || "Upstream video generation failed" };
  }
  return { status, progress, outcome: "pending" };
}

export async function executeTakoGenerateVideo(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const { model, error: modelErr } = normalizeVideoModel(args?.model);
  if (modelErr || !model) return errorResult(modelErr ?? "Invalid video model.");

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) return errorResult("Tako API key is not configured.");
  if (!creds.baseUrl) return errorResult("Tako base URL is not configured.");

  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const pollIntervalMs = deps?.pollIntervalMs ?? 3000;
  const waitSecs = typeof args?.wait_timeout_secs === "number" && Number.isFinite(args.wait_timeout_secs)
    ? Math.max(5, Math.min(300, Math.floor(args.wait_timeout_secs)))
    : 120;

  let taskId = typeof args?.resume_task_id === "string" ? args.resume_task_id.trim() : "";
  if (!taskId) {
    const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return errorResult("'prompt' or 'resume_task_id' is required.");

    const duration = typeof args?.duration === "number" && Number.isFinite(args.duration)
      ? Math.max(1, Math.min(15, Math.floor(args.duration)))
      : 5;
    const resolution = typeof args?.resolution === "string" && args.resolution.trim() ? args.resolution.trim() : "480p";
    const aspectRatio = typeof args?.aspect_ratio === "string" && args.aspect_ratio.trim() ? args.aspect_ratio.trim() : undefined;

    let imageRef: string | undefined;
    const rawRef = typeof args?.input_reference_path === "string" ? args.input_reference_path.trim() : "";
    if (rawRef) {
      if (/^(?:https?:\/\/|data:)/i.test(rawRef)) {
        imageRef = rawRef;
      } else {
        try {
          imageRef = (await readImageRef(resolveUserPath(rawRef, deps))).dataUri;
        } catch (err) {
          return errorResult(`Failed to read input_reference_path: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    try {
      const submitRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          model,
          prompt,
          duration,
          resolution,
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(imageRef ? { image: imageRef } : {}),
        }),
      });
      if (!submitRes.ok) {
        const errText = await submitRes.text().catch(() => "");
        return errorResult(`Video submission returned HTTP ${submitRes.status} (do NOT auto-retry): ${truncateText(errText)}`);
      }
      const submitBody = (await submitRes.json()) as Record<string, unknown>;
      taskId = extractVideoTaskId(submitBody) ?? "";
      if (!taskId) return errorResult(`Video submission response missing task id: ${truncateText(JSON.stringify(submitBody))}`);
    } catch (err) {
      return errorResult(`Video submission failed (do NOT auto-retry): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deadline = Date.now() + waitSecs * 1000;
  let lastStatus = "queued";
  let lastProgress = 0;

  while (true) {
    let pollBody: Record<string, unknown>;
    try {
      const pollRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
      if (!pollRes.ok) {
        const errText = await pollRes.text().catch(() => "");
        return errorResult(`Polling video task ${taskId} returned HTTP ${pollRes.status} (pass resume_task_id to recover; do NOT resubmit): ${truncateText(errText)}`);
      }
      pollBody = (await pollRes.json()) as Record<string, unknown>;
    } catch (err) {
      return errorResult(`Polling video task ${taskId} failed (pass resume_task_id to recover; do NOT resubmit): ${err instanceof Error ? err.message : String(err)}`);
    }

    const classified = classifyVideoPollState(pollBody);
    lastStatus = classified.status;
    lastProgress = classified.progress;

    if (classified.outcome === "completed") break;
    if (classified.outcome === "failed") {
      return errorResult(`Video task ${taskId} failed (do NOT auto-resubmit): ${classified.reason}`);
    }
    if (Date.now() >= deadline) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: lastStatus,
            progress: lastProgress,
            task_id: taskId,
            message: "Polling timeout while video is still generating. Pass resume_task_id later instead of submitting a new paid job.",
          }, null, 2),
        }],
      };
    }
    await sleepMs(pollIntervalMs);
  }

  let mp4Bytes: Buffer;
  try {
    const dlRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!dlRes.ok) {
      const errText = await dlRes.text().catch(() => "");
      return errorResult(`Downloading video ${taskId} returned HTTP ${dlRes.status} (pass resume_task_id to retry download): ${truncateText(errText)}`);
    }
    const contentType = (dlRes.headers.get("content-type") ?? "").toLowerCase();
    const raw = Buffer.from(await dlRes.arrayBuffer());
    if (contentType.includes("json") || raw[0] === 0x7b) {
      const meta = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const b64 = [
        meta.b64_json,
        meta.video_base64,
        (meta.data as Record<string, unknown> | undefined)?.b64_json,
        Array.isArray(meta.data) ? (meta.data[0] as Record<string, unknown> | undefined)?.b64_json : undefined,
      ].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      const cdnUrl = [
        meta.url,
        meta.video_url,
        (meta.data as Record<string, unknown> | undefined)?.url,
        Array.isArray(meta.data) ? (meta.data[0] as Record<string, unknown> | undefined)?.url : undefined,
      ].find((v) => typeof v === "string" && v.trim()) as string | undefined;

      if (b64) mp4Bytes = Buffer.from(b64.trim(), "base64");
      else if (cdnUrl) mp4Bytes = await fetchCdnBytes(fetchFn, cdnUrl.trim());
      else return errorResult(`Video download JSON missing url/b64_json (task_id=${taskId}).`);
    } else {
      mp4Bytes = raw;
    }
  } catch (err) {
    return errorResult(`Failed to download video ${taskId} (pass resume_task_id to retry): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidMp4Bytes(mp4Bytes)) {
    return errorResult(`Downloaded video failed MP4 (ftyp) header check (task_id=${taskId}, bytes=${mp4Bytes.length}). Pass resume_task_id to inspect.`);
  }

  const outputPath = resolveOutputFilePath(args?.output_path, "tako-video", ".mp4", deps);
  try {
    await writeOutputFileAtomic(outputPath, mp4Bytes);
  } catch (err) {
    return errorResult(`Failed to write video to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ status: "completed", task_id: taskId, model, saved_path: outputPath, bytes: mp4Bytes.length }, null, 2),
    }],
  };
}

export async function executeTakoGenerateAudio(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const model = typeof args?.model === "string" && args.model.trim() ? args.model.trim() : TAKO_DEFAULT_AUDIO_MODEL;
  const rawFormat = typeof args?.response_format === "string" ? args.response_format.trim().toLowerCase() : "";
  const format = !rawFormat || rawFormat === "wave" ? "wav" : rawFormat === "mp3" ? "mp3" : rawFormat === "pcm" || rawFormat === "pcm16" ? "pcm" : "";
  if (!format) return errorResult(`Unsupported audio format "${rawFormat}". Supported: wav, mp3, pcm.`);

  const instructions = typeof args?.instructions === "string" && args.instructions.trim() ? args.instructions.trim() : undefined;
  const input = typeof args?.input === "string" && args.input.trim() ? args.input.trim() : undefined;
  const isVoiceDesign = model === "mimo-v2.5-tts-voicedesign";
  const isVoiceClone = model === "mimo-v2.5-tts-voiceclone";

  if (!input && !(isVoiceDesign && instructions)) {
    return errorResult("'input' is required (optional only for mimo-v2.5-tts-voicedesign with instructions).");
  }

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) return errorResult("Tako API key is not configured.");
  if (!creds.baseUrl) return errorResult("Tako base URL is not configured.");

  const payload: Record<string, unknown> = { model, response_format: format };
  if (input) payload.input = input;
  if (instructions) payload.instructions = instructions;

  let voiceUsed: string | undefined;
  const explicitVoice = typeof args?.voice === "string" && args.voice.trim() ? args.voice.trim() : undefined;
  const samplePathRaw = typeof args?.voice_sample_path === "string" && args.voice_sample_path.trim() ? args.voice_sample_path.trim() : undefined;

  if (isVoiceClone) {
    if (samplePathRaw) {
      const samplePath = resolveUserPath(samplePathRaw, deps);
      try {
        const sampleBytes = await readFile(samplePath);
        if (sampleBytes.length > MAX_VOICE_SAMPLE_BYTES) {
          return errorResult(`Voice clone sample exceeds 10MB limit (${sampleBytes.length} bytes).`);
        }
        payload.voice = `data:${detectAudioMimeType(samplePath)};base64,${sampleBytes.toString("base64")}`;
      } catch (err) {
        return errorResult(`Failed to read voice_sample_path "${samplePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (explicitVoice?.startsWith("data:")) {
      payload.voice = explicitVoice;
    } else {
      return errorResult("mimo-v2.5-tts-voiceclone requires voice_sample_path or a data: URI in voice.");
    }
    voiceUsed = "<voice_sample>";
  } else if (!isVoiceDesign) {
    if (explicitVoice?.startsWith("data:")) {
      return errorResult("Preset voice models do not accept data: URIs; use mimo-v2.5-tts-voiceclone.");
    }
    voiceUsed = explicitVoice ?? "冰糖";
    payload.voice = voiceUsed;
  }

  const fetchFn = deps?.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return errorResult(`Speech synthesis request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return errorResult(`Tako speech API returned HTTP ${res.status}${errText ? `: ${truncateText(errText)}` : ""}`);
  }

  const preview = res.headers.get("x-speech-final-text-preview")?.trim() || undefined;
  const audioBytes = Buffer.from(await res.arrayBuffer());
  const outputPath = resolveOutputFilePath(args?.output_path, "tako-audio", `.${format}`, deps);

  try {
    await writeOutputFileAtomic(outputPath, audioBytes);
  } catch (err) {
    return errorResult(`Failed to write audio file to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        saved_path: outputPath,
        model,
        format,
        bytes: audioBytes.length,
        ...(voiceUsed ? { voice: voiceUsed } : {}),
        ...(preview ? { final_text_preview: preview } : {}),
      }, null, 2),
    }],
  };
}
