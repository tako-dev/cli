import { join } from "node:path";
import { homedir } from "node:os";
import { SessionDatabase } from "./database";
import { discoverNativeSessions } from "./discovery";
import { indexSessionCandidates } from "./indexer";
import { SESSION_PARSERS } from "./registry";
import { withSessionIndexLock } from "./lock";

export function openSessionDatabase(path = join(homedir(), ".tako", "session-index", "sessions.db")): SessionDatabase { return new SessionDatabase(path); }
async function refreshSessionIndexUnlocked(db: SessionDatabase): Promise<number> {
    const candidates = await discoverNativeSessions();
    const changed = await indexSessionCandidates(db, candidates, SESSION_PARSERS);
    if (changed > 0) db.optimize();
    return candidates.length;
}
export async function refreshSessionIndex(db: SessionDatabase): Promise<number> { return withSessionIndexLock(db.path, () => refreshSessionIndexUnlocked(db)); }
export async function rebuildSessionIndex(db: SessionDatabase): Promise<number> { return withSessionIndexLock(db.path, async () => { db.clear(); return refreshSessionIndexUnlocked(db); }); }
export async function clearSessionIndex(db: SessionDatabase): Promise<void> { await withSessionIndexLock(db.path, () => db.clear()); }
export * from "./types";
export * from "./search";
