import type { NativeSessionSource, ParsedNativeSession } from "./types";
import type { SessionDatabase } from "./database";
import { open } from "node:fs/promises";

const MAX_SOURCE_TEXT = 2_500_000;
const SOURCE_HEAD_BYTES = 256_000;

async function readBoundedSessionText(path: string, size: number): Promise<string> {
  if (size <= MAX_SOURCE_TEXT) return Bun.file(path).text();
  const handle = await open(path, "r");
  try {
    const tailBytes = MAX_SOURCE_TEXT - SOURCE_HEAD_BYTES;
    const head = Buffer.allocUnsafe(SOURCE_HEAD_BYTES);
    const tail = Buffer.allocUnsafe(tailBytes);
    const headRead = await handle.read(head, 0, head.length, 0);
    const tailRead = await handle.read(tail, 0, tail.length, Math.max(0, size - tailBytes));
    return `${head.subarray(0, headRead.bytesRead).toString("utf8")}\n${tail.subarray(0, tailRead.bytesRead).toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

export interface SessionIndexCandidate { source: NativeSessionSource; path: string; text?: string; size: number; mtimeMs: number; cwd?: string }
export type VersionedParser = ((text: string, path: string, cwd?: string) => ParsedNativeSession | null) & { parserVersion?: number };
export type ParserMap = Partial<Record<NativeSessionSource, VersionedParser>>;

export async function indexSessionCandidates(db: SessionDatabase, candidates: SessionIndexCandidate[], parsers: ParserMap): Promise<number> {
  let changed = 0;
  for (const candidate of candidates) {
    const parser = parsers[candidate.source];
    if (!parser) continue;
    const previous = db.getSourceFile(candidate.path);
    const parserVersion = parser.parserVersion ?? 1;
    if (previous && previous.size === candidate.size && previous.mtimeMs === candidate.mtimeMs && previous.parserVersion === parserVersion && previous.sessionKey) continue;
    const text = candidate.text ?? await readBoundedSessionText(candidate.path, candidate.size);
    const parsed = parser(text, candidate.path, candidate.cwd);
    if (!parsed) continue;
    db.replaceSession({ ...parsed, parserVersion }, candidate);
    changed++;
  }
  return changed;
}
