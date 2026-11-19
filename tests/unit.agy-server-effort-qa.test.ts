import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyClient,
  buildAgyModelOptions,
  DEFAULT_AGY_GATEWAY_MODELS,
  expandAgyGatewayModelsWithEffort,
  isAgySupportedModelId,
  prepareAgyEnv,
  resolveAgyGatewayModels,
} from "../src/clients/agy";
import {
  _resetTakoCatalog,
  _setCachePathForTest,
  getTakoModels,
  parseGeminiModels,
  refreshTakoModels,
  type TakoModelEntry,
} from "../src/models/tako";
import type { Provider, ProviderContext } from "../src/providers/types";

type TakoModelEntryWithEffort = TakoModelEntry & {
  supportedEffortLevels?: string[];
};

type ExpandAgyGatewayModelsFn = (
  models: readonly string[],
  effortLevelsByModel?: ReadonlyMap<string, readonly string[]>,
) => string[];

const expandModels = expandAgyGatewayModelsWithEffort as ExpandAgyGatewayModelsFn;

const BASE_URL = "https://agy-server-effort-qa.example.test";
const API_KEY = "cr_qa_server_effort_key_0359";
const API_KEY_SHA256 = createHash("sha256").update(API_KEY).digest("hex");
const AGY_ONLY_KEY = "cr_qa_server_effort_agy_only_0359";
const AGY_ONLY_KEY_SHA256 = createHash("sha256").update(AGY_ONLY_KEY).digest("hex");

const TRACKED_ENV_KEYS = [
  "AGY_LLM_GATEWAY_MODELS",
  "AGY_LLM_GATEWAY_TIER_PRO",
  "AGY_LLM_GATEWAY_TIER_FLASH",
  "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
  "TAKO_AGY_GATEWAY_URL",
  "TAKO_AGY_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AICODE_ENDPOINT_URL",
] as const;

const EFFORT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh|max)$/i;

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeTempDir(prefix = "tako-agy-srv-effort-qa-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function getEffortLevels(entry: TakoModelEntry | undefined): string[] | undefined {
  return (entry as TakoModelEntryWithEffort | undefined)?.supportedEffortLevels;
}

function expectNormalizedEffortSet(actual: unknown, expected: readonly string[]): void {
  expect(Array.isArray(actual)).toBe(true);
  const arr = actual as string[];
  for (const level of arr) {
    expect(typeof level).toBe("string");
    expect(level).toBe(level.trim().toLowerCase());
  }
  expect(new Set(arr).size).toBe(arr.length);
  expect([...arr].sort()).toEqual([...expected].sort());
}

function geminiModelRow(
  id: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: id.startsWith("models/") ? id : `models/${id}`,
    displayName: id.replace(/^models\//, ""),
    description: `Fixture ${id}`,
    inputTokenLimit: 1_000_000,
    supportedGenerationMethods: ["generateContent"],
    ...extra,
  };
}

function cacheEntry(
  id: string,
  sortOrder = 0,
  supportedEffortLevels?: string[],
): TakoModelEntryWithEffort {
  const entry: TakoModelEntryWithEffort = {
    id,
    displayName: id,
    description: `Cached ${id}`,
    contextWindow: 1_000_000,
    sortOrder,
    category: "chat",
  };
  if (supportedEffortLevels !== undefined) {
    entry.supportedEffortLevels = supportedEffortLevels;
  }
  return entry;
}

function writeAgyV2Cache(
  cacheFile: string,
  entries: readonly TakoModelEntryWithEffort[],
  opts?: { baseUrl?: string; keySha256?: string },
): void {
  const base = (opts?.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const fp = opts?.keySha256 ?? API_KEY_SHA256;
  writeFileSync(
    cacheFile,
    JSON.stringify({
      version: 2,
      buckets: {
        [`${base}#agy-v2#${fp}`]: {
          fetchedAt: Date.now(),
          entries,
        },
      },
    }),
    "utf8",
  );
  _setCachePathForTest(cacheFile);
  _resetTakoCatalog();
}

function makeProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: "prov-agy-srv-effort-qa",
    name: "Tako",
    type: "tako",
    baseUrl: `${BASE_URL}/v1`,
    apiKey: API_KEY,
    createdAt: "2026-11-19T00:00:00.000Z",
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

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of TRACKED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setCachePathForTest(null);
  _resetTakoCatalog();
  for (const key of TRACKED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// SRV-EFFORT-01: parseGeminiModels supportedEffortLevels metadata parsing
// ============================================================================
describe("SRV-EFFORT-01: parseGeminiModels supportedEffortLevels metadata parsing", () => {
  it("TC-SRVEFF-01: parses supportedEffortLevels when present on /v1beta/models?client=agy entries", () => {
    const parsed = parseGeminiModels({
      models: [
        geminiModelRow("gemini-4-hydrogen", {
          displayName: "Gemini 4 Hydrogen",
          description: "Flagship reasoning",
          inputTokenLimit: 1_048_576,
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        }),
        geminiModelRow("claude-opus-5-5", {
          supportedEffortLevels: ["low", "medium", "high", "max"],
        }),
        geminiModelRow("gemini-4-krypton", {
          supportedEffortLevels: ["low", "high"],
        }),
      ],
    });

    expect(parsed).toHaveLength(3);

    const hydrogen = parsed[0]!;
    expect(hydrogen.id).toBe("gemini-4-hydrogen");
    expect(hydrogen.displayName).toBe("Gemini 4 Hydrogen");
    expect(hydrogen.description).toBe("Flagship reasoning");
    expect(hydrogen.contextWindow).toBe(1_048_576);
    expect(hydrogen.sortOrder).toBe(0);
    expect(hydrogen.category).toBe("chat");
    expectNormalizedEffortSet(getEffortLevels(hydrogen), ["low", "medium", "high", "xhigh"]);

    expectNormalizedEffortSet(getEffortLevels(parsed[1]), ["low", "medium", "high", "max"]);
    expectNormalizedEffortSet(getEffortLevels(parsed[2]), ["low", "high"]);
  });

  it("TC-SRVEFF-02: normalizes case/whitespace, deduplicates, and strips unknown values and 'off'", () => {
    const parsed = parseGeminiModels({
      models: [
        geminiModelRow("gemini-4-hydrogen", {
          supportedEffortLevels: [
            "  Low  ",
            "MEDIUM",
            "High",
            "  XHIGH ",
            "low",
            "HIGH",
            "off",
            "OFF",
            "  Off ",
            "ultra",
            "turbo",
            "none",
            "",
            "   ",
            42,
            null,
            undefined,
            true,
            { level: "max" },
          ],
        }),
        geminiModelRow("claude-opus-5-5", {
          supportedEffortLevels: [" MAX ", "max", "off", "Medium", "  LOW\t", "extreme"],
        }),
      ],
    });

    expect(parsed).toHaveLength(2);
    expectNormalizedEffortSet(getEffortLevels(parsed[0]), ["low", "medium", "high", "xhigh"]);
    expectNormalizedEffortSet(getEffortLevels(parsed[1]), ["low", "medium", "max"]);
  });

  it("TC-SRVEFF-03: omits supportedEffortLevels (undefined) when absent, non-array, empty, or only invalid/'off' values", () => {
    const parsed = parseGeminiModels({
      models: [
        geminiModelRow("claude-opus-4-6"),
        geminiModelRow("gemini-3.5-flash-lite", { supportedEffortLevels: undefined }),
        geminiModelRow("model-null", { supportedEffortLevels: null }),
        geminiModelRow("model-string", { supportedEffortLevels: "high" }),
        geminiModelRow("model-csv", { supportedEffortLevels: "low,medium,high" }),
        geminiModelRow("model-number", { supportedEffortLevels: 3 }),
        geminiModelRow("model-bool", { supportedEffortLevels: true }),
        geminiModelRow("model-object", { supportedEffortLevels: { low: true, high: true } }),
        geminiModelRow("model-empty", { supportedEffortLevels: [] }),
        geminiModelRow("model-off-only", { supportedEffortLevels: ["off", "OFF", " off "] }),
        geminiModelRow("model-invalid-only", { supportedEffortLevels: ["off", "ultra"] }),
        geminiModelRow("model-junk-only", {
          supportedEffortLevels: ["", "   ", "super", "extreme", 123, null, {}],
        }),
      ],
    });

    expect(parsed).toHaveLength(12);
    for (const entry of parsed) {
      expect(getEffortLevels(entry)).toBeUndefined();
    }

    // Legacy shape compatibility for entries without supportedEffortLevels
    expect(parsed[0]).toEqual({
      id: "claude-opus-4-6",
      displayName: "claude-opus-4-6",
      description: "Fixture claude-opus-4-6",
      contextWindow: 1_000_000,
      sortOrder: 0,
      category: "chat",
    });
  });

  it("TC-SRVEFF-04: isolates metadata per entry and still filters out non-generateContent/malformed models", () => {
    const parsed = parseGeminiModels({
      models: [
        geminiModelRow("gemini-4-hydrogen", {
          supportedEffortLevels: ["low", "high", "xhigh"],
        }),
        {
          name: "models/text-embedding-004",
          displayName: "Embedding",
          supportedGenerationMethods: ["embedContent"],
          supportedEffortLevels: ["low", "high"],
        },
        {
          name: "models/invalid/nested",
          supportedGenerationMethods: ["generateContent"],
          supportedEffortLevels: ["low", "high"],
        },
        geminiModelRow("claude-opus-4-6"),
        geminiModelRow("gemini-3.9-flash", {
          supportedEffortLevels: ["off", "low", "medium", "high"],
        }),
      ],
    });

    expect(parsed.map((e) => e.id)).toEqual([
      "gemini-4-hydrogen",
      "claude-opus-4-6",
      "gemini-3.9-flash",
    ]);
    expectNormalizedEffortSet(getEffortLevels(parsed[0]), ["low", "high", "xhigh"]);
    expect(getEffortLevels(parsed[1])).toBeUndefined();
    expectNormalizedEffortSet(getEffortLevels(parsed[2]), ["low", "medium", "high"]);
  });
});

// ============================================================================
// SRV-EFFORT-02: Cache round-trip (#agy-v2# bucket)
// ============================================================================
describe("SRV-EFFORT-02: #agy-v2# disk cache round-trip for supportedEffortLevels", () => {
  it("TC-SRVEFF-05: refreshTakoModels persists supportedEffortLevels under #agy-v2# and getTakoModels returns them across cold disk reload", async () => {
    const dir = makeTempDir();
    const cacheFile = join(dir, "tako-models-cache.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requestedUrls.push(String(url));
      expect(url.pathname).toBe("/v1beta/models");
      expect(url.searchParams.get("client")).toBe("agy");
      expect(url.searchParams.has("key")).toBe(false);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);

      return Response.json({
        models: [
          geminiModelRow("gemini-3.8-flash", {
            supportedEffortLevels: ["low", "medium", "high"],
          }),
          geminiModelRow("gemini-3.9-flash", {
            supportedEffortLevels: [" LOW ", "Medium", "HIGH", "off"],
          }),
          geminiModelRow("gemini-4-hydrogen", {
            supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          }),
          geminiModelRow("claude-opus-5-5", {
            supportedEffortLevels: ["low", "medium", "high", "max"],
          }),
          geminiModelRow("claude-opus-4-6"),
          geminiModelRow("gemini-3.5-flash-lite"),
        ],
      });
    }) as typeof fetch;

    await refreshTakoModels(BASE_URL, API_KEY, "gemini");

    expect(requestedUrls).toHaveLength(1);

    // Verify raw disk snapshot structure under #agy-v2#
    const rawDiskText = readFileSync(cacheFile, "utf8");
    expect(rawDiskText).toContain("#agy-v2#");
    expect(rawDiskText).not.toContain("#gemini#");
    expect(rawDiskText).not.toContain(API_KEY);

    const diskJson = JSON.parse(rawDiskText) as {
      version: number;
      buckets: Record<string, { fetchedAt: number; entries: TakoModelEntryWithEffort[] }>;
    };
    expect(diskJson.version).toBe(2);
    const bucketKey = `${BASE_URL}#agy-v2#${API_KEY_SHA256}`;
    expect(diskJson.buckets[bucketKey]).toBeDefined();

    const assertEntries = (entries: TakoModelEntry[] | null) => {
      expect(entries).not.toBeNull();
      const byId = new Map(entries!.map((e) => [e.id, e]));
      expect([...byId.keys()]).toEqual([
        "gemini-3.8-flash",
        "gemini-3.9-flash",
        "gemini-4-hydrogen",
        "claude-opus-5-5",
        "claude-opus-4-6",
        "gemini-3.5-flash-lite",
      ]);

      expectNormalizedEffortSet(getEffortLevels(byId.get("gemini-3.8-flash")), [
        "low",
        "medium",
        "high",
      ]);
      expectNormalizedEffortSet(getEffortLevels(byId.get("gemini-3.9-flash")), [
        "low",
        "medium",
        "high",
      ]);
      expectNormalizedEffortSet(getEffortLevels(byId.get("gemini-4-hydrogen")), [
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expectNormalizedEffortSet(getEffortLevels(byId.get("claude-opus-5-5")), [
        "low",
        "medium",
        "high",
        "max",
      ]);
      expect(getEffortLevels(byId.get("claude-opus-4-6"))).toBeUndefined();
      expect(getEffortLevels(byId.get("gemini-3.5-flash-lite"))).toBeUndefined();
    };

    // 1. Verify on-disk parsed entries
    assertEntries(diskJson.buckets[bucketKey]!.entries);

    // 2. Verify in-memory getTakoModels
    assertEntries(getTakoModels(BASE_URL, "gemini", API_KEY));

    // 3. Reset in-memory catalog and verify cold reload from disk preserves supportedEffortLevels
    _resetTakoCatalog();
    assertEntries(getTakoModels(BASE_URL, "gemini", API_KEY));
  });

  it("TC-SRVEFF-06: preserves supportedEffortLevels across paginated /v1beta/models?client=agy responses", async () => {
    const dir = makeTempDir();
    const cacheFile = join(dir, "tako-models-cache-paged.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("client")).toBe("agy");
      if (!url.searchParams.has("pageToken")) {
        return Response.json({
          models: [
            geminiModelRow("gemini-4-hydrogen", {
              supportedEffortLevels: ["low", "medium", "high", "xhigh"],
            }),
            geminiModelRow("claude-opus-4-6"),
          ],
          nextPageToken: "page-2-token",
        });
      }
      expect(url.searchParams.get("pageToken")).toBe("page-2-token");
      return Response.json({
        models: [
          geminiModelRow("claude-opus-5-5", {
            supportedEffortLevels: ["low", "medium", "high", "max"],
          }),
          geminiModelRow("gemini-3.5-flash-lite", {
            supportedEffortLevels: ["off", "ultra"],
          }),
        ],
      });
    }) as typeof fetch;

    await refreshTakoModels(BASE_URL, API_KEY, "gemini");
    _resetTakoCatalog();

    const reloaded = getTakoModels(BASE_URL, "gemini", API_KEY);
    expect(reloaded).not.toBeNull();
    const byId = new Map(reloaded!.map((e) => [e.id, e]));

    expectNormalizedEffortSet(getEffortLevels(byId.get("gemini-4-hydrogen")), [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expectNormalizedEffortSet(getEffortLevels(byId.get("claude-opus-5-5")), [
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getEffortLevels(byId.get("claude-opus-4-6"))).toBeUndefined();
    expect(getEffortLevels(byId.get("gemini-3.5-flash-lite"))).toBeUndefined();
  });

  it("TC-SRVEFF-07: legacy #agy-v2# disk cache entries without supportedEffortLevels load cleanly", () => {
    const dir = makeTempDir();
    const cacheFile = join(dir, "tako-models-cache-legacy.json");
    writeAgyV2Cache(cacheFile, [
      cacheEntry("claude-opus-4-6", 0),
      cacheEntry("gemini-3.8-flash", 1),
      cacheEntry("gemini-3.5-flash-lite", 2),
    ]);

    const loaded = getTakoModels(BASE_URL, "gemini", API_KEY);
    expect(loaded).not.toBeNull();
    expect(loaded!.map((e) => e.id)).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
    for (const entry of loaded!) {
      expect(getEffortLevels(entry)).toBeUndefined();
    }
  });
});

// ============================================================================
// SRV-EFFORT-03: expandAgyGatewayModelsWithEffort
// ============================================================================
describe("SRV-EFFORT-03: expandAgyGatewayModelsWithEffort (1-arg legacy & 2-arg server-driven)", () => {
  it("TC-SRVEFF-08: 1-arg backward compatibility expands gemini-3.8-flash into high, medium, low without mutating input", () => {
    const input = Object.freeze([
      "claude-opus-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);

    expect(expandModels(input)).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ]);

    expect(expandModels([])).toEqual([]);
  });

  it("TC-SRVEFF-09: 2-arg server-driven expansion orders variants highest -> lowest for known & future models", () => {
    // gemini-4-hydrogen: xhigh -> high -> medium -> low
    expect(
      expandModels(
        ["gemini-4-hydrogen"],
        new Map([["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]]]),
      ),
    ).toEqual([
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
    ]);

    // claude-opus-5-5: max -> high -> medium -> low
    expect(
      expandModels(
        ["claude-opus-5-5"],
        new Map([["claude-opus-5-5", ["low", "medium", "high", "max"]]]),
      ),
    ).toEqual([
      "claude-opus-5-5-max",
      "claude-opus-5-5-high",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
    ]);

    // Arbitrary future model gemini-4-krypton: high -> low
    expect(
      expandModels(
        ["gemini-4-krypton"],
        new Map([["gemini-4-krypton", ["low", "high"]]]),
      ),
    ).toEqual(["gemini-4-krypton-high", "gemini-4-krypton-low"]);

    // Relative rank across all 5 standard levels: max > xhigh > high > medium > low
    expect(
      expandModels(
        ["gemini-4-xenon"],
        new Map([["gemini-4-xenon", ["low", "high", "max", "medium", "xhigh"]]]),
      ),
    ).toEqual([
      "gemini-4-xenon-max",
      "gemini-4-xenon-xhigh",
      "gemini-4-xenon-high",
      "gemini-4-xenon-medium",
      "gemini-4-xenon-low",
    ]);
  });

  it("TC-SRVEFF-10: deduplicates/sorts map levels, preserves in-place order across mixed lists, and never mutates frozen inputs", () => {
    const frozenLevels = Object.freeze(["low", "max", "low", "medium"]);
    const effortMap = new Map<string, readonly string[]>([
      ["claude-opus-5-5", frozenLevels],
      ["gemini-4-hydrogen", Object.freeze(["low", "medium", "high", "xhigh"])],
    ]);

    // Duplicate / unsorted levels in map -> max, medium, low
    expect(expandModels(["claude-opus-5-5"], effortMap)).toEqual([
      "claude-opus-5-5-max",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
    ]);

    // Mixed list with duplicates & blanks preserves first-seen in-place ordering
    const mixedInput = Object.freeze([
      "claude-opus-5-5",
      "  ",
      "claude-opus-4-6",
      "gemini-4-hydrogen",
      "claude-opus-5-5",
      "gemini-3.5-flash-lite",
      "",
    ]);

    expect(expandModels(mixedInput, effortMap)).toEqual([
      "claude-opus-5-5-max",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
      "claude-opus-4-6",
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
      "gemini-3.5-flash-lite",
    ]);
  });

  it("TC-SRVEFF-11: explicit suffixed sibling guard prevents double-expanding that model without blocking unrelated models", () => {
    const effortMap = new Map<string, readonly string[]>([
      ["gemini-4-neon", ["low", "medium", "high", "xhigh"]],
      ["gemini-4-hydrogen", ["low", "high"]],
      ["claude-opus-5-5", ["low", "medium", "high", "max"]],
    ]);

    // Bare before explicit suffixed sibling -> must NOT expand gemini-4-neon
    expect(expandModels(["gemini-4-neon", "gemini-4-neon-xhigh"], effortMap)).toEqual([
      "gemini-4-neon",
      "gemini-4-neon-xhigh",
    ]);

    // Explicit suffixed sibling before bare -> still must NOT expand gemini-4-neon
    expect(expandModels(["gemini-4-neon-xhigh", "gemini-4-neon"], effortMap)).toEqual([
      "gemini-4-neon-xhigh",
      "gemini-4-neon",
    ]);

    // Sibling guard on claude-opus-5-5 (-max) and gemini-4-neon (-xhigh) must NOT block gemini-4-hydrogen
    expect(
      expandModels(
        [
          "gemini-4-neon",
          "gemini-4-neon-xhigh",
          "gemini-4-hydrogen",
          "claude-opus-5-5",
          "claude-opus-5-5-max",
        ],
        effortMap,
      ),
    ).toEqual([
      "gemini-4-neon",
      "gemini-4-neon-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-low",
      "claude-opus-5-5",
      "claude-opus-5-5-max",
    ]);

    // Non-effort hyphenated sibling (e.g. -lite) must NOT falsely suppress expansion
    expect(
      expandModels(
        ["gemini-4-neon", "gemini-4-neon-lite"],
        new Map([["gemini-4-neon", ["low", "high"]]]),
      ),
    ).toEqual(["gemini-4-neon-high", "gemini-4-neon-low", "gemini-4-neon-lite"]);
  });

  it("TC-SRVEFF-12: already-suffixed model IDs never double-suffix", () => {
    // Map keyed by base model ID
    expect(
      expandModels(
        ["gemini-4-neon-high"],
        new Map([["gemini-4-neon", ["low", "medium", "high", "xhigh"]]]),
      ),
    ).toEqual(["gemini-4-neon-high"]);

    // Even if map erroneously includes the already-suffixed ID as a key
    const suffixedMap = new Map<string, readonly string[]>([
      ["gemini-4-neon-high", ["low", "medium", "high", "xhigh"]],
      ["claude-opus-5-5-max", ["low", "max"]],
      ["gemini-4-hydrogen-xhigh", ["low", "xhigh"]],
      ["gemini-3.8-flash-medium", ["low", "medium", "high"]],
      ["gemini-4-krypton-low", ["low", "high"]],
    ]);

    expect(
      expandModels(
        [
          "gemini-4-neon-high",
          "claude-opus-5-5-max",
          "gemini-4-hydrogen-xhigh",
          "gemini-3.8-flash-medium",
          "gemini-4-krypton-low",
        ],
        suffixedMap,
      ),
    ).toEqual([
      "gemini-4-neon-high",
      "claude-opus-5-5-max",
      "gemini-4-hydrogen-xhigh",
      "gemini-3.8-flash-medium",
      "gemini-4-krypton-low",
    ]);
  });

  it("TC-SRVEFF-13: explicit empty array for gemini-3.8-flash suppresses expansion; explicit custom levels override default", () => {
    expect(
      expandModels(
        ["claude-opus-4-6", "gemini-3.8-flash", "gemini-3.5-flash-lite"],
        new Map([["gemini-3.8-flash", []]]),
      ),
    ).toEqual(["claude-opus-4-6", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);

    expect(
      expandModels(
        ["gemini-3.8-flash"],
        new Map([["gemini-3.8-flash", ["low", "xhigh"]]]),
      ),
    ).toEqual(["gemini-3.8-flash-xhigh", "gemini-3.8-flash-low"]);
  });
});

// ============================================================================
// SRV-EFFORT-04: End-to-end prepareAgyEnv, Launcher separation & fallback
// ============================================================================
describe("SRV-EFFORT-04: End-to-end prepareAgyEnv, Launcher model list separation & fallback", () => {
  it("TC-SRVEFF-14: isAgySupportedModelId allows gemini-3.9-flash and rejects gemini-3.9-flash-image and other non-chat models", () => {
    expect(isAgySupportedModelId("gemini-3.9-flash")).toBe(true);
    expect(isAgySupportedModelId("models/gemini-3.9-flash")).toBe(true);
    expect(isAgySupportedModelId("GEMINI-3.9-FLASH")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.9-flash-high")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.9-flash-medium")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.9-flash-low")).toBe(true);
    expect(isAgySupportedModelId("gemini-4-hydrogen")).toBe(true);
    expect(isAgySupportedModelId("gemini-4-hydrogen-xhigh")).toBe(true);
    expect(isAgySupportedModelId("claude-opus-5-5")).toBe(true);
    expect(isAgySupportedModelId("claude-opus-5-5-max")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.1-pro-preview")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.1-pro-high")).toBe(true);
    expect(isAgySupportedModelId("gemini-3.1-pro-low")).toBe(true);

    expect(isAgySupportedModelId("gemini-3.9-flash-image")).toBe(false);
    expect(isAgySupportedModelId("models/gemini-3.9-flash-image")).toBe(false);
    expect(isAgySupportedModelId("gemini-3.9-flash-video")).toBe(false);
    expect(isAgySupportedModelId("gemini-3.9-flash-audio")).toBe(false);
    expect(isAgySupportedModelId("gemini-4-hydrogen-image")).toBe(false);
    expect(isAgySupportedModelId("gemini-3.1-pro-image")).toBe(false);
    expect(isAgySupportedModelId("gemini-3.1-flash-image")).toBe(false);
    expect(isAgySupportedModelId("gemma-4-31b-it")).toBe(false);
  });

  it("TC-SRVEFF-15: end-to-end server-declared supportedEffortLevels separates bare Launcher picker from expanded AGY_LLM_GATEWAY_MODELS", async () => {
    const dir = makeTempDir();
    const cacheFile = join(dir, "tako-models-cache-e2e.json");
    _setCachePathForTest(cacheFile);
    _resetTakoCatalog();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1beta/models");
      expect(url.searchParams.get("client")).toBe("agy");
      return Response.json({
        models: [
          geminiModelRow("gemini-4-hydrogen", {
            displayName: "Gemini 4 Hydrogen",
            supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          }),
          geminiModelRow("gemini-3.9-flash", {
            displayName: "Gemini 3.9 Flash",
            supportedEffortLevels: ["low", "medium", "high"],
          }),
          geminiModelRow("gemini-3.9-flash-image", {
            displayName: "Gemini 3.9 Flash Image",
            supportedEffortLevels: ["low", "high"],
          }),
          geminiModelRow("claude-opus-5-5", {
            displayName: "Claude Opus 5.5",
            supportedEffortLevels: ["low", "medium", "high", "max"],
          }),
          geminiModelRow("claude-opus-4-6", {
            displayName: "Claude Opus 4.6",
          }),
          geminiModelRow("gemini-3.5-flash-lite", {
            displayName: "Gemini 3.5 Flash Lite",
          }),
        ],
      });
    }) as typeof fetch;

    await refreshTakoModels(BASE_URL, API_KEY, "gemini");
    // Force reload from #agy-v2# disk cache to verify end-to-end persistence
    _resetTakoCatalog();

    const provider = makeProvider();
    const providerCtx = makeProviderContext();

    // 1. resolveAgyGatewayModels returns ONLY bare IDs (no effort suffix clutter, image filtered out)
    const bareModels = resolveAgyGatewayModels(providerCtx);
    expect(bareModels).toEqual([
      "gemini-4-hydrogen",
      "gemini-3.9-flash",
      "claude-opus-5-5",
      "claude-opus-4-6",
      "gemini-3.5-flash-lite",
    ]);
    for (const modelId of bareModels) {
      expect(modelId).not.toMatch(EFFORT_SUFFIX_RE);
    }

    // 2. Launcher picker (buildAgyModelOptions) exposes ONLY bare model options
    const pickerOptions = buildAgyModelOptions(provider);
    expect(pickerOptions.map((o) => o.id)).toEqual([
      "model-gemini-4-hydrogen",
      "model-gemini-3.9-flash",
      "model-claude-opus-5-5",
      "model-claude-opus-4-6",
      "model-gemini-3.5-flash-lite",
    ]);
    expect(pickerOptions.map((o) => o.args)).toEqual([
      ["--model", "gemini-4-hydrogen"],
      ["--model", "gemini-3.9-flash"],
      ["--model", "claude-opus-5-5"],
      ["--model", "claude-opus-4-6"],
      ["--model", "gemini-3.5-flash-lite"],
    ]);

    // 3. prepareAgyEnv & agyClient.getEnvVars emit dynamically expanded AGY_LLM_GATEWAY_MODELS
    const expectedExpanded = [
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
      "gemini-3.9-flash-high",
      "gemini-3.9-flash-medium",
      "gemini-3.9-flash-low",
      "claude-opus-5-5-max",
      "claude-opus-5-5-high",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
      "claude-opus-4-6",
      "gemini-3.5-flash-lite",
    ];

    const prepared = prepareAgyEnv(
      {
        GOOGLE_GEMINI_BASE_URL: "https://conflict.example",
        GEMINI_API_KEY: "conflict-key",
        GOOGLE_API_KEY: "conflict-google-key",
        AICODE_ENDPOINT_URL: "https://aicode.example",
      },
      providerCtx,
    );
    const envVars = agyClient.getEnvVars(providerCtx);

    for (const env of [prepared, envVars]) {
      expect(env.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual(expectedExpanded);
      expect(env.AGY_LLM_GATEWAY_TIER_PRO).not.toMatch(EFFORT_SUFFIX_RE);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).not.toMatch(EFFORT_SUFFIX_RE);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).not.toMatch(EFFORT_SUFFIX_RE);
      expect(env.AGY_LLM_GATEWAY_TIER_PRO).toBe("gemini-4-hydrogen");
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gemini-3.5-flash-lite");
    }

    // Conflicting Gemini/Google/AICode env keys remain stripped
    expect(prepared.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(prepared.GEMINI_API_KEY).toBeUndefined();
    expect(prepared.GOOGLE_API_KEY).toBeUndefined();
    expect(prepared.AICODE_ENDPOINT_URL).toBeUndefined();

    // Explicit AGY_LLM_GATEWAY_MODELS env override still wins verbatim
    const overridden = prepareAgyEnv(
      { AGY_LLM_GATEWAY_MODELS: "claude-opus-4-6,gemini-4-hydrogen-high" },
      providerCtx,
    );
    expect(overridden.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-4-6,gemini-4-hydrogen-high");
  });

  it("TC-SRVEFF-16: honors /v1 fallback bucket lookup, dedicated agyApiKey isolation, and server-returned explicit suffixed sibling", () => {
    const dir = makeTempDir();

    // 1. Cache keyed under raw provider baseUrl (`${BASE_URL}/v1`) rather than normalized gateway URL
    const v1CacheFile = join(dir, "cache-v1-bucket.json");
    writeAgyV2Cache(
      v1CacheFile,
      [
        cacheEntry("gemini-4-hydrogen", 0, ["low", "high", "xhigh"]),
        cacheEntry("claude-opus-4-6", 1),
      ],
      { baseUrl: `${BASE_URL}/v1`, keySha256: API_KEY_SHA256 },
    );

    const v1Prepared = prepareAgyEnv({}, makeProviderContext());
    expect(v1Prepared.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual([
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-low",
      "claude-opus-4-6",
    ]);

    // 2. Dedicated agyApiKey resolves its own #agy-v2# bucket (isolated from main apiKey)
    const agyKeyCacheFile = join(dir, "cache-agy-key.json");
    writeAgyV2Cache(
      agyKeyCacheFile,
      [
        cacheEntry("claude-opus-5-5", 0, ["low", "max"]),
        cacheEntry("gemini-4-neon", 1, ["low", "medium", "high", "xhigh"]),
        cacheEntry("gemini-4-neon-xhigh", 2),
      ],
      { baseUrl: BASE_URL, keySha256: AGY_ONLY_KEY_SHA256 },
    );

    const agyKeyCtx = makeProviderContext({ agyApiKey: AGY_ONLY_KEY });
    expect(resolveAgyGatewayModels(agyKeyCtx)).toEqual([
      "claude-opus-5-5",
      "gemini-4-neon",
      "gemini-4-neon-xhigh",
    ]);
    const agyKeyPrepared = prepareAgyEnv({}, agyKeyCtx);
    expect(agyKeyPrepared.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual([
      "claude-opus-5-5-max",
      "claude-opus-5-5-low",
      "gemini-4-neon",
      "gemini-4-neon-xhigh",
    ]);
  });

  it("TC-SRVEFF-17: legacy gateway cache (no supportedEffortLevels) and offline fallback still expand gemini-3.8-flash into high, medium, low", () => {
    const dir = makeTempDir();
    const providerCtx = makeProviderContext();

    // 1. Legacy gateway: cached entries exist under #agy-v2#, but NONE have supportedEffortLevels
    const legacyCacheFile = join(dir, "cache-legacy-gateway.json");
    writeAgyV2Cache(legacyCacheFile, [
      cacheEntry("claude-opus-4-6", 0),
      cacheEntry("gemini-3.8-flash", 1),
      cacheEntry("gemini-4-hydrogen", 2),
      cacheEntry("gemini-3.5-flash-lite", 3),
    ]);

    expect(resolveAgyGatewayModels(providerCtx)).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash",
      "gemini-4-hydrogen",
      "gemini-3.5-flash-lite",
    ]);

    const legacyPrepared = prepareAgyEnv({}, providerCtx);
    const legacyEnvVars = agyClient.getEnvVars(providerCtx);
    for (const env of [legacyPrepared, legacyEnvVars]) {
      expect(env.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual([
        "claude-opus-4-6",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-4-hydrogen",
        "gemini-3.5-flash-lite",
      ]);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).toBe("gemini-3.8-flash");
    }

    // 2. Offline / cold start: cache file does not exist -> falls back to DEFAULT_AGY_GATEWAY_MODELS
    const missingCacheFile = join(dir, "non-existent-cache.json");
    _setCachePathForTest(missingCacheFile);
    _resetTakoCatalog();

    expect(resolveAgyGatewayModels(providerCtx)).toEqual([...DEFAULT_AGY_GATEWAY_MODELS]);
    const offlinePrepared = prepareAgyEnv({}, providerCtx);
    expect(offlinePrepared.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ]);
  });
});
