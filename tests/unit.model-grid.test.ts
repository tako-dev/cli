import { describe, it, expect } from "bun:test";
import type { LaunchOption } from "../src/clients";
import {
  buildGroupedGrid,
  buildGrid,
  compareModelIdsForPicker,
  getGridColumnCountForLabels,
  gridIndexOf,
  initialModelPickerMode,
  modelFamilyOf,
  visibleModelOptions,
} from "../src/ui/shared/model-picker";

function model(id: string): LaunchOption {
  return {
    id,
    label: { en: id, zh: id },
    shortLabel: id,
    description: { en: id, zh: id },
    flag: `--model ${id}`,
    args: [],
    group: "model",
  };
}

describe("model picker grid and collapsed visibility", () => {
  it("shows all model options for new users without pick counts", () => {
    const options = ["model-a", "model-b", "model-c"].map(model);

    const result = visibleModelOptions(options, new Set(), {});

    expect(result.list.map((o) => o.id)).toEqual(["model-a", "model-b", "model-c"]);
    expect(result.hiddenCount).toBe(0);
  });

  it("opens long model lists as a grid before a new user has pick counts", () => {
    const options = [
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "model-g",
      "model-h",
    ].map(model);

    const result = visibleModelOptions(options, new Set(), {});

    expect(result.list.map((o) => o.id)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "model-g",
      "model-h",
    ]);
    expect(result.hiddenCount).toBe(0);
    expect(initialModelPickerMode(options, {})).toBe("grid");
  });

  it("shows top picked models in pick-count order and keeps selected models appended", () => {
    const options = [
      "model-a",
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "model-g",
      "model-h",
    ].map(model);

    const result = visibleModelOptions(
      options,
      new Set(["model-h"]),
      {
        "model-b": 90,
        "model-c": 80,
        "model-d": 70,
        "model-e": 60,
        "model-f": 50,
        "model-g": 40,
      },
    );

    expect(result.list.map((o) => o.id)).toEqual([
      "model-b",
      "model-c",
      "model-d",
      "model-e",
      "model-f",
      "model-g",
      "model-h",
    ]);
    expect(result.hiddenCount).toBe(1);
    expect(initialModelPickerMode(options, { "model-b": 90 })).toBe("collapsed");
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

    const result = visibleModelOptions(options, new Set(), {
      "model-glm-5.2": 6.6,
      "model-deepseek-v4-pro": 2.0,
      "model-kimi-k2.6": 0.98,
      "model-claude-fable-5": 0.59,
      "model-mimo-v2.5-pro": 0.39,
      "model-minimax-m3": 0.14,
    });

    expect(result.list.map((o) => o.id)).toEqual([
      "model-glm-5.2",
      "model-deepseek-v4-pro",
      "model-kimi-k2.6",
      "model-claude-fable-5",
      "model-mimo-v2.5-pro",
      "model-minimax-m3",
    ]);
  });

  it("builds rows and flat model ids with the requested column count", () => {
    const result = buildGrid(["a", "b", "c", "d", "e"], 3);

    expect(result.rows).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    expect(result.flat).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("groups model ids by the underlying vendor family", () => {
    expect(modelFamilyOf("model-gpt-5.5")).toBe("gpt");
    expect(modelFamilyOf("model-glm-5.2")).toBe("glm");
    expect(modelFamilyOf("model-qwen3.7-max")).toBe("qwe");
    expect(modelFamilyOf("model-deepseek-v4-pro")).toBe("dee");
    // 回归: "full-" / "满血-" 是变体修饰词,必须剥掉,否则 full-claude/full-gpt/full-glm
    // 会全部撞成 "ful" 家族跨厂商混在一起 (INV-MODEL-FAMILY-PREFIX)。
    expect(modelFamilyOf("model-full-claude-opus-4-8")).toBe("cla");
    expect(modelFamilyOf("model-full-gpt-5")).toBe("gpt");
    expect(modelFamilyOf("model-full-glm-5")).toBe("glm");
    expect(modelFamilyOf("model-满血-claude-opus-4-8")).toBe("cla");
  });

  it("sorts larger model numbers before smaller model numbers in the same family", () => {
    const ids = ["model-gpt-5.4", "model-gpt-5.5", "model-gpt-4o-mini", "model-gpt-5.3-codex"];

    expect([...ids].sort(compareModelIdsForPicker)).toEqual([
      "model-gpt-5.5",
      "model-gpt-5.4",
      "model-gpt-5.3-codex",
      "model-gpt-4o-mini",
    ]);
  });

  it("builds grouped grid rows and flat ids in rendered order", () => {
    const result = buildGroupedGrid(
      [
        "model-qwen3.5",
        "model-gpt-5.4",
        "model-gpt-5.5",
        "model-qwen3.7-max",
        "model-kimi-k2.6",
      ],
      2,
    );

    expect(result.groups.map((g) => [g.family, g.rows])).toEqual([
      ["gpt", [["model-gpt-5.5", "model-gpt-5.4"]]],
      ["kim", [["model-kimi-k2.6"]]],
      ["qwe", [["model-qwen3.7-max", "model-qwen3.5"]]],
    ]);
    expect(result.flat).toEqual([
      "model-gpt-5.5",
      "model-gpt-5.4",
      "model-kimi-k2.6",
      "model-qwen3.7-max",
      "model-qwen3.5",
    ]);
  });

  it("finds a model index in grouped render order", () => {
    const ids = ["model-qwen3.5", "model-gpt-5.4", "model-gpt-5.5"];

    expect(gridIndexOf(ids, "model-gpt-5.4", 2)).toBe(1);
    expect(gridIndexOf(ids, "model-qwen3.5", 2)).toBe(2);
    expect(gridIndexOf(ids, "model-missing", 2)).toBe(-1);
  });

  it("uses at most four columns in the grouped picker grid", () => {
    const result = buildGroupedGrid(
      ["model-gpt-5.5", "model-gpt-5.4", "model-gpt-5.3", "model-gpt-5.2", "model-gpt-5.1"],
      8,
    );

    expect(result.groups[0].rows).toEqual([
      ["model-gpt-5.5", "model-gpt-5.4", "model-gpt-5.3", "model-gpt-5.2"],
      ["model-gpt-5.1"],
    ]);
  });

  it("reduces columns when labels are too wide for four columns", () => {
    const labels = [
      "Claude Opus 4.8 (满血)",
      "Claude Sonnet 4.6 (满血)",
      "Qwen3 Coder Next FP8",
      "GPT Image 2",
    ];

    expect(getGridColumnCountForLabels(labels, 80)).toBeLessThan(4);
    expect(getGridColumnCountForLabels(["gpt-5.5", "gpt-5.4", "glm-5"], 120)).toBe(3);
  });
});
