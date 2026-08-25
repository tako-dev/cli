import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

interface LockOwner { pid: number; token: string; createdAt: number }

function lockPath(databasePath: string): string { return `${databasePath}.lock`; }
function ownerPath(databasePath: string): string { return `${lockPath(databasePath)}/owner.json`; }

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function staleOwner(owner: LockOwner | null, modifiedAt: number): boolean {
  if (owner) return !processAlive(owner.pid);
  return Date.now() - modifiedAt > 60_000;
}

async function readOwner(databasePath: string): Promise<LockOwner | null> {
  try { return JSON.parse(await readFile(ownerPath(databasePath), "utf8")); } catch { return null; }
}

function readOwnerSync(databasePath: string): LockOwner | null {
  try { return JSON.parse(readFileSync(ownerPath(databasePath), "utf8")); } catch { return null; }
}

async function recoverStaleLock(databasePath: string): Promise<boolean> {
  try {
    const path = lockPath(databasePath);
    const info = await stat(path);
    const observed = await readOwner(databasePath);
    if (!staleOwner(observed, info.mtimeMs)) return false;
    if (!observed) {
      const claim = `${path}/reclaim`;
      try { await mkdir(claim); } catch { return false; }
      if (await readOwner(databasePath)) { await rm(claim, { recursive: true, force: true }); return false; }
      await rm(path, { recursive: true, force: true });
      return true;
    }
    const claim = `${path}/owner.reclaim.${crypto.randomUUID()}.json`;
    try { await rename(ownerPath(databasePath), claim); } catch { return false; }
    const claimed = JSON.parse(await readFile(claim, "utf8")) as LockOwner;
    if (claimed.token !== observed.token || processAlive(claimed.pid)) {
      try { await rename(claim, ownerPath(databasePath)); } catch {}
      return false;
    }
    await rm(path, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function recoverStaleLockSync(databasePath: string): boolean {
  try {
    const path = lockPath(databasePath);
    const info = statSync(path);
    const observed = readOwnerSync(databasePath);
    if (!staleOwner(observed, info.mtimeMs)) return false;
    if (!observed) {
      const claim = `${path}/reclaim`;
      try { mkdirSync(claim); } catch { return false; }
      if (readOwnerSync(databasePath)) { rmSync(claim, { recursive: true, force: true }); return false; }
      rmSync(path, { recursive: true, force: true });
      return true;
    }
    const claim = `${path}/owner.reclaim.${crypto.randomUUID()}.json`;
    try { renameSync(ownerPath(databasePath), claim); } catch { return false; }
    const claimed = JSON.parse(readFileSync(claim, "utf8")) as LockOwner;
    if (claimed.token !== observed.token || processAlive(claimed.pid)) {
      try { renameSync(claim, ownerPath(databasePath)); } catch {}
      return false;
    }
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

async function release(databasePath: string, token: string): Promise<void> {
  if ((await readOwner(databasePath))?.token === token) await rm(lockPath(databasePath), { recursive: true, force: true });
}

function releaseSync(databasePath: string, token: string): void {
  if (readOwnerSync(databasePath)?.token === token) rmSync(lockPath(databasePath), { recursive: true, force: true });
}

export async function withSessionIndexLock<T>(databasePath: string, task: () => Promise<T> | T): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await mkdir(lockPath(databasePath), { mode: 0o700 });
      await writeFile(ownerPath(databasePath), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await recoverStaleLock(databasePath)) continue;
      if (Date.now() >= deadline) throw new Error("Session index is busy in another process");
      await Bun.sleep(100);
    }
  }
  try { return await task(); }
  finally { await release(databasePath, token); }
}

export function withSessionIndexLockSync<T>(databasePath: string, task: () => T): T {
  const token = crypto.randomUUID();
  const deadline = Date.now() + 5_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(lockPath(databasePath), { mode: 0o700 });
      writeFileSync(ownerPath(databasePath), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (recoverStaleLockSync(databasePath)) continue;
      if (Date.now() >= deadline) throw new Error("Session index is busy in another process");
      Atomics.wait(sleeper, 0, 0, 100);
    }
  }
  try { return task(); }
  finally { releaseSync(databasePath, token); }
}
