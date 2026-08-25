import { getClient } from "../clients/base";
import { launchClientUnified } from "../launcher";
import { existsSync, statSync } from "node:fs";
import type { UnifiedSession } from "./types";

function existingDirectory(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try { return statSync(path).isDirectory() ? path : undefined; } catch { return undefined; }
}

export function resumeArgs(session: UnifiedSession, cwd = session.cwd): { clientId: string; args: string[] } {
  if (session.source === "claude") return { clientId: "claude-code", args: ["--resume", session.nativeId] };
  if (session.source === "codex") return { clientId: "codex", args: ["resume", session.nativeId, ...(cwd ? ["-C", cwd] : [])] };
  throw new Error("Tako does not support resuming Gemini sessions yet; use search or detail view instead.");
}

export function prepareResume(session: UnifiedSession, fallbackCwd?: string): { clientId: string; args: string[]; projectPath?: string; warning?: string } {
  if (!existsSync(session.sourcePath)) throw new Error("The native session source file no longer exists. Rebuild the session index before resuming.");
  const originalCwd = existingDirectory(session.cwd);
  const projectPath = originalCwd ?? existingDirectory(fallbackCwd) ?? existingDirectory(process.cwd());
  const prepared = resumeArgs(session, projectPath);
  return {
    ...prepared,
    projectPath,
    warning: session.cwd && !originalCwd ? `Original project directory is unavailable; continuing in ${projectPath}.` : undefined,
  };
}

export async function resumeNativeSession(session: UnifiedSession): Promise<void> {
  const prepared = prepareResume(session, process.cwd());
  if (prepared.warning) console.warn(prepared.warning);
  const client = getClient(prepared.clientId);
  if (!client) throw new Error(`Client ${prepared.clientId} is not registered`);
  const result = await launchClientUnified(client, { projectPath: prepared.projectPath, args: prepared.args });
  if (!result.success) throw new Error(result.error ?? "Failed to resume session");
}
