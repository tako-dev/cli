import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { ParsedNativeSession, SessionMessageRole } from "../types";
import { firstLine, isBoilerplateUserText, makeMessage, parseJsonLines, projectNameFromCwd } from "../parser-utils";

function nativeIdFromPath(sourcePath: string): string | undefined {
  return sourcePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]updates\.jsonl$/i)?.[1];
}

const PARSER_VERSION = 1;

export interface GrokSessionSummary {
  generated_title?: string;
  session_summary?: string;
  current_model_id?: string;
  created_at?: string;
  updated_at?: string;
  info?: { id?: string; cwd?: string };
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function grokContentText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(grokContentText);
  const record = asRecord(value);
  if (!record) return [];
  if (typeof record.text === "string" && record.text.trim()) return [record.text.trim()];
  if (record.content !== undefined) return grokContentText(record.content);
  return [];
}

function grokTimestamp(record: Record<string, any>, update?: Record<string, any>): number | undefined {
  const candidates = [
    record._meta?.agentTimestampMs,
    update?._meta?.agentTimestampMs,
    record.params?._meta?.agentTimestampMs,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const ts = record.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === "string" && ts) {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toolDetail(update: Record<string, any>): string {
  const name = typeof update.title === "string" && update.title.trim()
    ? update.title.trim()
    : typeof update.kind === "string" && update.kind.trim()
      ? update.kind.trim()
      : "tool";
  const raw = asRecord(update.rawInput);
  const command = typeof raw?.command === "string" ? raw.command.trim() : "";
  const description = typeof raw?.description === "string" ? raw.description.trim() : "";
  const output = typeof asRecord(update.rawOutput)?.output_for_prompt === "string"
    ? String(update.rawOutput.output_for_prompt).trim()
    : grokContentText(update.content).join("\n");
  const detail = command || description || output;
  return detail ? `${name}: ${detail}` : name;
}

export function readGrokSummary(sourcePath: string): GrokSessionSummary | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(sourcePath), "summary.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as GrokSessionSummary : undefined;
  } catch {
    return undefined;
  }
}

export function parseGrokSessionText(
  text: string,
  sourcePath: string,
  cwd?: string,
  summary: GrokSessionSummary | undefined = readGrokSummary(sourcePath),
): ParsedNativeSession | null {
  const records = parseJsonLines(text) as Record<string, any>[];
  let nativeId = typeof summary?.info?.id === "string" ? summary.info.id : undefined;
  let resolvedCwd = cwd ?? (typeof summary?.info?.cwd === "string" ? summary.info.cwd : undefined);
  let title = typeof summary?.generated_title === "string" && summary.generated_title.trim()
    ? firstLine(summary.generated_title)
    : typeof summary?.session_summary === "string" && summary.session_summary.trim()
      ? firstLine(summary.session_summary)
      : undefined;
  let createdAt = isoTimestamp(summary?.created_at);
  let updatedAt = isoTimestamp(summary?.updated_at) ?? 0;
  let model = typeof summary?.current_model_id === "string" ? summary.current_model_id : undefined;
  const messages: ReturnType<typeof makeMessage>[] = [];
  let pending: { role: SessionMessageRole; parts: string[]; timestamp?: number } | null = null;

  const flush = () => {
    if (!pending) return;
    const textValue = pending.parts.join("");
    if (textValue && !(pending.role === "user" && isBoilerplateUserText(textValue))) {
      messages.push(makeMessage(messages.length, pending.role, textValue, pending.timestamp));
    }
    pending = null;
  };

  const appendChunk = (role: SessionMessageRole, value: string, timestamp?: number) => {
    if (!value) return;
    if (pending && pending.role === role) {
      pending.parts.push(value);
      pending.timestamp ??= timestamp;
      return;
    }
    flush();
    pending = { role, parts: [value], timestamp };
  };

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const params = asRecord(record.params);
    const update = asRecord(params?.update);
    if (typeof params?.sessionId === "string") nativeId ??= params.sessionId;
    const ts = grokTimestamp(record, update);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }
    if (!update) continue;
    const modelId = update._meta?.modelId;
    if (typeof modelId === "string") model = modelId;

    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "user_message_chunk") {
      for (const value of grokContentText(update.content)) appendChunk("user", value, ts);
      continue;
    }
    if (kind === "agent_thought_chunk") {
      for (const value of grokContentText(update.content)) appendChunk("reasoning", value, ts);
      continue;
    }
    if (kind === "agent_message_chunk") {
      for (const value of grokContentText(update.content)) appendChunk("assistant", value, ts);
      continue;
    }
    if (kind === "tool_call") {
      flush();
      messages.push(makeMessage(messages.length, "tool", toolDetail(update), ts));
      continue;
    }
    if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      const detail = toolDetail(update);
      if (detail.includes(": ")) {
        flush();
        messages.push(makeMessage(messages.length, "tool", detail, ts));
      }
    }
  }
  flush();

  nativeId ??= nativeIdFromPath(sourcePath);
  if (!nativeId) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `grok:${nativeId}`,
      nativeId,
      source: "grok",
      title: title ?? (firstUser ? firstLine(firstUser) : undefined),
      cwd: resolvedCwd,
      projectName: projectNameFromCwd(resolvedCwd),
      createdAt,
      updatedAt: updatedAt || createdAt || 0,
      model,
      userMessageCount: messages.filter((message) => message.role === "user").length,
      assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
      preview: assistant ?? firstUser ?? "",
      sourcePath,
      resumeCapability: "direct",
    },
  };
}
