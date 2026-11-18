import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agyConversationIdFromPath,
  isAgyTranscriptPath,
  parseAgySessionText,
  stripAgyUserEnvelope,
} from "../src/sessions/adapters/agy";
import { SessionDatabase } from "../src/sessions/database";
import { discoverNativeSessions, readAgyConversationSummaries } from "../src/sessions/discovery";
import { indexSessionCandidates } from "../src/sessions/indexer";
import { SESSION_PARSERS } from "../src/sessions/registry";
import { searchSessions } from "../src/sessions/search";
import {
  isNativeSessionSource,
  NATIVE_SESSION_SOURCES,
  sessionSourceColor,
  sessionSourceLabel,
} from "../src/sessions/types";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Antigravity (agy) native session adapter & discovery", () => {
  it("registers agy in NATIVE_SESSION_SOURCES and session display helpers", () => {
    expect(NATIVE_SESSION_SOURCES).toContain("agy");
    expect(isNativeSessionSource("agy")).toBe(true);
    expect(sessionSourceLabel("agy")).toBe("Antigravity");
    expect(sessionSourceColor("agy")).toBe("green");
    expect(SESSION_PARSERS.agy).toBe(parseAgySessionText);
  });

  it("matches transcript.jsonl paths across Unix and Windows and extracts conversation UUID", () => {
    const id = "3950030c-a9ed-4562-b388-d0eca579abf6";
    const unixPath = `/Users/me/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
    const winPath = `C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\${id}\\.system_generated\\logs\\transcript.jsonl`;
    const fullPath = `/Users/me/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;

    expect(isAgyTranscriptPath(unixPath)).toBe(true);
    expect(isAgyTranscriptPath(winPath)).toBe(true);
    expect(isAgyTranscriptPath(fullPath)).toBe(false);
    expect(agyConversationIdFromPath(unixPath)).toBe(id);
    expect(agyConversationIdFromPath(winPath)).toBe(id);
    expect(agyConversationIdFromPath(fullPath)).toBeUndefined();
  });

  it("strips Antigravity XML envelopes cleanly", () => {
    const wrapped = [
      "<CONTEXT_SUMMARY>old context</CONTEXT_SUMMARY>",
      "<USER_REQUEST>",
      "帮我优化 tako 启动速度",
      "</USER_REQUEST>",
      "<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>",
    ].join("\n");
    expect(stripAgyUserEnvelope(wrapped)).toBe("帮我优化 tako 启动速度");

    const multi = "<USER_REQUEST>part 1</USER_REQUEST>\nnoise\n<USER_REQUEST>part 2</USER_REQUEST>";
    expect(stripAgyUserEnvelope(multi)).toBe("part 1\n\npart 2");

    const plainWithMeta = "直接提问内容\n<USER_SETTINGS_CHANGE>mode=fast</USER_SETTINGS_CHANGE>\n<SYSTEM_MESSAGE>sys</SYSTEM_MESSAGE>";
    expect(stripAgyUserEnvelope(plainWithMeta)).toBe("直接提问内容");

    const subagentPrompt =
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>do work</SYSTEM_MESSAGE>";
    expect(stripAgyUserEnvelope(subagentPrompt)).toBe("");
  });

  it("parses main agy transcripts, extracts fallback cwd, and filters out subagent transcripts", () => {
    const convId = "11111111-2222-3333-4444-555555555555";
    const transcriptPath = `/tmp/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_PROMPT",
        created_at: "2026-11-18T10:00:00Z",
        content: "Active Workspaces:\n- /work/tako-cli\nCommand Working Directory: /work/tako-cli/packages/core",
      }),
      JSON.stringify({
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-18T10:01:00Z",
        content: "<USER_REQUEST>实现 agy 历史会话检索</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-opus-4-6",
        created_at: "2026-11-18T10:02:00Z",
        thinking: "先检查 transcript.jsonl 结构",
        content: "已完成 agy 会话适配器实现。",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-11-18T10:02:30Z",
        content: "ignored generic step",
      }),
    ].join("\n");

    const parsed = parseAgySessionText(lines, transcriptPath, undefined, { title: "AGY 会话索引" });
    expect(parsed).not.toBeNull();
    expect(parsed?.session).toMatchObject({
      key: `agy:${convId}`,
      nativeId: convId,
      source: "agy",
      title: "AGY 会话索引",
      cwd: "/work/tako-cli/packages/core",
      projectName: "core",
      model: "claude-opus-4-6",
      userMessageCount: 1,
      assistantMessageCount: 1,
      preview: "已完成 agy 会话适配器实现。",
      resumeCapability: "direct",
    });
    expect(parsed?.messages.map((m) => m.role)).toEqual(["user", "reasoning", "assistant"]);

    // Subagent session without USER_INPUT / USER_EXPLICIT must return null
    const subagentLines = [
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-18T10:00:00Z",
        content: "<SYSTEM_MESSAGE>Subagent task brief</SYSTEM_MESSAGE>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-18T10:01:00Z",
        content: "Subagent finished.",
      }),
    ].join("\n");
    expect(parseAgySessionText(subagentLines, transcriptPath)).toBeNull();
  });

  it("reads conversation_summaries.db, skips subagents in discoverNativeSessions, and indexes into search", async () => {
    const home = join(tmpdir(), `tako-agy-home-${crypto.randomUUID()}`);
    tempDirs.push(home);
    const agyHome = join(home, ".gemini", "antigravity-cli");
    await mkdir(agyHome, { recursive: true });

    const mainId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const subId = "ffffffff-1111-2222-3333-444444444444";
    const projectDir = join(home, "workspace", "my-repo");
    await mkdir(projectDir, { recursive: true });

    const sumDb = new Database(join(agyHome, "conversation_summaries.db"), { create: true });
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0
      );
    `);
    sumDb
      .query(
        "INSERT INTO conversation_summaries(conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?)",
      )
      .run(mainId, "主会话标题", JSON.stringify([pathToFileURL(projectDir).href]), "", 0);
    sumDb
      .query(
        "INSERT INTO conversation_summaries(conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?)",
      )
      .run(subId, "子代理会话", JSON.stringify([pathToFileURL(projectDir).href]), mainId, 1);
    sumDb.close();

    const summaries = readAgyConversationSummaries(agyHome);
    expect(summaries.get(mainId)).toEqual({
      title: "主会话标题",
      cwd: projectDir,
      isSubagent: false,
    });
    expect(summaries.get(subId)?.isSubagent).toBe(true);

    // Write both main and subagent transcripts
    for (const id of [mainId, subId]) {
      const logsDir = join(agyHome, "brain", id, ".system_generated", "logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, "transcript.jsonl"),
        [
          JSON.stringify({
            type: "USER_INPUT",
            created_at: "2026-11-18T12:00:00Z",
            content: `<USER_REQUEST>unique_keyword_${id.slice(0, 8)}</USER_REQUEST>`,
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-18T12:01:00Z",
            content: "assistant reply",
          }),
        ].join("\n"),
      );
    }

    const discovered = await discoverNativeSessions(home);
    const agyCandidates = discovered.filter((c) => c.source === "agy");
    expect(agyCandidates).toHaveLength(1);
    expect(agyCandidates[0]).toMatchObject({
      source: "agy",
      cwd: projectDir,
      title: "主会话标题",
    });

    const indexDb = new SessionDatabase(join(home, "sessions.db"));
    try {
      const indexed = await indexSessionCandidates(indexDb, agyCandidates, SESSION_PARSERS);
      expect(indexed).toBe(1);
      const hits = searchSessions(indexDb, "unique_keyword_aaaaaaaa", { sources: ["agy"] });
      expect(hits).toHaveLength(1);
      expect(hits[0].session).toMatchObject({
        key: `agy:${mainId}`,
        title: "主会话标题",
        cwd: projectDir,
        projectName: "my-repo",
      });
    } finally {
      indexDb.close();
    }
  });
});
