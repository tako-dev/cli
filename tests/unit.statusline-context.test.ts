import { describe, expect, it } from "bun:test";
import { ContextSegment, resolveAutoCompactThreshold, resolveContextLimit, statusLineUsageTokens } from "../src/statusline/segments/context";
import type { StatusLineInput } from "../src/statusline/types";

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
    expect(resolveContextLimit("unknown-instance-model", undefined)).toBe(200000);
  });

  it("matches Claude Code auto-compaction thresholds", () => {
    expect(resolveAutoCompactThreshold(950_000)).toBe(753_446);
    expect(resolveAutoCompactThreshold(272_000)).toBe(211_046);
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

    const previous = process.env.TAKO_MODEL_CONTEXT_WINDOW;
    process.env.TAKO_MODEL_CONTEXT_WINDOW = "950000";
    try {
      expect(await new ContextSegment().render(input)).toContain("86%");
    } finally {
      if (previous === undefined) delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
      else process.env.TAKO_MODEL_CONTEXT_WINDOW = previous;
    }
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

    const previous = process.env.TAKO_MODEL_CONTEXT_WINDOW;
    process.env.TAKO_MODEL_CONTEXT_WINDOW = "272000";
    try {
      expect(await new ContextSegment().render(input)).toContain("1%");
    } finally {
      if (previous === undefined) delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
      else process.env.TAKO_MODEL_CONTEXT_WINDOW = previous;
    }
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

    const previous = process.env.TAKO_MODEL_CONTEXT_WINDOW;
    process.env.TAKO_MODEL_CONTEXT_WINDOW = "272000";
    try {
      expect(await new ContextSegment().render(input)).toContain("0%");
    } finally {
      if (previous === undefined) delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
      else process.env.TAKO_MODEL_CONTEXT_WINDOW = previous;
    }
  });
});
