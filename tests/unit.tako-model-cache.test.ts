import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetTakoCatalog, _setCachePathForTest, getTakoModels,
  refreshAllTakoCatalogs, refreshTakoModels,
} from "../src/models/tako";
import type { Provider } from "../src/providers/types";

const URL = "https://registry.example.test";
const KEY_A = "fake-model-account-a";
const KEY_B = "fake-model-account-b";
const originalFetch = globalThis.fetch;

function provider(apiKey: string): Provider {
  return { id: "provider", name: "Provider", type: "custom", baseUrl: URL, apiKey, createdAt: "2026-10-31" };
}

function response(model: string): Response {
  return Response.json({ models: [{ slug: model, context_window: 200000 }] });
}

describe("provider model cache account isolation", () => {
  let directory: string;
  let cache: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tako-model-account-cache-"));
    cache = join(directory, "models.json");
    _setCachePathForTest(cache);
    _resetTakoCatalog();
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const header = new Headers(init?.headers).get("Authorization");
      return response(header === `Bearer ${KEY_A}` ? "model-a" : "model-b");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps same-endpoint account fetches and catalogs separate", async () => {
    await refreshAllTakoCatalogs([provider(KEY_A), provider(KEY_B)]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(getTakoModels(URL, "openai", KEY_A)?.map((entry) => entry.id)).toEqual(["model-a"]);
    expect(getTakoModels(URL, "openai", KEY_B)?.map((entry) => entry.id)).toEqual(["model-b"]);
  });

  it("refreshes when the key changes on the same saved provider", async () => {
    await refreshAllTakoCatalogs([provider(KEY_A)]);
    expect(getTakoModels(URL, "claude", KEY_B)).toBeNull();
    await refreshAllTakoCatalogs([provider(KEY_B)]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(getTakoModels(URL, "claude", KEY_B)?.[0]?.id).toBe("model-b");
    expect(getTakoModels(URL, "claude", KEY_A)?.[0]?.id).toBe("model-a");
  });

  it("deduplicates the same account and normalizes trailing slashes", async () => {
    await Promise.all([
      refreshTakoModels(URL, KEY_A, "openai"),
      refreshTakoModels(`${URL}/`, KEY_A, "openai"),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getTakoModels(`${URL}/`, "openai", KEY_A)?.[0]?.id).toBe("model-a");
  });

  it("does not reuse account-ambiguous legacy snapshots", () => {
    writeFileSync(cache, JSON.stringify({ version: 1, buckets: {
      [`${URL}#openai`]: { fetchedAt: Date.now(), entries: [{ id: "legacy-account-model" }] },
    } }));
    expect(getTakoModels(URL, "openai", KEY_A)).toBeNull();
    expect(getTakoModels(URL, "openai")).toBeNull();
  });

  it("persists separate caches without writing the keys themselves", async () => {
    await refreshTakoModels(URL, KEY_A, "openai");
    await refreshTakoModels(URL, KEY_B, "openai");
    const saved = readFileSync(cache, "utf8");
    expect(saved).not.toContain(KEY_A);
    expect(saved).not.toContain(KEY_B);
    expect(JSON.parse(saved).version).toBe(2);
    _resetTakoCatalog();
    expect(getTakoModels(URL, "openai", KEY_A)?.[0]?.id).toBe("model-a");
    expect(getTakoModels(URL, "openai", KEY_B)?.[0]?.id).toBe("model-b");
  });

  it("never falls back to another account after a refresh failure", async () => {
    await refreshTakoModels(URL, KEY_A, "claude");
    globalThis.fetch = mock(async () => { throw new Error("offline"); }) as typeof fetch;
    await refreshTakoModels(URL, KEY_B, "claude");
    expect(getTakoModels(URL, "claude", KEY_B)).toBeNull();
    expect(getTakoModels(URL, "claude", KEY_A)?.[0]?.id).toBe("model-a");
  });
});
