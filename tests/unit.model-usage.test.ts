import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("model usage picks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-model-usage-"));
    const mod = await import("../src/model-usage");
    mod._setPathForTest(join(tmpDir, "model-usage.json"));
  });

  afterEach(async () => {
    const mod = await import("../src/model-usage");
    mod._setPathForTest(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty table for new users", async () => {
    const { getModelPickCounts } = await import("../src/model-usage");

    await expect(getModelPickCounts()).resolves.toEqual({});
  });

  it("decays existing picks before adding the current pick", async () => {
    const { getModelPickCounts, recordModelPicks } = await import("../src/model-usage");

    await recordModelPicks(["model-a"]);
    await recordModelPicks(["model-a"]);
    await recordModelPicks(["model-a"]);
    await recordModelPicks(["model-b"]);

    const counts = await getModelPickCounts();
    expect(counts["model-a"]).toBeCloseTo(2.709875, 6);
    expect(counts["model-b"]).toBe(1);
  });

  it("prunes decayed counts below the threshold", async () => {
    const usagePath = join(tmpDir, "model-usage.json");
    writeFileSync(
      usagePath,
      JSON.stringify({
        counts: {
          "model-stale": 0.04,
          "model-keep": 1,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { getModelPickCounts, recordModelPicks } = await import("../src/model-usage");

    await recordModelPicks([]);

    const counts = await getModelPickCounts();
    expect(counts["model-stale"]).toBeUndefined();
    expect(counts["model-keep"]).toBeCloseTo(0.95, 6);
  });
});
