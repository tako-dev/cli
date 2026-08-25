import { describe, expect, it } from "bun:test";
import {
  enabledWithProviderDefaultModel,
  selectedArgs,
  selectedArgsWithGroupOverride,
} from "../src/ui/shared/launch-options";
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

describe("enabledWithProviderDefaultModel", () => {
  const catalogFirst = "model-claude-fable-5";
  const catalogOptions: LaunchOption[] = [
    OPTIONS[0],
    {
      id: catalogFirst,
      label: { en: "Fable", zh: "Fable" },
      shortLabel: "Fable",
      description: { en: "Fable", zh: "Fable" },
      flag: "--model claude-fable-5",
      args: ["--model", "claude-fable-5"],
      group: "model",
    },
    {
      id: "model-gpt-5.5",
      label: { en: "GPT 5.5", zh: "GPT 5.5" },
      shortLabel: "GPT 5.5",
      description: { en: "GPT 5.5", zh: "GPT 5.5" },
      flag: "--model gpt-5.5",
      args: ["--model", "gpt-5.5"],
      group: "model",
    },
    {
      id: "model-grok-4.6",
      label: { en: "Grok 4.6", zh: "Grok 4.6" },
      shortLabel: "Grok",
      description: { en: "Grok", zh: "Grok" },
      flag: "--model grok-4.6",
      args: ["--model", "grok-4.6"],
      group: "model",
    },
  ];

  it("leaves Codex empty so the client keeps its built-in default", () => {
    const next = enabledWithProviderDefaultModel(
      new Set(["search"]),
      catalogOptions,
    );
    expect([...next]).toEqual(["search"]);
  });

  it("does not fall back to the first catalog model", () => {
    const next = enabledWithProviderDefaultModel(new Set(), catalogOptions);
    expect([...next].some((id) => id.startsWith("model-"))).toBe(false);
  });

  it("uses the provider model when it is in the catalog", () => {
    const next = enabledWithProviderDefaultModel(
      new Set(["search"]),
      catalogOptions,
      "gpt-5.5",
    );
    expect(next.has("model-gpt-5.5")).toBe(true);
    expect(next.has(catalogFirst)).toBe(false);
  });

  it("falls back to grok-4.6 only when Pi passes that id", () => {
    const next = enabledWithProviderDefaultModel(
      new Set(),
      catalogOptions,
      undefined,
      "model-grok-4.6",
    );
    expect([...next]).toEqual(["model-grok-4.6"]);
  });

  it("keeps a previously selected model", () => {
    const previous = new Set(["search", catalogFirst]);
    const next = enabledWithProviderDefaultModel(
      previous,
      catalogOptions,
      "gpt-5.5",
      "model-grok-4.6",
    );
    expect(next).toBe(previous);
    expect(next.has(catalogFirst)).toBe(true);
  });
});
