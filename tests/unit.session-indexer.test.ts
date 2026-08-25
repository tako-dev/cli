import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDatabase } from "../src/sessions/database";
import { indexSessionCandidates } from "../src/sessions/indexer";
import { withSessionIndexLock } from "../src/sessions/lock";
import type { ParsedNativeSession } from "../src/sessions/types";

const paths: string[] = [];
function dbPath(): string { const dir = join(tmpdir(), `tako-session-${crypto.randomUUID()}`); paths.push(dir); return join(dir, "sessions.db"); }
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });

function parsed(title: string): ParsedNativeSession {
  return {
    parserVersion: 1,
    session: { key: "codex:id-1", nativeId: "id-1", source: "codex", title, cwd: "/work/app", projectName: "app", updatedAt: 10, userMessageCount: 1, assistantMessageCount: 0, preview: title, sourcePath: "/source/one.jsonl", resumeCapability: "direct" },
    messages: [{ ordinal: 0, role: "user", text: title, defaultSearchable: true, deepSearchable: true }],
  };
}

describe("session indexer", () => {
  it("atomically replaces a session and its messages", () => {
    const db = new SessionDatabase(dbPath());
    db.replaceSession(parsed("first"), { size: 10, mtimeMs: 20 });
    db.replaceSession(parsed("second"), { size: 11, mtimeMs: 21 });
    expect(db.getSession("codex:id-1")?.title).toBe("second");
    expect(db.getMessages("codex:id-1").map((message) => message.text)).toEqual(["second"]);
    db.close();
  });

  it("locks down the index directory and SQLite files", async () => {
    const path = dbPath();
    await mkdir(join(path, ".."), { recursive: true, mode: 0o755 });
    await writeFile(path, "", { mode: 0o644 });
    const db = new SessionDatabase(path);
    db.replaceSession(parsed("secure"), { size: 1, mtimeMs: 1 });
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${path}${suffix}`;
      expect((await stat(sidecar)).mode & 0o777).toBe(0o600);
    }
    db.close();
  });

  it("returns only recent messages without loading the full history", () => {
    const db = new SessionDatabase(dbPath());
    const value = parsed("history");
    value.messages = Array.from({ length: 20 }, (_, ordinal) => ({ ordinal, role: "assistant" as const, text: `message-${ordinal}`, defaultSearchable: true, deepSearchable: true }));
    db.replaceSession(value, { size: 1, mtimeMs: 1 });
    expect(db.getRecentMessages(value.session.key, 3).map((message) => message.text)).toEqual(["message-17", "message-18", "message-19"]);
    db.close();
  });

  it("recovers a lock owned by a dead process", async () => {
    const path = dbPath();
    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(join(`${path}.lock`, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "stale", createdAt: Date.now() - 60_000 }));
    const db = new SessionDatabase(path);
    db.replaceSession(parsed("recovered"), { size: 1, mtimeMs: 1 });
    expect(db.getSession("codex:id-1")?.title).toBe("recovered");
    db.close();
  });

  it("allows read-only opens during refresh and serializes stale-lock recovery", async () => {
    const path = dbPath();
    new SessionDatabase(path).close();
    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(join(`${path}.lock`, "owner.json"), JSON.stringify({ pid: process.pid, token: "active", createdAt: Date.now() }));
    const startedAt = Date.now();
    new SessionDatabase(path).close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await rm(`${path}.lock`, { recursive: true, force: true });

    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(join(`${path}.lock`, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "stale", createdAt: Date.now() - 60_000 }));
    let active = 0;
    let maximumActive = 0;
    await Promise.all([0, 1].map(() => withSessionIndexLock(path, async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(20);
      active--;
    })));
    expect(maximumActive).toBe(1);
  });

  it("skips unchanged files and reparses when parser version changes", async () => {
    const db = new SessionDatabase(dbPath());
    let calls = 0;
    const parser = Object.assign(() => { calls++; return parsed(`call-${calls}`); }, { parserVersion: 1 });
    const candidate = { source: "codex" as const, path: "/source/one.jsonl", text: "x", size: 1, mtimeMs: 2 };
    await indexSessionCandidates(db, [candidate], { codex: parser });
    await indexSessionCandidates(db, [candidate], { codex: parser });
    expect(calls).toBe(1);
    const parserV2 = Object.assign(() => ({ ...parser()!, parserVersion: 2 }), { parserVersion: 2 });
    await indexSessionCandidates(db, [candidate], { codex: parserV2 });
    expect(calls).toBe(2);
    db.close();
  });

  it("bounds source text passed to parsers for very large session files", async () => {
    const path = dbPath();
    const sourcePath = join(path, "..", "large.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const head = "HEAD-METADATA\n";
    const tail = "\nTAIL-RECENT";
    await writeFile(sourcePath, head + "x".repeat(6 * 1024 * 1024) + tail);
    const sourceInfo = await stat(sourcePath);
    const db = new SessionDatabase(path);
    let received = "";
    const parser = Object.assign((text: string) => { received = text; return parsed("large"); }, { parserVersion: 1 });
    await indexSessionCandidates(db, [{ source: "codex", path: sourcePath, size: sourceInfo.size, mtimeMs: 1 }], { codex: parser });
    expect(received.length).toBeLessThan(3 * 1024 * 1024);
    expect(received.startsWith("HEAD-METADATA")).toBe(true);
    expect(received.endsWith("TAIL-RECENT")).toBe(true);
    db.close();
  });

  it("keeps repeated large deep-search updates within a small disk budget", () => {
    const path = dbPath();
    const db = new SessionDatabase(path);
    const value = parsed("bounded");
    value.messages = Array.from({ length: 100 }, (_, ordinal) => ({ ordinal, role: "tool" as const, text: `tool-${ordinal}-` + "x".repeat(100_000), defaultSearchable: false, deepSearchable: true }));
    for (let index = 0; index < 12; index++) db.replaceSession(value, { size: index + 1, mtimeMs: index + 1 });
    db.optimize();
    expect(db.status().bytes).toBeLessThan(5 * 1024 * 1024);
    db.close();
  });
});
