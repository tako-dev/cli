import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "../src/ui/shared/fuzzy";

describe("fuzzyMatch", () => {
  it("matches characters in order, not necessarily consecutive", () => {
    expect(fuzzyMatch("glm", "glm-5.2").matches).toBe(true);
    expect(fuzzyMatch("g52", "glm-5.2").matches).toBe(true);
    expect(fuzzyMatch("xyz", "glm-5.2").matches).toBe(false);
  });

  it("is case insensitive", () => {
    expect(fuzzyMatch("GPT", "gpt-5.5").matches).toBe(true);
  });

  it("ranks exact and prefix matches ahead of scattered matches", () => {
    const exact = fuzzyMatch("gpt", "gpt");
    const prefix = fuzzyMatch("gpt", "gpt-5.5");
    const scattered = fuzzyMatch("gpt", "google-palm-turbo");
    expect(exact.matches && prefix.matches && scattered.matches).toBe(true);
    expect(exact.score).toBeLessThan(prefix.score);
    expect(prefix.score).toBeLessThan(scattered.score);
  });
});

describe("fuzzyFilter", () => {
  const items = ["glm-5.2", "gpt-5.5", "gpt-5.4", "claude-opus-4-8", "deepseek-v4-pro"];

  it("returns original items when the query is empty", () => {
    expect(fuzzyFilter(items, "  ", (item) => item)).toEqual(items);
  });

  it("keeps only matching items and sorts better matches first", () => {
    expect(fuzzyFilter(items, "gpt", (item) => item)).toEqual(["gpt-5.5", "gpt-5.4"]);
  });

  it("requires every whitespace-separated token to match", () => {
    expect(fuzzyFilter(items, "gpt 5.4", (item) => item)).toEqual(["gpt-5.4"]);
  });
});
