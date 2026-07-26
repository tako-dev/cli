import { describe, expect, it } from "bun:test";
import {
  buildWindowsCmdWrapper,
  buildWindowsPs1Wrapper,
  windowsWrapperNeedsRepair,
} from "../src/windows-wrapper";

describe("Windows wrapper scripts", () => {
  it("cmd wrapper provides a handoff file path and runs it after Bun exits", () => {
    const script = buildWindowsCmdWrapper("C:\\tako\\bun\\bun.exe", "C:\\tako\\cli\\dist\\index.js");

    expect(script).toContain('set "TAKO_WINDOWS_HANDOFF_FILE=%TEMP%\\tako-handoff-%RANDOM%-%RANDOM%.ps1"');
    expect(script).toContain('"C:\\tako\\bun\\bun.exe" "C:\\tako\\cli\\dist\\index.js" %*');
    expect(script).toContain('if not exist "%TAKO_WINDOWS_HANDOFF_FILE%" exit /b %TAKO_EXIT_CODE%');
    expect(script).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TAKO_WINDOWS_HANDOFF_FILE%"');
    expect(script).not.toContain("if exist \"%TAKO_WINDOWS_HANDOFF_FILE%\" (");
  });

  it("ps1 wrapper provides a handoff file path and preserves normal exit code", () => {
    const script = buildWindowsPs1Wrapper("C:\\tako\\bun\\bun.exe", "C:\\tako\\cli\\dist\\index.js");

    expect(script).toContain("$env:TAKO_WINDOWS_HANDOFF_FILE = Join-Path");
    expect(script).toContain('& "C:\\tako\\bun\\bun.exe" "C:\\tako\\cli\\dist\\index.js" @args');
    expect(script).toContain("Test-Path -LiteralPath $env:TAKO_WINDOWS_HANDOFF_FILE");
    expect(script).toContain("exit $code");
  });

  it("flags legacy wrappers without handoff logic as needing repair", () => {
    const legacy = [
      "@echo off",
      '"C:\\tako\\bun\\bun.exe" "C:\\tako\\cli\\dist\\index.js" %*',
    ].join("\r\n");

    expect(windowsWrapperNeedsRepair(legacy)).toBe(true);
    expect(windowsWrapperNeedsRepair("")).toBe(true);
    expect(windowsWrapperNeedsRepair(null)).toBe(true);
  });

  it("leaves current wrappers alone", () => {
    const cmd = buildWindowsCmdWrapper("C:\\tako\\bun\\bun.exe", "C:\\tako\\cli\\dist\\index.js");
    const ps1 = buildWindowsPs1Wrapper("C:\\tako\\bun\\bun.exe", "C:\\tako\\cli\\dist\\index.js");

    expect(windowsWrapperNeedsRepair(cmd)).toBe(false);
    expect(windowsWrapperNeedsRepair(ps1)).toBe(false);
  });
});
