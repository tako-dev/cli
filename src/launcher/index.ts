/**
 * Launcher Entry
 */

import type { ClientConfig } from "../clients/base";
import type { ProviderContext } from "../providers/types";
import { ensureClientReady } from "../installer";
import { getDefaultProvider, getProvidersForClient, resolveProviderContext } from "../providers";
import { loadConfig } from "../config";
import { recordProjectLaunch, isValidDirectory } from "../project-history";
import { log } from "../logger";
import { t } from "../i18n";
import { track, hashProjectPath } from "../analytics";
import { launchClient as legacyLaunchClient } from "../launcher-legacy";
import { recordModelPicks } from "../model-usage";

export interface LaunchOptions {
  projectPath?: string;
  args?: string[];
  envVars?: Record<string, string>;
  /** Ephemeral launch files removed after the client exits. */
  cleanupFiles?: string[];
  selectedOptionIds?: string[];
  /** 调用方直接指定的 Provider（跳过选择） */
  providerContext?: ProviderContext;
  /**
   * Windows quick-launch mode: prepare a wrapper-level handoff instead of
   * spawning the interactive TUI as Bun's child process.
   */
  handoffOnWindows?: boolean;
  /**
   * 面板（Ink 主循环）路径专用：Windows 上走 handoff 启动客户端，并让 handoff
   * 脚本在客户端退出后重新拉起 Tako 面板。这样键盘能正常工作（子进程由顶层
   * cmd/PowerShell 启动而非 Bun），且用户仍能回到菜单。
   * 设置该项时，launchClient 返回后调用方应 process.exit()（Bun 必须完全退出，
   * 外层 wrapper 才会执行 handoff）。
   */
  relaunchTakoOnWindows?: boolean;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  exitCode?: number;
}

/**
 * 为客户端解析 ProviderContext
 * 优先用 options 里的，否则自动选择
 */
async function resolveProvider(
  client: ClientConfig,
  options?: LaunchOptions,
): Promise<ProviderContext | null> {
  if (options?.providerContext) return options.providerContext;

  // 尝试默认 Provider
  const defaultProvider = await getDefaultProvider();
  if (defaultProvider) {
    const compatible = await getProvidersForClient(client.id);
    const isDefault = compatible.some((p) => p.id === defaultProvider.id);
    if (isDefault) return resolveProviderContext(defaultProvider);
    // 默认不兼容，取第一个兼容的
    if (compatible.length > 0) return resolveProviderContext(compatible[0]);
  }

  return null;
}

/**
 * Launch client
 */
export async function launchClientUnified(
  client: ClientConfig,
  options?: LaunchOptions
): Promise<LaunchResult> {
  let setupCleanupFiles: string[] = [];
  try {
    const workingDir = options?.projectPath || process.cwd();
    if (options?.projectPath) {
      const dirExists = await isValidDirectory(options.projectPath);
      if (!dirExists) {
        return {
          success: false,
          error: t("launcher.directoryNotFound", { path: options.projectPath })
        };
      }
    }

    const installResult = await ensureClientReady(client);
    if (!installResult.success) return installResult;

    // 解析 Provider
    const providerContext = await resolveProvider(client, options);
    if (!providerContext) {
      return { success: false, error: t("launcher.apiKeyNotConfigured") };
    }

    // Setup config files
    let setupLaunchArgs: string[] = [];
    let setupEnvVars: Record<string, string> = {};
    if (client.setupConfigFiles) {
      const launchEnvVars = {
        ...client.getEnvVars(providerContext),
        ...(options?.envVars ?? {}),
      };
      const setupResult = await client.setupConfigFiles(
        providerContext,
        options?.selectedOptionIds,
        { forLaunch: true, launchEnvVars },
      );
      if (setupResult && typeof setupResult === "object") {
        setupLaunchArgs = setupResult.args ?? [];
        setupEnvVars = setupResult.envVars ?? {};
        setupCleanupFiles = setupResult.cleanupFiles ?? [];
      }
    }

    await recordProjectLaunch(workingDir, client.id, options?.selectedOptionIds);
    try {
      const pickedModelIds = (options?.selectedOptionIds ?? []).filter((id) => id.startsWith("model-"));
      await recordModelPicks(pickedModelIds);
    } catch {
      // Usage ranking is best-effort and must never block launching a client.
    }

    const config = await loadConfig();
    const clientVersion = config.installedClients[client.id]?.version;
    track("client_launched", {
      client_id: client.id,
      client_version: clientVersion,
      project_hash: hashProjectPath(workingDir),
      is_recent_project: !!options?.projectPath,
    });

    log.info(t("launcher.starting", { client: client.name }));

    return await legacyLaunchClient(client, {
      ...options,
      args: [...setupLaunchArgs, ...(options?.args ?? [])],
      envVars: { ...setupEnvVars, ...(options?.envVars ?? {}) },
      cleanupFiles: [...setupCleanupFiles, ...(options?.cleanupFiles ?? [])],
      providerContext,
    });
  } catch (error) {
    if (setupCleanupFiles.length > 0) {
      const { rm } = await import("node:fs/promises");
      await Promise.all(setupCleanupFiles.map((path) => rm(path, { force: true }).catch(() => {})));
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Launch failed",
    };
  }
}
