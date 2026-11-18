import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agyConversationIdFromPath, isAgyTranscriptPath } from "./adapters/agy";
import type { NativeSessionSource } from "./types";
import type { SessionIndexCandidate } from "./indexer";

async function walk(root: string, accept: (path: string) => boolean): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (accept(path)) output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function geminiCwd(path: string): Promise<string | undefined> {
  let dir = dirname(path);
  for (let i = 0; i < 3; i++, dir = dirname(dir)) {
    try { return (await readFile(join(dir, ".project_root"), "utf8")).trim() || undefined; } catch {}
  }
  return undefined;
}

export function isGeminiSessionPath(path: string): boolean {
  return /[\\/]chats[\\/]session-.*\.jsonl?$/.test(path);
}

export function isPiSessionPath(path: string): boolean {
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.test(path);
}

const GROK_SESSION_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

export function isGrokSessionPath(path: string): boolean {
  return new RegExp(`[\\\\/]sessions[\\\\/].+[\\\\/]${GROK_SESSION_ID}[\\\\/]updates\\.jsonl$`, "i").test(path);
}

export function grokSessionIdFromPath(path: string): string | undefined {
  return path.match(new RegExp(`${GROK_SESSION_ID}[\\\\/]updates\\.jsonl$`, "i"))?.[1];
}

export function grokCwdFromEncodedName(encoded: string): string | undefined {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded)) return decoded;
  } catch {}
  return undefined;
}

async function grokCwd(path: string): Promise<string | undefined> {
  const groupDir = dirname(dirname(path));
  try {
    const fromFile = (await readFile(join(groupDir, ".cwd"), "utf8")).trim();
    if (fromFile) return fromFile;
  } catch {}
  return grokCwdFromEncodedName(groupDir.replace(/\\/g, "/").split("/").pop() ?? "");
}

function parseAgyWorkspaceCwd(workspaceUrisRaw: unknown): string | undefined {
  if (typeof workspaceUrisRaw !== "string" || !workspaceUrisRaw.trim()) return undefined;
  try {
    const parsed = JSON.parse(workspaceUrisRaw);
    if (!Array.isArray(parsed)) return undefined;
    for (const item of parsed) {
      if (typeof item !== "string" || !/^file:\/\//i.test(item.trim())) continue;
      const uri = item.trim();
      try {
        return fileURLToPath(uri);
      } catch {
        if (/^file:\/\/\/[A-Za-z]:/i.test(uri)) {
          return decodeURIComponent(uri.replace(/^file:\/\/\//i, "")).replace(/\//g, "\\");
        }
      }
    }
  } catch {}
  return undefined;
}

export function readAgyConversationSummaries(
  agyHome: string,
): Map<string, { title?: string; cwd?: string; isSubagent: boolean }> {
  const result = new Map<string, { title?: string; cwd?: string; isSubagent: boolean }>();
  const dbPath = join(agyHome, "conversation_summaries.db");
  if (!existsSync(dbPath)) return result;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries",
      )
      .all() as Array<{
      conversation_id?: unknown;
      title?: unknown;
      workspace_uris?: unknown;
      parent_conversation_id?: unknown;
      nesting_depth?: unknown;
    }>;

    for (const row of rows) {
      const id = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
      if (!id) continue;
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined;
      const cwd = parseAgyWorkspaceCwd(row.workspace_uris);
      const isSubagent =
        Number(row.nesting_depth) > 0 ||
        Boolean(row.parent_conversation_id && String(row.parent_conversation_id).trim());
      result.set(id, { title, cwd, isSubagent });
    }
  } catch {
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return result;
}

export async function discoverNativeSessions(home = homedir()): Promise<SessionIndexCandidate[]> {
  const grokHome = home === homedir()
    ? (process.env.GROK_HOME?.trim() || join(home, ".grok"))
    : join(home, ".grok");
  const agyHome = home === homedir()
    ? (process.env.AGY_HOME?.trim() || join(home, ".gemini", "antigravity-cli"))
    : join(home, ".gemini", "antigravity-cli");
  const specs: Array<[NativeSessionSource, string, (path: string) => boolean]> = [
    ["claude", join(home, ".claude", "projects"), (path) => path.endsWith(".jsonl")],
    ["codex", join(home, ".codex", "sessions"), (path) => path.endsWith(".jsonl")],
    ["gemini", join(home, ".gemini", "tmp"), isGeminiSessionPath],
    ["grok", join(grokHome, "sessions"), isGrokSessionPath],
    ["pi", join(home, ".pi", "agent", "sessions"), isPiSessionPath],
  ];
  const output: SessionIndexCandidate[] = [];
  for (const [source, root, accept] of specs) {
    for (const path of await walk(root, accept)) {
      try {
        const info = await stat(path);
        const cwd = source === "gemini"
          ? await geminiCwd(path)
          : source === "grok"
            ? await grokCwd(path)
            : undefined;
        output.push({ source, path, size: info.size, mtimeMs: info.mtimeMs, cwd });
      } catch {}
    }
  }

  // Antigravity (agy): 单层枚举 <agyHome>/brain/<dirent>/.system_generated/logs/transcript.jsonl
  const agySummaries = readAgyConversationSummaries(agyHome);
  try {
    const brainDir = join(agyHome, "brain");
    const entries = await readdir(brainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
      if (!isAgyTranscriptPath(transcriptPath)) continue;
      const id = agyConversationIdFromPath(transcriptPath) ?? entry.name;
      const meta = agySummaries.get(id) ?? agySummaries.get(id.toLowerCase());
      if (meta?.isSubagent === true) continue;
      try {
        const info = await stat(transcriptPath);
        output.push({
          source: "agy",
          path: transcriptPath,
          size: info.size,
          mtimeMs: info.mtimeMs,
          cwd: meta?.cwd,
          title: meta?.title,
        });
      } catch {}
    }
  } catch {}

  return output;
}
