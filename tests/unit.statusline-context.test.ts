import { describe, expect, it } from "bun:test";
import {
  ContextSegment,
  resolveAutoCompactThreshold,
  resolveAutoCompactWindow,
  resolveContextLimit,
  resolveStatusLineContextLimit,
  statusLineUsageTokens,
} from "../src/statusline/segments/context";
import type { StatusLineInput } from "../src/statusline/types";

async function withContextEnv(
  env: { tako?: string; autoCompact?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const previousTako = process.env.TAKO_MODEL_CONTEXT_WINDOW;
  const previousAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (env.tako === undefined) delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
  else process.env.TAKO_MODEL_CONTEXT_WINDOW = env.tako;
  if (env.autoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = env.autoCompact;
  try {
    await fn();
  } finally {
    if (previousTako === undefined) delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
    else process.env.TAKO_MODEL_CONTEXT_WINDOW = previousTako;
    if (previousAutoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousAutoCompact;
  }
}

describe("statusline context limit", () => {
  it("prefers the instance-specific launch value", () => {
    expect(resolveContextLimit("claude-opus-4-8[1m]", "950000")).toBe(950000);
    expect(resolveContextLimit("gpt-5.5", "272000")).toBe(272000);
  });

  it("falls back to catalog metadata for invalid launch values", () => {
    expect(resolveContextLimit("claude-haiku-4-5", "0")).toBe(200000);
    expect(resolveContextLimit("claude-haiku-4-5", "not-a-number")).toBe(200000);
  });

  it("falls back to 200k for unknown models", () => {
    expect(resolveContextLimit("unknown-instance-model", "")).toBe(200000);
  });

  it("prefers Claude Code's context_window_size over the launch env", () => {
    const input = {
      model: { id: "unknown-instance-model", display_name: "Unknown" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 1_000_000,
        current_usage: null,
        used_percentage: null,
        remaining_percentage: null,
      },
    } satisfies StatusLineInput;

    expect(resolveStatusLineContextLimit(input)).toBe(1_000_000);
  });

  it("falls back to the launch env when context_window_size is absent", async () => {
    const input = {
      model: { id: "unknown-instance-model", display_name: "Unknown" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
    } satisfies StatusLineInput;

    await withContextEnv({ tako: "262000" }, async () => {
      expect(resolveStatusLineContextLimit(input)).toBe(262000);
    });
  });

  it("falls back to the catalog when both input and env are absent", async () => {
    const input = {
      model: { id: "unknown-instance-model", display_name: "Unknown" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
    } satisfies StatusLineInput;

    await withContextEnv({ tako: undefined }, async () => {
      expect(resolveStatusLineContextLimit(input)).toBe(200000);
    });
  });

  it("uses a lower CLAUDE_CODE_AUTO_COMPACT_WINDOW when configured", () => {
    expect(resolveAutoCompactWindow(1_000_000, "450000")).toBe(450000);
    expect(resolveAutoCompactWindow(450_000, "1000000")).toBe(450000);
    expect(resolveAutoCompactWindow(1_000_000, undefined)).toBe(1_000_000);
  });

  it("matches Claude Code auto-compaction thresholds", () => {
    // window - min(maxOutputTokens, 20000) - 13000
    expect(resolveAutoCompactThreshold(950_000)).toBe(917_000);
    expect(resolveAutoCompactThreshold(272_000)).toBe(239_000);
    expect(resolveAutoCompactThreshold(1_000_000)).toBe(967_000);
    expect(resolveAutoCompactThreshold(272_000, 8192)).toBe(250_808);
  });

  it("uses Claude Code current context usage without output tokens", () => {
    const input = {
      model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 1_000_000,
        current_usage: {
          input_tokens: 57_073,
          output_tokens: 666,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 52_736,
        },
        used_percentage: 11,
        remaining_percentage: 89,
      },
    } satisfies StatusLineInput;

    expect(statusLineUsageTokens(input)).toBe(109_809);
  });

  it("returns null before Claude Code has current usage", () => {
    const input = {
      model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 1_000_000,
        current_usage: null,
        used_percentage: null,
        remaining_percentage: null,
      },
    } satisfies StatusLineInput;

    expect(statusLineUsageTokens(input)).toBeNull();
  });

  it("renders remaining percentage against the auto-compaction threshold", async () => {
    const input = {
      model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 1_000_000,
        current_usage: {
          input_tokens: 57_073,
          output_tokens: 666,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 52_736,
        },
        used_percentage: 11,
        remaining_percentage: 89,
      },
    } satisfies StatusLineInput;

    await withContextEnv({ tako: "950000", autoCompact: "1000000" }, async () => {
      // context_window_size=1M, auto-compact window=1M → threshold 967,000
      expect(await new ContextSegment().render(input)).toContain("89%");
    });
  });

  it("does not display zero before the auto-compaction threshold", async () => {
    const threshold = resolveAutoCompactThreshold(272_000);
    const input = {
      model: { id: "gpt-5.6", display_name: "GPT-5.6" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 272_000,
        current_usage: {
          input_tokens: threshold - 1,
          output_tokens: 1_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: null,
        remaining_percentage: null,
      },
    } satisfies StatusLineInput;

    await withContextEnv({ tako: "272000", autoCompact: "272000" }, async () => {
      expect(await new ContextSegment().render(input)).toContain("1%");
    });
  });

  it("reaches zero exactly at the auto-compaction threshold", async () => {
    const threshold = resolveAutoCompactThreshold(272_000);
    const input = {
      model: { id: "gpt-5.6", display_name: "GPT-5.6" },
      workspace: { current_dir: "/tmp" },
      transcript_path: "/tmp/transcript.jsonl",
      context_window: {
        context_window_size: 272_000,
        current_usage: {
          input_tokens: threshold,
          output_tokens: 1_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        used_percentage: null,
        remaining_percentage: null,
      },
    } satisfies StatusLineInput;

    await withContextEnv({ tako: "272000", autoCompact: "272000" }, async () => {
      expect(await new ContextSegment().render(input)).toContain("0%");
    });
  });
});
