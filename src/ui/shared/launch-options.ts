import type { LaunchOption } from "../../clients";
import type { LauncherResult, OptionRow } from "./types";

export interface LaunchSelectionSource {
  launchOptions: LaunchOption[];
  enabled: Set<string>;
}

export function buildOptionRows(options: LaunchOption[], zh: boolean): OptionRow[] {
  const rows: OptionRow[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.group) {
      rows.push({ kind: "flag", opt: option });
      continue;
    }
    if (!seen.has(option.group)) {
      seen.add(option.group);
      rows.push({
        kind: "group",
        group: option.group,
        title: option.group === "model" ? (zh ? "模型" : "Model") : option.group,
      });
    }
  }
  rows.push({ kind: "provider", title: zh ? "服务商" : "Provider" });
  return rows;
}

export function getGroupSelection(
  options: LaunchOption[],
  enabled: Set<string>,
  group: string,
): LaunchOption | undefined {
  return options.find((option) => option.group === group && enabled.has(option.id));
}

export function selectedArgs(
  current: LaunchSelectionSource,
): Pick<Extract<LauncherResult, { type: "launch" }>, "args" | "envVars" | "selectedOptionIds"> {
  const args: string[] = [];
  const envVars: Record<string, string> = {};
  const selectedOptionIds: string[] = [];
  for (const option of current.launchOptions) {
    if (!current.enabled.has(option.id)) continue;
    args.push(...option.args);
    if (option.envVars) Object.assign(envVars, option.envVars);
    selectedOptionIds.push(option.id);
  }
  return { args, envVars, selectedOptionIds };
}

export function selectedArgsWithGroupOverride(
  current: LaunchSelectionSource,
  group: string,
  forcedOptionId?: string,
): Pick<Extract<LauncherResult, { type: "launch" }>, "args" | "envVars" | "selectedOptionIds"> {
  if (!forcedOptionId) return selectedArgs(current);

  const nextEnabled = new Set(current.enabled);
  for (const option of current.launchOptions) {
    if (option.group === group) nextEnabled.delete(option.id);
  }
  nextEnabled.add(forcedOptionId);

  return selectedArgs({
    launchOptions: current.launchOptions,
    enabled: nextEnabled,
  });
}

/**
 * Keep last-selected flags, drop stale ids, and fill a model only when we have
 * an explicit default. Catalog order is not a default: leaving the group empty
 * lets each client use its own built-in model (Codex gpt-5.5, Claude Code's
 * own policy). Pass fallbackModelId for Pi so an empty selection still lands
 * on grok-4.6.
 */
export function enabledWithProviderDefaultModel(
  previous: Set<string>,
  options: LaunchOption[],
  providerModel?: string,
  fallbackModelId?: string,
): Set<string> {
  const validIds = new Set(options.map((option) => option.id));
  const modelIds = new Set(options.filter((option) => option.group === "model").map((option) => option.id));
  const preferredIds = [
    providerModel ? `model-${providerModel}` : undefined,
    fallbackModelId,
  ].filter((id): id is string => !!id && modelIds.has(id));

  const next = new Set<string>();
  let changed = false;
  let hasModel = false;
  for (const id of previous) {
    if (validIds.has(id)) {
      next.add(id);
      if (modelIds.has(id)) hasModel = true;
    } else {
      changed = true;
    }
  }

  if (!hasModel && preferredIds[0]) {
    next.add(preferredIds[0]);
    changed = true;
  }

  return changed ? next : previous;
}
