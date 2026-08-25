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

export async function discoverNativeSessions(home = homedir()): Promise<SessionIndexCandidate[]> {
  const specs: Array<[NativeSessionSource, string, (path: string) => boolean]> = [
    ["claude", join(home, ".claude", "projects"), (path) => path.endsWith(".jsonl")],
    ["codex", join(home, ".codex", "sessions"), (path) => path.endsWith(".jsonl")],
    ["gemini", join(home, ".gemini", "tmp"), isGeminiSessionPath],
  ];
  const output: SessionIndexCandidate[] = [];
  for (const [source, root, accept] of specs) {
    for (const path of await walk(root, accept)) {
      try {
        const info = await stat(path);
        output.push({ source, path, size: info.size, mtimeMs: info.mtimeMs, cwd: source === "gemini" ? await geminiCwd(path) : undefined });
      } catch {}
    }
  }
  return output;
}
