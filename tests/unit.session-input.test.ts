import { describe, expect, it } from "bun:test";
import { normalizeSessionSearchInput } from "../src/sessions/input";

describe("session search input", () => {
  it("accepts multi-character IME commits and pasted text", () => {
    expect(normalizeSessionSearchInput("支付回调", {})).toBe("支付回调");
    expect(normalizeSessionSearchInput("HTTP 200", {})).toBe("HTTP 200");
  });

  it("ignores control-key input and strips control characters", () => {
    expect(normalizeSessionSearchInput("c", { ctrl: true })).toBe("");
    expect(normalizeSessionSearchInput("hello\nworld", {})).toBe("helloworld");
  });
});
