import { getAllClients } from "../../clients";
import { getClientLaunchOptions } from "../../clients/base";
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

export async function loadLauncherData(projectPathWidth = 45): Promise<LauncherLoadResult> {
  const all = getAllClients();
  const lastId = await getLastClientForCwd();
  const defaultProvider = await getDefaultProvider();
  const zh = getLocale() === "zh";

  const sorted = [...all].sort((a, b) => {
    if (a.id === lastId) return -1;
    if (b.id === lastId) return 1;
    return 0;
  });

  const clients: LauncherClientData[] = [];
  for (const client of sorted) {
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
    const lastSelectedOptionIds = savedIds.filter((id) => validIds.has(id));

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
    defaultIdx: 0,
    hasProviders: clients.some((client) => client.providers.length > 0),
    pickCounts,
    zh,
  };
}
