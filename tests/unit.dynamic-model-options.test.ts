import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClientLaunchOptions } from "../src/clients/base";
import { claudeCodeClient } from "../src/clients/claude-code";
import { codexClient } from "../src/clients/codex";
import type { Provider } from "../src/providers/types";
import {
  _resetTakoCatalog,
  _setCachePathForTest,
  filterChatModels,
  parseCodexResponse,
} from "../src/models/tako";

const BASE_URL = "https://models.example.test";

function provider(clientId: string): Provider {
  return {
    id: `p-${clientId}`,
    name: "P",
    type: "tako",
    baseUrl: BASE_URL,
    apiKey: "sk-test",
    supportedClients: [clientId],
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

function entry(id: string, category = "chat") {
  return {
    id,
    displayName: id,
    description: id,
    contextWindow: 200000,
    sortOrder: 0,
    category,
  };
}

// 非 chat 模型（纯生图/视频/音频）—— 不能在 Claude Code / Codex 里跑 chat，
// 必须被 filterChatModels 从下拉里剔除。INV-MODEL-CATEGORY-FILTER。
const IMAGE_ENTRY = entry("gpt-image-2", "image");
const VIDEO_ENTRY = entry("sora-2", "video");
const AUDIO_ENTRY = entry("tts-1", "audio");

describe("dynamic model launch options", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-dynamic-models-"));
    const cachePath = join(tmpDir, "tako-models-cache.json");
    _setCachePathForTest(cachePath);
    _resetTakoCatalog();
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        buckets: {
          [`${BASE_URL}#openai`]: {
            fetchedAt: Date.now(),
            entries: [
              entry("gpt-5.5"),
              entry("claude-opus-4-8"),
              entry("full-claude-opus-4-8"),
              entry("anthropic/claude-sonnet-4-6"),
              IMAGE_ENTRY,
              VIDEO_ENTRY,
              AUDIO_ENTRY,
            ],
          },
          [`${BASE_URL}#claude`]: {
            fetchedAt: Date.now(),
            entries: [
              entry("claude-opus-4-8"),
              entry("full-claude-opus-4-8"),
              entry("gpt-5.5"),
              entry("openai/gpt-5.4"),
              IMAGE_ENTRY,
              VIDEO_ENTRY,
              AUDIO_ENTRY,
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

  it("Codex model picker lists chat models in order", () => {
    const opts = getClientLaunchOptions(codexClient, provider("codex"));
    const ids = opts.filter((o) => o.group === "model").map((o) => o.id);

    expect(ids).toEqual([
      "model-gpt-5.5",
      "model-claude-opus-4-8",
      "model-full-claude-opus-4-8",
      "model-anthropic/claude-sonnet-4-6",
    ]);
  });

  it("Claude Code model picker lists chat models in order", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, provider("claude-code"));
    const ids = opts.filter((o) => o.group === "model").map((o) => o.id);

    expect(ids).toEqual([
      "model-claude-opus-4-8",
      "model-full-claude-opus-4-8",
      "model-gpt-5.5",
      "model-openai/gpt-5.4",
    ]);
  });

  it("filters out non-chat models (image/video/audio) from both pickers", () => {
    const codexIds = getClientLaunchOptions(codexClient, provider("codex"))
      .filter((o) => o.group === "model").map((o) => o.id);
    const claudeIds = getClientLaunchOptions(claudeCodeClient, provider("claude-code"))
      .filter((o) => o.group === "model").map((o) => o.id);

    for (const id of ["model-gpt-image-2", "model-sora-2", "model-tts-1"]) {
      expect(codexIds).not.toContain(id);
      expect(claudeIds).not.toContain(id);
    }
  });
});

describe("filterChatModels + parseCodexResponse", () => {
  it("parseCodexResponse reads model_category and defaults missing to 'chat'", () => {
    const entries = parseCodexResponse({
      models: [
        { slug: "gpt-5", model_category: "chat" },
        { slug: "gpt-image-2", model_category: "image" },
        { slug: "sora-2", model_category: "video" },
        { slug: "tts-1", model_category: "audio" },
        { slug: "claude-opus-4-8" }, // no field → default 'chat'
        { slug: "gemini-image", model_category: "" }, // empty → default 'chat'
      ],
    });

    const byId = Object.fromEntries(entries.map((e) => [e.id, e.category]));
    expect(byId).toEqual({
      "gpt-5": "chat",
      "gpt-image-2": "image",
      "sora-2": "video",
      "tts-1": "audio",
      "claude-opus-4-8": "chat",
      "gemini-image": "chat",
    });
  });

  it("filterChatModels keeps chat and missing-category, drops non-chat", () => {
    const entries = [
      { id: "a", category: "chat" },
      { id: "b", category: "image" },
      { id: "c", category: "video" },
      { id: "d", category: "audio" },
      { id: "e" }, // missing category (old cache) → treated as chat
    ];

    expect(filterChatModels(entries as any).map((e) => e.id)).toEqual(["a", "e"]);
  });
});

describe("parseCodexResponse OpenAI (new-api) fallback", () => {
  it("无 models 数组时回退解析 data[]，按 api_type 过滤并补 contextWindow", () => {
    const payload = {
      object: "list",
      success: true,
      data: [
        { id: "gpt-5.4", object: "model", owned_by: "openai", supported_endpoint_types: ["openai"] },
        { id: "claude-haiku-4-5", object: "model", owned_by: "claude", supported_endpoint_types: ["anthropic", "openai"] },
        { id: "glm-5.2", object: "model", owned_by: "zhipu", supported_endpoint_types: ["anthropic"] },
        { id: "gpt-image-2", object: "model", owned_by: "openai", supported_endpoint_types: ["openai"] },
      ],
    };
    const openaiList = parseCodexResponse(payload as any, "openai");
    expect(openaiList.map((e) => e.id)).toEqual(["claude-haiku-4-5", "gpt-5.4", "gpt-image-2"]);
    const haiku = openaiList.find((e) => e.id === "claude-haiku-4-5");
    expect(haiku?.contextWindow).toBe(200000); // bundled catalog 补
    const img = openaiList.find((e) => e.id === "gpt-image-2");
    expect(img?.category).toBe("image"); // 生图模型被标 image，不进 chat 下拉
    const claudeList = parseCodexResponse(payload as any, "claude");
    expect(claudeList.map((e) => e.id)).toEqual(["claude-haiku-4-5", "glm-5.2"]);
  });

  it("codex 形态优先，不走 OpenAI fallback", () => {
    const codex = {
      models: [{ slug: "gpt-5.4", display_name: "GPT 5.4", context_window: 272000, priority: 2 }],
      data: [{ id: "should-ignore" }],
    };
    const list = parseCodexResponse(codex as any, "openai");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "gpt-5.4",
      displayName: "GPT 5.4",
      contextWindow: 272000,
      sortOrder: 2,
      category: "chat",
    });
  });
});
