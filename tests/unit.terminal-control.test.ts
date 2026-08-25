import { describe, expect, it } from "bun:test";
import {
  releaseStdinForExternalChild,
  resetTerminalModes,
  settleTerminalForExternalChild,
} from "../src/terminal-control";

describe("terminal control", () => {
  it("releases stdin raw mode and listeners before an external child", () => {
    const calls: string[] = [];
    releaseStdinForExternalChild({
      isTTY: true,
      removeAllListeners: () => calls.push("removeAllListeners"),
      setRawMode: (enabled) => calls.push(`setRawMode:${enabled}`),
      pause: () => calls.push("pause"),
    });

    expect(calls).toEqual(["removeAllListeners", "setRawMode:false", "pause"]);
  });

  it("resets terminal modes when stdout is a TTY", () => {
    let output = "";
    resetTerminalModes({
      isTTY: true,
      write: (chunk) => {
        output += chunk;
      },
    });

    expect(output).toContain("\x1b[?2004l");
    expect(output).toContain("\x1b[?25h");
  });

  it("settles twice so prompt cleanup cannot keep stdin captured", async () => {
    const calls: string[] = [];
    await settleTerminalForExternalChild({
      delayMs: 0,
      stdin: {
        isTTY: true,
        removeAllListeners: () => calls.push("removeAllListeners"),
        setRawMode: (enabled) => calls.push(`setRawMode:${enabled}`),
        pause: () => calls.push("pause"),
      },
      stdout: {
        isTTY: true,
        write: () => calls.push("write"),
      },
    });

    expect(calls).toEqual([
      "removeAllListeners",
      "setRawMode:false",
      "pause",
      "write",
      "removeAllListeners",
      "setRawMode:false",
      "pause",
      "write",
    ]);
  });
});
