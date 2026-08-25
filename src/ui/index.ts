/**
 * UI 模块入口 — Ink 单实例路由
 */

import { startApp } from "./ink";
import { runPreLaunchSetup, handleLaunchResult } from "./shared/launch";

/**
 * 主入口
 */
export async function main(): Promise<void> {
  await runPreLaunchSetup();

  // Ink 单实例主循环（无 provider 时 LauncherView 会显示提示，不阻塞）
  while (true) {
    const result = await startApp();

    if (!result) break; // exit

    // launch — Ink 已 unmount，处理启动
    if (result.type !== "launch") continue;

    const shouldExit = await handleLaunchResult(result);
    if (shouldExit) process.exit(0);
    // 循环回 startApp()，重新渲染主菜单（非 Windows / 无 handoff 路径）
  }
}
