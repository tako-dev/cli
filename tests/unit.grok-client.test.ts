import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import "../src/clients";
import { getAllClients, getClient, getClientLaunchOptions } from "../src/clients/base";
import {
  GROK_API_ENV_KEY,
  GROK_DEFAULT_MODEL,
  applyTakoGrokModels,
  buildGrokModelBlock,
  collectGrokCatalogModels,
  grokBinCandidates,
  grokBinaryName,
  grokClient,
  isGrokFamilyModel,
  mapGrokPassthroughModel,
  parseGrokVersion,
  resolveGrokBaseUrl,
  resolveSelectedGrokSlug,
  takoGrokModelId,
  takoGrokSlug,
  writeGrokConfigFile,
} from "../src/clients/grok";
import { PROXY_BASE_URL } from "../src/config";
import { insertSupportedClient } from "../src/providers";
import { getDefaultSupportedClients } from "../src/providers/types";
import type { Provider } from "../src/providers/types";
import {
  _resetTakoCatalog,
  _setCachePathForTest,
} from "../src/models/tako";

const BASE_URL = "https://models.example.test";

function provider(): Provider {
  return {
    id: "p-grok",
    name: "P",
    type: "tako",
    baseUrl: BASE_URL,
    apiKey: "sk-test",
    supportedClients: ["grok"],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function entry(id: string, category = "chat", contextWindow = 200000) {
  return {
    id,
    displayName: id,
    description: id,
    contextWindow,
    sortOrder: 0,
    category,
  };
}

describe("Grok Build client registry", () => {
  it("registers a visible system client before Gemini", () => {
    const ids = getAllClients().map((c) => c.id);
    expect(ids).toContain("grok");
    expect(ids.indexOf("grok")).toBeLessThan(ids.indexOf("gemini"));
    expect(getClient("grok")?.install).toBe("system");
    expect(getClient("grok")?.runtime).toBe("native");
  });

  it("custom providers include grok by default", () => {
    expect(getDefaultSupportedClients("custom")).toEqual(["claude-code", "codex", "grok"]);
  });

  it("inserts grok before gemini in existing provider client lists", () => {
    expect(insertSupportedClient(["codex", "claude-code", "pi", "gemini"], "grok", "gemini"))
      .toEqual(["codex", "claude-code", "pi", "grok", "gemini"]);
    expect(insertSupportedClient(["codex", "grok", "gemini"], "grok", "gemini"))
      .toEqual(["codex", "grok", "gemini"]);
    expect(insertSupportedClient(["codex", "claude-code"], "grok", "gemini"))
      .toEqual(["codex", "claude-code", "grok"]);
  });
});

describe("Grok model id helpers", () => {
  it("keeps grok family and drops Cursor composer", () => {
    expect(isGrokFamilyModel("grok-4.6")).toBe(true);
    expect(isGrokFamilyModel("grok-4.5")).toBe(true);
    expect(isGrokFamilyModel("composer-2.5")).toBe(true);
    expect(isGrokFamilyModel("cursor-composer-2.5")).toBe(false);
    expect(isGrokFamilyModel("gpt-5.5")).toBe(false);
  });

  it("prefixes Tako logical names once", () => {
    expect(takoGrokModelId("grok-4.6")).toBe("tako-grok-4.6");
    expect(takoGrokModelId("tako-grok-4.6")).toBe("tako-grok-4.6");
    expect(takoGrokSlug("tako-composer-2.5")).toBe("composer-2.5");
  });

  it("maps quick-launch --model slugs onto tako-* ids", () => {
    expect(mapGrokPassthroughModel("grok-4.6")).toBe("tako-grok-4.6");
    expect(mapGrokPassthroughModel("tako-grok-4.5")).toBe("tako-grok-4.5");
    expect(mapGrokPassthroughModel("gpt-5.5")).toBe("gpt-5.5");
  });

  it("parses grok --version output", () => {
    expect(parseGrokVersion("grok 0.2.93 (f00f96316d4b)")).toBe("0.2.93");
    expect(parseGrokVersion("not-grok")).toBeNull();
  });

  it("lists official and Tako-managed binary locations", () => {
    expect(grokBinaryName("darwin")).toBe("grok");
    expect(grokBinaryName("win32")).toBe("grok.exe");
    expect(grokBinCandidates("/Users/me", "/Users/me/.tako/tools", "darwin")).toEqual([
      "/Users/me/.tako/tools/grok/bin/grok",
      "/Users/me/.grok/bin/grok",
      "/Users/me/.local/bin/grok",
    ]);
  });
});

describe("Grok config blocks", () => {
  it("points Tako models at /v1 responses with env_key", () => {
    const block = buildGrokModelBlock({
      slug: "grok-4.6",
      displayName: "Grok 4.6",
      baseUrl: "https://tako.shiroha.tech/v1",
      contextWindow: 500000,
    });
    expect(block).toMatchObject({
      model: "grok-4.6",
      base_url: "https://tako.shiroha.tech/v1",
      env_key: GROK_API_ENV_KEY,
      api_backend: "responses",
      context_window: 500000,
      supports_reasoning_effort: true,
    });
    expect(block).not.toHaveProperty("api_key");
  });

  it("omits unknown context windows", () => {
    const block = buildGrokModelBlock({
      slug: "composer-2.5",
      baseUrl: "https://tako.shiroha.tech/v1",
      contextWindow: 0,
    });
    expect(block).not.toHaveProperty("context_window");
    expect(block.supports_reasoning_effort).toBe(true);
  });

  it("resolves Tako and custom base URLs", () => {
    expect(resolveGrokBaseUrl({ type: "tako" })).toBe(`${PROXY_BASE_URL}/v1`);
    expect(resolveGrokBaseUrl({ type: "custom", baseUrl: "https://gw.example/v1" }))
      .toBe("https://gw.example/v1");
    expect(resolveGrokBaseUrl({ type: "custom", baseUrl: "https://gw.example" }))
      .toBe("https://gw.example/v1");
  });

  it("replaces only tako-* model sections", () => {
    const next = applyTakoGrokModels(
      {
        ui: { yolo: false },
        model: {
          "user-local": { model: "keep-me" },
          "tako-grok-4.5": { model: "stale" },
        },
      },
      {
        "tako-grok-4.6": { model: "grok-4.6" },
      },
    );
    expect(next.ui).toEqual({ yolo: false });
    expect(next.model["user-local"]).toEqual({ model: "keep-me" });
    expect(next.model["tako-grok-4.5"]).toBeUndefined();
    expect(next.model["tako-grok-4.6"]).toEqual({ model: "grok-4.6" });
  });
});

describe("Grok catalog and picker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-grok-models-"));
    _setCachePathForTest(join(tmpDir, "tako-models-cache.json"));
    _resetTakoCatalog();
    writeFileSync(
      join(tmpDir, "tako-models-cache.json"),
      JSON.stringify({
        version: 1,
        buckets: {
          [`${BASE_URL}#openai`]: {
            fetchedAt: Date.now(),
            entries: [
              entry("grok-4.6", "chat", 500000),
              entry("composer-2.5", "chat", 0),
              entry("cursor-composer-2.5", "chat", 0),
              entry("gpt-5.5", "chat", 272000),
              entry("grok-imagine", "image", 0),
            ],
          },
        },
      }),
    );
  });

  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("picker lists Tako grok-family chat models only", () => {
    const ids = getClientLaunchOptions(grokClient, provider())
      .filter((option) => option.group === "model")
      .map((option) => option.id);
    expect(ids).toEqual(["model-grok-4.6", "model-composer-2.5"]);
    expect(ids).not.toContain("model-cursor-composer-2.5");
    expect(ids).not.toContain("model-gpt-5.5");
  });

  it("launch args use quoted-safe tako-* logical names", () => {
    const composer = getClientLaunchOptions(grokClient, provider())
      .find((option) => option.id === "model-composer-2.5");
    expect(composer?.args).toEqual(["-m", "tako-composer-2.5"]);
  });

  it("collects catalog windows and falls back for composer", () => {
    const models = collectGrokCatalogModels(provider());
    expect(models).toEqual([
      { id: "grok-4.6", displayName: "grok-4.6", contextWindow: 500000 },
      { id: "composer-2.5", displayName: "composer-2.5", contextWindow: 0 },
    ]);
  });

  it("selects picker model, then default grok-4.6", () => {
    expect(resolveSelectedGrokSlug(["model-composer-2.5"], undefined, [
      { id: "grok-4.6" },
      { id: "composer-2.5" },
    ])).toBe("composer-2.5");
    expect(resolveSelectedGrokSlug([], undefined, [{ id: "grok-4.6" }, { id: "composer-2.5" }]))
      .toBe(GROK_DEFAULT_MODEL);
  });
});

describe("writeGrokConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-grok-config-"));
    _setCachePathForTest(join(tmpDir, "tako-models-cache.json"));
    _resetTakoCatalog();
  });

  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges tako models into existing grok config without wiping UI", async () => {
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(
      configPath,
      `[cli]\ninstaller = "internal"\n\n[ui]\nyolo = false\npermission_mode = "always-approve"\n`,
    );

    const setup = await writeGrokConfigFile(
      { type: "tako", apiKey: "sk-test" },
      ["model-grok-4.6"],
      configPath,
    );
    expect(setup.args ?? []).toEqual([]);

    const text = readFileSync(configPath, "utf-8");
    expect(text).toContain('[model."tako-grok-4.6"]');
    expect(text).toContain('[model."tako-composer-2.5"]');
    expect(text).toContain(`env_key = "${GROK_API_ENV_KEY}"`);
    expect(text).not.toContain("api_key");

    const parsed = parse(text) as Record<string, any>;
    expect(parsed.ui).toEqual({ yolo: false, permission_mode: "always-approve" });
    expect(parsed.cli).toEqual({ installer: "internal" });
    expect(parsed.model["tako-grok-4.6"].model).toBe("grok-4.6");
    expect(parsed.model["tako-grok-4.6"].api_backend).toBe("responses");
    expect(parsed.model["tako-grok-4.6"].base_url).toBe(`${PROXY_BASE_URL}/v1`);
  });

  it("injects the Tako key via env, not config.toml", () => {
    expect(grokClient.getEnvVars({ type: "tako", apiKey: "sk-secret" })).toEqual({
      [GROK_API_ENV_KEY]: "sk-secret",
    });
  });
});
