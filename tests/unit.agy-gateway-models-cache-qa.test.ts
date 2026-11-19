import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agyMod from "../src/clients/agy";
import { agyClient, buildAgyModelOptions, prepareAgyEnv } from "../src/clients/agy";
import { getClientLaunchOptions } from "../src/clients/base";
import { launchClient } from "../src/launcher-legacy";
import {
  _resetTakoCatalog,
  _setCachePathForTest,
  getFreshTakoModels,
  getTakoModels,
  refreshAllTakoCatalogs,
  refreshTakoModels,
  type TakoModelEntry,
} from "../src/models/tako";
import type { Provider, ProviderContext } from "../src/providers/types";

const BASE_URL = "https://agy-qa.example.test";
const API_KEY = "cr_agy_qa_secret_key";
const KEY_SHA256 = createHash("sha256").update(API_KEY).digest("hex");
const DEFAULT_FALLBACK_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
] as const;
const DEFAULT_FALLBACK_CSV = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.5-flash-lite",
].join(",");

const AGY_ALLOWED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5",
  "claude-opus-4-6-thinking",
  "gemini-3.8-flash",
  "gemini-3.8-flash-medium",
  "gemini-3.5-flash-lite",
  "gemini-4-carbon-high",
  "gemini-4-argon",
  "gpt-oss-120b",
  "gpt-oss-120b-medium",
] as const;

const AGY_REJECTED_MODELS = [
  "gemini-2.5-pro",
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemma-4-31b-it",
  "glm-5.3",
  "glm-5.3-flash",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash-1017",
  "kimi-k3",
  "kimi-k3.1-pro",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5.6",
  "grok-4.6",
  "mimo-v2.6-pro",
  "minimax-m3",
  "swe-2-flash",
  "tako-auto",
  "composer-2.5",
  "speech_tts",
  "web_search",
  "",
  "agy-cli/claude-sonnet-4-6",
] as const;

const MIXED_CATALOG_IDS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gemini-2.5-pro",
  "gemini-3-pro-image",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemma-4-31b-it",
  "glm-5.3",
  "gpt-6-sol",
] as const;

const TRACKED_ENV_KEYS = [
  "AGY_LLM_GATEWAY_MODELS",
  "AGY_LLM_GATEWAY_TIER_PRO",
  "AGY_LLM_GATEWAY_TIER_FLASH",
  "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
  "TAKO_AGY_GATEWAY_URL",
  "TAKO_AGY_API_KEY",
  "AGY_PATH",
] as const;

function getIsAgySupportedModelId(): (modelId: string) => boolean {
  const fn = (agyMod as Record<string, unknown>).isAgySupportedModelId;
  expect(typeof fn).toBe("function");
  return fn as (modelId: string) => boolean;
}

function geminiApiRow(id: string) {
  return {
    name: id.startsWith("models/") ? id : `models/${id}`,
    displayName: id,
    description: `Model ${id}`,
    inputTokenLimit: 200_000,
    supportedGenerationMethods: ["generateContent"],
  };
}

function cacheEntry(id: string, sortOrder = 0): TakoModelEntry {
  return {
    id,
    displayName: id.replace(/^models\//, ""),
    description: `Cached ${id}`,
    contextWindow: 200_000,
    sortOrder,
    category: "chat",
  };
}

function makeTakoProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: "prov-tako-qa",
    name: "Tako",
    type: "tako",
    baseUrl: `${BASE_URL}/v1`,
    apiKey: API_KEY,
    createdAt: "2026-11-18T00:00:00.000Z",
    ...overrides,
  };
}

function makeProviderContext(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    type: "tako",
    baseUrl: `${BASE_URL}/v1`,
    apiKey: API_KEY,
    ...overrides,
  };
}

describe("AGY-CACHE-01 (AC-1): isAgySupportedModelId strict allowlist", () => {
  it("exports isAgySupportedModelId and accepts all Antigravity-supported model IDs", () => {
    const isAgySupportedModelId = getIsAgySupportedModelId();

    for (const id of AGY_ALLOWED_MODELS) {
      expect(isAgySupportedModelId(id)).toBe(true);
    }
  });

  it("accepts Antigravity-supported models with 'models/' prefix and case-insensitive variants", () => {
    const isAgySupportedModelId = getIsAgySupportedModelId();

    for (const id of AGY_ALLOWED_MODELS) {
      expect(isAgySupportedModelId(`models/${id}`)).toBe(true);
      expect(isAgySupportedModelId(id.toUpperCase())).toBe(true);
      expect(isAgySupportedModelId(`models/${id.toUpperCase()}`)).toBe(true);
    }

    expect(isAgySupportedModelId("Claude-Opus-4-6")).toBe(true);
    expect(isAgySupportedModelId("models/Gemini-3.8-Flash-Medium")).toBe(true);
    expect(isAgySupportedModelId("  models/claude-haiku-4-5  ")).toBe(true);
  });

  it("rejects non-Antigravity, official-only, media, open-weights, third-party vendor, and invalid IDs", () => {
    const isAgySupportedModelId = getIsAgySupportedModelId();

    for (const rejected of AGY_REJECTED_MODELS) {
      expect(isAgySupportedModelId(rejected)).toBe(false);
    }

    for (const prefixedRejected of [
      "models/gemini-2.5-pro",
      "models/gemini-3-pro-image",
      "models/gemma-4-31b-it",
      "models/glm-5.3",
      "models/gpt-6-sol",
      "models/deepseek-v4-flash",
      "models/",
      "   ",
    ]) {
      expect(isAgySupportedModelId(prefixedRejected)).toBe(false);
    }
  });
});

describe("AGY-CACHE-02 (AC-2): fetchGeminiModels ?client=agy & stale #gemini# cache invalidation", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let cacheFile: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-agy-qa-ac2-"));
    cacheFile = join(tmpDir, "tako-models-cache.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();
    savedEnv = {};
    for (const k of TRACKED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setCachePathForTest(null);
    _resetTakoCatalog();
    for (const k of TRACKED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requests GET <baseUrl>/v1beta/models?client=agy and preserves client=agy with pageToken on pagination", async () => {
    const requestedCalls: Array<{ url: URL; apiKeyHeader: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requestedCalls.push({
        url,
        apiKeyHeader: new Headers(init?.headers).get("x-goog-api-key"),
      });

      if (!url.searchParams.has("pageToken")) {
        return Response.json({
          models: [geminiApiRow("claude-opus-4-6"), geminiApiRow("claude-sonnet-4-6")],
          nextPageToken: "cursor-page-2",
        });
      }
      return Response.json({
        models: [geminiApiRow("gemini-3.8-flash"), geminiApiRow("gemini-3.5-flash-lite")],
      });
    }) as typeof fetch;

    await refreshTakoModels(`${BASE_URL}/`, API_KEY, "gemini");

    expect(requestedCalls).toHaveLength(2);
    for (const call of requestedCalls) {
      expect(call.url.origin + call.url.pathname).toBe(`${BASE_URL}/v1beta/models`);
      expect(call.url.searchParams.get("client")).toBe("agy");
      expect(call.url.searchParams.has("key")).toBe(false);
      expect(call.apiKeyHeader).toBe(API_KEY);
    }
    expect(requestedCalls[0]?.url.searchParams.has("pageToken")).toBe(false);
    expect(requestedCalls[1]?.url.searchParams.get("pageToken")).toBe("cursor-page-2");

    const models = getTakoModels(BASE_URL, "gemini", API_KEY);
    expect(models?.map((m) => m.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
  });

  it("invalidates pre-existing v0.3.54 #gemini#<sha256> bucket with 50 non-agy models and writes #agy-v2#<sha256>", async () => {
    const pollutedEntries: TakoModelEntry[] = [
      cacheEntry("glm-5.3", 0),
      cacheEntry("gpt-6-sol", 1),
      cacheEntry("gemma-4-31b-it", 2),
      cacheEntry("deepseek-v4-flash", 3),
      cacheEntry("kimi-k3", 4),
      ...Array.from({ length: 45 }, (_, idx) => cacheEntry(`legacy-non-agy-${idx + 1}`, idx + 5)),
    ];
    expect(pollutedEntries).toHaveLength(50);

    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE_URL}#gemini#${KEY_SHA256}`]: {
            fetchedAt: Date.now(),
            entries: pollutedEntries,
          },
        },
      }),
    );
    _resetTakoCatalog();

    // Upgrading from v0.3.54 must NOT read the stale #gemini#<sha256> bucket
    expect(getTakoModels(BASE_URL, "gemini", API_KEY)).toBeNull();
    expect(getFreshTakoModels(BASE_URL, "gemini", API_KEY)).toBeNull();

    // refreshAllTakoCatalogs must treat #agy-v2# as cold and fetch ?client=agy despite fresh #gemini# bucket
    const geminiFetchedUrls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1beta/models") {
        geminiFetchedUrls.push(url);
        return Response.json({
          models: [geminiApiRow("claude-opus-4-6"), geminiApiRow("gemini-3.8-flash")],
        });
      }
      return Response.json({ models: [{ slug: "claude-opus-4-6", context_window: 200000 }] });
    }) as typeof fetch;

    await refreshAllTakoCatalogs([
      makeTakoProvider({ baseUrl: BASE_URL, supportedClients: ["agy"] }),
    ]);
    expect(geminiFetchedUrls).toHaveLength(1);
    expect(geminiFetchedUrls[0]?.searchParams.get("client")).toBe("agy");

    const diskRaw = readFileSync(cacheFile, "utf-8");
    expect(diskRaw).not.toContain(API_KEY);
    const diskJson = JSON.parse(diskRaw) as { buckets: Record<string, { entries: TakoModelEntry[] }> };
    expect(diskJson.buckets[`${BASE_URL}#agy-v2#${KEY_SHA256}`]).toBeDefined();
    expect(diskJson.buckets[`${BASE_URL}#agy-v2#${KEY_SHA256}`]?.entries.map((e) => e.id)).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash",
    ]);

    _resetTakoCatalog();
    expect(getTakoModels(BASE_URL, "gemini", API_KEY)?.map((e) => e.id)).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash",
    ]);
  });
});

describe("AGY-CACHE-03 (AC-3): buildAgyModelOptions strict agy filtering & cold-cache fallback", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let cacheFile: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-agy-qa-ac3-"));
    cacheFile = join(tmpDir, "tako-models-cache.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();
    savedEnv = {};
    for (const k of TRACKED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setCachePathForTest(null);
    _resetTakoCatalog();
    for (const k of TRACKED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ONLY the 4 agy-supported models from a mixed Gemini catalog and strips models/ prefixes", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        models: MIXED_CATALOG_IDS.map((id) => geminiApiRow(id)),
      })) as typeof fetch;

    await refreshTakoModels(BASE_URL, API_KEY, "gemini");

    const provider = makeTakoProvider({
      baseUrl: `${BASE_URL}/v1`,
      apiKey: "cr_other_main_key",
      agyApiKey: API_KEY,
    });

    const modelOptions = buildAgyModelOptions(provider);
    expect(modelOptions.map((o) => o.id)).toEqual([
      "model-claude-opus-4-6",
      "model-claude-sonnet-4-6",
      "model-gemini-3.5-flash-lite",
      "model-gemini-3.8-flash",
    ]);
    expect(modelOptions.map((o) => o.args)).toEqual([
      ["--model", "claude-opus-4-6"],
      ["--model", "claude-sonnet-4-6"],
      ["--model", "gemini-3.5-flash-lite"],
      ["--model", "gemini-3.8-flash"],
    ]);

    for (const forbidden of [
      "model-gemini-2.5-pro",
      "model-gemini-3-pro-image",
      "model-gemma-4-31b-it",
      "model-glm-5.3",
      "model-gpt-6-sol",
    ]) {
      expect(modelOptions.map((o) => o.id)).not.toContain(forbidden);
    }

    const fullLaunchOptions = getClientLaunchOptions(agyClient, provider);
    expect(fullLaunchOptions.filter((o) => o.group === "model").map((o) => o.id)).toEqual([
      "model-claude-opus-4-6",
      "model-claude-sonnet-4-6",
      "model-gemini-3.5-flash-lite",
      "model-gemini-3.8-flash",
    ]);
  });

  it("also filters mixed entries loaded directly from #agy-v2# disk cache with models/ prefixes", () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE_URL}#agy-v2#${KEY_SHA256}`]: {
            fetchedAt: Date.now(),
            entries: MIXED_CATALOG_IDS.map((id, i) => cacheEntry(`models/${id}`, i)),
          },
        },
      }),
    );
    _resetTakoCatalog();

    const options = buildAgyModelOptions(makeTakoProvider());
    expect(options.map((o) => o.id)).toEqual([
      "model-claude-opus-4-6",
      "model-claude-sonnet-4-6",
      "model-gemini-3.5-flash-lite",
      "model-gemini-3.8-flash",
    ]);
  });

  it("falls back to DEFAULT_AGY_GATEWAY_MODELS when cache is cold instead of returning []", () => {
    const takoProvider = makeTakoProvider();
    const coldOptions = buildAgyModelOptions(takoProvider);

    expect(coldOptions.map((o) => o.id)).toEqual([
      "model-claude-opus-4-6",
      "model-claude-sonnet-4-6",
      "model-gemini-3.8-flash",
      "model-gemini-3.5-flash-lite",
    ]);
    expect(coldOptions.map((o) => o.args)).toEqual([
      ["--model", "claude-opus-4-6"],
      ["--model", "claude-sonnet-4-6"],
      ["--model", "gemini-3.8-flash"],
      ["--model", "gemini-3.5-flash-lite"],
    ]);

    // Unconfigured or incompatible providers still return []
    expect(buildAgyModelOptions(undefined)).toEqual([]);
    expect(buildAgyModelOptions(makeTakoProvider({ apiKey: "", agyApiKey: "" }))).toEqual([]);
    expect(buildAgyModelOptions(makeTakoProvider({ type: "anthropic" }))).toEqual([]);
  });
});

describe("AGY-CACHE-04 (AC-4): AGY_LLM_GATEWAY_MODELS & AGY_LLM_GATEWAY_TIER_* env injection & user override", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let cacheFile: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-agy-qa-ac4-"));
    cacheFile = join(tmpDir, "tako-models-cache.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();
    savedEnv = {};
    for (const k of TRACKED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setCachePathForTest(null);
    _resetTakoCatalog();
    for (const k of TRACKED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function expectValidTierEnvVars(env: Record<string, string | undefined>) {
    const isAgySupportedModelId = getIsAgySupportedModelId();
    for (const tierKey of [
      "AGY_LLM_GATEWAY_TIER_PRO",
      "AGY_LLM_GATEWAY_TIER_FLASH",
      "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
    ] as const) {
      const value = env[tierKey];
      expect(typeof value).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
      expect(value!.startsWith("models/")).toBe(false);
      expect(isAgySupportedModelId(value!)).toBe(true);
    }
  }

  it("injects AGY_LLM_GATEWAY_MODELS (filtered to agy-supported only) and AGY_LLM_GATEWAY_TIER_* in prepareAgyEnv and agyClient.getEnvVars", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        models: MIXED_CATALOG_IDS.map((id) => geminiApiRow(id)),
      })) as typeof fetch;

    await refreshTakoModels(BASE_URL, API_KEY, "gemini");

    const providerCtx = makeProviderContext({
      baseUrl: `${BASE_URL}/v1`,
      apiKey: "cr_unused_main",
      agyApiKey: API_KEY,
    });

    const prepared = prepareAgyEnv({ PATH: "/usr/bin:/bin" }, providerCtx);
    const clientVars = agyClient.getEnvVars(providerCtx);

    for (const env of [prepared, clientVars]) {
      expect(env.AGY_LLM_GATEWAY_URL).toBe(BASE_URL);
      expect(env.AGY_LLM_GATEWAY_API_KEY).toBe(API_KEY);
      expect(env.AGY_LLM_GATEWAY_MODELS).toBe(
        "claude-opus-4-6,claude-sonnet-4-6,gemini-3.5-flash-lite,gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
      );
      expectValidTierEnvVars(env);
      expect(env.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-4-6");
      expect(["claude-sonnet-4-6", "gemini-3.8-flash"]).toContain(env.AGY_LLM_GATEWAY_TIER_FLASH!);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gemini-3.5-flash-lite");
    }

    // Also verify Gemini-4 pro-tier catalog strips models/ prefixes cleanly
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE_URL}#agy-v2#${KEY_SHA256}`]: {
            fetchedAt: Date.now(),
            entries: [
              cacheEntry("models/gemini-4-carbon-high", 0),
              cacheEntry("models/claude-sonnet-4-6", 1),
              cacheEntry("models/gemini-3.5-flash-lite", 2),
            ],
          },
        },
      }),
    );
    _resetTakoCatalog();

    const geminiProPrepared = prepareAgyEnv({}, providerCtx);
    const geminiProClientVars = agyClient.getEnvVars(providerCtx);
    for (const env of [geminiProPrepared, geminiProClientVars]) {
      expect(env.AGY_LLM_GATEWAY_MODELS).toBe(
        "gemini-4-carbon-high,claude-sonnet-4-6,gemini-3.5-flash-lite",
      );
      expectValidTierEnvVars(env);
      expect(["gemini-4-carbon-high", "claude-opus-4-6"]).toContain(env.AGY_LLM_GATEWAY_TIER_PRO!);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-4-6");
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gemini-3.5-flash-lite");
    }
  });

  it("falls back to default 4 agy models when cache is cold OR contains zero agy-supported models", () => {
    const providerCtx = makeProviderContext();

    // 1. Completely cold cache
    const coldPrepared = prepareAgyEnv({}, providerCtx);
    const coldClientVars = agyClient.getEnvVars(providerCtx);
    for (const env of [coldPrepared, coldClientVars]) {
      expect(env.AGY_LLM_GATEWAY_MODELS).toBe(DEFAULT_FALLBACK_CSV);
      expectValidTierEnvVars(env);
      expect(env.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-4-6");
      expect(["claude-sonnet-4-6", "gemini-3.8-flash"]).toContain(env.AGY_LLM_GATEWAY_TIER_FLASH!);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gemini-3.5-flash-lite");
    }

    // 2. Cache populated with ONLY unsupported non-agy models
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE_URL}#agy-v2#${KEY_SHA256}`]: {
            fetchedAt: Date.now(),
            entries: [
              cacheEntry("glm-5.3", 0),
              cacheEntry("gpt-6-sol", 1),
              cacheEntry("gemma-4-31b-it", 2),
              cacheEntry("gemini-2.5-pro", 3),
            ],
          },
        },
      }),
    );
    _resetTakoCatalog();

    const zeroSupportedPrepared = prepareAgyEnv({}, providerCtx);
    const zeroSupportedClientVars = agyClient.getEnvVars(providerCtx);
    for (const env of [zeroSupportedPrepared, zeroSupportedClientVars]) {
      expect(env.AGY_LLM_GATEWAY_MODELS).toBe(DEFAULT_FALLBACK_CSV);
      expectValidTierEnvVars(env);
    }
  });

  it("preserves explicit non-empty AGY_LLM_GATEWAY_MODELS and AGY_LLM_GATEWAY_TIER_* in baseEnv, process.env, and child launch", async () => {
    // Seed warm cache so an implementation that overwrites user env with cached models gets caught
    globalThis.fetch = (async () =>
      Response.json({
        models: [geminiApiRow("claude-opus-4-6"), geminiApiRow("gemini-3.8-flash")],
      })) as typeof fetch;
    await refreshTakoModels(BASE_URL, API_KEY, "gemini");

    const providerCtx = makeProviderContext();

    // 1. Explicit full override in baseEnv for prepareAgyEnv
    const overriddenPrepared = prepareAgyEnv(
      {
        PATH: "/usr/bin",
        AGY_LLM_GATEWAY_MODELS: "claude-opus-5-5,gemini-4-argon",
        AGY_LLM_GATEWAY_TIER_PRO: "claude-opus-5-5",
        AGY_LLM_GATEWAY_TIER_FLASH: "claude-sonnet-5-5",
        AGY_LLM_GATEWAY_TIER_FLASH_LITE: "claude-haiku-4-5",
      },
      providerCtx,
    );
    expect(overriddenPrepared.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-5-5,gemini-4-argon");
    expect(overriddenPrepared.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-5-5");
    expect(overriddenPrepared.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-5-5");
    expect(overriddenPrepared.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("claude-haiku-4-5");

    // 2. Empty / whitespace-only strings in baseEnv are NOT treated as non-empty overrides,
    // while non-empty partial override (AGY_LLM_GATEWAY_TIER_FLASH) IS preserved
    const emptyOverridePrepared = prepareAgyEnv(
      {
        AGY_LLM_GATEWAY_MODELS: "   ",
        AGY_LLM_GATEWAY_TIER_PRO: "",
        AGY_LLM_GATEWAY_TIER_FLASH: "gemini-3.8-flash-medium",
      },
      providerCtx,
    );
    expect(emptyOverridePrepared.AGY_LLM_GATEWAY_MODELS).toBe(
      "claude-opus-4-6,gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
    );
    expect(emptyOverridePrepared.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-4-6");
    expect(emptyOverridePrepared.AGY_LLM_GATEWAY_TIER_FLASH).toBe("gemini-3.8-flash-medium");
    expect(typeof emptyOverridePrepared.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("string");
    expect(emptyOverridePrepared.AGY_LLM_GATEWAY_TIER_FLASH_LITE!.length).toBeGreaterThan(0);

    // 3. Explicit non-empty overrides in process.env for agyClient.getEnvVars AND real launchClient child process
    process.env.AGY_LLM_GATEWAY_MODELS = "claude-opus-5-5,gpt-oss-120b";
    process.env.AGY_LLM_GATEWAY_TIER_PRO = "claude-opus-5-5";
    process.env.AGY_LLM_GATEWAY_TIER_FLASH = "claude-sonnet-5-5";
    process.env.AGY_LLM_GATEWAY_TIER_FLASH_LITE = "claude-haiku-4-5";

    const mergedProcessEnv = { ...process.env, ...agyClient.getEnvVars(providerCtx) };
    expect(mergedProcessEnv.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-5-5,gpt-oss-120b");
    expect(mergedProcessEnv.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-5-5");
    expect(mergedProcessEnv.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-5-5");
    expect(mergedProcessEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("claude-haiku-4-5");

    if (process.platform !== "win32") {
      const mockAgyBin = join(tmpDir, "mock-agy");
      const envDumpPath = join(tmpDir, "child-env.json");
      writeFileSync(
        mockAgyBin,
        `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({
  AGY_LLM_GATEWAY_MODELS: process.env.AGY_LLM_GATEWAY_MODELS ?? null,
  AGY_LLM_GATEWAY_TIER_PRO: process.env.AGY_LLM_GATEWAY_TIER_PRO ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH: process.env.AGY_LLM_GATEWAY_TIER_FLASH ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH_LITE: process.env.AGY_LLM_GATEWAY_TIER_FLASH_LITE ?? null,
}));
`,
      );
      chmodSync(mockAgyBin, 0o755);
      process.env.AGY_PATH = mockAgyBin;

      const launchRes = await launchClient(agyClient, {
        providerContext: providerCtx,
        args: ["-p", "ping"],
        projectPath: tmpDir,
      });
      expect(launchRes.success).toBe(true);

      const childEnv = JSON.parse(readFileSync(envDumpPath, "utf-8"));
      expect(childEnv).toEqual({
        AGY_LLM_GATEWAY_MODELS: "claude-opus-5-5,gpt-oss-120b",
        AGY_LLM_GATEWAY_TIER_PRO: "claude-opus-5-5",
        AGY_LLM_GATEWAY_TIER_FLASH: "claude-sonnet-5-5",
        AGY_LLM_GATEWAY_TIER_FLASH_LITE: "claude-haiku-4-5",
      });
    }
  });
});
