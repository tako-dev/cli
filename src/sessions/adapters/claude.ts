import type { ParsedNativeSession } from "../types";
import { extractText, firstLine, isBoilerplateUserText, makeMessage, parseJsonLines, projectNameFromCwd, timestampMs } from "../parser-utils";

const PARSER_VERSION = 1;

export function parseClaudeSessionText(text: string, sourcePath: string): ParsedNativeSession | null {
  const records = parseJsonLines(text) as Record<string, any>[];
  let nativeId: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let createdAt: number | undefined;
  let updatedAt = 0;
  let model: string | undefined;
  const messages = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.sessionId === "string") nativeId ??= record.sessionId;
    if (typeof record.cwd === "string") cwd ??= record.cwd;
    if (typeof record.model === "string") model ??= record.model;
    const ts = timestampMs(record.timestamp);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }
    if (record.type === "ai-title") {
      const candidate = record.title ?? record.content ?? record.message?.content;
      if (typeof candidate === "string" && candidate.trim()) title = firstLine(candidate);
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const role = record.type;
    const content = record.message?.content ?? record.content;
    if (role === "user") {
      for (const value of extractText(content)) if (!isBoilerplateUserText(value)) messages.push(makeMessage(messages.length, "user", value, ts));
      continue;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
          messages.push(makeMessage(messages.length, "reasoning", item.thinking.trim(), ts));
        } else {
          for (const value of extractText([item])) messages.push(makeMessage(messages.length, "assistant", value, ts));
        }
      }
    } else {
      for (const value of extractText(content)) messages.push(makeMessage(messages.length, "assistant", value, ts));
    }
  }

  if (!nativeId) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `claude:${nativeId}`,
      nativeId,
      source: "claude",
      title: title ?? (firstUser ? firstLine(firstUser) : undefined),
      cwd,
      projectName: projectNameFromCwd(cwd),
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
