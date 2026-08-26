import { describe, expect, it } from "bun:test";
import { resolveCodexModel } from "../src/clients/codex";

describe("Codex model config resolution", () => {
  it("preserves the existing Codex model when Tako has no explicit override", () => {
    expect(resolveCodexModel("gpt-5.6-sol", undefined, ["bypass-sandbox"]))
      .toBe("gpt-5.6-sol");
  });

  it("keeps explicit Tako and provider model overrides above the existing config", () => {
    expect(resolveCodexModel("gpt-5.6-sol", "gpt-5.4", ["model-gpt-5.3-codex"]))
      .toBe("gpt-5.3-codex");
    expect(resolveCodexModel("gpt-5.6-sol", "gpt-5.4"))
      .toBe("gpt-5.4");
  });

  it("uses the bundled default only when no valid model is configured", () => {
    expect(resolveCodexModel("   ")).toBe("gpt-5.5");
    expect(resolveCodexModel(undefined)).toBe("gpt-5.5");
  });
});
