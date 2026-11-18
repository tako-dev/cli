import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientLaunchOptions } from "../src/clients/base";
import { agyClient } from "../src/clients/agy";
import { claudeCodeClient } from "../src/clients/claude-code";
import { codexClient } from "../src/clients/codex";
import { geminiClient } from "../src/clients/gemini";
import { grokClient } from "../src/clients/grok";
import { piClient } from "../src/clients/pi";
import { _resetTakoCatalog, _setCachePathForTest, type TakoApiType } from "../src/models/tako";
import type { Provider } from "../src/providers/types";

const BASE = "https://qualification.example.test";
const KEY_A = "fixture-account-a";
const KEY_B = "fixture-account-b";
const protocols: TakoApiType[] = ["openai", "claude", "gemini"];
const clients = [claudeCodeClient, codexClient, piClient, grokClient, geminiClient, agyClient];
const entry = (id: string, category = "chat") => ({
  id, displayName: id, description: "Fixture only", contextWindow: 128000, sortOrder: 0, category,
});
const provider = (apiKey: string, baseUrl = BASE): Provider => ({
  id: "qualification", name: "Fixture", type: "custom", baseUrl, apiKey, createdAt: "2026-11-16",
});
const key = (baseUrl: string, apiType: TakoApiType, apiKey: string) =>
  `${baseUrl}#${apiType}#${createHash("sha256").update(apiKey).digest("hex")}`;

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
          entry(`grok-${apiType}-account-a`), ...(apiType === "gemini" ? [] : [entry("grok-image-fixture", "image")]),
        ] }],
        [key(BASE, apiType, KEY_B), { fetchedAt: Date.now(), entries: [entry(`grok-${apiType}-account-b`)] }],
        [key(`${BASE}/other`, apiType, KEY_A), { fetchedAt: Date.now(), entries: [entry(`grok-${apiType}-other-endpoint`)] }],
      ]));
      writeFileSync(cache, JSON.stringify({ version: 2, buckets }));
      const apiType = ["gemini", "agy"].includes(client.id) ? "gemini" : ["codex", "grok"].includes(client.id) ? "openai" : "claude";
      expect(models(client, provider(KEY_A))).toEqual([`model-grok-${apiType}-account-a`]);
      expect(models(client, provider(KEY_B))).toEqual([`model-grok-${apiType}-account-b`]);
      expect(models(client, provider(KEY_A, `${BASE}/other`))).toEqual([`model-grok-${apiType}-other-endpoint`]);
      expect(models(client, provider("unseen-account")).some(id => id.includes("account-a") || id.includes("account-b")))
        .toBe(false);
    });

    it(`${client.id}: does not borrow model IDs from a different protocol's catalog`, () => {
      const apiType = ["gemini", "agy"].includes(client.id) ? "gemini" : ["codex", "grok"].includes(client.id) ? "openai" : "claude";
      writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(
        protocols.filter(protocol => protocol !== apiType).map(protocol => [
          key(BASE, protocol, KEY_A), { fetchedAt: Date.now(), entries: [entry(`grok-unqualified-${protocol}`)] },
        ]),
      ) }));
      expect(models(client, provider(KEY_A)).some(id => id.includes("unqualified"))).toBe(false);
    });

    it(`${client.id}: a known empty or non-chat catalog does not re-enable static fallback models`, () => {
      for (const entries of ["gemini", "agy"].includes(client.id) ? [[]] : [[], [entry("grok-image-fixture", "image")]]) {
        writeFileSync(cache, JSON.stringify({ version: 2, buckets: Object.fromEntries(protocols.map(apiType => [
          key(BASE, apiType, KEY_A), { fetchedAt: Date.now(), entries },
        ])) }));
        _resetTakoCatalog();
        expect(models(client, provider(KEY_A))).toEqual([]);
      }
    });
  }

  it("keeps legacy static launcher fallbacks only when no account catalog is available", () => {
    for (const client of [claudeCodeClient, codexClient, piClient, grokClient]) {
      expect(models(client, provider("unseen-account")).length).toBeGreaterThan(0);
    }
    expect(models(geminiClient, provider("unseen-account"))).toEqual([]);
    expect(models(agyClient, provider("unseen-account"))).toEqual([]);
  });
});
