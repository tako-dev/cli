/**
 * Launcher Entry
 */

import type { ClientConfig } from "../clients/base";
import { getClient } from "../clients/base";
import type { ProviderContext } from "../providers/types";
import { ensureClientReady, ensureNodeInstalled } from "../installer";
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

export function resolveLaunchTarget(
  client: Pick<ClientConfig, "id">,
  options?: LaunchOptions,
): { installId: string; recordId: string; web: boolean } {
  const web = wantsPiWeb(client as ClientConfig, options);
  return {
    installId: client.id === "pi-web" ? "pi" : client.id,
    recordId: client.id === "pi-web" ? "pi" : client.id,
    web,
  };
}

export { wantsPiWeb, stripPiOnlyArgs };

function wantsPiWeb(client: ClientConfig, options?: LaunchOptions): boolean {
  if (client.id === "pi-web") return true;
  if (client.id !== "pi") return false;
  if (options?.selectedOptionIds?.includes("web")) return true;
  return !!options?.args?.includes("--web");
}

function stripPiOnlyArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" || arg === "--model") {
      i++;
      continue;
    }
    if (arg === "--no-session" || arg === "--continue" || arg === "--web") continue;
    if (arg.startsWith("--provider=") || arg.startsWith("--model=")) continue;
    out.push(arg);
  }
  return out;
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

    const { installId, recordId, web } = resolveLaunchTarget(client, options);
    const installClient = getClient(installId) ?? client;
    const installResult = await ensureClientReady(installClient);
    if (!installResult.success) return installResult;

    if (installId === "pi" || web || client.id === "pi" || client.id === "pi-web") {
      const nodeReady = await ensureNodeInstalled();
      if (!nodeReady) {
        return { success: false, error: "Tako 专属 Node 安装失败，Pi 需要 Node >= 22.19" };
      }
    }

    let target = client;
    if (web) {
      const webClient = getClient("pi-web");
      if (!webClient) return { success: false, error: "Pi Web client not registered" };
      const webReady = await ensureClientReady(webClient);
      if (!webReady.success) return webReady;
      target = webClient;
    }

    // 解析 Provider
    const providerContext = await resolveProvider(installClient, options);
    if (!providerContext) {
      return { success: false, error: t("launcher.apiKeyNotConfigured") };
    }

    // Setup config files
    let setupLaunchArgs: string[] = [];
    let setupEnvVars: Record<string, string> = {};
    if (installClient.setupConfigFiles) {
      const launchEnvVars = {
        ...installClient.getEnvVars(providerContext),
        ...(options?.envVars ?? {}),
      };
      const setupResult = await installClient.setupConfigFiles(
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

    await recordProjectLaunch(workingDir, recordId, options?.selectedOptionIds);
    try {
      const pickedModelIds = (options?.selectedOptionIds ?? []).filter((id) => id.startsWith("model-"));
      await recordModelPicks(pickedModelIds);
    } catch {
      // Usage ranking is best-effort and must never block launching a client.
    }

    const config = await loadConfig();
    const clientVersion = config.installedClients[target.id]?.version;
    track("client_launched", {
      client_id: target.id,
      client_version: clientVersion,
      project_hash: hashProjectPath(workingDir),
      is_recent_project: !!options?.projectPath,
    });

    log.info(t("launcher.starting", { client: target.name }));

    const mergedArgs = [...setupLaunchArgs, ...(options?.args ?? [])];
    return await legacyLaunchClient(target, {
      ...options,
      args: target.id === "pi-web" ? stripPiOnlyArgs(mergedArgs) : mergedArgs,
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
