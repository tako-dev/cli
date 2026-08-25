import { basename } from "node:path";
import type { ParsedSessionMessage, SessionMessageRole } from "./types";

export function parseJsonLines(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Native clients may be appending the final line while Tako indexes it.
    }
  }
  return records;
}

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function projectNameFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const name = basename(cwd.replace(/[\\/]+$/, ""));
  return name || undefined;
}

export function extractText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim()) output.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = record.text ?? record.output_text ?? record.input_text;
    if (typeof text === "string" && text.trim()) output.push(text.trim());
  }
  return output;
}

export function makeMessage(
  ordinal: number,
  role: SessionMessageRole,
  text: string,
  timestamp?: number,
): ParsedSessionMessage {
  const defaultSearchable = role === "user" || role === "assistant";
  return {
    ordinal,
    role,
    timestamp,
    text,
    defaultSearchable,
    deepSearchable: role !== "system" && role !== "other",
  };
}

export function firstLine(text: string, maxLength = 120): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export function isBoilerplateUserText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<permissions instructions>")
    || trimmed.startsWith("<collaboration_mode>")
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("# Files mentioned by the user:")
    || trimmed.startsWith("# AGENTS.md instructions for ")
    || trimmed.startsWith("<image ")
    || trimmed.startsWith("<turn_aborted>")
    || trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<local-command-")
    || trimmed === "</image>"
    || trimmed === "undefined"
    || /^\/(model|status|help|clear)\b/i.test(trimmed);
}
