export type NativeSessionSource = "claude" | "codex" | "gemini" | "grok" | "pi" | "agy";

export const NATIVE_SESSION_SOURCES: NativeSessionSource[] = ["claude", "codex", "gemini", "grok", "pi", "agy"];

export function isNativeSessionSource(value: string): value is NativeSessionSource {
  return (NATIVE_SESSION_SOURCES as string[]).includes(value);
}

export function sessionSourceLabel(source: NativeSessionSource): string {
  if (source === "claude") return "Claude";
  if (source === "codex") return "Codex";
  if (source === "grok") return "Grok";
  if (source === "pi") return "Pi";
  if (source === "agy") return "Antigravity";
  return "Gemini";
}

export function sessionSourceColor(source: NativeSessionSource): string {
  if (source === "claude") return "magenta";
  if (source === "codex") return "blue";
  if (source === "grok") return "white";
  if (source === "pi") return "magenta";
  if (source === "agy") return "green";
  return "cyan";
}

export type ResumeCapability = "direct" | "partial" | "unsupported";

export interface UnifiedSession {
  key: string;
  nativeId: string;
  source: NativeSessionSource;
  title?: string;
  cwd?: string;
  projectName?: string;
  createdAt?: number;
  updatedAt: number;
  model?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string;
  sourcePath: string;
  resumeCapability: ResumeCapability;
  resumeHint?: string;
}

export type SessionMessageRole = "user" | "assistant" | "tool" | "reasoning" | "system" | "other";

export interface ParsedSessionMessage {
  ordinal: number;
  role: SessionMessageRole;
  timestamp?: number;
  text: string;
  defaultSearchable: boolean;
  deepSearchable: boolean;
}

export interface ParsedNativeSession {
  session: UnifiedSession;
  messages: ParsedSessionMessage[];
  parserVersion: number;
}
