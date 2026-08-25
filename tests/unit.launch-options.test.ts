import { describe, expect, it } from "bun:test";
import { selectedArgs, selectedArgsWithGroupOverride } from "../src/ui/shared/launch-options";
import type { LaunchOption } from "../src/clients";

const OPTIONS: LaunchOption[] = [
  {
    id: "search",
    label: { en: "Search", zh: "搜索" },
    shortLabel: "Search",
    description: { en: "Search", zh: "搜索" },
    flag: "--search",
    args: ["--search"],
  },
  {
    id: "model-a",
    label: { en: "Model A", zh: "模型 A" },
    shortLabel: "A",
    description: { en: "A", zh: "A" },
    flag: "--model a",
    args: ["--model", "a"],
    group: "model",
  },
  {
    id: "model-b",
    label: { en: "Model B", zh: "模型 B" },
    shortLabel: "B",
    description: { en: "B", zh: "B" },
    flag: "--model b",
    args: ["--model", "b"],
    envVars: { MODEL_ID: "b" },
    group: "model",
  },
];

describe("selectedArgsWithGroupOverride", () => {
  it("replaces the current model selection for launch output", () => {
    const result = selectedArgsWithGroupOverride(
      { launchOptions: OPTIONS, enabled: new Set(["search", "model-a"]) },
      "model",
      "model-b",
    );

    expect(result).toEqual({
      args: ["--search", "--model", "b"],
      envVars: { MODEL_ID: "b" },
      selectedOptionIds: ["search", "model-b"],
    });
  });

  it("supports launching with the default model by clearing the group override", () => {
    const result = selectedArgsWithGroupOverride(
      { launchOptions: OPTIONS, enabled: new Set(["search", "model-a"]) },
      "model",
      undefined,
    );

    expect(result).toEqual(selectedArgs({ launchOptions: OPTIONS, enabled: new Set(["search", "model-a"]) }));
  });
});
