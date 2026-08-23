import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseClaudeSessionText } from "../src/sessions/adapters/claude";
import { parseCodexSessionText } from "../src/sessions/adapters/codex";
import { parseGeminiSessionText } from "../src/sessions/adapters/gemini";
import { parsePiSessionText } from "../src/sessions/adapters/pi";
import { isGeminiSessionPath, isPiSessionPath } from "../src/sessions/discovery";

const fixtures = join(import.meta.dir, "fixtures", "sessions");

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
});
