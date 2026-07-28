import { describe, expect, it } from "bun:test";
import { resolveContextLimit } from "../src/statusline/segments/context";

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
});
