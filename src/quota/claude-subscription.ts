/**
 * Claude 订阅 fetcher：GET https://api.anthropic.com/api/oauth/usage
 *
 * 鉴权：Authorization: Bearer ${access_token} + anthropic-beta: oauth-2025-04-20
 * Token 来源：provider.authData.credentials.claudeAiOauth.accessToken
 *
 * 返回示例（社区逆向，未官方文档化）：
 * {
 *   "session": { "utilization": 45, "resets_at": "2026-04-26T14:30:00Z" },
 *   "weekly":  { "utilization": 78, "resets_at": "2026-05-03T00:00:00Z" },
 *   "seven_day_opus": { "utilization": 93, "resets_at": "..." }   // Pro/Max 专属
 * }
 */
import type { Provider } from "../providers/types";
import type { OfficialQuota, QuotaFetchOptions, QuotaSlot } from "./types";

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string | null;
}

/**
 * 真实响应字段（GET /api/oauth/usage with anthropic-beta: oauth-2025-04-20）：
 * {
 *   "five_hour":            { utilization, resets_at },
 *   "seven_day":            { utilization, resets_at },
 *   "seven_day_sonnet":     { utilization, resets_at } | null,
 *   "seven_day_opus":       { utilization, resets_at } | null,
 *   "seven_day_oauth_apps": ... | null,
 *   "seven_day_cowork":     ... | null,
 *   "seven_day_omelette":   ... | null,
 *   "extra_usage": { is_enabled, monthly_limit, used_credits, utilization, currency }
 * }
 */
interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_sonnet?: ClaudeUsageWindow | null;
  seven_day_opus?: ClaudeUsageWindow | null;
  extra_usage?: { is_enabled?: boolean; utilization?: number };
}

function toSlot(w: ClaudeUsageWindow | null | undefined): QuotaSlot | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  return {
    usedPct: Math.min(100, Math.max(0, Math.round(w.utilization))),
    resetsAt: w.resets_at ?? undefined,
  };
}

function extractToken(provider: Provider): string | undefined {
  const creds = provider.authData?.credentials as Record<string, any> | undefined;
  return creds?.claudeAiOauth?.accessToken;
}

export async function fetchClaudeSubscriptionQuota(
  provider: Provider,
  options?: QuotaFetchOptions,
): Promise<OfficialQuota> {
  const fetchedAt = Date.now();
  const base: OfficialQuota = { provider: "claude-subscription", status: "error", fetchedAt };

  const token = extractToken(provider);
  if (!token) {
    return {
      ...base,
      hint: "Claude OAuth 未保存：按 p → 选中账号 → d → 重新登录",
      error: "missing_access_token",
    };
  }

  const timeoutMs = options?.timeoutMs ?? 5000;
  if (timeoutMs <= 0) {
    return { ...base, hint: "Anthropic 用量接口请求超时", error: "timeout" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401) {
      return {
        ...base,
        hint: "Claude OAuth 已过期：按 p → 选中账号 → d → 重新登录",
        error: "unauthorized",
      };
    }
    if (!res.ok) {
      return { ...base, hint: "Anthropic 用量接口不可用", error: `http_${res.status}` };
    }

    const json: ClaudeUsageResponse = await res.json();
    const opus = toSlot(json.seven_day_opus);
    const primary = toSlot(json.five_hour);
    if (primary) primary.windowMinutes = 300;          // 5h
    const secondary = toSlot(json.seven_day);
    if (secondary) secondary.windowMinutes = 7 * 1440; // 7d

    return {
      provider: "claude-subscription",
      status: "ok",
      primary,
      secondary,
      ...(opus ? { modelLimits: { opus } } : {}),
      fetchedAt,
    };
  } catch (e) {
    return {
      ...base,
      hint: "Anthropic 用量接口请求失败",
      error: String((e as Error).message ?? e),
    };
  }
}
