import { PROXY_BASE_URL } from "../config";
import type { Provider } from "../providers/types";
import type { OfficialQuota, QuotaSlot } from "./types";

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

export async function resolveTakoApiId(apiKey: string): Promise<ApiIdResult> {
  if (!apiKey) {
    return { valid: false, error: "missing_api_key", message: "Tako provider is missing its API key" };
  }

  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/get-key-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await readJson(response) as (ApiErrorResponse & { data?: { id?: string } }) | null;

    if (!response.ok) {
      return {
        valid: false,
        error: `http_${response.status}`,
        message: json?.error || json?.message || "Tako key validation request failed",
      };
    }

    if (!json) {
      return { valid: false, error: "invalid_json", message: "Tako key validation returned invalid JSON" };
    }

    if (!json.success) {
      const message = json.error || json.message || "Tako key validation failed";
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

async function tryFullQuota(apiId: string): Promise<OfficialQuota | null> {
  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/user-quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const json = await readJson(response) as FullQuotaResponse | null;
    if (!json?.plan || !json.usage) return null;

    return {
      provider: "tako",
      status: "ok",
      primary: makeSlot(json.usage.windowCost ?? 0, json.plan.window_cost_limit ?? 0, json.plan.window_minutes),
      daily: makeSlot(json.usage.dailyCost ?? 0, json.plan.daily_cost_limit ?? 0),
      secondary: makeSlot(json.usage.weeklyCost ?? 0, json.plan.weekly_cost_limit ?? 0),
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchTakoQuotaByApiId(apiId: string): Promise<OfficialQuota> {
  const fetchedAt = Date.now();
  if (!apiId) return errorQuota("missing_api_id", "缺少 Tako 数字用户 ID", fetchedAt);

  const full = await tryFullQuota(apiId);
  if (full) return full;

  try {
    const response = await fetch(`${PROXY_BASE_URL}/apiStats/api/user-stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await readJson(response) as RsCompatStatsResponse | null;

    if (!response.ok) {
      return errorQuota(
        `http_${response.status}`,
        json?.error || json?.message || "Tako 用量接口不可用",
        fetchedAt,
      );
    }
    if (!json) return errorQuota("invalid_json", "Tako 用量接口返回了无效 JSON", fetchedAt);
    if (!json.success) {
      const message = json.error || json.message;
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

export async function fetchTakoQuota(provider: Provider): Promise<OfficialQuota> {
  if (!provider.apiKey) {
    return errorQuota("missing_api_key", "Tako provider 缺少 API key，请重新配置");
  }

  const resolved = await resolveTakoApiId(provider.apiKey);
  if (!resolved.valid) return errorQuota(resolved.error, resolved.message);
  return fetchTakoQuotaByApiId(resolved.apiId);
}
