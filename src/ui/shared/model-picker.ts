import type { LaunchOption } from "../../clients";
import { fuzzyFilter } from "./fuzzy";

export const COMMON_MODEL_LIMIT = 6;
export const MODEL_PAGE_SIZE = 10;

export function commonModelOptions(
  groupOptions: LaunchOption[],
  pickCounts: Record<string, number>,
): LaunchOption[] {
  const hasCounts = groupOptions.some((option) => (pickCounts[option.id] ?? 0) > 0);
  if (!hasCounts) {
    return groupOptions.slice(0, COMMON_MODEL_LIMIT);
  }

  const order = new Map(groupOptions.map((option, idx) => [option.id, idx]));
  return groupOptions
    .filter((option) => (pickCounts[option.id] ?? 0) > 0)
    .sort((a, b) => {
      const countDiff = (pickCounts[b.id] ?? 0) - (pickCounts[a.id] ?? 0);
      if (countDiff !== 0) return countDiff;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    })
    .slice(0, COMMON_MODEL_LIMIT);
}

export function modelPickerSearchText(option: LaunchOption, zh: boolean): string {
  const raw = option.id.startsWith("model-") ? option.id.slice(6) : option.id;
  const label = option.label[zh ? "zh" : "en"] || option.label.en || "";
  const otherLabel = option.label[zh ? "en" : "zh"] || "";
  return `${raw} ${option.id} ${label} ${otherLabel} ${option.shortLabel} ${option.flag}`;
}

export function listedModelOptions(
  groupOptions: LaunchOption[],
  pickCounts: Record<string, number>,
  query: string,
  zh = false,
): LaunchOption[] {
  const trimmed = query.trim();
  if (trimmed) {
    return fuzzyFilter(groupOptions, trimmed, (option) => modelPickerSearchText(option, zh));
  }

  const common = commonModelOptions(groupOptions, pickCounts);
  const commonIds = new Set(common.map((option) => option.id));
  const rest = groupOptions.filter((option) => !commonIds.has(option.id));
  return [...common, ...rest];
}

export function modelPickerWindow(
  selectedIndex: number,
  total: number,
  pageSize = MODEL_PAGE_SIZE,
): { start: number; end: number } {
  if (total <= pageSize) return { start: 0, end: total };
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, total - 1)));
  const start = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), total - pageSize));
  return { start, end: Math.min(start + pageSize, total) };
}
