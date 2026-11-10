import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  resolveInheritedDangerousFlag,
  withInheritedDangerousFlag,
} from "../src/clients/dangerous-flags";
import { claudeCodeClient, resolveClaudeContextWindow } from "../src/clients/claude-code";
import { _resetTakoCatalog, _setTakoCachePathForTest } from "../src/models";
import type { ProviderContext } from "../src/providers/types";

const claude = (ids: string[], seen?: { clientId: string; projectPath?: string }) => ({
  getLastSelectedOptionIds: async (clientId: string, projectPath?: string) => {
    if (seen) {
      seen.clientId = clientId;
      seen.projectPath = projectPath;
    }
    return ids;
  },
});

describe("inherited dangerous flags", () => {
  it("adds skip-permissions when the last selection had it", async () => {
    expect(await resolveInheritedDangerousFlag("claude-code", ["--resume", "id"], claude(["skip-permissions"])))
      .toBe("--dangerously-skip-permissions");
  });

  it("does not add skip-permissions when the user unchecked it", async () => {
    expect(await resolveInheritedDangerousFlag("claude-code", ["--resume", "id"], claude(["model-x"])))
      .toBeNull();
  });

  it("defaults to full access when there is no saved selection", async () => {
    expect(await resolveInheritedDangerousFlag("claude-code", ["--resume", "id"], claude([])))
      .toBe("--dangerously-skip-permissions");
  });

  it("does not duplicate an explicitly passed flag", async () => {
    expect(await resolveInheritedDangerousFlag(
      "claude-code",
      ["--dangerously-skip-permissions", "--resume", "id"],
      claude(["skip-permissions"]),
    )).toBeNull();
  });

  it("handles codex bypass-sandbox the same way", async () => {
    expect(await resolveInheritedDangerousFlag("codex", ["resume", "id"], claude(["bypass-sandbox"])))
      .toBe("--dangerously-bypass-approvals-and-sandbox");
  });

  it("ignores clients without a dangerous flag", async () => {
    expect(await resolveInheritedDangerousFlag("pi", ["--session", "id"], claude(["anything"])))
      .toBeNull();
  });

  it("passes the resume project path to the history reader", async () => {
    const seen: { clientId: string; projectPath?: string } = { clientId: "" };
    await withInheritedDangerousFlag("claude-code", ["--resume", "id"], {
      ...claude(["skip-permissions"], seen),
      projectPath: "/work/app",
    });
    expect(seen).toEqual({ clientId: "claude-code", projectPath: "/work/app" });
  });

  it("puts the flag before the existing args", async () => {
    expect(await withInheritedDangerousFlag("claude-code", ["--resume", "id"], claude(["skip-permissions"])))
      .toEqual(["--dangerously-skip-permissions", "--resume", "id"]);
  });
});

describe("resume context window", () => {
  it("uses provider.modelContextWindow for the provider's own model", () => {
    const provider: ProviderContext = {
      type: "custom",
      model: "my-model",
      modelContextWindow: 123_456,
      baseUrl: "https://example.invalid",
    };
    expect(resolveClaudeContextWindow(provider)).toBe(123_456);
  });

  it("does not apply modelContextWindow to a different resumed model", () => {
    const provider: ProviderContext = {
      type: "custom",
      model: "my-model",
      modelContextWindow: 123_456,
      baseUrl: "https://example.invalid",
    };
    expect(resolveClaudeContextWindow(provider, "another-model")).toBeUndefined();
  });

  it("honors the [1m] variant via the catalog", () => {
    expect(resolveClaudeContextWindow({ type: "anthropic", model: "claude-haiku-4-5[1m]" }))
      .toBe(1_000_000);
  });

  it("uses the tako provider catalog for the session model", async () => {
    const apiKey = "test-key";
    const fingerprint = createHash("sha256").update(apiKey).digest("hex");
    const path = join(tmpdir(), `tako-models-test-${process.pid}.json`);
    await Bun.write(path, JSON.stringify({
      version: 2,
      buckets: {
        [`https://example.invalid#claude#${fingerprint}`]: {
          fetchedAt: Date.now(),
          entries: [{
            id: "swe-2",
            displayName: "SWE-2",
            description: "",
            contextWindow: 262_000,
            sortOrder: 0,
            category: "chat",
          }],
        },
      },
    }));
    _resetTakoCatalog();
    _setTakoCachePathForTest(path);
    try {
      expect(resolveClaudeContextWindow(
        { type: "tako", baseUrl: "https://example.invalid", apiKey },
        "swe-2",
      )).toBe(262_000);
    } finally {
      _setTakoCachePathForTest(null);
      _resetTakoCatalog();
      await unlink(path).catch(() => {});
    }
  });

  it("exposes resume env vars on the claude client", () => {
    const env = claudeCodeClient.getModelEnvVars?.(
      { type: "anthropic", model: "claude-haiku-4-5" },
      "claude-haiku-4-5",
    );
    expect(env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      TAKO_MODEL_CONTEXT_WINDOW: "200000",
    });
  });

  it("does not set context env for claude subscription", () => {
    expect(claudeCodeClient.getModelEnvVars?.(
      { type: "claude-subscription" },
      "claude-haiku-4-5",
    )).toEqual({});
  });

  it("clears context env when an explicit model has no known window", () => {
    expect(claudeCodeClient.getModelEnvVars?.(
      {
        type: "custom",
        model: "my-model",
        modelContextWindow: 123_456,
        baseUrl: "https://example.invalid",
      },
      "unknown-model",
    )).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "",
      TAKO_MODEL_CONTEXT_WINDOW: "",
    });
  });
});
