import type { LaunchOption } from "../../clients";
import { getDisplayWidth } from "../../utils/display-width";

export const COLLAPSED_MODEL_LIMIT = 6;
export const MODEL_GRID_MAX_COLUMNS = 4;
export const MODEL_GRID_MIN_COLUMN_WIDTH = 16;
export const MODEL_GRID_PADDING = 12;

export type ModelPickerMode = "collapsed" | "grid";

export interface ModelGrid {
  rows: string[][];
  flat: string[];
}

export interface GroupedModelGrid {
  groups: Array<{ family: string; rows: string[][] }>;
  flat: string[];
}

export function visibleModelOptions(
  groupOptions: LaunchOption[],
  enabled: Set<string>,
  pickCounts: Record<string, number>,
): { list: LaunchOption[]; hiddenCount: number } {
  const hasCounts = groupOptions.some((option) => (pickCounts[option.id] ?? 0) > 0);
  if (!hasCounts) {
    return { list: groupOptions, hiddenCount: 0 };
  }

  const order = new Map(groupOptions.map((option, idx) => [option.id, idx]));
  const topIds = groupOptions
    .filter((option) => (pickCounts[option.id] ?? 0) > 0)
    .sort((a, b) => {
      const countDiff = (pickCounts[b.id] ?? 0) - (pickCounts[a.id] ?? 0);
      if (countDiff !== 0) return countDiff;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    })
    .slice(0, COLLAPSED_MODEL_LIMIT)
    .map((option) => option.id);

  const visibleIds = new Set(topIds);
  for (const option of groupOptions) {
    if (enabled.has(option.id)) visibleIds.add(option.id);
  }

  const rank = new Map(topIds.map((id, idx) => [id, idx]));
  let extraRank = topIds.length;
  for (const option of groupOptions) {
    if (visibleIds.has(option.id) && !rank.has(option.id)) {
      rank.set(option.id, extraRank++);
    }
  }

  const list = groupOptions
    .filter((option) => visibleIds.has(option.id))
    .sort((a, b) => {
      const rankDiff = (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
      if (rankDiff !== 0) return rankDiff;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
  return { list, hiddenCount: groupOptions.length - list.length };
}

export function initialModelPickerMode(
  groupOptions: LaunchOption[],
  pickCounts: Record<string, number>,
): ModelPickerMode {
  const hasCounts = groupOptions.some((option) => (pickCounts[option.id] ?? 0) > 0);
  return !hasCounts && groupOptions.length > COLLAPSED_MODEL_LIMIT ? "grid" : "collapsed";
}

export function getGridColumnCountForLabels(labels: string[], terminalColumns: number): number {
  if (labels.length === 0) return 1;
  const maxWidth = Math.max(...labels.map((label) => getDisplayWidth(label)));
  const colWidth = Math.max(MODEL_GRID_MIN_COLUMN_WIDTH, maxWidth + 4);
  const usable = Math.max(colWidth, terminalColumns - MODEL_GRID_PADDING);
  return Math.max(1, Math.min(MODEL_GRID_MAX_COLUMNS, labels.length, Math.floor(usable / colWidth)));
}

export function getGridColumnCountForOptions(
  options: LaunchOption[],
  terminalColumns: number,
  zh: boolean,
): number {
  const labels = options.map((option) => option.label[zh ? "zh" : "en"] || option.label.en || option.id);
  return getGridColumnCountForLabels(labels, terminalColumns);
}

export function buildGrid(ids: string[], columns: number): ModelGrid {
  const colCount = Math.max(1, Math.min(MODEL_GRID_MAX_COLUMNS, Math.floor(columns) || 1));
  const rows: string[][] = [];
  for (let i = 0; i < ids.length; i += colCount) {
    rows.push(ids.slice(i, i + colCount));
  }
  return { rows, flat: rows.flat() };
}

function rawModelId(id: string): string {
  return id.startsWith("model-") ? id.slice(6) : id;
}

export function modelFamilyOf(id: string): string {
  const raw = rawModelId(id).toLowerCase();
  const stripped = raw.replace(/^(?:full[-_]|满血[-_])+/u, "");
  return stripped.slice(0, 3) || raw.slice(0, 3) || raw;
}

function familyRank(family: string): number {
  const order = ["gpt", "ful", "cla", "dee", "glm", "kim", "qwe", "min", "mim", "spa"];
  const idx = order.indexOf(family);
  return idx === -1 ? order.length : idx;
}

function modelTokens(id: string): Array<number | string> {
  const raw = rawModelId(id).toLowerCase();
  const tokens: Array<number | string> = [];
  for (const part of raw.match(/\d+(?:\.\d+)?|[a-z]+/g) ?? [raw]) {
    const numeric = Number(part);
    tokens.push(Number.isFinite(numeric) && /^\d/.test(part) ? numeric : part);
  }
  return tokens;
}

export function compareModelIdsForPicker(a: string, b: string): number {
  const familyA = modelFamilyOf(a);
  const familyB = modelFamilyOf(b);
  const familyDiff = familyRank(familyA) - familyRank(familyB) || familyA.localeCompare(familyB);
  if (familyDiff !== 0) return familyDiff;

  const tokensA = modelTokens(a);
  const tokensB = modelTokens(b);
  const len = Math.max(tokensA.length, tokensB.length);
  for (let i = 0; i < len; i++) {
    const valueA = tokensA[i];
    const valueB = tokensB[i];
    if (valueA === undefined) return 1;
    if (valueB === undefined) return -1;
    if (typeof valueA === "number" && typeof valueB === "number") {
      if (valueA !== valueB) return valueB - valueA;
      continue;
    }
    const stringA = String(valueA);
    const stringB = String(valueB);
    if (stringA !== stringB) return stringA.localeCompare(stringB);
  }
  return rawModelId(a).localeCompare(rawModelId(b));
}

export function buildGroupedGrid(ids: string[], columns: number): GroupedModelGrid {
  const sorted = [...ids].sort(compareModelIdsForPicker);
  const families: Array<{ family: string; ids: string[] }> = [];
  for (const id of sorted) {
    const family = modelFamilyOf(id);
    const last = families[families.length - 1];
    if (last?.family === family) {
      last.ids.push(id);
    } else {
      families.push({ family, ids: [id] });
    }
  }

  const groups = families.map((group) => ({
    family: group.family,
    rows: buildGrid(group.ids, columns).rows,
  }));
  return { groups, flat: groups.flatMap((group) => group.rows.flat()) };
}

export function gridIndexOf(ids: string[], id: string, columns: number): number {
  return buildGroupedGrid(ids, columns).flat.indexOf(id);
}

export function modelPickerRowsInOrder(ids: string[], columns: number): string[][] {
  return buildGroupedGrid(ids, columns).groups.flatMap((group) => group.rows);
}
