import { getOfficialQuota, type OfficialQuota } from "../../quota";
import {
  getClientProvider,
  getDefaultProvider,
  getProvidersForClient,
  type Provider,
} from "../../providers";
import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon, fg } from "../colors";

/**
 * statusline 场景的配额请求总预算（ms）。
 * 宿主 CLI（如 Antigravity / agy）对 statusline 有 5s 硬超时并直接 SIGKILL，
 * 留出充裕余量给进程启动与其他 segment，避免网络抖动触发弹窗报错。
 */
export const STATUSLINE_QUOTA_TIMEOUT_MS = 2500;

/**
 * 解析当前客户端在 statusline 中应展示配额的 Provider。
 * 优先级与 launcher 保持一致：客户端显式绑定 → 兼容的默认 Provider → 第一个兼容 Provider。
 * 避免把不兼容的默认 Provider（例如给 agy / claude-code 回落到 codex-subscription）错派去发无效网络请求。
 */
export async function resolveStatusLineProvider(clientId: string): Promise<Provider | undefined> {
  const bound = await getClientProvider(clientId);
  if (bound) return bound;

  const compatible = await getProvidersForClient(clientId);
  if (compatible.length === 0) return undefined;
  if (compatible.length === 1) return compatible[0];

  const defaultProvider = await getDefaultProvider();
  if (defaultProvider && compatible.some((p) => p.id === defaultProvider.id)) {
    return defaultProvider;
  }
  return compatible[0];
}

/**
 * Quota Segment：显示当前 Claude Code / Antigravity 绑定的 provider 用量
 *
 * - Tako provider:        💰 5h:$2.30/$50
 * - claude-subscription:  💰 5h:45% · wk:78%   (opus 单独额度时再追加 · opus:93%)
 * - codex-subscription:   💰 5h:45% · 7d:72%
 * - 取不到任何 provider 用量时回落到 Claude Code 当次会话花费：💰 Session:$0.30
 */
export class QuotaSegment implements Segment {
  id = "quota";

  constructor(private readonly quotaTimeoutMs = STATUSLINE_QUOTA_TIMEOUT_MS) {}

  async render(input: StatusLineInput): Promise<string | null> {
    const official = await this.tryRenderOfficial(input);
    if (official) return official;
    return this.renderSessionCost(input);
  }

  /** 解析当前客户端（Claude Code / Antigravity）绑定的兼容 provider，并按其类型渲染用量 */
  private async tryRenderOfficial(input: StatusLineInput): Promise<string | null> {
    try {
      const clientId = input.product === "antigravity" ? "agy" : "claude-code";
      const provider = await resolveStatusLineProvider(clientId);

      if (!provider) return null;

      const quota = await getOfficialQuota(provider, {
        timeoutMs: this.quotaTimeoutMs,
        skipCodexRpc: true,
      });
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
  // 纯余额（无窗口限额且有钱包余额）→ 展示钱包余额（低余额变黄/红）
  // 兜底（旧后端无余额字段）→ 展示已花费金额

  private renderTako(quota: OfficialQuota): string | null {
    if (quota.status !== "ok") return null;
    const hasLimits = !!(quota.primary?.costLimit || quota.secondary?.costLimit || quota.daily?.costLimit);
    if (hasLimits) return this.renderSub(quota);

    if (typeof quota.balanceUsd === "number" && Number.isFinite(quota.balanceUsd)) {
      return this.renderBalance(quota.balanceUsd);
    }

    const slot = quota.daily ?? quota.primary ?? quota.secondary;
    if (!slot) return null;
    const used = slot.costUsed ?? 0;
    return `${this.icon()} ${fg.brightGreen}Day:${this.fmtCost(used)}${style.reset}`;
  }

  private renderBalance(balanceUsd: number): string {
    const safe = Math.max(0, balanceUsd);
    const color = safe <= 1 ? fg.brightRed
      : safe <= 5 ? fg.brightYellow
      : fg.brightGreen;
    return `${this.icon()} 余额 ${color}$${safe.toFixed(2)}${style.reset}`;
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
