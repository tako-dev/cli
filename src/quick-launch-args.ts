/**
 * 计算 shortcut 命令（--claude / --codex / --gemini）的透传参数。
 *
 * - 移除 shortcut 标志本身
 * - claude-code: --model <id> / --model=<id> 的值自动补 [1m] 后缀
 *   （与交互菜单选模型行为一致；规则见 appendOneMTagIfNeeded）
 * - 继承 panel 上次勾选的"危险跳过"开关：
 *     claude-code · skip-permissions → --dangerously-skip-permissions
 *     codex       · bypass-sandbox    → --dangerously-bypass-approvals-and-sandbox
 *   无记忆（首次）默认补全放行 flag；有记忆则尊重上次选择，仅当勾过该开关才补。
 *   若用户已显式传入对应 flag 则不重复补。
 * - 其它 client 原样透传
 *
 * 抽成独立模块是为了让单测能直接 import 而不触发 src/index.ts 的 run() 副作用。
 * `getLastSelectedOptionIds` 通过参数注入，让单测无需读真实 config。
 */
import { appendOneMTagIfNeeded } from "./clients/claude-code";
import { getLastSelectedOptionsForClient } from "./project-history";

const INHERITED_DANGEROUS_FLAGS: Record<string, { optionId: string; flag: string }> = {
  "claude-code": { optionId: "skip-permissions", flag: "--dangerously-skip-permissions" },
  codex: { optionId: "bypass-sandbox", flag: "--dangerously-bypass-approvals-and-sandbox" },
};

export interface BuildPassthroughOptions {
  /** 注入用 — 读取 panel 上次勾选的 option id。默认走 project-history。 */
  getLastSelectedOptionIds?: (clientId: string) => Promise<string[]>;
}

export async function buildPassthroughArgs(
  clientId: string,
  allArgs: string[],
  shortcutFlag: string,
  opts?: BuildPassthroughOptions,
): Promise<string[]> {
  const rest = allArgs.filter((a) => a !== shortcutFlag);

  const inherited = await resolveInheritedFlag(clientId, rest, opts);

  if (clientId !== "claude-code") {
    return inherited ? [inherited, ...rest] : rest;
  }

  const out: string[] = [];
  if (inherited) out.push(inherited);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--model" && i + 1 < rest.length) {
      out.push(a, appendOneMTagIfNeeded(rest[i + 1]));
      i++;
      continue;
    }
    if (a.startsWith("--model=")) {
      const id = a.slice("--model=".length);
      out.push(`--model=${appendOneMTagIfNeeded(id)}`);
      continue;
    }
    out.push(a);
  }
  return out;
}

async function resolveInheritedFlag(
  clientId: string,
  rest: string[],
  opts?: BuildPassthroughOptions,
): Promise<string | null> {
  const entry = INHERITED_DANGEROUS_FLAGS[clientId];
  if (!entry) return null;
  if (rest.includes(entry.flag)) return null;

  const reader = opts?.getLastSelectedOptionIds ?? getLastSelectedOptionsForClient;
  const ids = await reader(clientId);
  // 有记忆：尊重用户上次的选择（只有勾过该危险开关才补全放行 flag）
  if (ids.length > 0) return ids.includes(entry.optionId) ? entry.flag : null;
  // 无记忆（首次）：默认全放行 → 补危险 flag
  return entry.flag;
}
