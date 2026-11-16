import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  _resetTakoCatalog, _setCachePathForTest, getFreshTakoModels, getTakoModels,
  refreshAllTakoCatalogs, refreshTakoModels,
} from "../src/models/tako";
import type { Provider } from "../src/providers/types";

const URL = "https://registry.example.test";
const KEY_A = "fake-model-account-a";
const KEY_B = "fake-model-account-b";
const originalFetch = globalThis.fetch;

function provider(apiKey: string): Provider {
  return { id: "provider", name: "Provider", type: "custom", baseUrl: URL, apiKey, createdAt: "2026-10-31", supportedClients: ["claude-code", "codex"] };
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

  for (const apiType of ["openai", "claude"] as const) {
    for (const list of ["models", "data"] as const) {
      it(`revokes only the current ${apiType} account after a complete empty ${list} list`, async () => {
        await refreshTakoModels(URL, KEY_A, apiType);
        await refreshTakoModels(URL, KEY_B, apiType);
        globalThis.fetch = mock(async () => Response.json({ [list]: [] })) as typeof fetch;
        await refreshTakoModels(URL, KEY_A, apiType);
        expect(getFreshTakoModels(URL, apiType, KEY_A)).toEqual([]);
        expect(getTakoModels(URL, apiType, KEY_B)?.[0]?.id).toBe("model-b");
        _resetTakoCatalog();
        expect(getTakoModels(URL, apiType, KEY_A)).toEqual([]);
        expect(getTakoModels(URL, apiType, KEY_B)?.[0]?.id).toBe("model-b");
      });
    }

    it(`rejects invalid or incomplete ${apiType} lists without renewing freshness`, async () => {
      await refreshTakoModels(URL, KEY_A, apiType);
      const snapshot = readFileSync(cache, "utf8");
      for (const payload of [
        {}, [], null, { models: "invalid" }, { data: "invalid" },
        { models: [{ name: "wrong-protocol" }] }, { data: [null] },
        { models: [{ slug: "partial" }], has_more: true },
        { data: [{ id: "partial" }], has_more: true, last_id: "partial" },
        { data: [], has_more: "false" },
      ]) {
        globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch;
        await refreshTakoModels(URL, KEY_A, apiType);
        expect(readFileSync(cache, "utf8")).toBe(snapshot);
        expect(getTakoModels(URL, apiType, KEY_A)?.[0]?.id).toBe("model-a");
      }
    });
  }

  it("revokes models when a complete OpenAI list no longer supports the requested protocol", async () => {
    await refreshTakoModels(URL, KEY_A, "claude");
    globalThis.fetch = mock(async () => Response.json({
      data: [{ id: "openai-only", supported_endpoint_types: ["openai"] }], has_more: false,
    })) as typeof fetch;
    await refreshTakoModels(URL, KEY_A, "claude");
    expect(getTakoModels(URL, "claude", KEY_A)).toEqual([]);
  });

  it("does not follow redirects while discovering an authenticated catalog", async () => {
    await refreshTakoModels(URL, KEY_A, "openai");
    expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("refreshes future-dated snapshots rather than suppressing discovery indefinitely", async () => {
    const fingerprint = createHash("sha256").update(KEY_A).digest("hex");
    writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(
      ["openai", "claude"].map(apiType => [`${URL}#${apiType}#${fingerprint}`, {
        fetchedAt: Date.now() + 24 * 60 * 60 * 1000, entries: [{ id: "future-snapshot" }],
      }]),
    ) }));
    expect(getFreshTakoModels(URL, "claude", KEY_A)).toBeNull();
    await refreshAllTakoCatalogs([provider(KEY_A)]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(getFreshTakoModels(URL, "claude", KEY_A)?.[0]?.id).toBe("model-a");
  });
});
