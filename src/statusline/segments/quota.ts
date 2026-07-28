import { getOfficialQuota, type OfficialQuota } from "../../quota";
import { getClientProvider, getDefaultProvider } from "../../providers";
import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon, fg } from "../colors";

/**
 * Quota Segment：显示当前 Claude Code 绑定的 provider 用量
 *
 * - Tako provider:        💰 5h:$2.30/$50
 * - claude-subscription:  💰 5h:45% · wk:78%   (opus 单独额度时再追加 · opus:93%)
 * - codex-subscription:   💰 5h:45% · 7d:72%
 * - 取不到任何 provider 用量时回落到 Claude Code 当次会话花费：💰 Session:$0.30
 */
export class QuotaSegment implements Segment {
  id = "quota";

  async render(input: StatusLineInput): Promise<string | null> {
    const official = await this.tryRenderOfficial();
    if (official) return official;
    return this.renderSessionCost(input);
  }

  /** 解析当前 Claude Code 绑定的 provider，并按其类型渲染用量 */
  private async tryRenderOfficial(): Promise<string | null> {
    try {
      const provider =
        (await getClientProvider("claude-code")) ??
        (await getDefaultProvider());

      if (!provider) return null;

      const quota = await getOfficialQuota(provider);
      if (quota.status !== "ok") return null;
      switch (quota.provider) {
        case "tako":
          return this.renderTako(quota);
        case "claude-subscription":
          return this.renderClaudeSub(quota);
        case "codex-subscription":
          return this.renderCodexSub(quota);
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  // ─── 渲染：Tako ─────────────────────────────────────────────
  // 订阅（有窗口限额）→ 与 Claude/Codex 一样走剩余 % 展示
  // 按量（无任何限额）→ 展示已花费金额

  private renderTako(quota: OfficialQuota): string | null {
    if (quota.status !== "ok") return null;
    const hasLimits = !!(quota.primary?.costLimit || quota.secondary?.costLimit || quota.daily?.costLimit);
    if (hasLimits) return this.renderSub(quota);

    const slot = quota.daily ?? quota.primary ?? quota.secondary;
    if (!slot) return null;
    const used = slot.costUsed ?? 0;
    return `${this.icon()} ${fg.brightGreen}Day:${this.fmtCost(used)}${style.reset}`;
  }

  // ─── 渲染：Claude/Codex 订阅（百分比制）──────────────────────

  /** Claude / Codex 共用同一套渲染（展示"剩余%"，与 LauncherView 一致） */
  private renderSub(quota: OfficialQuota): string | null {
    const labelOf = (mins: number | undefined, fallbackH: number, fallbackD?: number): string => {
      if (mins && mins >= 1440) return `${Math.round(mins / 1440)}d`;
      if (mins) return `${Math.round(mins / 60)}h`;
      return fallbackD ? `${fallbackD}d` : `${fallbackH}h`;
    };
    const parts: string[] = [];
    if (quota.primary) parts.push(this.remainChunk(labelOf(quota.primary.windowMinutes, 5), quota.primary.usedPct));
    if (quota.secondary) parts.push(this.remainChunk(labelOf(quota.secondary.windowMinutes, 24, 7), quota.secondary.usedPct));
    if (quota.modelLimits?.opus) parts.push(this.remainChunk("opus", quota.modelLimits.opus.usedPct));
    if (!parts.length) return null;
    return `${this.icon()} ${parts.join(`${style.dim} · ${style.reset}`)}`;
  }

  private renderClaudeSub = this.renderSub;
  private renderCodexSub = this.renderSub;

  private pctChunk(label: string, pct: number): string {
    // 已用越多越红（用于 Tako 金额制兜底，订阅类已不再用此函数）
    const color = pct >= 90 ? fg.brightRed
      : pct >= 70 ? fg.brightYellow
      : fg.brightGreen;
    return `${label}:${color}${pct}%${style.reset}`;
  }

  /** 剩余百分比 chunk（剩越少越红） */
  private remainChunk(label: string, usedPct: number): string {
    const remain = Math.max(0, Math.min(100, 100 - Math.round(usedPct)));
    const color = remain <= 10 ? fg.brightRed
      : remain <= 30 ? fg.brightYellow
      : fg.brightGreen;
    return `${label} 剩 ${color}${remain}%${style.reset}`;
  }

  // ─── 兜底：当次会话花费（Claude Code 传入）────────────────────

  private renderSessionCost(input: StatusLineInput): string | null {
    const cost = input.cost?.total_cost_usd;
    if (cost == null || cost <= 0) return null;
    return `${this.icon()} ${fg.brightGreen}Session:${this.fmtCost(cost)}${style.reset}`;
  }

  // ─── 工具 ────────────────────────────────────────────────────

  private icon(): string {
    return `${theme.todayUsage.icon}${getIcon("todayUsage")}${style.reset}`;
  }

  private fmtCost(value: number): string {
    if (value >= 100) return `$${Math.round(value)}`;
    if (value >= 10) return `$${value.toFixed(1)}`;
    return `$${value.toFixed(2)}`;
  }
}
