import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildClaudeModelPicker, prepareTakoClaudeSettingsForLaunch } from "../src/clients/claude-code";
import { clientVersionMeets } from "../src/installer";
import { buildCodexNativeCatalogArgs } from "../src/clients/codex";
import { _resetTakoCatalog, _setCachePathForTest } from "../src/models/tako";
import type { ProviderContext } from "../src/providers/types";

const URL = "https://models.example.test";
const KEY = "fixture-account-a";
const provider: ProviderContext = { type: "custom", baseUrl: URL, apiKey: KEY };

function bucket(apiKey: string): string {
  return `${URL}#claude#${createHash("sha256").update(apiKey).digest("hex")}`;
}

describe("Claude native model menu", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tako-native-model-menu-"));
    const cache = join(directory, "catalog.json");
    _setCachePathForTest(cache);
    _resetTakoCatalog();
    writeFileSync(cache, JSON.stringify({ version: 2, buckets: {
      [bucket(KEY)]: { fetchedAt: Date.now(), entries: [
        { id: "deepseek-fixture", displayName: "Fixture chat", description: "Gateway chat", contextWindow: 1000000, category: "chat" },
        { id: "gpt-image-fixture", displayName: "Fixture image", description: "", contextWindow: 0, category: "image" },
      ] },
      [bucket("fixture-account-b")]: { fetchedAt: Date.now(), entries: [
        { id: "other-account-model", displayName: "Other account", description: "", contextWindow: 200000, category: "chat" },
      ] },
    } }));
  });

  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(directory, { recursive: true, force: true });
  });

  it("adds only the selected account's chat models using documented picker fields", () => {
    expect(buildClaudeModelPicker(provider, "2.1.242")).toEqual({ options: [
      { model: "deepseek-fixture[1m]", label: "Fixture chat", description: "Gateway chat" },
    ] });
    expect(buildClaudeModelPicker({ ...provider, apiKey: "fixture-account-b" }, "2.1.316")?.options[0]?.model)
      .toBe("other-account-model");
  });

  it("leaves unsupported versions, subscriptions and missing catalogs alone", () => {
    for (const version of [null, "latest", "2.1.241"]) {
      expect(buildClaudeModelPicker(provider, version)).toBeUndefined();
    }
    expect(buildClaudeModelPicker({ type: "claude-subscription" }, "2.1.316")).toBeUndefined();
    expect(buildClaudeModelPicker({ ...provider, apiKey: "missing-account" }, "2.1.316")).toBeUndefined();
  });

  it("writes the native lineup only into a launch-owned overlay", async () => {
    const sourcePath = join(directory, "user.json");
    const targetPath = join(directory, "launch.json");
    const source = JSON.stringify({ permissions: { allow: ["Read"] }, model: "personal-model" });
    writeFileSync(sourcePath, source);
    const picker = buildClaudeModelPicker(provider, "2.1.316");
    const result = await prepareTakoClaudeSettingsForLaunch({
      launchEnvVars: {}, modelPicker: picker, sourcePath, targetPath, logConflicts: false,
    });
    expect(JSON.parse(readFileSync(targetPath, "utf8")).modelPicker).toEqual(picker);
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    expect(result.cleanupFiles).toEqual([targetPath]);
  });

  it("preserves a user-authored picker without copying or replacing it", async () => {
    const sourcePath = join(directory, "user.json");
    const targetPath = join(directory, "launch.json");
    const source = JSON.stringify({ modelPicker: { options: [{ model: "personal-model", label: "Mine" }], replaceBuiltInOptions: true } });
    writeFileSync(sourcePath, source);
    await prepareTakoClaudeSettingsForLaunch({
      launchEnvVars: {}, modelPicker: buildClaudeModelPicker(provider, "2.1.316"),
      sourcePath, targetPath, logConflicts: false,
    });
    expect(JSON.parse(readFileSync(targetPath, "utf8")).modelPicker).toBeUndefined();
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
  });
});

describe("Codex native catalog launch override", () => {
  it("uses the inference endpoint with version-scoped authenticated discovery", () => {
    expect(buildCodexNativeCatalogArgs(provider, "0.162.1", `${URL}/v1/`, {})).toEqual([
      "-c", `model_providers.tako.model_catalog_url=\"${URL}/v1/models?api_type=openai\"`,
    ]);
    expect(buildCodexNativeCatalogArgs(provider, "0.166.0", `${URL}/v1`, {})).toHaveLength(2);
  });

  it("preserves user catalogs, subscriptions and explicitly disabled discovery", () => {
    for (const existing of [
      { model_catalog_json: "/fixture/personal-catalog.json" },
      { model_providers: { tako: { model_catalog_url: "https://personal.example.test/catalog" } } },
      { features: { api_key_model_discovery: false } },
    ]) {
      const before = JSON.stringify(existing);
      expect(buildCodexNativeCatalogArgs(provider, "0.166.0", `${URL}/v1`, existing)).toEqual([]);
      expect(JSON.stringify(existing)).toBe(before);
    }
    expect(buildCodexNativeCatalogArgs({ type: "codex-subscription" }, "0.166.0", URL, {})).toEqual([]);
    expect(buildCodexNativeCatalogArgs({ ...provider, apiKey: undefined }, "0.166.0", URL, {})).toEqual([]);
  });

  it("does not send unsupported or unknown versions a new config field", () => {
    for (const version of [null, "latest", "0.162.0", "0.100.0"]) {
      expect(buildCodexNativeCatalogArgs(provider, version, URL, {})).toEqual([]);
    }
  });
});

describe("native-menu version gates", () => {
  it("accepts verified stable versions at or above the minimum", () => {
    expect(clientVersionMeets("2.1.242", "2.1.242")).toBe(true);
    expect(clientVersionMeets("v2.1.316", "2.1.242")).toBe(true);
    expect(clientVersionMeets("3.0.0", "2.1.242")).toBe(true);
    expect(clientVersionMeets("2.1.241", "2.1.242")).toBe(false);
    expect(clientVersionMeets("latest", "2.1.242")).toBe(false);
    expect(clientVersionMeets(null, "2.1.242")).toBe(false);
  });
});
