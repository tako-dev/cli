/**
 * 共享启动逻辑 — Ink 主循环复用
 */

import { launchClientUnified } from "../../launcher";
import { getClient } from "../../clients/base";
import { t } from "../../i18n";
import { track } from "../../analytics";
import { log } from "../../logger";
import { getProviders, migrateIfNeeded, fixupProviders } from "../../providers";
import { selectProviderForClient, runProviderDetection } from "../providers";
import { fetchAndMaybeShowAnnouncement } from "../../announcements";
import { refreshAllTakoCatalogs } from "../../models";
import type { LauncherResult } from "./types";

/**
 * launcher 启动前置：迁移 / 修复 provider / 检测 / 目录刷新 / 公告。
 */
export async function runPreLaunchSetup(): Promise<void> {
  await migrateIfNeeded();
  await fixupProviders();
  await runProviderDetection();

  // Par 模型目录刷新：冷桶（首次启动）阻塞到拉完，热桶（>1h 过期）后台刷新。
  // 加 3s 超时保护，网络抖时也不挂死 launcher。
  await Promise.race([
    refreshAllTakoCatalogs(await getProviders()),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);

  // 启动公告：从默认 par 拉一次 popup，若有未看过的就先弹。
  // 任何失败（无 provider / 网络 / 解析）都静默跳过，不影响 launcher。
  await fetchAndMaybeShowAnnouncement();
}

/**
 * 处理 launcher 返回的 launch 结果：选 provider、Windows handoff、实际启动。
 * @returns true 表示应退出进程（Windows handoff 已写入）；false 表示回到主菜单循环。
 */
export async function handleLaunchResult(
  result: Extract<LauncherResult, { type: "launch" }>,
): Promise<boolean> {
  const client = getClient(result.clientId);
  if (!client) return false;

  track("menu_action", { action: "launch", client_id: result.clientId });

  const providerContext = await selectProviderForClient(result.clientId);
  if (!providerContext) {
    log.warn(t("cli.noProvider") || "未配置可用的服务商");
    return false;
  }

  const isWindows = process.platform === "win32";
  // Windows 面板路径：走 handoff 让顶层 shell 启动客户端（键盘才正常），
  // 客户端退出后 handoff 会重开 tako 回到菜单。仅当 wrapper 提供了 handoff
  // 文件时启用；否则退化到 Bun 直接 spawn（launcher 内部处理）。
  const useWindowsHandoff = isWindows && !!process.env.TAKO_WINDOWS_HANDOFF_FILE;

  const launchResult = await launchClientUnified(client, {
    projectPath: result.projectPath,
    args: result.args,
    envVars: result.envVars,
    selectedOptionIds: result.selectedOptionIds,
    providerContext,
    relaunchTakoOnWindows: useWindowsHandoff,
  });

  if (!launchResult.success) {
    log.error(launchResult.error || t("cli.launchFailed"));
    // handoff 写入失败时不退出，回到菜单循环
    return false;
  }
  if (useWindowsHandoff) {
    // handoff 已写入：Bun 必须完全退出，外层 wrapper 才会执行 handoff
    // （启动客户端 → 客户端退出后重开 tako）。
    return true;
  }
  return false;
}
