import { describe, expect, it } from "bun:test";
import { summarizeInstallError } from "../src/error-format";

describe("install error formatting", () => {
  it("summarizes HTTP 524 as an upstream timeout", () => {
    const raw = [
      "some bundled output",
      "error: HTTP error! status: 524",
      "more bundled output",
    ].join("\n");

    const summary = summarizeInstallError(raw);

    expect(summary).toContain("HTTP 524");
    expect(summary).toContain("超时");
    expect(summary.length).toBeLessThan(120);
  });

  it("returns a short relevant line instead of a huge raw log", () => {
    const raw = `${"x".repeat(2000)}\nerror: network timeout while downloading package`;

    expect(summarizeInstallError(raw)).toBe("error: network timeout while downloading package");
  });
});
