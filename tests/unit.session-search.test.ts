import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { SessionDatabase } from "../src/sessions/database";
import { searchSessions } from "../src/sessions/search";
import type { ParsedNativeSession } from "../src/sessions/types";

const files: string[] = [];
afterEach(async () => Promise.all(files.splice(0).map((file) => rm(file, { force: true }))));

describe("native session search", () => {
  it("keeps tool output out of default search and includes it in deep search", () => {
    const path = join(tmpdir(), `session-search-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    const parsed: ParsedNativeSession = {
      parserVersion: 1,
      session: { key: "codex:1", nativeId: "1", source: "codex", title: "支付回调排查", cwd: "/work/pay", projectName: "pay", updatedAt: 100, userMessageCount: 1, assistantMessageCount: 0, preview: "验签失败", sourcePath: "/one", resumeCapability: "direct" },
      messages: [
        { ordinal: 0, role: "user", text: "验签失败", defaultSearchable: true, deepSearchable: true },
        { ordinal: 1, role: "tool", text: "upstream_timeout_500", defaultSearchable: false, deepSearchable: true },
      ],
    };
    db.replaceSession(parsed, { size: 1, mtimeMs: 1 });
    expect(searchSessions(db, "支付")).toHaveLength(1);
    expect(searchSessions(db, "upstream_timeout_500")).toHaveLength(0);
    expect(searchSessions(db, "upstream_timeout_500", { deep: true })).toHaveLength(1);
    db.close();
  });

  it("sorts empty-query browsing strictly by recent activity", () => {
    const path = join(tmpdir(), `session-recent-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    for (const [key, cwd, updatedAt] of [["old", "/current", 10], ["new", "/other", 20]] as const) {
      db.replaceSession({ parserVersion: 1, session: { key: `codex:${key}`, nativeId: key, source: "codex", title: key, cwd, updatedAt, userMessageCount: 1, assistantMessageCount: 0, preview: key, sourcePath: `/${key}`, resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: key, defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: updatedAt });
    }
    expect(searchSessions(db, "", { currentCwd: "/current" }).map((result) => result.session.nativeId)).toEqual(["new", "old"]);
    db.close();
  });

  it("only fetches the requested recent-session page", () => {
    const path = join(tmpdir(), `session-page-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    for (let index = 0; index < 8; index++) db.replaceSession({ parserVersion: 1, session: { key: `codex:${index}`, nativeId: String(index), source: "codex", title: String(index), updatedAt: index, userMessageCount: 1, assistantMessageCount: 0, preview: String(index), sourcePath: `/${index}`, resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: String(index), defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: index });
    expect(searchSessions(db, "", { limit: 5 }).map((result) => result.session.nativeId)).toEqual(["7", "6", "5", "4", "3"]);
    db.close();
  });

  it("applies source and cwd filters before the SQL limit", () => {
    const path = join(tmpdir(), `session-filter-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    for (let index = 0; index < 30; index++) {
      const source = index === 0 ? "claude" as const : "codex" as const;
      db.replaceSession({ parserVersion: 1, session: { key: `${source}:${index}`, nativeId: String(index), source, title: "needle", cwd: index === 0 ? "/wanted/project" : "/other", updatedAt: index, userMessageCount: 1, assistantMessageCount: 0, preview: "needle", sourcePath: `/${index}`, resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: "needle", defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: index });
    }
    expect(searchSessions(db, "needle", { sources: ["claude"], cwd: "/wanted", limit: 1 }).map((result) => result.session.source)).toEqual(["claude"]);
    db.close();
  });

  it("treats FTS punctuation and wildcard characters as literal input", () => {
    const path = join(tmpdir(), `session-special-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    db.replaceSession({ parserVersion: 1, session: { key: "codex:special", nativeId: "special", source: "codex", title: "100%_ready HTTP 200", updatedAt: 1, userMessageCount: 1, assistantMessageCount: 0, preview: "100%_ready", sourcePath: "/special", resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: "100%_ready", defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: 1 });
    expect(() => searchSessions(db, `100%_ready " HTTP`)).not.toThrow();
    expect(searchSessions(db, "100%_ready")).toHaveLength(1);
    db.close();
  });

  it("finds Chinese text in the middle of a sentence", () => {
    const path = join(tmpdir(), `session-chinese-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    db.replaceSession({ parserVersion: 1, session: { key: "codex:zh", nativeId: "zh", source: "codex", title: "线上故障", updatedAt: 1, userMessageCount: 1, assistantMessageCount: 0, preview: "线上支付回调偶尔验签失败", sourcePath: "/zh", resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: "线上支付回调偶尔验签失败", defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: 1 });
    expect(searchSessions(db, "支付回调")).toHaveLength(1);
    expect(searchSessions(db, "支付")).toHaveLength(1);
    db.close();
  });

  it("ranks title matches before newer body-only matches", () => {
    const path = join(tmpdir(), `session-ranking-${crypto.randomUUID()}.db`); files.push(path);
    const db = new SessionDatabase(path);
    for (let index = 0; index < 25; index++) db.replaceSession({ parserVersion: 1, session: { key: `codex:new-${index}`, nativeId: `new-${index}`, source: "codex", title: `new ${index}`, updatedAt: 100 + index, userMessageCount: 1, assistantMessageCount: 0, preview: "needle in body", sourcePath: `/new-${index}`, resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: "needle in body", defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: index });
    db.replaceSession({ parserVersion: 1, session: { key: "codex:best", nativeId: "best", source: "codex", title: "needle exact title", updatedAt: 1, userMessageCount: 1, assistantMessageCount: 0, preview: "needle", sourcePath: "/best", resumeCapability: "direct" }, messages: [{ ordinal: 0, role: "user", text: "needle", defaultSearchable: true, deepSearchable: true }] }, { size: 1, mtimeMs: 1 });
    expect(searchSessions(db, "needle", { limit: 5 })[0]?.session.nativeId).toBe("best");
    db.close();
  });
});
