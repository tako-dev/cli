import { ClientConfig, getClientBinPath, getClientEntryPath, buildClientLaunchCommand, parsePathLookup, pathLookupCommand } from "./clients/base";
import { TAKO_DIR } from "./config";
import { getBunPath, getNodePath } from "./installer";
import { settleTerminalForExternalChild } from "./terminal-control";
import { WINDOWS_HANDOFF_ENV, writeWindowsHandoffScript } from "./windows-handoff";
import { join } from "path";

// LaunchOptions 的权威定义在 ./launcher/index.ts；这里复用避免字段漂移。
// import type 不引入运行时依赖，不会和 launcher/index.ts 对本模块的 import 形成循环。
export type { LaunchOptions } from "./launcher";
import type { LaunchOptions } from "./launcher";

/**
 * 启动客户端。
 *
 * Unix 走同步 spawn，让子进程独占终端。Windows 的交互式 TUI 走
 * PowerShell handoff，避免 Bun 作为直接父进程时继承控制台输入不完整。
 */
export async function launchClient(
  client: ClientConfig,
  options?: LaunchOptions
): Promise<{ success: boolean; error?: string; exitCode?: number }> {
  const cleanupFiles = options?.cleanupFiles ?? [];
  let cleanupTransferred = false;
  try {
    const workingDir = options?.projectPath || process.cwd();
    const providerContext = options?.providerContext;
    const isWindows = process.platform === "win32";

    if (!providerContext) {
      return { success: false, error: "未选择服务商" };
    }

    let binPath = await getClientEntryPath(client);
    if (!binPath) binPath = getClientBinPath(client);

    const binFile = Bun.file(binPath);
    if (!(await binFile.exists())) {
      // Tako 管理目录没找到，fallback 到 PATH 中的全局安装
      const { execSync } = await import("node:child_process");
      // Windows 上优先找 .exe（真正的可执行文件），避免 where 返回无扩展名的
      // POSIX shell 脚本（如 npm 全局安装的 `claude` shim），直接 spawnSync 会卡死。
      const findCmd = pathLookupCommand(client.command, isWindows ? "win32" : process.platform);
      try {
        const candidates = execSync(findCmd, { encoding: "utf8" });
        const pick = parsePathLookup(candidates, isWindows ? "win32" : process.platform);
        if (pick) binPath = pick;
        else return { success: false, error: `找不到 ${client.command}，请运行 tako install ${client.id}` };
      } catch {
        return { success: false, error: `找不到 ${client.command}，请运行 tako install ${client.id}` };
      }
    }

    const clientEnvVars = client.getEnvVars(providerContext);
    const extraEnv = { ...clientEnvVars, ...(options?.envVars ?? {}) };
    const env = { ...process.env, ...extraEnv };

    const command = buildClientLaunchCommand(
      client,
      binPath,
      await getBunPath(),
      options?.args ?? [],
      isWindows ? "win32" : process.platform,
      await getNodePath(),
    );

    if (isWindows && options?.handoffOnWindows) {
      const handoffPath = process.env[WINDOWS_HANDOFF_ENV];
      if (handoffPath) {
        // quick-launch：handoff 由外层 cmd/ps1 wrapper 执行，wrapper 进程环境里
        // 没有 client.getEnvVars() 算出的 token，故必须显式写进脚本。脚本用
        // finally 保证执行后自删，token 不残留。
        await settleTerminalForExternalChild();
        await writeWindowsHandoffScript(
          handoffPath,
          {
            command,
            cwd: workingDir,
            env: extraEnv,
            cleanupFiles,
          },
        );
        cleanupTransferred = true;
        return { success: true };
      }
    }

    if (isWindows && options?.relaunchTakoOnWindows) {
      const handoffPath = process.env[WINDOWS_HANDOFF_ENV];
      if (handoffPath) {
        // 面板路径：和 quick-launch 一样把启动交给外层 wrapper 执行，Bun 退出后
        // 由顶层 cmd/PowerShell 起客户端 —— 这样 Windows 控制台输入能干净交接给
        // 子进程，键盘才有响应（Bun 作为父进程直接 spawn 会渲染出画面但收不到键）。
        // handoff 由 wrapper 执行，wrapper 环境没有 token，故需显式写 extraEnv。
        // 客户端退出后 handoff 重新拉起 tako.cmd，用户回到菜单。
        // 这里必须走 wrapper，不能直接用 `bun dist/index.js`：下一次从菜单启动
        // 客户端时还需要外层 wrapper 在 Bun 退出后执行新的 handoff 脚本。
        const relaunchCommand = [
          process.env.TAKO_WINDOWS_RELAUNCH_COMMAND || join(TAKO_DIR, "bin", "tako.cmd"),
        ];
        await settleTerminalForExternalChild();
        await writeWindowsHandoffScript(
          handoffPath,
          {
            command,
            cwd: workingDir,
            env: extraEnv,
            relaunchCommand,
            cleanupFiles,
          },
        );
        cleanupTransferred = true;
        return { success: true };
      }
      // 没有 wrapper handoff 文件（如直接用 bun 跑、非 wrapper 环境）：
      // 退化到下面的交互式 PowerShell 子进程路径（键盘可能不响应，但不中断）。
    }

    if (isWindows) {
      const fs = await import("fs/promises");
      const { tmpdir } = await import("os");
      const handoffPath = join(tmpdir(), `tako-handoff-${process.pid}-${Date.now()}.ps1`);
      // 交互式路径由本进程直接起 PowerShell，PowerShell 继承本进程的 env，
      // 故 handoff 脚本不写 extraEnv（避免 token 明文落盘）。
      await writeWindowsHandoffScript(
        handoffPath,
        {
          command,
          cwd: workingDir,
          cleanupFiles,
        },
      );

      await settleTerminalForExternalChild();
      try {
        // 必须用 spawnSync：Windows 控制台输入是单一共享队列，Bun 事件循环只要还活着
        // 就持有控制台输入句柄，和子进程争抢按键 —— 表现为子进程 TUI 画面正常但
        // 键盘无响应。spawnSync 完全阻塞事件循环，子进程独占控制台。
        // （Unix 分支同理，见文件末尾。）
        const result = Bun.spawnSync(
          ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", handoffPath],
          {
            env,
            stdio: ["inherit", "inherit", "inherit"],
            cwd: workingDir,
          },
        );
        const exitCode = result.exitCode ?? 0;
        return { success: exitCode === 0, exitCode };
      } catch (spawnError) {
        // PowerShell 起不来（不在 PATH / 被拦截）：脚本内的自删不会执行，兜底清理
        await fs.rm(handoffPath, { force: true }).catch(() => {});
        return {
          success: false,
          error: spawnError instanceof Error ? spawnError.message : "PowerShell handoff 启动失败",
        };
      }
    }

    // 释放 stdin — 清除父进程（TUI / Bun）残留的监听器
    //
    // 背景：快捷启动前可能弹过 confirmPrompt（更新确认 / 清理 settings），
    // 交互式主菜单本身也是 TUI。这些都会 setRawMode(true) 并挂 stdin 的
    // "data"/"readable" 监听器。退出后这些监听器 + raw 状态不一定干净，
    // 父进程 Bun 若继续读 stdin，会和子进程争抢按键 —— 表现为子进程 TUI
    // （Claude Code / Codex）画面渲染出来了，但按键无响应（"卡死"）。
    //
    // 所以启动子进程前必须移除父进程自己的监听器并 pause，把 stdin 完全让给
    // 子进程（子进程通过 stdio:"inherit" 独占）。
    //
    await settleTerminalForExternalChild();

    // 清空屏幕 + scrollback —— 否则 launcher 的 Ink 输出会留在终端历史里，
    // 子进程（如 Claude Code）启动后用户向上滚动会看到 Tako 菜单残留，
    // 无法回到子进程自身的最早输出。
    // \x1b[2J 清可见区域，\x1b[3J 清 scrollback，\x1b[H 光标归位。
    if (process.stdout.isTTY) {
      try { process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); } catch { /* ignore */ }
    }

    // Linux/macOS：Bun.spawnSync 完全阻塞事件循环，子进程独占终端
    // 需要 Linux kernel 5.13+，macOS 全版本支持
    try {
      Bun.spawnSync(command, {
        env,
        stdio: ["inherit", "inherit", "inherit"],
        cwd: workingDir,
      });
    } catch {
      // fallback: 异步 spawn（极老内核不支持 spawnSync）
      const proc = Bun.spawn(command, {
        env,
        stdio: ["inherit", "inherit", "inherit"],
        cwd: workingDir,
      });
      await proc.exited;
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "启动失败",
    };
  } finally {
    if (!cleanupTransferred && cleanupFiles.length > 0) {
      const { rm } = await import("node:fs/promises");
      await Promise.all(cleanupFiles.map((path) => rm(path, { force: true }).catch(() => {})));
    }
  }
}
