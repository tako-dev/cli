import type { TakoConfig } from "../config";
import { loadConfig } from "../config";
import type { Provider } from "../providers/types";
import { fetchTakoQuotaByApiId, resolveTakoApiId, type ApiIdResult } from "./tako";
import type { OfficialQuota, QuotaSlot } from "./types";

export interface QuotaCommandDeps {
  loadConfig?: () => Promise<TakoConfig>;
  fetchQuotaByApiId?: (apiId: string) => Promise<OfficialQuota>;
  resolveApiIdFromKey?: (apiKey: string) => Promise<ApiIdResult>;
}

interface QuotaJsonSlot {
  used?: number;
  limit?: number;
  usedPct: number;
  remaining?: number;
  remainingPct?: number;
  windowMinutes?: number;
  resetsAt?: string;
}

type QuotaJsonPayload =
  | {
      provider: "tako";
      status: "ok";
      fiveHour?: QuotaJsonSlot;
      daily?: QuotaJsonSlot;
      weekly?: QuotaJsonSlot;
      fetchedAt: string;
    }
  | {
      provider: "tako";
      status: "error";
      error: string;
      message: string;
      hint?: string;
    };

export interface QuotaCommandResult {
  exitCode: number;
  payload: QuotaJsonPayload;
}

function getTakoProvider(config: TakoConfig): Provider | null {
  return (config.providers ?? []).find((provider) => provider.type === "tako") ?? null;
}

function toJsonSlot(slot: QuotaSlot | undefined): QuotaJsonSlot | undefined {
  if (!slot) return undefined;

  const out: QuotaJsonSlot = {
    usedPct: slot.usedPct,
    ...(slot.windowMinutes ? { windowMinutes: slot.windowMinutes } : {}),
    ...(slot.resetsAt ? { resetsAt: slot.resetsAt } : {}),
  };

  if (typeof slot.costUsed === "number") out.used = slot.costUsed;
  if (typeof slot.costLimit === "number") {
    out.limit = slot.costLimit;
    const used = slot.costUsed ?? 0;
    out.remaining = Math.max(0, slot.costLimit - used);
    out.remainingPct = Math.max(0, Math.min(100, 100 - Math.round(slot.usedPct)));
  }

  return out;
}

function errorPayload(error: string, message: string, hint?: string): QuotaCommandResult {
  return {
    exitCode: 1,
    payload: {
      provider: "tako",
      status: "error",
      error,
      message,
      ...(hint ? { hint } : {}),
    },
  };
}

function successPayload(quota: OfficialQuota): QuotaCommandResult {
  return {
    exitCode: 0,
    payload: {
      provider: "tako",
      status: "ok",
      fiveHour: toJsonSlot(quota.primary),
      daily: toJsonSlot(quota.daily),
      weekly: toJsonSlot(quota.secondary),
      fetchedAt: new Date(quota.fetchedAt).toISOString(),
    },
  };
}

function quotaErrorResult(quota: OfficialQuota): QuotaCommandResult {
  return errorPayload(
    quota.error || "quota_unavailable",
    quota.hint || "Tako quota is unavailable",
    quota.hint,
  );
}

export async function buildQuotaPayload(
  config: TakoConfig,
  deps: QuotaCommandDeps = {},
): Promise<QuotaCommandResult> {
  const provider = getTakoProvider(config);
  if (!provider) return errorPayload("missing_tako_provider", "Tako provider is not configured");
  if (!provider.apiKey) return errorPayload("missing_api_key", "Tako provider is missing its API key");

  const resolveApiId = deps.resolveApiIdFromKey ?? resolveTakoApiId;
  const resolved = await resolveApiId(provider.apiKey);
  if (!resolved.valid) return errorPayload(resolved.error, resolved.message);

  const fetchQuota = deps.fetchQuotaByApiId ?? fetchTakoQuotaByApiId;
  const quota = await fetchQuota(resolved.apiId);
  return quota.status === "ok" ? successPayload(quota) : quotaErrorResult(quota);
}

export async function runQuotaCommand(
  args: string[] = [],
  deps: QuotaCommandDeps = {},
): Promise<number> {
  if (args.length > 0) {
    const result = errorPayload("invalid_args", "Usage: tako quota");
    process.stdout.write(`${JSON.stringify(result.payload)}\n`);
    return result.exitCode;
  }

  const readConfig = deps.loadConfig ?? loadConfig;
  const result = await buildQuotaPayload(await readConfig(), deps);
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  return result.exitCode;
}
