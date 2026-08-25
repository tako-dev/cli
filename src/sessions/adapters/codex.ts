import type { ParsedNativeSession } from "../types";
import { extractText, firstLine, isBoilerplateUserText, makeMessage, parseJsonLines, projectNameFromCwd, timestampMs } from "../parser-utils";

const PARSER_VERSION = 1;

export function parseCodexSessionText(text: string, sourcePath: string): ParsedNativeSession | null {
  const records = parseJsonLines(text) as Record<string, any>[];
  let nativeId: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let updatedAt = 0;
  let model: string | undefined;
  const messages = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const payload = record.payload ?? {};
    const ts = timestampMs(record.timestamp ?? payload.timestamp);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }
    if (record.type === "session_meta") {
      if (typeof payload.id === "string") nativeId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (record.type === "turn_context") {
      if (typeof payload.cwd === "string") cwd ??= payload.cwd;
      if (typeof payload.model === "string") model = payload.model;
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message") {
      const role = payload.role;
      if (role === "developer" || role === "system") continue;
      const values = extractText(payload.content);
      for (const value of values) {
        if (role === "user" && isBoilerplateUserText(value)) continue;
        if (role === "user" || role === "assistant") messages.push(makeMessage(messages.length, role, value, ts));
      }
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "tool_result") {
      for (const value of extractText(payload.output ?? payload.content)) {
        messages.push(makeMessage(messages.length, "tool", value, ts));
      }
      continue;
    }
    if (payload.type === "reasoning") {
      for (const value of extractText(payload.summary ?? payload.content)) {
        messages.push(makeMessage(messages.length, "reasoning", value, ts));
      }
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const detail = payload.arguments ?? payload.input ?? payload.content;
      const values = extractText(detail);
      const name = typeof payload.name === "string" ? payload.name : payload.type;
      for (const value of values.length ? values : [typeof detail === "string" ? detail : JSON.stringify(detail)]) {
        if (value) messages.push(makeMessage(messages.length, "tool", `${name}: ${value}`, ts));
      }
    }
  }

  if (!nativeId) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `codex:${nativeId}`,
      nativeId,
      source: "codex",
      title: firstUser ? firstLine(firstUser) : undefined,
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
