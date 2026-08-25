import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { NativeSessionSource, ParsedNativeSession, UnifiedSession, ParsedSessionMessage } from "./types";
import { withSessionIndexLockSync } from "./lock";

const SCHEMA_VERSION = 5;
const MAX_DETAIL_MESSAGES = 24;
const MAX_MESSAGE_TEXT = 2_048;
const MAX_DEFAULT_SEARCH_TEXT = 32 * 1_024;
const MAX_DEEP_SEARCH_TEXT = 32 * 1_024;

export interface SessionIndexStatus {
  sessions: number;
  sourceFiles: number;
  bytes: number;
  schemaVersion: number;
  path: string;
}

export interface SessionCandidateFilters {
  sources?: NativeSessionSource[];
  cwd?: string;
  project?: string;
  after?: number;
  currentCwd?: string;
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function boundedJoin(values: Array<string | undefined>, maxLength: number): string {
  let output = "";
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    const remaining = maxLength - output.length;
    if (remaining <= 0) break;
    output += `${output ? "\n" : ""}${normalized.slice(0, remaining)}`;
  }
  return output.toLocaleLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function ftsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"*`;
}

function requiresLikeFallback(term: string): boolean {
  return [...term].length < 3 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
}

export class SessionDatabase {
  private readonly db: Database;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (basename(path) === "sessions.db") chmodSync(directory, 0o700);
    try { chmodSync(path, 0o600); } catch {}
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) withSessionIndexLockSync(path, () => this.migrate());
    this.secureFiles();
  }

  private migrate(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === SCHEMA_VERSION) return;
    this.db.exec(`
      DROP TABLE IF EXISTS search_fts;
      DROP TABLE IF EXISTS search_docs;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS source_files;
      DROP TABLE IF EXISTS sessions;
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        cwd TEXT,
        project_name TEXT,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE
      );
      CREATE INDEX sessions_recent_idx ON sessions(updated_at DESC);
      CREATE INDEX sessions_source_recent_idx ON sessions(source, updated_at DESC);
      CREATE TABLE messages (
        session_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(session_key, ordinal),
        FOREIGN KEY(session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );
      CREATE TABLE source_files (
        source_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        parser_version INTEGER NOT NULL,
        session_key TEXT
      );
      CREATE VIRTUAL TABLE search_fts USING fts5(
        session_key UNINDEXED,
        default_content,
        deep_content,
        tokenize = 'unicode61'
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  }

  private secureFiles(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try { chmodSync(file, 0o600); } catch {}
    }
  }

  replaceSession(parsed: ParsedNativeSession, file: { size: number; mtimeMs: number }): void {
    const transaction = this.db.transaction(() => {
      this.db.query("DELETE FROM sessions WHERE source_path = ? AND session_key != ?").run(parsed.session.sourcePath, parsed.session.key);
      this.db.query(`INSERT INTO sessions(session_key,source,cwd,project_name,updated_at,data,source_path) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(session_key) DO UPDATE SET source=excluded.source,cwd=excluded.cwd,project_name=excluded.project_name,updated_at=excluded.updated_at,data=excluded.data,source_path=excluded.source_path`)
        .run(parsed.session.key, parsed.session.source, parsed.session.cwd ?? null, parsed.session.projectName ?? null, parsed.session.updatedAt, JSON.stringify(parsed.session), parsed.session.sourcePath);

      this.db.query("DELETE FROM messages WHERE session_key = ?").run(parsed.session.key);
      const detailMessages = parsed.messages.slice(-MAX_DETAIL_MESSAGES);
      const insertMessage = this.db.query("INSERT INTO messages(session_key,ordinal,data) VALUES(?,?,?)");
      for (const message of detailMessages) {
        insertMessage.run(parsed.session.key, message.ordinal, JSON.stringify({ ...message, text: truncateText(message.text, MAX_MESSAGE_TEXT) }));
      }

      const metadata = [parsed.session.title, parsed.session.projectName, parsed.session.cwd];
      const defaultContent = boundedJoin([
        ...metadata,
        ...parsed.messages.filter((message) => message.defaultSearchable).map((message) => message.text),
      ], MAX_DEFAULT_SEARCH_TEXT);
      const deepContent = boundedJoin(
        parsed.messages.filter((message) => message.deepSearchable && !message.defaultSearchable).map((message) => message.text),
        MAX_DEEP_SEARCH_TEXT,
      );
      this.db.query("DELETE FROM search_fts WHERE session_key = ?").run(parsed.session.key);
      this.db.query("INSERT INTO search_fts(session_key,default_content,deep_content) VALUES(?,?,?)")
        .run(parsed.session.key, defaultContent, deepContent);
      this.db.query(`INSERT INTO source_files(source_path,size,mtime_ms,parser_version,session_key) VALUES(?,?,?,?,?)
        ON CONFLICT(source_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,parser_version=excluded.parser_version,session_key=excluded.session_key`)
        .run(parsed.session.sourcePath, file.size, file.mtimeMs, parsed.parserVersion, parsed.session.key);
    });
    transaction();
    this.secureFiles();
  }

  getSession(key: string): UnifiedSession | null {
    const row = this.db.query("SELECT data FROM sessions WHERE session_key = ?").get(key) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  getMessages(key: string): ParsedSessionMessage[] {
    return (this.db.query("SELECT data FROM messages WHERE session_key = ? ORDER BY ordinal").all(key) as { data: string }[]).map((row) => JSON.parse(row.data));
  }

  getRecentMessages(key: string, limit: number): ParsedSessionMessage[] {
    const rows = this.db.query("SELECT data FROM messages WHERE session_key = ? ORDER BY ordinal DESC LIMIT ?").all(key, limit) as { data: string }[];
    return rows.reverse().map((row) => JSON.parse(row.data));
  }

  listSessions(): UnifiedSession[] {
    return (this.db.query("SELECT data FROM sessions ORDER BY updated_at DESC").all() as { data: string }[]).map((row) => JSON.parse(row.data));
  }

  getSourceFile(path: string): { size: number; mtimeMs: number; parserVersion: number; sessionKey?: string } | null {
    const row = this.db.query("SELECT size,mtime_ms,parser_version,session_key FROM source_files WHERE source_path = ?").get(path) as { size: number; mtime_ms: number; parser_version: number; session_key?: string } | null;
    return row ? { size: row.size, mtimeMs: row.mtime_ms, parserVersion: row.parser_version, sessionKey: row.session_key } : null;
  }

  searchCandidates(terms: string[], deep: boolean, limit = 200, filters: SessionCandidateFilters = {}): Array<{ session: UnifiedSession; text: string }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    let join = "";
    let textExpression = "''";
    if (terms.length) {
      join = "JOIN search_fts f ON f.session_key = s.session_key";
      const useLikeFallback = terms.some(requiresLikeFallback);
      if (useLikeFallback) {
        for (const term of terms) {
          where.push(deep ? "(f.default_content LIKE ? ESCAPE '\\' OR f.deep_content LIKE ? ESCAPE '\\')" : "f.default_content LIKE ? ESCAPE '\\'");
          const pattern = `%${escapeLike(term)}%`;
          params.push(pattern);
          if (deep) params.push(pattern);
        }
      } else {
        const query = terms.map((term) => deep ? ftsTerm(term) : `default_content:${ftsTerm(term)}`).join(" AND ");
        where.push("search_fts MATCH ?");
        params.push(query);
      }
      textExpression = deep ? "f.default_content || char(10) || f.deep_content" : "f.default_content";
    }
    if (filters.sources?.length) {
      where.push(`s.source IN (${filters.sources.map(() => "?").join(",")})`);
      params.push(...filters.sources);
    }
    if (filters.cwd) {
      where.push("s.cwd LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filters.cwd.toLocaleLowerCase())}%`);
    }
    if (filters.project) {
      where.push("s.project_name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filters.project.toLocaleLowerCase())}%`);
    }
    if (filters.after !== undefined) {
      where.push("s.updated_at >= ?");
      params.push(filters.after);
    }
    const ranking: string[] = [];
    const rankingParams: Array<string | number> = [];
    for (const term of terms) {
      ranking.push("CASE WHEN instr(lower(coalesce(json_extract(s.data, '$.title'), '')), ?) > 0 THEN 8 ELSE 0 END");
      rankingParams.push(term);
      ranking.push("CASE WHEN instr(lower(coalesce(s.project_name, '')), ?) > 0 THEN 5 ELSE 0 END");
      rankingParams.push(term);
    }
    if (terms.length && filters.currentCwd) {
      ranking.push("CASE WHEN s.cwd = ? THEN 4 ELSE 0 END");
      rankingParams.push(filters.currentCwd);
    }
    params.push(...rankingParams, limit);
    const order = ranking.length ? `(${ranking.join(" + ")}) DESC, s.updated_at DESC` : "s.updated_at DESC";
    const sql = `SELECT s.data, ${textExpression} AS text FROM sessions s ${join} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
    const rows = this.db.query(sql).all(...params) as Array<{ data: string; text: string }>;
    return rows.map((row) => ({ session: JSON.parse(row.data), text: row.text }));
  }

  clear(): void {
    this.db.exec("DELETE FROM search_fts; DELETE FROM messages; DELETE FROM source_files; DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    this.secureFiles();
  }

  optimize(): void {
    this.db.exec("INSERT INTO search_fts(search_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(0);");
    this.secureFiles();
  }

  status(): SessionIndexStatus {
    let bytes = 0;
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try { bytes += statSync(file).size; } catch {}
    }
    const sessions = this.db.query("SELECT count(*) AS count FROM sessions").get() as { count: number };
    const sourceFiles = this.db.query("SELECT count(*) AS count FROM source_files").get() as { count: number };
    return { sessions: sessions.count, sourceFiles: sourceFiles.count, bytes, schemaVersion: SCHEMA_VERSION, path: this.path };
  }

  close(): void { this.db.close(); }
}
