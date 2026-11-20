/**
 * 统一的官方用量类型
 *
 * 把上游三家不同的窗口名（Tako=window, Claude=session, Codex=primary_window）
 * 统一成 primary / secondary，UI 不用关心 provider 类型。
 */
import type { ProviderType } from "../providers/types";

export interface QuotaSlot {
  /** 已用百分比 0-100 */
  usedPct: number;
  /** 重置时间 ISO 8601 */
  resetsAt?: string;
  /** 金额限额（仅 Tako 提供） */
  costLimit?: number;
  /** 已用金额（仅 Tako 提供） */
  costUsed?: number;
  /** 窗口大小（分钟），用于显示 "5h"/"24h" 标签 */
  windowMinutes?: number;
}

export type QuotaStatus = "ok" | "error" | "unsupported";

export interface OfficialQuota {
  provider: ProviderType;
  status: QuotaStatus;
  /** 5 小时滑动窗口 */
  primary?: QuotaSlot;
  /** 7 天周窗口 */
  secondary?: QuotaSlot;
  /** 自然日窗口（仅 Tako 提供） */
  daily?: QuotaSlot;
  /** 钱包剩余余额（USD，仅 Tako 提供） */
  balanceUsd?: number;
  /** Pro/Max 套餐独立模型额度（如 Claude 的 Opus） */
  modelLimits?: { opus?: QuotaSlot };
  /** 套餐类型 "plus" / "pro" / "max" / "team" 等，用于 UI 显示徽标 */
  planType?: string;
  /** unsupported / error 时给用户的引导文案 */
  hint?: string;
  /** 错误信息（开发者诊断用，UI 不一定展示） */
  error?: string;
  /** 拉取时间戳 */
  fetchedAt: number;
}

export interface QuotaFetchOptions {
  /** 总网络超时预算（ms）。statusline 场景需显著低于宿主 CLI 的 5s 强杀上限 */
  timeoutMs?: number;
  /** 跳过耗时较长的 codex app-server RPC 探活（statusline 等短超时场景） */
  skipCodexRpc?: boolean;
}
