import { apiErrorText } from "../api-error";
import { PROXY_BASE_URL } from "../config";
import type { Provider } from "../providers/types";
import type { OfficialQuota, QuotaFetchOptions, QuotaSlot } from "./types";

const DEFAULT_STEP_TIMEOUT_MS = 5000;

function remainingTimeout(deadline: number | undefined, fallbackMs = DEFAULT_STEP_TIMEOUT_MS): number {
  if (deadline === undefined) return fallbackMs;
  return Math.max(0, deadline - Date.now());
}

export type ApiIdResult =
  | { valid: true; apiId: string }
  | { valid: false; error: string; message: string };

interface ApiErrorResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

interface RsCompatStatsResponse extends ApiErrorResponse {
  data?: {
    id: string;
    name?: string;
    limits?: {
      currentDailyCost?: number;
      currentTotalCost?: number;
      currentWindowRequests?: number;
    };
    usage?: {
      total?: {
        cost?: number;
        formattedCost?: string;
        requests?: number;
      };
    };
  };
}

interface FullQuotaResponse extends ApiErrorResponse {
  plan?: {
    daily_cost_limit?: number;
    weekly_cost_limit?: number;
    total_cost_limit?: number;
    window_cost_limit?: number;
    window_minutes?: number;
  };
  usage?: {
    dailyCost?: number;
    weeklyCost?: number;
    windowCost?: number;
  };
  balance?: {
    remain_usd?: number;
    used_usd?: number;
    remain?: number;
    used?: number;
  };
}

interface DesktopMeResponse {
  success?: boolean;
  data?: {
    quota?: {
      remain?: number;
      used?: number;
    };
  };
}

function parseBalanceUsd(balance: FullQuotaResponse["balance"]): number | undefined {
  if (!balance) return undefined;
  if (typeof balance.remain_usd === "number" && Number.isFinite(balance.remain_usd)) {
    return Math.max(0, balance.remain_usd);
  }
  if (typeof balance.remain === "number" && Number.isFinite(balance.remain)) {
    return Math.max(0, balance.remain / 500_000);
  }
  return undefined;
}

function makeSlot(used: number, limit: number, windowMinutes?: number): QuotaSlot | undefined {
  if (limit <= 0) return undefined;
  const usedPct = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  return { usedPct, costUsed: used, costLimit: limit, ...(windowMinutes ? { windowMinutes } : {}) };
}

function makeSpentSlot(used: number, windowMinutes?: number): QuotaSlot | undefined {
  if (!Number.isFinite(used) || used < 0) return undefined;
  return { usedPct: 0, costUsed: used, ...(windowMinutes ? { windowMinutes } : {}) };
}

function apiErrorCode(message: string): string {
  switch (message.toLowerCase()) {
    case "invalid key":
      return "invalid_key";
    case "user not found":
      return "user_not_found";
    case "apiid required":
      return "missing_api_id";
    default:
      return "api_error";
  }
}

function errorQuota(error: string, hint: string, fetchedAt = Date.now()): OfficialQuota {
  return { provider: "tako", status: "error", error, hint, fetchedAt };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function resolveTakoApiId(
  apiKey: string,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
): Promise<ApiIdResult> {
  if (!apiKey) {
    return { valid: false, error: "missing_api_key", message: "Tako provider is missing its API key" };
  }
  if (timeoutMs <= 0) {
    return { valid: false, error: "request_failed", message: "Tako key validation timed out" };
  }

  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/get-key-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await readJson(response) as (ApiErrorResponse & { data?: { id?: string } }) | null;

    if (!response.ok) {
      return {
        valid: false,
        error: `http_${response.status}`,
        message: apiErrorText(json, "Tako key validation request failed"),
      };
    }

    if (!json) {
      return { valid: false, error: "invalid_json", message: "Tako key validation returned invalid JSON" };
    }

    if (!json.success) {
      const message = apiErrorText(json, "Tako key validation failed");
      return { valid: false, error: apiErrorCode(message), message };
    }

    const apiId = json.data?.id;
    if (!apiId || !/^\d+$/.test(apiId) || Number(apiId) <= 0) {
      return {
        valid: false,
        error: "bad_payload",
        message: "Tako key validation returned an invalid numeric user ID",
      };
    }

    return { valid: true, apiId };
  } catch (e) {
    return {
      valid: false,
      error: "request_failed",
      message: String((e as Error).message ?? e),
    };
  }
}

async function tryFullQuota(apiId: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS): Promise<OfficialQuota | null> {
  if (timeoutMs <= 0) return null;
  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/user-quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;

    const json = await readJson(response) as FullQuotaResponse | null;
    if (!json) return null;

    const balanceUsd = parseBalanceUsd(json.balance);
    const hasPlan = !!(
      json.plan &&
      ((json.plan.window_cost_limit ?? 0) > 0 ||
        (json.plan.daily_cost_limit ?? 0) > 0 ||
        (json.plan.weekly_cost_limit ?? 0) > 0)
    );

    if (hasPlan && json.plan && json.usage) {
      return {
        provider: "tako",
        status: "ok",
        primary: makeSlot(json.usage.windowCost ?? 0, json.plan.window_cost_limit ?? 0, json.plan.window_minutes),
        daily: makeSlot(json.usage.dailyCost ?? 0, json.plan.daily_cost_limit ?? 0),
        secondary: makeSlot(json.usage.weeklyCost ?? 0, json.plan.weekly_cost_limit ?? 0),
        ...(balanceUsd !== undefined ? { balanceUsd } : {}),
        fetchedAt: Date.now(),
      };
    }

    if (balanceUsd !== undefined) {
      const dailyUsed = json.usage?.dailyCost;
      return {
        provider: "tako",
        status: "ok",
        ...(typeof dailyUsed === "number" ? { daily: makeSpentSlot(dailyUsed) } : {}),
        balanceUsd,
        fetchedAt: Date.now(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function tryDesktopMeBalance(apiKey: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS): Promise<number | undefined> {
  if (!apiKey || timeoutMs <= 0) return undefined;
  try {
    const response = await fetch(`${PROXY_BASE_URL}/api/desktop/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const json = await readJson(response) as DesktopMeResponse | null;
    if (json?.success !== true) return undefined;
    const remain = json.data?.quota?.remain;
    if (typeof remain !== "number" || !Number.isFinite(remain)) return undefined;
    return Math.max(0, remain / 500_000);
  } catch {
    return undefined;
  }
}

export async function fetchTakoQuotaByApiId(
  apiId: string,
  options?: QuotaFetchOptions & { apiKey?: string },
): Promise<OfficialQuota> {
  const fetchedAt = Date.now();
  if (!apiId) return errorQuota("missing_api_id", "缺少 Tako 数字用户 ID", fetchedAt);

  const deadline = options?.timeoutMs != null ? fetchedAt + options.timeoutMs : undefined;
  const fullTimeout = remainingTimeout(deadline);
  if (fullTimeout <= 0) return errorQuota("request_failed", "Tako 用量请求超时", fetchedAt);

  const full = await tryFullQuota(apiId, fullTimeout);
  if (full) return full;

  if (options?.apiKey) {
    const meTimeout = remainingTimeout(deadline);
    if (meTimeout <= 0) return errorQuota("request_failed", "Tako 用量请求超时", fetchedAt);
    const balanceUsd = await tryDesktopMeBalance(options.apiKey, meTimeout);
    if (balanceUsd !== undefined) {
      return {
        provider: "tako",
        status: "ok",
        balanceUsd,
        fetchedAt: Date.now(),
      };
    }
  }

  const fallbackTimeout = remainingTimeout(deadline);
  if (fallbackTimeout <= 0) return errorQuota("request_failed", "Tako 用量请求超时", fetchedAt);

  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/user-stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId }),
      signal: AbortSignal.timeout(fallbackTimeout),
    });
    const json = await readJson(response) as RsCompatStatsResponse | null;

    if (!response.ok) {
      return errorQuota(
        `http_${response.status}`,
        apiErrorText(json, "Tako 用量接口不可用"),
        fetchedAt,
      );
    }
    if (!json) return errorQuota("invalid_json", "Tako 用量接口返回了无效 JSON", fetchedAt);
    if (!json.success) {
      const message = apiErrorText(json, "");
      if (message) return errorQuota(apiErrorCode(message), message, fetchedAt);
      return errorQuota("bad_payload", "Tako 用量数据格式异常", fetchedAt);
    }
    if (!json.data) return errorQuota("bad_payload", "Tako 用量数据格式异常", fetchedAt);

    const dailyCost = json.data.limits?.currentDailyCost ?? json.data.usage?.total?.cost ?? 0;
    return {
      provider: "tako",
      status: "ok",
      daily: makeSpentSlot(dailyCost),
      fetchedAt,
    };
  } catch (e) {
    return errorQuota("request_failed", String((e as Error).message ?? e), fetchedAt);
  }
}

export async function fetchTakoQuota(
  provider: Provider,
  options?: QuotaFetchOptions,
): Promise<OfficialQuota> {
  if (!provider.apiKey) {
    return errorQuota("missing_api_key", "Tako provider 缺少 API key，请重新配置");
  }

  const deadline = options?.timeoutMs != null ? Date.now() + options.timeoutMs : undefined;
  const resolveTimeout = remainingTimeout(deadline);
  if (resolveTimeout <= 0) return errorQuota("request_failed", "Tako 用量请求超时");

  const resolved = await resolveTakoApiId(provider.apiKey, resolveTimeout);
  if (!resolved.valid) return errorQuota(resolved.error, resolved.message);

  const remaining = remainingTimeout(deadline);
  if (remaining <= 0) return errorQuota("request_failed", "Tako 用量请求超时");

  return fetchTakoQuotaByApiId(resolved.apiId, {
    ...options,
    apiKey: provider.apiKey,
    ...(deadline !== undefined ? { timeoutMs: remaining } : {}),
  });
}
