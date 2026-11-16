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

  it("does not inject expired or future-dated catalogs into the native menu", () => {
    const cache = join(directory, "catalog.json");
    const snapshot = JSON.parse(readFileSync(cache, "utf8"));
    for (const fetchedAt of [Date.now() - 60 * 60 * 1000 - 1, Date.now() + 60000]) {
      snapshot.buckets[bucket(KEY)].fetchedAt = fetchedAt;
      writeFileSync(cache, JSON.stringify(snapshot));
      _resetTakoCatalog();
      expect(buildClaudeModelPicker(provider, "2.1.316")).toBeUndefined();
    }
  });

  it("uses final launch credentials and refuses a changed or ambiguous route", () => {
    expect(buildClaudeModelPicker(provider, "2.1.316", {
      ANTHROPIC_AUTH_TOKEN: "fixture-account-b", ANTHROPIC_BASE_URL: URL,
    })?.options[0]?.model).toBe("other-account-model");
    expect(buildClaudeModelPicker(provider, "2.1.316", {
      ANTHROPIC_API_KEY: "fixture-account-b",
    })?.options[0]?.model).toBe("other-account-model");
    for (const env of [
      { ANTHROPIC_AUTH_TOKEN: "" },
      { ANTHROPIC_BASE_URL: "https://different.example.test" },
      { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: "fixture-account-b" },
    ]) {
      expect(buildClaudeModelPicker(provider, "2.1.316", env)).toBeUndefined();
    }
    expect(buildClaudeModelPicker({ ...provider, type: "tako" }, "2.1.316", {
      ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: `${URL}/api/`,
    })?.options).toHaveLength(1);
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

  it("keeps project/local/explicit pickers authoritative and fails closed on unreadable settings", async () => {
    const sourcePath = join(directory, "user.json");
    const additional = join(directory, "project.json");
    writeFileSync(sourcePath, "{}");
    for (const [index, content] of [
      JSON.stringify({ modelPicker: { options: [], replaceBuiltInOptions: true } }),
      JSON.stringify({ modelPicker: null }),
      '{ "modelPicker": /* JSONC remains client-owned */ {} }',
      "[]",
    ].entries()) {
      writeFileSync(additional, content);
      const targetPath = join(directory, `preserved-${index}.json`);
      await prepareTakoClaudeSettingsForLaunch({
        launchEnvVars: {}, modelPicker: buildClaudeModelPicker(provider, "2.1.316"),
        sourcePath, targetPath, additionalSettingsPaths: [additional], logConflicts: false,
      });
      expect(JSON.parse(readFileSync(targetPath, "utf8")).modelPicker).toBeUndefined();
      expect(readFileSync(additional, "utf8")).toBe(content);
    }
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

  it("does not override catalogs supplied by a configured or selected profile", () => {
    for (const existing of [{ profile: "personal" }, { profiles: { personal: { model_catalog_json: "/fixture/models.json" } } }]) {
      expect(buildCodexNativeCatalogArgs(provider, "0.166.0", URL, existing)).toEqual([]);
    }
    for (const args of [["-p", "personal"], ["--profile", "personal"], ["--profile=personal"], ["-ppersonal"]]) {
      expect(buildCodexNativeCatalogArgs(provider, "0.166.0", URL, {}, args)).toEqual([]);
    }
  });

  it("does not replace explicit command-line catalog choices or disabled discovery", () => {
    for (const args of [
      ["-c", 'model_catalog_json="/fixture/personal.json"'],
      ["--config=model_providers.tako.model_catalog_url=\"https://personal.example.test\""],
      ["-cfeatures.api_key_model_discovery=false"],
      ["--config", '"model_catalog_json"="/fixture/personal.json"'],
      ["-c", 'model_providers = { tako = { model_catalog_url = "https://personal.example.test" } }'],
      ["-c", 'features = { api_key_model_discovery = false }'],
      ["--disable", "api_key_model_discovery"],
      ["--disable=api_key_model_discovery"],
      ["-c", 'model_providers.tako.base_url="https://other.example.test/v1"'],
      ["-c", 'model_provider="personal"'],
      ["-c", 'profile="personal"'],
      ["-c", "invalid TOML"],
    ]) {
      expect(buildCodexNativeCatalogArgs(provider, "0.166.0", URL, {}, args)).toEqual([]);
    }
    expect(buildCodexNativeCatalogArgs(provider, "0.166.0", URL, {}, ["-c", "model_reasoning_effort=\"high\""]))
      .toHaveLength(2);
  });

  it("does not send unsupported or unknown versions a new config field", () => {
    for (const version of [null, "latest", "0.162.0", "0.100.0"]) {
      expect(buildCodexNativeCatalogArgs(provider, version, URL, {})).toEqual([]);
    }
  });
});

describe("real adapter setup in an isolated home", () => {
  it("reads fixture managed-package versions and returns launch-only menu settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "tako-native-setup-"));
    try {
      const env = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !/CLAUDE|ANTHROPIC|CODEX|OPENAI|TAKO|KEY|TOKEN|SECRET|PROXY|HOME|XDG/i.test(key)));
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/native-menu-setup.ts")], {
        cwd: home,
        env: { ...env, HOME: home, USERPROFILE: home, TAKO_HOME: join(home, "tako"), XDG_CONFIG_HOME: join(home, "config") },
        stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        claudeModelPicker: { options: [{ model: "fixture-model", label: "Fixture model", description: "Fixture only" }] },
        claudeProjectPickerPreserved: true,
        claudeExplicitPickerPreserved: true,
        claudeConfigDirPickerPreserved: true,
        claudeUserUnchanged: true,
        codexArgs: ["-c", 'model_providers.tako.model_catalog_url="https://fixture.example.test/v1/models?api_type=openai"'],
        codexCatalogNotPersisted: true,
        codexModelPreserved: true,
        profileOverrideAbsent: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
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
