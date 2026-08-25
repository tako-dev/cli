export type NativeSessionSource = "claude" | "codex" | "gemini";

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
