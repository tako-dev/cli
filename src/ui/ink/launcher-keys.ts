export type LauncherFocus = "projects" | "options" | "search";

export function nextLauncherFocus(
  current: LauncherFocus,
  reverse: boolean,
  hasOptions: boolean,
): LauncherFocus {
  if (!reverse) {
    if (current === "projects") return hasOptions ? "options" : "search";
    if (current === "options") return "search";
    return "projects";
  }
  if (current === "projects") return "search";
  if (current === "search") return hasOptions ? "options" : "projects";
  return "projects";
}
