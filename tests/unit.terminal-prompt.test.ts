import { describe, expect, it } from "bun:test";
import { settleStdinForTerminalPrompt } from "../src/ui/shared/terminal";

describe("terminal prompt control", () => {
  it("reclaims stdin before direct key prompts after TUI teardown", async () => {
    const calls: string[] = [];
    await settleStdinForTerminalPrompt(
      {
        isTTY: true,
        ref: () => calls.push("ref"),
        removeAllListeners: () => calls.push("removeAllListeners"),
        setRawMode: (enabled) => calls.push(`setRawMode:${enabled}`),
        pause: () => calls.push("pause"),
      },
      0,
    );

    expect(calls).toEqual([
      "ref",
      "removeAllListeners",
      "setRawMode:false",
      "pause",
      "ref",
      "removeAllListeners",
      "setRawMode:false",
      "pause",
    ]);
  });
});
