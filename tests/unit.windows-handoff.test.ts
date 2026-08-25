import { describe, expect, it } from "bun:test";
import { buildWindowsHandoffScript, encodeWindowsPowerShellScript } from "../src/windows-handoff";

describe("Windows handoff script", () => {
  it("quotes paths, args, cwd, and env values for PowerShell", () => {
    const script = buildWindowsHandoffScript({
      command: [
        "C:\\Tools\\Claude Code\\claude.exe",
        "--model",
        "claude-opus-4-7[1m]",
        "Bob's repo",
      ],
      cwd: "E:\\work\\Bob's app",
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-ant-'quoted'",
        INVALID_KEY_NAME: "skip",
        "BAD-KEY": "skip",
      },
    });

    expect(script).toContain("& 'C:\\Tools\\Claude Code\\claude.exe' @argv");
    expect(script).toContain("Set-Location -LiteralPath 'E:\\work\\Bob''s app'");
    expect(script).toContain("@('--model', 'claude-opus-4-7[1m]', 'Bob''s repo')");
    expect(script).toContain("$env:ANTHROPIC_AUTH_TOKEN = 'sk-ant-''quoted'''");
    expect(script).toContain("$env:INVALID_KEY_NAME = 'skip'");
    expect(script).not.toContain("BAD-KEY");
    expect(script).toContain("[Console]::InputEncoding = [System.Text.Encoding]::UTF8");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    // 清屏用 [char]27 而非 `e，兼容 PowerShell 5.1
    expect(script).toContain("$esc = [char]27");
    expect(script).not.toContain("`e[2J");
    // finally 保证含 token 的临时脚本被删除
    expect(script).toContain("} finally {");
    expect(script).toContain("Remove-Item -LiteralPath $scriptPath -Force");
  });

  it("omits the env block when no env is provided (inherited from parent)", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\claude.exe"],
      cwd: "C:\\repo",
    });

    expect(script).not.toContain("$env:");
    expect(script).toContain("& 'C:\\claude.exe' @argv");
  });

  it("supports commands without extra args", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\claude.exe"],
      cwd: "C:\\repo",
      env: {},
    });

    expect(script).toContain("$argv = @()");
  });

  it("removes ephemeral client settings after the child exits", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\claude.exe"],
      cwd: "C:\\repo",
      cleanupFiles: ["C:\\Users\\Bob's AppData\\tako\\launch-settings.json"],
    });

    const childIdx = script.indexOf("& 'C:\\claude.exe' @argv");
    const cleanupIdx = script.indexOf(
      "Remove-Item -LiteralPath 'C:\\Users\\Bob''s AppData\\tako\\launch-settings.json' -Force",
    );
    expect(cleanupIdx).toBeGreaterThan(childIdx);
  });

  it("appends a relaunch command inside finally when provided (panel path)", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\claude.exe"],
      cwd: "C:\\repo",
      relaunchCommand: ["C:\\Tako\\bin\\tako.cmd"],
    });

    // 重开命令在 finally 内、且在删除临时脚本之后（先删 token 再重开）
    const finallyIdx = script.indexOf("} finally {");
    const removeIdx = script.indexOf("Remove-Item -LiteralPath $scriptPath");
    const relaunchIdx = script.indexOf("& 'C:\\Tako\\bin\\tako.cmd' @relaunchArgv");
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(relaunchIdx).toBeGreaterThan(removeIdx);
    expect(script).toContain("$relaunchArgv = @()");
  });

  it("omits relaunch when relaunchCommand is empty or absent", () => {
    const withEmpty = buildWindowsHandoffScript({
      command: ["C:\\claude.exe"],
      cwd: "C:\\repo",
      relaunchCommand: [],
    });
    expect(withEmpty).not.toContain("@relaunchArgv");
  });

  it("encodes handoff scripts as UTF-8 with BOM for Windows PowerShell 5.1", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\Windows\\System32\\cmd.exe", "/c", "echo", "ok"],
      cwd: "E:\\smart\\marketing\\市场与销售\\抽奖",
      env: {
        TAKO_TEST_VALUE: "中文'value",
      },
    });
    const bytes = encodeWindowsPowerShellScript(script);

    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const decoded = new TextDecoder("utf-8").decode(bytes.slice(3));
    expect(decoded).toContain("市场与销售\\抽奖");
    expect(decoded).toContain("$env:TAKO_TEST_VALUE = '中文''value'");
  });
});
