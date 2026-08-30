import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseClaudeSessionText } from "../src/sessions/adapters/claude";
import { parseCodexSessionText } from "../src/sessions/adapters/codex";
import { parseGeminiSessionText } from "../src/sessions/adapters/gemini";
import { parseGrokSessionText, readGrokSummary } from "../src/sessions/adapters/grok";
import { parsePiSessionText } from "../src/sessions/adapters/pi";
import { SESSION_PARSERS } from "../src/sessions/registry";
import { discoverNativeSessions, grokCwdFromEncodedName, grokSessionIdFromPath, isGeminiSessionPath, isGrokSessionPath, isPiSessionPath } from "../src/sessions/discovery";
import { isNativeSessionSource } from "../src/sessions/types";

const fixtures = join(import.meta.dir, "fixtures", "sessions");
const tempHomes: string[] = [];
afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native session adapters", () => {
  it("normalizes Claude metadata and separates default from deep content", async () => {
    const text = await readFile(join(fixtures, "claude-basic.jsonl"), "utf8");
    const parsed = parseClaudeSessionText(text, "/tmp/claude-basic.jsonl");

    expect(parsed?.session).toMatchObject({
      key: "claude:claude-session-1",
      nativeId: "claude-session-1",
      source: "claude",
      title: "修复支付回调签名",
      cwd: "/work/payments",
      projectName: "payments",
      resumeCapability: "direct",
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "reasoning", "assistant"]);
    expect(parsed?.messages.find((message) => message.role === "reasoning")).toMatchObject({
      defaultSearchable: false,
      deepSearchable: true,
    });
    expect(parsed?.messages.some((message) => message.text.includes("system template"))).toBe(false);
  });

  it("filters Codex boilerplate while retaining tool output for deep search", async () => {
    const text = await readFile(join(fixtures, "codex-basic.jsonl"), "utf8");
    const parsed = parseCodexSessionText(text, "/tmp/codex-basic.jsonl");

    expect(parsed?.session).toMatchObject({
      key: "codex:codex-session-1",
      cwd: "/work/compass",
      projectName: "compass",
      title: "帮我定位 HTTP 200 但 output_tokens=0",
      resumeCapability: "direct",
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(parsed?.messages.some((message) => message.text.includes("environment_context"))).toBe(false);
    expect(parsed?.messages.at(-1)).toMatchObject({ role: "tool", defaultSearchable: false, deepSearchable: true });
  });

  it("normalizes Gemini JSONL chat files as view-only sessions", async () => {
    const text = await readFile(join(fixtures, "gemini-basic.jsonl"), "utf8");
    const parsed = parseGeminiSessionText(text, "/tmp/.gemini/tmp/ccgo/chats/session.jsonl", "/work/ccgo");

    expect(parsed?.session).toMatchObject({
      key: "gemini:gemini-session-1",
      cwd: "/work/ccgo",
      projectName: "ccgo",
      title: "帮我查看 Gemini 历史会话",
      resumeCapability: "unsupported",
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("normalizes Gemini single-object JSON chat files", async () => {
    const text = await readFile(join(fixtures, "gemini-basic.json"), "utf8");
    const parsed = parseGeminiSessionText(text, "/tmp/.gemini/tmp/ccgo/chats/session.json", "/work/ccgo");
    expect(parsed?.session).toMatchObject({
      key: "gemini:gemini-json-session-1",
      title: "查找旧会话",
      createdAt: Date.parse("2026-07-10T10:00:00.000Z"),
      updatedAt: Date.parse("2026-07-10T10:01:00.000Z"),
      resumeCapability: "unsupported",
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("includes Codex reasoning and tool-call payloads in deep-search messages", () => {
    const text = [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-deep", cwd: "/work/app" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "find it" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "private clue" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"rg needle\"}" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "patch marker" } }),
    ].join("\n");
    const parsed = parseCodexSessionText(text, "/tmp/codex-deep.jsonl");
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "reasoning", "tool", "tool"]);
    expect(parsed?.messages.slice(1).every((message) => !message.defaultSearchable && message.deepSearchable)).toBe(true);
  });

  it("ignores malformed lines and an incomplete JSONL tail", () => {
    const text = [
      JSON.stringify({ type: "session_meta", payload: { id: "safe-id", cwd: "/tmp/project" } }),
      "not json",
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] } }),
      '{"type":"response_item"',
    ].join("\n");

    const parsed = parseCodexSessionText(text, "/tmp/safe.jsonl");
    expect(parsed?.session.nativeId).toBe("safe-id");
    expect(parsed?.messages.map((message) => message.text)).toEqual(["keep me"]);
  });

  it("recognizes Gemini chat paths on Unix and Windows", () => {
    expect(isGeminiSessionPath("/tmp/project/chats/session-1.json")).toBe(true);
    expect(isGeminiSessionPath("C:\\Users\\me\\.gemini\\tmp\\project\\chats\\session-1.jsonl")).toBe(true);
  });

  it("normalizes Pi metadata, thinking, tools, and named sessions", async () => {
    const text = await readFile(join(fixtures, "pi-basic.jsonl"), "utf8");
    const parsed = parsePiSessionText(text, "/tmp/--work-docs--/2026-08-22T06-49-56-438Z_01a0283b-b3d6-7b03-b37e-0498f8742df4.jsonl");

    expect(parsed?.session).toMatchObject({
      key: "pi:01a0283b-b3d6-7b03-b37e-0498f8742df4",
      nativeId: "01a0283b-b3d6-7b03-b37e-0498f8742df4",
      source: "pi",
      title: "飞书文档读取",
      cwd: "/work/docs",
      projectName: "docs",
      model: "tako/grok-4.6",
      resumeCapability: "direct",
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "reasoning", "assistant", "tool", "tool", "tool"]);
    expect(parsed?.messages.find((message) => message.role === "reasoning")).toMatchObject({
      text: "先确认文档权限",
      defaultSearchable: false,
      deepSearchable: true,
    });
    expect(parsed?.messages.some((message) => message.text.includes("read:"))).toBe(true);
    expect(parsed?.messages.some((message) => message.text.includes("支付回调"))).toBe(true);
  });

  it("recovers a Pi session id from the filename when the header is missing", () => {
    const text = JSON.stringify({
      type: "message",
      timestamp: "2026-08-22T06:50:09.225Z",
      message: { role: "user", content: [{ type: "text", text: "hello from pi" }] },
    });
    const parsed = parsePiSessionText(
      text,
      "/tmp/--Users-hashiro--/2026-08-22T06-49-56-438Z_01a0283b-b3d6-7b03-b37e-0498f8742df4.jsonl",
    );
    expect(parsed?.session.nativeId).toBe("01a0283b-b3d6-7b03-b37e-0498f8742df4");
    expect(parsed?.messages.map((message) => message.text)).toEqual(["hello from pi"]);
  });

  it("recognizes Pi session paths on Unix and Windows", () => {
    expect(isPiSessionPath("/Users/me/.pi/agent/sessions/--work--/2026-08-22T06-49-56-438Z_01a0283b-b3d6-7b03-b37e-0498f8742df4.jsonl")).toBe(true);
    expect(isPiSessionPath("C:\\Users\\me\\.pi\\agent\\sessions\\--work--\\2026-08-22T06-49-56-438Z_01a0283b-b3d6-7b03-b37e-0498f8742df4.jsonl")).toBe(true);
    expect(isPiSessionPath("/Users/me/.pi/agent/sessions/--work--/notes.jsonl")).toBe(false);
  });

  it("normalizes Grok ACP updates and concatenates streamed chunks", async () => {
    const text = await readFile(join(fixtures, "grok-basic.jsonl"), "utf8");
    const parsed = parseGrokSessionText(
      text,
      "/tmp/.grok/sessions/%2Fwork%2Fdocs/01a0511f-64a7-7b51-b22a-2c642ccd20c1/updates.jsonl",
      "/work/docs",
    );

    expect(parsed?.session).toMatchObject({
      key: "grok:01a0511f-64a7-7b51-b22a-2c642ccd20c1",
      nativeId: "01a0511f-64a7-7b51-b22a-2c642ccd20c1",
      source: "grok",
      title: "帮我看下我的电脑性能怎么样？",
      cwd: "/work/docs",
      projectName: "docs",
      model: "grok-4.6",
      resumeCapability: "direct",
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "reasoning", "assistant", "tool", "tool"]);
    expect(parsed?.messages.find((message) => message.role === "assistant")?.text).toBe("我先采集硬件信息。");
    expect(parsed?.messages.find((message) => message.role === "reasoning")).toMatchObject({
      text: "先采集 CPU 和内存",
      defaultSearchable: false,
      deepSearchable: true,
    });
    expect(parsed?.messages.some((message) => message.text.includes("sysctl"))).toBe(true);
    expect(parsed?.messages.some((message) => message.text.includes("Apple M4 Pro"))).toBe(true);
  });

  it("prefers Grok summary.json title and recovers the session id from the path", () => {
    const text = JSON.stringify({
      timestamp: 1788067391,
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Reply with exactly tako-cli-ok" },
        },
      },
    });
    const parsed = parseGrokSessionText(
      text,
      "/tmp/.grok/sessions/%2Fwork%2Fapp/01a0511f-0eb8-73c3-9b3f-6bc8b7907c99/updates.jsonl",
      "/work/app",
      { generated_title: "Reply with exactly tako-cli-ok", current_model_id: "grok-4.6" },
    );
    expect(parsed?.session).toMatchObject({
      key: "grok:01a0511f-0eb8-73c3-9b3f-6bc8b7907c99",
      title: "Reply with exactly tako-cli-ok",
      model: "grok-4.6",
    });
  });

  it("recognizes Grok session paths and decodes the encoded cwd group", () => {
    expect(isGrokSessionPath("/Users/me/.grok/sessions/%2Fwork%2Fapp/01a0511f-0eb8-73c3-9b3f-6bc8b7907c99/updates.jsonl")).toBe(true);
    expect(isGrokSessionPath("C:\\Users\\me\\.grok\\sessions\\%2Fwork%2Fapp\\01a0511f-0eb8-73c3-9b3f-6bc8b7907c99\\updates.jsonl")).toBe(true);
    expect(isGrokSessionPath("/Users/me/.grok/sessions/%2Fwork%2Fapp/01a0511f-0eb8-73c3-9b3f-6bc8b7907c99/chat_history.jsonl")).toBe(false);
    expect(grokCwdFromEncodedName("%2Fwork%2Fapp")).toBe("/work/app");
  });

  it("discovers Grok updates.jsonl and decodes the workspace cwd", async () => {
    const home = join(tmpdir(), `grok-home-${crypto.randomUUID()}`);
    tempHomes.push(home);
    const sessionDir = join(home, ".grok", "sessions", encodeURIComponent("/work/docs"), "01a0511f-64a7-7b51-b22a-2c642ccd20c1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "updates.jsonl"), "{}\n");
    const found = await discoverNativeSessions(home);
    expect(found.some((candidate) => (
      candidate.source === "grok"
      && candidate.cwd === "/work/docs"
      && candidate.path.endsWith("updates.jsonl")
    ))).toBe(true);
  });

  it("reads Grok cwd from .cwd when the group name is a hashed slug", async () => {
    const home = join(tmpdir(), `grok-home-${crypto.randomUUID()}`);
    tempHomes.push(home);
    const groupDir = join(home, ".grok", "sessions", "work-docs-a1b2");
    const sessionDir = join(groupDir, "01a0511f-64a7-7b51-b22a-2c642ccd20c1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(groupDir, ".cwd"), "/work/docs\n");
    await writeFile(join(sessionDir, "updates.jsonl"), "{}\n");
    const found = await discoverNativeSessions(home);
    expect(found.some((candidate) => candidate.source === "grok" && candidate.cwd === "/work/docs")).toBe(true);
  });

  it("reads sibling summary.json when the parser is not given an override", async () => {
    const root = join(tmpdir(), `grok-summary-${crypto.randomUUID()}`);
    tempHomes.push(root);
    await mkdir(root, { recursive: true });
    const sourcePath = join(root, "updates.jsonl");
    await writeFile(sourcePath, `${JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "raw prompt" } } },
    })}\n`);
    await writeFile(join(root, "summary.json"), JSON.stringify({
      info: { id: "01a0511f-0eb8-73c3-9b3f-6bc8b7907c99", cwd: "/work/app" },
      generated_title: "生成标题",
      current_model_id: "grok-4.6",
    }));
    expect(readGrokSummary(sourcePath)).toMatchObject({ generated_title: "生成标题" });
    const parsed = parseGrokSessionText(await readFile(sourcePath, "utf8"), sourcePath);
    expect(parsed?.session).toMatchObject({
      nativeId: "01a0511f-0eb8-73c3-9b3f-6bc8b7907c99",
      title: "生成标题",
      cwd: "/work/app",
      model: "grok-4.6",
    });
  });

  it("ignores malformed Grok JSONL and returns null without a session id", () => {
    const text = [
      "not json",
      JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "keep me" } } } }),
      '{"method":"session/update"',
    ].join("\n");
    expect(parseGrokSessionText(text, "/tmp/updates.jsonl")).toBeNull();
    expect(parseGrokSessionText(text, "/tmp/.grok/sessions/%2Fwork/01a0511f-0eb8-73c3-9b3f-6bc8b7907c99/updates.jsonl")?.messages.map((message) => message.text)).toEqual(["keep me"]);
  });

  it("skips in-progress Grok tool updates and registers grok as a searchable source", () => {
    const text = JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "01a0511f-0eb8-73c3-9b3f-6bc8b7907c99",
        update: { sessionUpdate: "tool_call_update", status: "in_progress", title: "run_terminal_command", rawOutput: { output_for_prompt: "partial" } },
      },
    });
    const parsed = parseGrokSessionText(text, "/tmp/updates.jsonl");
    expect(parsed?.messages).toEqual([]);
    expect(SESSION_PARSERS.grok).toBe(parseGrokSessionText);
    expect(isNativeSessionSource("grok")).toBe(true);
    expect(isNativeSessionSource("unknown")).toBe(false);
    expect(grokSessionIdFromPath("/tmp/.grok/sessions/x/01a0511f-0eb8-73c3-9b3f-6bc8b7907c99/updates.jsonl")).toBe("01a0511f-0eb8-73c3-9b3f-6bc8b7907c99");
  });
});
