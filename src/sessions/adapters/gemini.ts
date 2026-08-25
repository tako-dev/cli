import type { ParsedNativeSession } from "../types";
import { extractText, firstLine, isBoilerplateUserText, makeMessage, parseJsonLines, projectNameFromCwd, timestampMs } from "../parser-utils";

const PARSER_VERSION = 1;

export function parseGeminiSessionText(text: string, sourcePath: string, cwd?: string): ParsedNativeSession | null {
  let records: Record<string, any>[];
  try {
    const document = JSON.parse(text);
    records = document && typeof document === "object"
      ? [document, ...(Array.isArray(document.messages) ? document.messages : [])]
      : [];
  } catch {
    records = parseJsonLines(text) as Record<string, any>[];
  }
  let nativeId: string | undefined;
  let createdAt: number | undefined;
  let updatedAt = 0;
  const messages = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.sessionId === "string") nativeId ??= record.sessionId;
    const ts = timestampMs(record.timestamp ?? record.startTime);
    const lastUpdated = timestampMs(record.lastUpdated ?? record.endTime);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }
    if (lastUpdated !== undefined) updatedAt = Math.max(updatedAt, lastUpdated);
    const role = record.type === "user"
      ? "user"
      : record.type === "gemini" || record.type === "assistant"
        ? "assistant"
        : record.type === "tool"
          ? "tool"
          : null;
    if (!role) continue;
    for (const value of extractText(record.content ?? record.message)) {
      if (role === "user" && isBoilerplateUserText(value)) continue;
      messages.push(makeMessage(messages.length, role, value, ts));
    }
  }

  if (!nativeId) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `gemini:${nativeId}`,
      nativeId,
      source: "gemini",
      title: firstUser ? firstLine(firstUser) : undefined,
      cwd,
      projectName: projectNameFromCwd(cwd),
      createdAt,
      updatedAt: updatedAt || createdAt || 0,
      userMessageCount: messages.filter((message) => message.role === "user").length,
      assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
      preview: assistant ?? firstUser ?? "",
      sourcePath,
      resumeCapability: "unsupported",
      resumeHint: "Gemini sessions can be searched and viewed, but this Gemini CLI format does not provide a stable resume command.",
    },
  };
}
