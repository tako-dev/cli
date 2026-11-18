import type { ParsedNativeSession } from "../types";
import {
  extractText,
  firstLine,
  isBoilerplateUserText,
  makeMessage,
  parseJsonLines,
  projectNameFromCwd,
  timestampMs,
} from "../parser-utils";

const PARSER_VERSION = 1;

const AGY_TRANSCRIPT_PATH_RE =
  /[\\/]brain[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i;

export function isAgyTranscriptPath(path: string): boolean {
  return AGY_TRANSCRIPT_PATH_RE.test(path);
}

export function agyConversationIdFromPath(path: string): string | undefined {
  return path.match(AGY_TRANSCRIPT_PATH_RE)?.[1];
}

export function stripAgyUserEnvelope(raw: string): string {
  const userMatches = [...raw.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/g)];
  if (userMatches.length > 0) {
    return userMatches
      .map((match) => match[1].trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  let cleaned = raw;
  if (cleaned.includes("<SYSTEM_MESSAGE>")) {
    cleaned = cleaned.replace(
      /The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\r\n]*/g,
      "",
    );
  }
  return cleaned
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
    .trim();
}

function extractCwdFromAgyText(raw: string): string | undefined {
  const cmdMatch = raw.match(/Command Working Directory:\s*([^\r\n]+)/);
  if (cmdMatch?.[1]?.trim()) return cmdMatch[1].trim();
  const wsMatch = raw.match(/Active Workspaces:\s*\r?\n-\s*([^\r\n]+)/);
  if (wsMatch?.[1]?.trim()) return wsMatch[1].trim();
  return undefined;
}

export function parseAgySessionText(
  text: string,
  sourcePath: string,
  cwd?: string,
  summaryMeta?: { title?: string },
): ParsedNativeSession | null {
  const records = parseJsonLines(text) as Record<string, any>[];
  let nativeId = agyConversationIdFromPath(sourcePath);
  let resolvedCwd = cwd?.trim() || undefined;
  let createdAt: number | undefined;
  let updatedAt = 0;
  let model: string | undefined;
  const messages: ReturnType<typeof makeMessage>[] = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;

    if (!nativeId && typeof record.conversation_id === "string" && record.conversation_id.trim()) {
      nativeId = record.conversation_id.trim();
    }

    const ts = timestampMs(record.created_at ?? record.timestamp);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }

    if (typeof record.model === "string" && record.model.trim()) {
      model = record.model.trim();
    }

    if (!resolvedCwd) {
      if (typeof record.cwd === "string" && record.cwd.trim()) {
        resolvedCwd = record.cwd.trim();
      } else {
        for (const candidateText of [
          ...extractText(record.content ?? record.message?.content),
          typeof record.system_prompt === "string" ? record.system_prompt : "",
        ]) {
          if (!candidateText) continue;
          const extracted = extractCwdFromAgyText(candidateText);
          if (extracted) {
            resolvedCwd = extracted;
            break;
          }
        }
      }
    }

    if (record.type === "USER_INPUT" || record.source === "USER_EXPLICIT") {
      for (const rawContent of extractText(record.content ?? record.message?.content)) {
        const cleaned = stripAgyUserEnvelope(rawContent);
        if (cleaned && !isBoilerplateUserText(cleaned)) {
          messages.push(makeMessage(messages.length, "user", cleaned, ts));
        }
      }
      continue;
    }

    if (
      record.type === "PLANNER_RESPONSE" ||
      (record.source === "MODEL" && record.type !== "GENERIC")
    ) {
      if (typeof record.thinking === "string" && record.thinking.trim()) {
        messages.push(makeMessage(messages.length, "reasoning", record.thinking.trim(), ts));
      }
      for (const value of extractText(record.content ?? record.message?.content)) {
        messages.push(makeMessage(messages.length, "assistant", value, ts));
      }
    }
  }

  if (!nativeId) return null;

  const userMessageCount = messages.filter((message) => message.role === "user").length;
  if (userMessageCount === 0) return null;

  const assistantMessageCount = messages.filter((message) => message.role === "assistant").length;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;

  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `agy:${nativeId}`,
      nativeId,
      source: "agy",
      title: summaryMeta?.title?.trim() || (firstUser ? firstLine(firstUser) : undefined),
      cwd: resolvedCwd,
      projectName: projectNameFromCwd(resolvedCwd),
      createdAt,
      updatedAt: updatedAt || createdAt || 0,
      model,
      userMessageCount,
      assistantMessageCount,
      preview: assistant ?? firstUser ?? "",
      sourcePath,
      resumeCapability: "direct",
    },
  };
}
