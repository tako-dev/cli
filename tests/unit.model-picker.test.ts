import { describe, expect, it } from "bun:test";
import type { LaunchOption } from "../src/clients";
import {
  COMMON_MODEL_LIMIT,
  commonModelOptions,
  listedModelOptions,
  MODEL_PAGE_SIZE,
  modelPickerWindow,
} from "../src/ui/shared/model-picker";

function model(id: string, label = id): LaunchOption {
  return {
    id,
    label: { en: label, zh: label },
    shortLabel: label,
    description: { en: label, zh: label },
    flag: `--model ${id.replace(/^model-/, "")}`,
    args: [],
    group: "model",
  };
}

describe("commonModelOptions", () => {
  it("uses the first six catalog models when there are no pick counts", () => {
    const options = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => model(`model-${id}`));

    expect(commonModelOptions(options, {}).map((o) => o.id)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
    ]);
  });

  it("shows the top six picked models in pick-count order", () => {
    const options = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => model(`model-${id}`));

    expect(commonModelOptions(options, {
      "model-b": 90,
      "model-c": 80,
      "model-d": 70,
      "model-e": 60,
      "model-f": 50,
      "model-g": 40,
      "model-h": 30,
      "model-i": 20,
      "model-a": 10,
    }).map((o) => o.id)).toEqual([
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "model-g",
    ]);
  });

  it("reorders visible picks by hotness even when source option order differs", () => {
    const options = [
      "model-minimax-m3",
      "model-claude-fable-5",
      "model-glm-5.2",
      "model-kimi-k2.6",
      "model-deepseek-v4-pro",
      "model-mimo-v2.5-pro",
    ].map(model);

    expect(commonModelOptions(options, {
      "model-glm-5.2": 6.6,
      "model-deepseek-v4-pro": 2.0,
      "model-kimi-k2.6": 0.98,
      "model-claude-fable-5": 0.59,
      "model-mimo-v2.5-pro": 0.39,
      "model-minimax-m3": 0.14,
    }).map((o) => o.id)).toEqual([
      "model-glm-5.2",
      "model-deepseek-v4-pro",
      "model-kimi-k2.6",
      "model-claude-fable-5",
      "model-mimo-v2.5-pro",
      "model-minimax-m3",
    ]);
  });
});

describe("listedModelOptions", () => {
  const options = [
    model("model-glm-5.2", "GLM 5.2"),
    model("model-gpt-5.5", "GPT 5.5"),
    model("model-gpt-5.4", "GPT 5.4"),
    model("model-claude-opus-4-8", "Claude Opus 4.8"),
    model("model-deepseek-v4-pro", "DeepSeek V4 Pro"),
    model("model-kimi-k2.6", "Kimi K2.6"),
    model("model-minimax-m3", "MiniMax M3"),
    model("model-mimo-v2.5-pro", "MiMo V2.5 Pro"),
    model("model-qwen3.7-max", "Qwen3.7 Max"),
  ];

  it("puts the six common models first, then the rest of the catalog", () => {
    const list = listedModelOptions(options, {
      "model-glm-5.2": 6.6,
      "model-deepseek-v4-pro": 2.0,
      "model-kimi-k2.6": 0.98,
      "model-gpt-5.5": 0.5,
      "model-gpt-5.4": 0.4,
      "model-claude-opus-4-8": 0.3,
      "model-minimax-m3": 0.1,
    }, "");

    expect(list.slice(0, COMMON_MODEL_LIMIT).map((o) => o.id)).toEqual([
      "model-glm-5.2",
      "model-deepseek-v4-pro",
      "model-kimi-k2.6",
      "model-gpt-5.5",
      "model-gpt-5.4",
      "model-claude-opus-4-8",
    ]);
    expect(list.map((o) => o.id)).toEqual([
      "model-glm-5.2",
      "model-deepseek-v4-pro",
      "model-kimi-k2.6",
      "model-gpt-5.5",
      "model-gpt-5.4",
      "model-claude-opus-4-8",
      "model-minimax-m3",
      "model-mimo-v2.5-pro",
      "model-qwen3.7-max",
    ]);
  });

  it("returns every matching model when filtering, not just one page", () => {
    const many = Array.from({ length: 12 }, (_, i) => model(`model-gpt-${i}`, `GPT ${i}`));
    const list = listedModelOptions(many, {}, "gpt");

    expect(list).toHaveLength(12);
    expect(list.every((option) => option.id.includes("gpt"))).toBe(true);
  });

  it("can surface a model that is not in the common six", () => {
    const list = listedModelOptions(options, {
      "model-glm-5.2": 90,
      "model-gpt-5.5": 80,
      "model-gpt-5.4": 70,
      "model-claude-opus-4-8": 60,
      "model-deepseek-v4-pro": 50,
      "model-kimi-k2.6": 40,
      "model-minimax-m3": 30,
    }, "qwen");

    expect(list.map((o) => o.id)).toEqual(["model-qwen3.7-max"]);
  });
});

describe("modelPickerWindow", () => {
  it("shows the full list when it fits on one page", () => {
    expect(modelPickerWindow(3, 8)).toEqual({ start: 0, end: 8 });
  });

  it("keeps a ten-item window around the selection", () => {
    expect(MODEL_PAGE_SIZE).toBe(10);
    expect(modelPickerWindow(0, 30)).toEqual({ start: 0, end: 10 });
    expect(modelPickerWindow(14, 30)).toEqual({ start: 9, end: 19 });
    expect(modelPickerWindow(29, 30)).toEqual({ start: 20, end: 30 });
  });
});
