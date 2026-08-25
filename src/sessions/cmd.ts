import { clearSessionIndex, openSessionDatabase, rebuildSessionIndex, refreshSessionIndex } from "./index";
import { searchSessions } from "./search";
import { resumeNativeSession } from "./resume";
import type { NativeSessionSource } from "./types";

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function afterTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const duration = /^(\d+)([dhw])$/i.exec(value);
  if (duration) {
    const unit = duration[2].toLowerCase();
    const days = Number(duration[1]) * (unit === "h" ? 1 / 24 : unit === "w" ? 7 : 1);
    return Date.now() - days * 86_400_000;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --after value: ${value}`);
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function searchQuery(args: string[], command: string): string {
  const values = command === "search" ? args.slice(1) : args;
  const flagsWithValues = new Set(["--source", "--cwd", "--project", "--after", "--limit"]);
  const query: string[] = [];
  for (let index = 0; index < values.length; index++) {
    if (flagsWithValues.has(values[index])) { index++; continue; }
    if (!values[index].startsWith("--")) query.push(values[index]);
  }
  return query.join(" ");
}

export async function runSessionsCommand(args: string[]): Promise<void> {
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const { startApp } = await import("../ui/ink");
    const { handleLaunchResult } = await import("../ui/shared/launch");
    const result = await startApp({ initialSessionSearch: true });
    if (result?.type === "launch") await handleLaunchResult(result);
    return;
  }
  const db = openSessionDatabase();
  try {
    const command = args[0] ?? "search";
    if (command === "index") {
      if (args.includes("--clear")) {
        await clearSessionIndex(db);
        console.log("Cleared the native session index.");
        return;
      }
      if (args.includes("--status")) {
        const status = db.status();
        console.log(`${status.sessions} sessions from ${status.sourceFiles} files · ${formatBytes(status.bytes)} · schema v${status.schemaVersion}\n${status.path}`);
        return;
      }
      const count = args.includes("--rebuild") ? await rebuildSessionIndex(db) : await refreshSessionIndex(db);
      console.log(`Indexed ${count} native session files.`);
      return;
    }
    await refreshSessionIndex(db);
    if (command === "show") {
      const session = db.getSession(args[1] ?? "");
      if (!session) throw new Error("Session not found");
      console.log(JSON.stringify({ session, messages: db.getMessages(session.key) }, null, 2));
      return;
    }
    if (command === "resume") {
      const session = db.getSession(args[1] ?? "");
      if (!session) throw new Error("Session not found");
      await resumeNativeSession(session);
      return;
    }
    const query = searchQuery(args, command);
    const sources = flag(args, "--source")?.split(",").filter((source): source is NativeSessionSource => source === "claude" || source === "codex" || source === "gemini");
    const limit = Number(flag(args, "--limit") ?? 50);
    const results = searchSessions(db, query, { deep: args.includes("--deep"), sources, cwd: flag(args, "--cwd"), project: flag(args, "--project"), after: afterTimestamp(flag(args, "--after")), limit: Number.isFinite(limit) && limit > 0 ? limit : 50, currentCwd: process.cwd() });
    if (args.includes("--json")) console.log(JSON.stringify(results, null, 2));
    else for (const result of results) console.log(`${result.session.key}\t${result.session.projectName ?? "-"}\t${result.session.title ?? "(untitled)"}\n  ${result.snippet.slice(0, 180)}`);
  } finally { db.close(); }
}
