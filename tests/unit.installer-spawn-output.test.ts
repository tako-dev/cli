import { describe, expect, it } from "bun:test";
import { looksLikeVersion } from "./e2e/spawn-output";

describe("installer version output", () => {
  it("accepts Pi versions across major releases", () => {
    for (const version of ["0.61.0", "1.4.0", "2.0.0", "v1.4.0", "1.4.0-beta.1", "1.4.0+build.2"]) {
      expect(looksLikeVersion(`${version}\n`, "pi")).toBe(true);
      expect(looksLikeVersion(`Pi ${version}\n`, "pi")).toBe(true);
    }
  });

  it("rejects empty output and Pi error messages", () => {
    for (const output of ["", "pi failed to start", "Error: expected Pi 1.4.0", "1.4", "1.4.0 crashed"]) {
      expect(looksLikeVersion(output, "pi")).toBe(false);
    }
  });

  it("retains Codex and Pi Web readiness detection", () => {
    expect(looksLikeVersion("codex-cli 0.149.0", "codex")).toBe(true);
    expect(looksLikeVersion("1.4.0", "codex")).toBe(false);
    expect(looksLikeVersion("Ready on http://localhost:3000", "pi-web")).toBe(true);
    expect(looksLikeVersion("Error: failed to bind", "pi-web")).toBe(false);
  });
});
