import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientLaunchOptions } from "../src/clients/base";
import { agyClient, DEFAULT_AGY_GATEWAY_MODELS } from "../src/clients/agy";
import { claudeCodeClient } from "../src/clients/claude-code";
import { codexClient } from "../src/clients/codex";
import { grokClient } from "../src/clients/grok";
import { piClient } from "../src/clients/pi";
import { _resetTakoCatalog, _setCachePathForTest, type TakoApiType } from "../src/models/tako";
import type { Provider } from "../src/providers/types";

const BASE = "https://qualification.example.test";
const KEY_A = "fixture-account-a";
const KEY_B = "fixture-account-b";
const protocols: TakoApiType[] = ["openai", "claude", "gemini"];
const clients = [claudeCodeClient, codexClient, piClient, grokClient, agyClient];
const entry = (id: string, category = "chat") => ({
  id, displayName: id, description: "Fixture only", contextWindow: 128000, sortOrder: 0, category,
});
const provider = (apiKey: string, baseUrl = BASE): Provider => ({
  id: "qualification", name: "Fixture", type: "custom", baseUrl, apiKey, createdAt: "2026-11-16",
});
const key = (baseUrl: string, apiType: TakoApiType, apiKey: string) =>
  `${baseUrl}#${apiType === "gemini" ? "agy-v2" : apiType}#${createHash("sha256").update(apiKey).digest("hex")}`;
const fixturePrefix = (apiType: TakoApiType) => (apiType === "gemini" ? "gemini-4" : `grok-${apiType}`);
const defaultAgyOptionIds = DEFAULT_AGY_GATEWAY_MODELS.map((id) => `model-${id}`);

// These are launcher/adapter checks, NOT claims of native TUI or inference eligibility.
describe("cross-client launcher catalog qualification", () => {
  let directory: string;
  let cache: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tako-model-qualification-"));
    cache = join(directory, "models.json");
    _setCachePathForTest(cache);
    _resetTakoCatalog();
  });
  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(directory, { recursive: true, force: true });
  });
  const models = (client: typeof clients[number], current: Provider) =>
    getClientLaunchOptions(client, current).filter(option => option.group === "model").map(option => option.id);

  for (const client of clients) {
    it(`${client.id}: isolates endpoint, account and protocol without leaking another catalog`, () => {
      const buckets = Object.fromEntries(protocols.flatMap(apiType => [
        [key(BASE, apiType, KEY_A), { fetchedAt: Date.now(), entries: [
          entry(`${fixturePrefix(apiType)}-account-a`),
          ...(apiType === "gemini" ? [entry("deepseek-v4-flash"), entry("gemini-3-pro-image")] : [entry("grok-image-fixture", "image")]),
        ] }],
        [key(BASE, apiType, KEY_B), { fetchedAt: Date.now(), entries: [entry(`${fixturePrefix(apiType)}-account-b`)] }],
        [key(`${BASE}/other`, apiType, KEY_A), { fetchedAt: Date.now(), entries: [entry(`${fixturePrefix(apiType)}-other-endpoint`)] }],
      ]));
      writeFileSync(cache, JSON.stringify({ version: 2, buckets }));
      const apiType: TakoApiType = client.id === "agy" ? "gemini" : ["codex", "grok"].includes(client.id) ? "openai" : "claude";
      const prefix = fixturePrefix(apiType);
      expect(models(client, provider(KEY_A))).toEqual([`model-${prefix}-account-a`]);
      expect(models(client, provider(KEY_B))).toEqual([`model-${prefix}-account-b`]);
      expect(models(client, provider(KEY_A, `${BASE}/other`))).toEqual([`model-${prefix}-other-endpoint`]);
      expect(models(client, provider("unseen-account")).some(id => id.includes("account-a") || id.includes("account-b")))
        .toBe(false);
    });

    it(`${client.id}: does not borrow model IDs from a different protocol's catalog`, () => {
      const apiType: TakoApiType = client.id === "agy" ? "gemini" : ["codex", "grok"].includes(client.id) ? "openai" : "claude";
      writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(
        protocols.filter(protocol => protocol !== apiType).map(protocol => [
          key(BASE, protocol, KEY_A),
          {
            fetchedAt: Date.now(),
            entries: [entry(client.id === "agy" ? `gemini-4-unqualified-${protocol}` : `grok-unqualified-${protocol}`)],
          },
        ]),
      ) }));
      expect(models(client, provider(KEY_A)).some(id => id.includes("unqualified"))).toBe(false);
    });

    it(`${client.id}: handles empty or non-eligible catalogs appropriately`, () => {
      if (client.id === "agy") {
        for (const entries of [[], [entry("deepseek-v4-flash"), entry("gemini-3-pro-image")]]) {
          writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(protocols.map(apiType => [
            key(BASE, apiType, KEY_A), { fetchedAt: Date.now(), entries },
          ])) }));
          _resetTakoCatalog();
          expect(models(client, provider(KEY_A))).toEqual(defaultAgyOptionIds);
        }
        return;
      }
      for (const entries of [[], [entry("grok-image-fixture", "image")]]) {
        writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(protocols.map(apiType => [
          key(BASE, apiType, KEY_A), { fetchedAt: Date.now(), entries },
        ])) }));
        _resetTakoCatalog();
        expect(models(client, provider(KEY_A))).toEqual([]);
      }
    });
  }

  it("keeps static launcher fallbacks when no account catalog is available", () => {
    for (const client of [claudeCodeClient, codexClient, piClient, grokClient]) {
      expect(models(client, provider("unseen-account")).length).toBeGreaterThan(0);
    }
    expect(models(agyClient, provider("unseen-account"))).toEqual(defaultAgyOptionIds);
    expect(models(agyClient, { ...provider("unseen-account"), apiKey: "" })).toEqual([]);
  });
});
