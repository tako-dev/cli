import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
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

export async function discoverNativeSessions(home = homedir()): Promise<SessionIndexCandidate[]> {
  const grokHome = home === homedir()
    ? (process.env.GROK_HOME?.trim() || join(home, ".grok"))
    : join(home, ".grok");
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
  return output;
}
