import { getAllClients, type ClientConfig, type LaunchOption } from "../../clients";
import { getClientBinPath, getClientEntryPath, getClientLaunchOptions } from "../../clients/base";
import { GROK_DEFAULT_MODEL } from "../../clients/grok";
import { PI_DEFAULT_MODEL } from "../../clients/pi";
import { enabledWithProviderDefaultModel, EXPLICIT_DEFAULT_MODEL_SENTINEL } from "./launch-options";
import { getLocale } from "../../i18n";
import { getModelPickCounts } from "../../model-usage";
import {
  DISPLAY_PER_CLIENT,
  formatLastUsed,
  formatProjectPath,
  getLastClientForCwd,
  getLastSelectedOptionsForClient,
  getRecentProjectsForClient,
} from "../../project-history";
import { getClientProvider, getDefaultProvider, getProvidersForClient } from "../../providers";
import type { LauncherClientData, LauncherLoadResult, ProjectItem } from "./types";

export async function isClientInstalledFast(client: ClientConfig): Promise<boolean> {
  try {
    if (client.resolveBin) {
      return Boolean(await client.resolveBin());
    }
    if (await getClientEntryPath(client)) {
      return true;
    }
    return await Bun.file(getClientBinPath(client)).exists();
  } catch {
    return false;
  }
}

/** Tab 顺序保持注册序。有本目录历史就停在上次用的，否则默认 Pi。 */
export function resolveDefaultClientIndex(
  clientIds: string[],
  lastId: string | null,
  fallbackId = "pi",
): number {
  if (lastId === "pi-web") lastId = "pi";
  if (lastId === "gemini") lastId = "agy";
  if (lastId) {
    const lastIdx = clientIds.indexOf(lastId);
    if (lastIdx >= 0) return lastIdx;
  }
  const fallbackIdx = clientIds.indexOf(fallbackId);
  return fallbackIdx >= 0 ? fallbackIdx : 0;
}

export function resolveInitialClientOptionIds(
  savedIds: string[],
  launchOptions: LaunchOption[],
  providerModel?: string,
  fallbackModelId?: string,
): string[] {
  const validIds = new Set(launchOptions.map((o) => o.id));
  const baseSet = savedIds.length === 0
    ? new Set(launchOptions.filter((o) => o.defaultOn).map((o) => o.id))
    : new Set(savedIds.filter((id) => validIds.has(id) || id === EXPLICIT_DEFAULT_MODEL_SENTINEL));
  return [
    ...enabledWithProviderDefaultModel(
      baseSet,
      launchOptions,
      providerModel,
      fallbackModelId,
    ),
  ];
}

export async function loadLauncherData(projectPathWidth = 45): Promise<LauncherLoadResult> {
  const all = getAllClients();
  const [lastId, defaultProvider, installedFlags] = await Promise.all([
    getLastClientForCwd(),
    getDefaultProvider(),
    Promise.all(all.map((client) => isClientInstalledFast(client))),
  ]);
  const zh = getLocale() === "zh";

  const clients: LauncherClientData[] = [];
  for (let i = 0; i < all.length; i++) {
    const client = all[i];
    const recent = await getRecentProjectsForClient(client.id, DISPLAY_PER_CLIENT, true);
    const cwd = process.cwd();
    const projects: ProjectItem[] = [
      {
        label: zh ? "在当前目录启动" : "Launch in current directory",
        hint: formatProjectPath(cwd, projectPathWidth),
        path: cwd,
      },
      ...recent.map((project) => ({
        label: formatProjectPath(project.path, projectPathWidth),
        hint: formatLastUsed(project.lastLaunchedAt),
        path: project.path,
      })),
    ];

    const providers = await getProvidersForClient(client.id);
    const bound = await getClientProvider(client.id);
    const activeProvider =
      bound || providers.find((provider) => provider.id === defaultProvider?.id) || providers[0];
    const activeIdx = activeProvider
      ? providers.findIndex((provider) => provider.id === activeProvider.id)
      : 0;
    const launchOptions = getClientLaunchOptions(client, activeProvider);
    const savedIds = await getLastSelectedOptionsForClient(client.id);
    const lastSelectedOptionIds = resolveInitialClientOptionIds(
      savedIds,
      launchOptions,
      activeProvider?.model,
      client.id === "pi" ? `model-${PI_DEFAULT_MODEL}`
        : client.id === "grok" ? `model-${GROK_DEFAULT_MODEL}`
        : undefined,
    );

    clients.push({
      client,
      projects,
      providers,
      activeProvider,
      activeProvIdx: Math.max(activeIdx, 0),
      launchOptions,
      lastSelectedOptionIds,
      installed: installedFlags[i],
    });
  }

  let pickCounts: Record<string, number> = {};
  try {
    pickCounts = await getModelPickCounts();
  } catch {
    pickCounts = {};
  }

  return {
    clients,
    defaultIdx: resolveDefaultClientIndex(clients.map((item) => item.client.id), lastId),
    hasProviders: clients.some((client) => client.providers.length > 0),
    pickCounts,
    zh,
  };
}
