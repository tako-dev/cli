import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareResume, resumeArgs } from "../src/sessions/resume";
import type { UnifiedSession } from "../src/sessions/types";

function session(source: UnifiedSession["source"]): UnifiedSession {
  return { key: `${source}:id`, nativeId: "id", source, cwd: "/work/app", updatedAt: 1, userMessageCount: 0, assistantMessageCount: 0, preview: "", sourcePath: "/tmp/file", resumeCapability: source === "gemini" ? "unsupported" : "direct" };
}

describe("native session resume", () => {
  it("builds native Claude, Codex, Grok, and Pi resume commands", () => {
    expect(resumeArgs(session("claude"))).toEqual({ clientId: "claude-code", args: ["--resume", "id"] });
    expect(resumeArgs(session("codex"))).toEqual({ clientId: "codex", args: ["resume", "id", "-C", "/work/app"] });
    expect(resumeArgs(session("grok"))).toEqual({ clientId: "grok", args: ["--resume", "id"] });
    expect(resumeArgs(session("pi"))).toEqual({ clientId: "pi", args: ["--session", "id"] });
    expect(() => resumeArgs(session("gemini"))).toThrow("does not support resuming Gemini");
  });

  it("prepares a Grok resume in the original project directory", () => {
    const root = join(tmpdir(), `resume-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const sourcePath = join(root, "updates.jsonl");
    writeFileSync(sourcePath, "{}");
    const value = session("grok");
    value.sourcePath = sourcePath;
    value.cwd = root;
    expect(prepareResume(value)).toMatchObject({
      clientId: "grok",
      args: ["--resume", "id"],
      projectPath: root,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to an existing current directory and rejects stale source files", () => {
    const root = join(tmpdir(), `resume-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const value = session("codex");
    value.sourcePath = join(root, "session.jsonl");
    value.cwd = join(root, "missing");
    writeFileSync(value.sourcePath, "{}");
    expect(prepareResume(value, root)).toMatchObject({ projectPath: root, args: ["resume", "id", "-C", root] });
    value.sourcePath = join(root, "gone.jsonl");
    expect(() => prepareResume(value, root)).toThrow("source file no longer exists");
    rmSync(root, { recursive: true, force: true });
  });
});
