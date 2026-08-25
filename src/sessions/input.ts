export function normalizeSessionSearchInput(input: string, key: { ctrl?: boolean; meta?: boolean }): string {
  if (!input || key.ctrl || key.meta) return "";
  return input.replace(/[\x00-\x1f\x7f]/g, "");
}
