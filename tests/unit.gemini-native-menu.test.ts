import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGeminiNativeModels } from "../src/clients/gemini-native";

const models = [{ id: "upstream-id", displayName: "Friendly name" }];
describe("Gemini launch-only native menu", () => {
  it("adds menu metadata and exact routing without default generation settings", () => {
    expect(mergeGeminiNativeModels({}, [], models)).toEqual({
      experimental: { dynamicModelConfiguration: true },
      modelConfigs: {
        modelDefinitions: { "upstream-id": { displayName: "Friendly name", tier: "custom", isVisible: true, isPreview: false } },
        customAliases: { "upstream-id": { modelConfig: { model: "upstream-id" } } },
        modelIdResolutions: { "upstream-id": { default: "upstream-id" } },
      },
    });
  });

  it("preserves defaults and skips every user-owned routing map collision", () => {
    const defaults = { ui: { theme: "custom" }, modelConfigs: { modelDefinitions: { other: { isVisible: false } } } };
    for (const field of ["modelDefinitions", "customAliases", "modelIdResolutions"]) {
      expect(mergeGeminiNativeModels(defaults, [{ modelConfigs: { [field]: { "upstream-id": {} } } }], models)).toBeNull();
    }
    expect(defaults.modelConfigs.modelDefinitions.other.isVisible).toBe(false);
    expect(mergeGeminiNativeModels(defaults, [], models)?.ui).toEqual({ theme: "custom" });
  });

  it("retains explicit disablement and rejects reserved or malformed configuration", () => {
    expect(mergeGeminiNativeModels({}, [{ experimental: { dynamicModelConfiguration: false } }], models)).toBeNull();
    expect(mergeGeminiNativeModels({}, [{ modelConfigs: { customAliases: [] } }], models)).toBeNull();
    expect(mergeGeminiNativeModels({}, [{ modelConfigs: { aliases: {} } }], models)).toBeNull();
    expect(mergeGeminiNativeModels({}, [{ modelConfigs: { overrides: [] } }], models)).toBeNull();
    expect(mergeGeminiNativeModels({}, [], ["auto", "pro", "flash", "auto-gemini-3", "chat-base", "summarizer-default", "web-fetch", "gemini-2.5-pro", "__proto__"].map(id => ({ id, displayName: id })))).toBeNull();
  });

  it("uses real adapter setup with isolated account buckets, unchanged settings and cleanup", async () => {
    const home = mkdtempSync(join(tmpdir(), "tako-gemini-menu-"));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/GEMINI|GOOGLE|TAKO|KEY|TOKEN|SECRET|PROXY|HOME|XDG/i.test(key)));
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/gemini-native-setup.ts")], {
        env: { ...env, HOME: home, USERPROFILE: home, TAKO_HOME: join(home, "tako"), XDG_CONFIG_HOME: join(home, "config") },
        stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(output);
      expect(result.first.setup).toBe(true);
      expect(result.first.overlay.ui).toEqual({ theme: "existing" });
      expect(result.first.overlay.modelConfigs.modelDefinitions["model-a"].isVisible).toBe(true);
      expect(result.first.overlay.modelConfigs.customAliases["user-owned"]).toBeUndefined();
      expect(result.first.overlay.modelConfigs.modelDefinitions.existing).toEqual({ isVisible: false });
      expect(result.second.overlay.modelConfigs.modelDefinitions["model-b"].displayName).toBe("Model B");
      expect(result.second.overlay.modelConfigs.modelDefinitions["model-a"]).toBeUndefined();
      expect(result.explicitDefaultsSkipped).toBe(true);
      expect(result.disabled).toBe(false);
      expect(result.stale).toBe(false);
      expect(result.old).toBe(false);
      expect(result.jsoncDefaults).toBe(false);
      expect(result.malformed).toBe(false);
      expect(result.malformedPreserved).toBe(true);
      expect(result.userUnchanged).toBe(true);
      expect(result.systemUnchanged).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
