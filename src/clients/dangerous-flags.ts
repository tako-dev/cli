/**
 * 「危险跳过」启动开关的共享解析。
 *
 * 面板启动会把勾选项转成 args；但会话恢复、快捷启动等非面板入口没有
 * selectedOptionIds，必须自己补。这里统一「上次勾过才补 / 无记忆默认补 /
 * 已显式传过就不重复」的规则，避免各入口行为漂移。
 */
import { getLastSelectedOptionsForClient } from "../project-history";

export const INHERITED_DANGEROUS_FLAGS: Record<string, { optionId: string; flag: string }> = {
  "claude-code": { optionId: "skip-permissions", flag: "--dangerously-skip-permissions" },
  codex: { optionId: "bypass-sandbox", flag: "--dangerously-bypass-approvals-and-sandbox" },
};

export interface InheritDangerousFlagOptions {
  /** 注入用 — 读取 panel 上次勾选的 option id。默认走 project-history。 */
  getLastSelectedOptionIds?: (clientId: string, projectPath?: string) => Promise<string[]>;
  /** 恢复会话时用原项目目录查记忆；不传则用 process.cwd()。 */
  projectPath?: string;
}

/**
 * 返回需要补的危险 flag；不需要补时返回 null。
 *
 * - 已显式带 flag → null（尊重调用方）
 * - 有记忆：只有勾过对应开关才补
 * - 无记忆（首次）：默认全放行，补 flag
 */
export async function resolveInheritedDangerousFlag(
  clientId: string,
  args: string[],
  opts?: InheritDangerousFlagOptions,
): Promise<string | null> {
  const entry = INHERITED_DANGEROUS_FLAGS[clientId];
  if (!entry) return null;
  if (args.includes(entry.flag)) return null;

  const reader = opts?.getLastSelectedOptionIds ?? getLastSelectedOptionsForClient;
  const ids = await reader(clientId, opts?.projectPath);
  if (ids.length > 0) return ids.includes(entry.optionId) ? entry.flag : null;
  return entry.flag;
}

/** 在 args 前补上危险 flag（如需要）。 */
export async function withInheritedDangerousFlag(
  clientId: string,
  args: string[],
  opts?: InheritDangerousFlagOptions,
): Promise<string[]> {
  const flag = await resolveInheritedDangerousFlag(clientId, args, opts);
  return flag ? [flag, ...args] : args;
}
