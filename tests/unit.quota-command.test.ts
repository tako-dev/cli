import { afterEach, describe, expect, it } from "bun:test";
import type { TakoConfig } from "../src/config";
import type { OfficialQuota } from "../src/quota";
import { buildQuotaPayload, runQuotaCommand } from "../src/quota/command";

const ORIGINAL_STDOUT_WRITE = process.stdout.write;

function config(overrides: Partial<TakoConfig> = {}): TakoConfig {
  return { apiKey: "", apiId: "", installedClients: {}, ...overrides };
}

function takoProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-tako",
    name: "Tako 官方",
    type: "tako" as const,
    apiKey: "cr_test",
    apiId: "legacy-par-uuid",
    createdAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function okQuota(): OfficialQuota {
  return {
    provider: "tako",
    status: "ok",
    primary: { costUsed: 23.617805056000005, costLimit: 36, usedPct: 66, windowMinutes: 300 },
    daily: { costUsed: 55.44094080099994, costLimit: 120, usedPct: 46 },
    secondary: { costUsed: 191.37152484559988, costLimit: 400, usedPct: 48 },
    fetchedAt: Date.parse("2026-06-19T05:29:21.839Z"),
  };
}

afterEach(() => {
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
});

describe("tako quota command", () => {
  it("resolves the provider API key first and queries only the numeric user ID", async () => {
    const calls: string[] = [];
    const result = await buildQuotaPayload(config({ providers: [takoProvider()] }), {
      resolveApiIdFromKey: async (apiKey) => {
        calls.push(`resolve:${apiKey}`);
        return { valid: true, apiId: "123" };
      },
      fetchQuotaByApiId: async (apiId) => {
        calls.push(`quota:${apiId}`);
        return okQuota();
      },
    });

    expect(calls).toEqual(["resolve:cr_test", "quota:123"]);
    expect(result.exitCode).toBe(0);
    expect(result.payload).toEqual({
      provider: "tako",
      status: "ok",
      fiveHour: {
        used: 23.617805056000005,
        limit: 36,
        usedPct: 66,
        remaining: 12.382194943999995,
        remainingPct: 34,
        windowMinutes: 300,
      },
      daily: {
        used: 55.44094080099994,
        limit: 120,
        usedPct: 46,
        remaining: 64.55905919900006,
        remainingPct: 54,
      },
      weekly: {
        used: 191.37152484559988,
        limit: 400,
        usedPct: 48,
        remaining: 208.62847515440012,
        remainingPct: 52,
      },
      fetchedAt: "2026-06-19T05:29:21.839Z",
    });
  });

  it("does not fall back to legacy top-level credentials", async () => {
    let resolved = false;
    const result = await buildQuotaPayload(config({ apiKey: "cr_legacy", apiId: "legacy-id" }), {
      resolveApiIdFromKey: async () => {
        resolved = true;
        return { valid: true, apiId: "123" };
      },
    });

    expect(resolved).toBe(false);
    expect(result).toEqual({
      exitCode: 1,
      payload: {
        provider: "tako",
        status: "error",
        error: "missing_tako_provider",
        message: "Tako provider is not configured",
      },
    });
  });

  it("rejects a Tako provider without an API key even when apiId is saved", async () => {
    const result = await buildQuotaPayload(config({ providers: [takoProvider({ apiKey: "" })] }));
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ error: "missing_api_key" });
  });

  it("preserves key resolution errors", async () => {
    const result = await buildQuotaPayload(config({ providers: [takoProvider()] }), {
      resolveApiIdFromKey: async () => ({ valid: false, error: "invalid_key", message: "Invalid key" }),
    });
    expect(result).toEqual({
      exitCode: 1,
      payload: {
        provider: "tako",
        status: "error",
        error: "invalid_key",
        message: "Invalid key",
      },
    });
  });

  it("runQuotaCommand writes one JSON object to stdout", async () => {
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const code = await runQuotaCommand([], {
      loadConfig: async () => config({ providers: [takoProvider()] }),
      resolveApiIdFromKey: async () => ({ valid: true, apiId: "123" }),
      fetchQuotaByApiId: async () => okQuota(),
    });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      provider: "tako",
      status: "ok",
      fiveHour: { used: 23.617805056000005, limit: 36 },
    });
    expect(output.endsWith("\n")).toBe(true);
  });
});
