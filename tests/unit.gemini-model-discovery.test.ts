import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetTakoCatalog, _setCachePathForTest, getTakoModels, parseGeminiModels, refreshAllTakoCatalogs, refreshTakoModels } from "../src/models/tako";
import { buildGeminiModelOptions } from "../src/clients/gemini";
import type { Provider } from "../src/providers/types";

const BASE_URL = "https://gemini.example.test";
const KEY = "fixture-gemini-key-a";
const provider: Provider = { id: "fixture", name: "Fixture", type: "custom", baseUrl: BASE_URL, apiKey: KEY, createdAt: "2026-10-31", supportedClients: ["gemini"] };
const originalFetch = globalThis.fetch;
const model = (id: string) => ({ name: `models/${id}`, displayName: id.toUpperCase(), inputTokenLimit: 1000000, description: "Fixture model", supportedGenerationMethods: ["generateContent"] });

it("parses only valid Gemini generateContent models, not Codex or embeddings", () => {
  expect(parseGeminiModels({ models: [model("gemini-fixture"), { name: "models/embed", supportedGenerationMethods: ["embedContent"] }, { slug: "openai-model" }, model("invalid/path"), null] })).toEqual([
    { id: "gemini-fixture", displayName: "GEMINI-FIXTURE", description: "Fixture model", contextWindow: 1000000, sortOrder: 0, category: "chat" },
  ]);
  expect(parseGeminiModels({ data: [{ id: "openai-model" }] })).toEqual([]);
  expect(parseGeminiModels(null)).toEqual([]);
});

describe("Gemini-native account catalog discovery", () => {
  let directory: string;
  let cache: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tako-gemini-catalog-"));
    cache = join(directory, "cache.json");
    _setCachePathForTest(cache);
    _resetTakoCatalog();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(directory, { recursive: true, force: true });
  });

  it("fetches all pages using native auth and client=agy and exposes exact launcher IDs", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      urls.push(String(url));
      expect(url.pathname).toBe("/v1beta/models");
      expect(url.searchParams.get("client")).toBe("agy");
      expect(url.searchParams.has("key")).toBe(false);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(KEY);
      expect(init?.redirect).toBe("error");
      return Response.json(url.searchParams.has("pageToken")
        ? { models: [model("gemini-b")] }
        : { models: [model("gemini-a")], nextPageToken: "next" });
    };
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("client=agy");
    expect(urls[1]).toContain("client=agy");
    expect(urls[1]).toContain("pageToken=next");
    expect(buildGeminiModelOptions(provider).map((option) => option.args)).toEqual([["--model", "gemini-a"], ["--model", "gemini-b"]]);
    expect(getTakoModels(BASE_URL, "openai", KEY)).toBeNull();
    const saved = readFileSync(cache, "utf8");
    expect(saved).not.toContain(KEY);
    expect(saved).toContain("#agy-v2#");
    expect(saved).not.toContain("#gemini#");
  });

  it("bypasses stale v0.3.54 #gemini# buckets on upgrade and refreshes into #agy-v2#", async () => {
    const fp = createHash("sha256").update(KEY).digest("hex");
    writeFileSync(cache, JSON.stringify({
      version: 2,
      buckets: {
        [`${BASE_URL}#gemini#${fp}`]: {
          fetchedAt: Date.now(),
          entries: [{ id: "deepseek-v4-flash", displayName: "DeepSeek", description: "", contextWindow: 128000, sortOrder: 0, category: "chat" }],
        },
      },
    }));
    _resetTakoCatalog();

    // Stale #gemini# bucket must be ignored on read
    expect(getTakoModels(BASE_URL, "gemini", KEY)).toBeNull();

    // refreshAllTakoCatalogs treats #agy-v2# as cold and fetches with ?client=agy
    const fetchedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("/v1beta/models")) {
        return Response.json({ models: [model("claude-opus-4-6")] });
      }
      return Response.json({ models: [{ slug: "other", context_window: 200000 }] });
    };
    await refreshAllTakoCatalogs([provider]);
    const geminiCalls = fetchedUrls.filter((u) => u.includes("/v1beta/models"));
    expect(geminiCalls).toHaveLength(1);
    expect(new URL(geminiCalls[0]!).searchParams.get("client")).toBe("agy");
    expect(getTakoModels(BASE_URL, "gemini", KEY)?.map((e) => e.id)).toEqual(["claude-opus-4-6"]);
  });

  it("isolates credentials and preserves only that account's offline catalog", async () => {
    globalThis.fetch = async (_input, init) => Response.json({ models: [model(new Headers(init?.headers).get("x-goog-api-key") === KEY ? "gemini-a" : "gemini-b")] });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    await refreshTakoModels(BASE_URL, "fixture-gemini-key-b", "gemini");
    expect(getTakoModels(BASE_URL, "gemini", KEY)?.[0]?.id).toBe("gemini-a");
    expect(getTakoModels(BASE_URL, "gemini", "fixture-gemini-key-b")?.[0]?.id).toBe("gemini-b");
    globalThis.fetch = async () => Response.json({}, { status: 401 });
    await refreshTakoModels(BASE_URL, "fixture-account-new", "gemini");
    expect(getTakoModels(BASE_URL, "gemini", "fixture-account-new")).toBeNull();
    expect(buildGeminiModelOptions({ ...provider, apiKey: "fixture-account-new" })).toEqual([]);
  });

  it("does not publish partial pagination results when later pages fail or repeat", async () => {
    globalThis.fetch = async () => Response.json({ models: [model("cached")] });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    let count = 0;
    globalThis.fetch = async () => ++count === 1
      ? Response.json({ models: [model("partial")], nextPageToken: "next" })
      : Response.json({}, { status: 500 });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    expect(getTakoModels(BASE_URL, "gemini", KEY)?.[0]?.id).toBe("cached");
    globalThis.fetch = async () => Response.json({ models: [model("partial")], nextPageToken: "same" });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    expect(getTakoModels(BASE_URL, "gemini", KEY)?.[0]?.id).toBe("cached");
  });

  it("does not treat malformed or schema-less successful responses as an empty catalog", async () => {
    globalThis.fetch = async () => Response.json({ models: [model("retained")] });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    for (const malformed of [{}, [], { models: "invalid" }]) {
      globalThis.fetch = async () => Response.json(malformed);
      await refreshTakoModels(BASE_URL, KEY, "gemini");
      expect(getTakoModels(BASE_URL, "gemini", KEY)?.[0]?.id).toBe("retained");
    }
  });

  it("removes revoked Gemini models after a successful complete empty catalog", async () => {
    globalThis.fetch = async () => Response.json({ models: [model("removed")] });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    globalThis.fetch = async () => Response.json({ models: [] });
    await refreshTakoModels(BASE_URL, KEY, "gemini");
    expect(getTakoModels(BASE_URL, "gemini", KEY)).toEqual([]);
    _resetTakoCatalog();
    expect(getTakoModels(BASE_URL, "gemini", KEY)).toEqual([]);
    expect(buildGeminiModelOptions(provider)).toEqual([]);
  });

  it("refreshes compatible provider Gemini buckets with TTL and ignores non-Gemini declarations", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json(String(input).includes("v1beta") ? { models: [model("gemini-a")] } : { models: [{ slug: "other", context_window: 200000 }] });
    };
    await refreshAllTakoCatalogs([provider]);
    expect(urls.filter((url) => url.includes("v1beta"))).toHaveLength(1);
    await refreshAllTakoCatalogs([provider]);
    expect(urls).toHaveLength(3);
    await refreshAllTakoCatalogs([{ ...provider, apiKey: "other-key", supportedClients: ["codex"] }]);
    expect(urls.filter((url) => url.includes("v1beta"))).toHaveLength(1);
  });
});
