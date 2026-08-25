import { writeFile } from "node:fs/promises";

export const WINDOWS_HANDOFF_ENV = "TAKO_WINDOWS_HANDOFF_FILE";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psArray(values: string[]): string {
  if (values.length === 0) return "@()";
  return `@(${values.map(psSingleQuoted).join(", ")})`;
}

export interface WindowsHandoffScriptOptions {
  command: string[];
  cwd: string;
  /**
   * 需要显式写进脚本的环境变量。
   *
   * 仅当 handoff 脚本由**外层 cmd/ps1 wrapper**执行时才需要 —— 那个 wrapper
   * 进程的环境里没有 client.getEnvVars() 算出来的 token。若 handoff 由 Bun 自己
   * 起 PowerShell 执行（交互式菜单路径），PowerShell 会继承 Bun 进程的环境，
   * 传空对象即可，避免 token 明文落盘。
   */
  env?: Record<string, string | undefined>;
  /**
   * 子进程退出后要重新执行的命令（如重开 Tako 面板）。
   *
   * 面板路径（Ink 主循环）用这个：Claude 退出后 handoff 脚本再拉起 `tako`，
   * 让用户回到菜单。新 tako 会拿到自己 wrapper 的新 handoff 文件，循环得以继续。
   * 不传则子进程退出后 handoff 直接结束（等价于 quick-launch）。
   */
  relaunchCommand?: string[];
  /** Ephemeral client config files removed after the child exits. */
  cleanupFiles?: string[];
}

export function encodeWindowsPowerShellScript(script: string): Uint8Array {
  const body = new TextEncoder().encode(script);
  const bytes = new Uint8Array(UTF8_BOM.length + body.length);
  bytes.set(UTF8_BOM, 0);
  bytes.set(body, UTF8_BOM.length);
  return bytes;
}

export async function writeWindowsHandoffScript(
  path: string,
  options: WindowsHandoffScriptOptions,
): Promise<void> {
  // Windows PowerShell 5.1 reads UTF-8 without BOM as the active ANSI code page.
  // That turns paths like "WPS云盘\我的模板" into mojibake before Set-Location runs.
  await writeFile(path, encodeWindowsPowerShellScript(buildWindowsHandoffScript(options)));
}

/**
 * Build a PowerShell script that runs after the Bun wrapper exits.
 *
 * On Windows, interactive TUIs spawned directly by Bun can render but fail to
 * receive console input. The outer wrapper runs this script after Bun exits so
 * Claude/Codex inherit the terminal from PowerShell/CMD instead of from Bun.
 *
 * 脚本用 try/finally 保证无论子进程如何退出（含 Ctrl+C）都自删，避免含 token
 * 的临时脚本残留在 %TEMP%。清屏用 [char]27 而非 `e（PowerShell 5.1 不支持 `e）。
 */
export function buildWindowsHandoffScript(options: WindowsHandoffScriptOptions): string {
  const [exe, ...args] = options.command;
  if (!exe) throw new Error("handoff command is empty");

  const lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    "$scriptPath = $PSCommandPath",
  ];

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`$env:${key} = ${psSingleQuoted(String(value))}`);
  }

  lines.push(
    "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    `Set-Location -LiteralPath ${psSingleQuoted(options.cwd)}`,
    // ESC = [char]27，兼容 Windows 自带的 PowerShell 5.1（`e 是 7+ 才支持）
    "$esc = [char]27",
    "try { [Console]::Write(\"$esc[2J$esc[3J$esc[H\") } catch {}",
    `$argv = ${psArray(args)}`,
    "$code = 0",
    "try {",
    `  & ${psSingleQuoted(exe)} @argv`,
    "  $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }",
    "} finally {",
    // 无论子进程正常退出 / 抛错 / Ctrl+C，都先删掉含 token 的临时脚本，
    // 再（可选）重开 Tako。先删除是为了即使重开命令抛错也不残留 token。
    "  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue",
  );

  for (const path of options.cleanupFiles ?? []) {
    lines.push(`  Remove-Item -LiteralPath ${psSingleQuoted(path)} -Force -ErrorAction SilentlyContinue`);
  }

  const relaunch = options.relaunchCommand ?? [];
  if (relaunch.length > 0) {
    const [relaunchExe, ...relaunchArgs] = relaunch;
    lines.push(
      `  $relaunchArgv = ${psArray(relaunchArgs)}`,
      // 重开 Tako 面板。让它继承当前控制台，用户回到菜单；退出码以 Tako 为准。
      `  & ${psSingleQuoted(relaunchExe!)} @relaunchArgv`,
      "  $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { $code }",
    );
  }

  lines.push(
    "}",
    "exit $code",
    "",
  );

  return lines.join("\r\n");
}
