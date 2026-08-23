import { basename } from "node:path";
import type { ParsedNativeSession } from "../types";
import { extractText, firstLine, isBoilerplateUserText, makeMessage, parseJsonLines, projectNameFromCwd, timestampMs } from "../parser-utils";

const PARSER_VERSION = 1;

function nativeIdFromPath(sourcePath: string): string | undefined {
  const name = basename(sourcePath);
  const match = name.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

function contentFromMessage(message: Record<string, any> | undefined): unknown {
  if (!message) return undefined;
  if (message.content !== undefined) return message.content;
  if (message.summary !== undefined) return message.summary;
  if (message.output !== undefined) return message.output;
  return undefined;
}

export function parsePiSessionText(text: string, sourcePath: string): ParsedNativeSession | null {
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
    const ts = timestampMs(record.timestamp ?? record.message?.timestamp);
    if (ts !== undefined) {
      createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }

    if (record.type === "session") {
      if (typeof record.id === "string") nativeId ??= record.id;
      if (typeof record.cwd === "string") cwd ??= record.cwd;
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
      title = firstLine(record.name);
      continue;
    }
    if (record.type === "model_change") {
      const provider = typeof record.provider === "string" ? record.provider : undefined;
      const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
      if (modelId) model = provider ? `${provider}/${modelId}` : modelId;
      continue;
    }
    if (record.type === "compaction" && typeof record.summary === "string" && record.summary.trim()) {
      messages.push(makeMessage(messages.length, "tool", record.summary.trim(), ts));
      continue;
    }
    if (record.type !== "message" && record.type !== "custom_message") continue;

    const payload = record.message && typeof record.message === "object" ? record.message : record;
    const role = payload.role;
    if (role === "user") {
      for (const value of extractText(contentFromMessage(payload))) {
        if (!isBoilerplateUserText(value)) messages.push(makeMessage(messages.length, "user", value, ts));
      }
      continue;
    }
    if (role === "assistant") {
      const content = payload.content;
      if (typeof payload.model === "string") {
        const provider = typeof payload.provider === "string" ? payload.provider : undefined;
        model = provider ? `${provider}/${payload.model}` : payload.model;
      }
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
            messages.push(makeMessage(messages.length, "reasoning", item.thinking.trim(), ts));
            continue;
          }
          if (item.type === "toolCall") {
            const name = typeof item.name === "string" ? item.name : "tool";
            const detail = extractText(item.arguments).join(" ") || JSON.stringify(item.arguments ?? {});
            if (detail && detail !== "{}") messages.push(makeMessage(messages.length, "tool", `${name}: ${detail}`, ts));
            continue;
          }
          for (const value of extractText([item])) messages.push(makeMessage(messages.length, "assistant", value, ts));
        }
      } else {
        for (const value of extractText(content)) messages.push(makeMessage(messages.length, "assistant", value, ts));
      }
      continue;
    }
    if (role === "toolResult") {
      const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
      for (const value of extractText(contentFromMessage(payload))) {
        messages.push(makeMessage(messages.length, "tool", `${name}: ${value}`, ts));
      }
      continue;
    }
    if (role === "bashExecution") {
      const command = typeof payload.command === "string" ? payload.command : "bash";
      const output = typeof payload.output === "string" ? payload.output : "";
      messages.push(makeMessage(messages.length, "tool", `${command}${output ? `\n${output}` : ""}`, ts));
      continue;
    }
    if (role === "custom" || record.type === "custom_message") {
      for (const value of extractText(contentFromMessage(payload) ?? record.content)) {
        messages.push(makeMessage(messages.length, "other", value, ts));
      }
    }
  }

  nativeId ??= nativeIdFromPath(sourcePath);
  if (!nativeId) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text;
  const assistant = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  return {
    parserVersion: PARSER_VERSION,
    messages,
    session: {
      key: `pi:${nativeId}`,
      nativeId,
      source: "pi",
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
