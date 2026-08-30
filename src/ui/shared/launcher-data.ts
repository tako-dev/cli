import { getAllClients } from "../../clients";
import { getClientLaunchOptions } from "../../clients/base";
import { GROK_DEFAULT_MODEL } from "../../clients/grok";
import { PI_DEFAULT_MODEL } from "../../clients/pi";
import { enabledWithProviderDefaultModel } from "./launch-options";
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

/** Tab 顺序保持注册序。有本目录历史就停在上次用的，否则默认 Pi。 */
export function resolveDefaultClientIndex(
  clientIds: string[],
  lastId: string | null,
  fallbackId = "pi",
): number {
  if (lastId === "pi-web") lastId = "pi";
  if (lastId) {
    const lastIdx = clientIds.indexOf(lastId);
    if (lastIdx >= 0) return lastIdx;
  }
  const fallbackIdx = clientIds.indexOf(fallbackId);
  return fallbackIdx >= 0 ? fallbackIdx : 0;
}

export async function loadLauncherData(projectPathWidth = 45): Promise<LauncherLoadResult> {
  const all = getAllClients();
  const lastId = await getLastClientForCwd();
  const defaultProvider = await getDefaultProvider();
  const zh = getLocale() === "zh";

  const clients: LauncherClientData[] = [];
  for (const client of all) {
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
    const validIds = new Set(launchOptions.map((option) => option.id));
    const savedIds = await getLastSelectedOptionsForClient(client.id);
    const lastSelectedOptionIds = [...enabledWithProviderDefaultModel(
      new Set(savedIds.filter((id) => validIds.has(id))),
      launchOptions,
      activeProvider?.model,
      client.id === "pi" ? `model-${PI_DEFAULT_MODEL}`
        : client.id === "grok" ? `model-${GROK_DEFAULT_MODEL}`
        : undefined,
    )];

    clients.push({
      client,
      projects,
      providers,
      activeProvider,
      activeProvIdx: Math.max(activeIdx, 0),
      launchOptions,
      lastSelectedOptionIds,
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
