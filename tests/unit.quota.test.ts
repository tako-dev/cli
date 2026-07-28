import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeSubscriptionQuota } from "../src/quota/claude-subscription";
import { fetchCodexSubscriptionQuota, _setHttpFnForTest } from "../src/quota/codex-subscription";
import { fetchTakoQuota, fetchTakoQuotaByApiId, resolveTakoApiId } from "../src/quota/tako";
import { getOfficialQuota, _clearQuotaCache, _setQuotaDiskCachePathForTest } from "../src/quota";
import type { Provider } from "../src/providers/types";

const ORIGINAL_FETCH = globalThis.fetch;
let tmpDir: string;

interface MockCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): MockCall[] {
  const calls: MockCall[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return await handler(url, init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  _clearQuotaCache();
  // 隔离磁盘缓存到临时目录，防止测试互相污染或污染真实 ~/.tako
  tmpDir = mkdtempSync(join(tmpdir(), "tako-quota-"));
  _setQuotaDiskCachePathForTest(join(tmpDir, "quota-cache.json"));
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  _setQuotaDiskCachePathForTest(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tako ─────────────────────────────────────────────────────────

describe("TP-QUOTA-01 Tako fetcher rs-compat fallback", () => {
  it("/api/user-quota 不可用 → 回落 /api/user-stats 取 currentDailyCost", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/api/user-quota")) return new Response("not found", { status: 404 });
      return jsonResponse({
        success: true,
        data: {
          id: "u1", name: "test",
          limits: { currentDailyCost: 1.23, currentTotalCost: 1.23, currentWindowRequests: 5 },
          usage: { total: { cost: 1.23, formattedCost: "$1.23", requests: 5 } },
        },
      });
    });
    const q = await fetchTakoQuotaByApiId("apiid-x");
    expect(q.status).toBe("ok");
    expect(q.daily?.costUsed).toBe(1.23);
    expect(q.daily?.costLimit).toBeUndefined(); // 没限额
    expect(calls.length).toBe(2); // 试了 user-quota，再用 user-stats
  });
});

describe("TP-QUOTA-02 Tako fetcher 完整 quota 端点", () => {
  it("/api/user-quota 返回 plan+usage → 用完整窗口/周/日限额", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/user-quota")) {
        return jsonResponse({
          plan: { window_cost_limit: 50, window_minutes: 300, daily_cost_limit: 100, weekly_cost_limit: 500 },
          usage: { windowCost: 12.5, dailyCost: 30, weeklyCost: 200 },
        });
      }
      return jsonResponse({ success: false });
    });
    const q = await fetchTakoQuotaByApiId("apiid-x");
    expect(q.status).toBe("ok");
    expect(q.primary?.usedPct).toBe(25);  // 12.5/50
    expect(q.primary?.windowMinutes).toBe(300);
    expect(q.daily?.usedPct).toBe(30);    // 30/100
    expect(q.secondary?.usedPct).toBe(40); // 200/500
  });
});

describe("TP-QUOTA-11 Tako provider 新身份流", () => {
  it("先用 provider API key 解析数字 ID，再查询 quota", async () => {
    const calls = mockFetch((url, init) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/api/get-key-id")) {
        expect(body).toEqual({ apiKey: "cr_provider" });
        return jsonResponse({ success: true, data: { id: "123" } });
      }
      if (url.endsWith("/api/user-quota")) {
        expect(body).toEqual({ apiId: "123" });
        return jsonResponse({
          plan: { window_cost_limit: 50 },
          usage: { windowCost: 10 },
        });
      }
      return jsonResponse({ success: false });
    });
    const q = await fetchTakoQuota({
      id: "p-tako", name: "Tako", type: "tako", apiKey: "cr_provider",
      apiId: "old-par-uuid", createdAt: new Date().toISOString(),
    });
    expect(q.status).toBe("ok");
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual(["get-key-id", "user-quota"]);
  });

  it("拒绝非数字 get-key-id 响应", async () => {
    mockFetch(() => jsonResponse({ success: true, data: { id: "old-par-uuid" } }));
    const result = await resolveTakoApiId("cr_provider");
    expect(result).toEqual({
      valid: false,
      error: "bad_payload",
      message: "Tako key validation returned an invalid numeric user ID",
    });
  });

  it("provider 缺 API key 时不读取保存的 apiId", async () => {
    const calls = mockFetch(() => jsonResponse({}));
    const q = await fetchTakoQuota({
      id: "p-tako", name: "Tako", type: "tako", apiId: "123",
      createdAt: new Date().toISOString(),
    });
    expect(q.error).toBe("missing_api_key");
    expect(calls).toHaveLength(0);
  });
});

describe("TP-QUOTA-12 Tako 错误分类", () => {
  it("User not found 保留为业务错误，而不是 bad_payload", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/user-quota")) return jsonResponse({});
      return jsonResponse({ success: false, error: "User not found" });
    });
    const q = await fetchTakoQuotaByApiId("123");
    expect(q.error).toBe("user_not_found");
    expect(q.hint).toBe("User not found");
  });

  it("缺少 success/data/error 的响应仍标记 bad_payload", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/user-quota")) return jsonResponse({});
      return jsonResponse({ unexpected: true });
    });
    const q = await fetchTakoQuotaByApiId("123");
    expect(q.error).toBe("bad_payload");
  });
});

// ─── Claude ─────────────────────────────────────────────────────────

describe("TP-QUOTA-03 Claude fetcher 字段映射", () => {
  it("正确映射 five_hour/seven_day/seven_day_opus → primary/secondary/modelLimits.opus", async () => {
    const calls = mockFetch(() =>
      jsonResponse({
        five_hour:      { utilization: 45, resets_at: "2026-04-26T14:30:00Z" },
        seven_day:      { utilization: 78, resets_at: "2026-05-03T00:00:00Z" },
        seven_day_opus: { utilization: 93, resets_at: "2026-05-03T00:00:00Z" },
        seven_day_sonnet: null,
      })
    );

    const provider: Provider = {
      id: "p1", name: "Claude Max", type: "claude-subscription",
      authData: { credentials: { claudeAiOauth: { accessToken: "tok-abc" } } },
      createdAt: new Date().toISOString(),
    };

    const q = await fetchClaudeSubscriptionQuota(provider);
    expect(q.status).toBe("ok");
    expect(q.primary?.usedPct).toBe(45);
    expect(q.primary?.windowMinutes).toBe(300);
    expect(q.secondary?.usedPct).toBe(78);
    expect(q.modelLimits?.opus?.usedPct).toBe(93);

    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
});

describe("TP-QUOTA-04 Claude fetcher 缺少 token", () => {
  it("authData 缺 accessToken → status=error 并提示重新登录", async () => {
    const provider: Provider = {
      id: "p1", name: "Claude", type: "claude-subscription",
      authData: { credentials: {} },
      createdAt: new Date().toISOString(),
    };
    const q = await fetchClaudeSubscriptionQuota(provider);
    expect(q.status).toBe("error");
    expect(q.error).toBe("missing_access_token");
    expect(q.hint).toContain("重新登录");
  });
});

describe("TP-QUOTA-05 Claude fetcher 401 响应", () => {
  it("401 → status=error 并提示重新登录路径", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const provider: Provider = {
      id: "p1", name: "Claude", type: "claude-subscription",
      authData: { credentials: { claudeAiOauth: { accessToken: "expired" } } },
      createdAt: new Date().toISOString(),
    };
    const q = await fetchClaudeSubscriptionQuota(provider);
    expect(q.status).toBe("error");
    expect(q.error).toBe("unauthorized");
    expect(q.hint).toContain("重新登录");
  });
});

// ─── Codex ──────────────────────────────────────────────────────────

describe("TP-QUOTA-06 Codex fetcher 字段映射", () => {
  it("rate_limit.{primary,secondary}_window 正确映射，reset_at unix → ISO", async () => {
    const resetAt = 1714195200; // 2024-04-27T08:00:00Z
    _setHttpFnForTest(async () => ({
      status: 200,
      body: JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 45, reset_at: resetAt, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 72, reset_at: resetAt + 1000, limit_window_seconds: 604800 },
        },
      }),
    }));

    const provider: Provider = {
      id: "p1", name: "Codex Plus", type: "codex-subscription",
      authData: { tokens: { access_token: "tok-codex", account_id: "acc-1" } },
      createdAt: new Date().toISOString(),
    };
    const q = await fetchCodexSubscriptionQuota(provider);
    _setHttpFnForTest(null);
    expect(q.status).toBe("ok");
    expect(q.primary?.usedPct).toBe(45);
    expect(q.primary?.windowMinutes).toBe(300);
    expect(q.primary?.resetsAt).toBe(new Date(resetAt * 1000).toISOString());
    expect(q.secondary?.usedPct).toBe(72);
    expect(q.planType).toBe("plus");
  });
});

describe("TP-QUOTA-08 Codex 携带 ChatGPT-Account-Id", () => {
  it("authData.tokens.account_id 透传给 httpFn", async () => {
    let capturedAccountId: string | undefined;
    _setHttpFnForTest(async (_token, accountId) => {
      capturedAccountId = accountId;
      return { status: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, reset_at: 0 } } }) };
    });
    const provider: Provider = {
      id: "p1", name: "Codex", type: "codex-subscription",
      authData: { tokens: { access_token: "t", account_id: "acct-xyz" } },
      createdAt: new Date().toISOString(),
    };
    await fetchCodexSubscriptionQuota(provider);
    _setHttpFnForTest(null);
    expect(capturedAccountId).toBe("acct-xyz");
  });
});

describe("TP-QUOTA-07 Codex 缺少 token", () => {
  it("无 access_token → error", async () => {
    const provider: Provider = {
      id: "p1", name: "Codex", type: "codex-subscription",
      authData: { tokens: {} },
      createdAt: new Date().toISOString(),
    };
    const q = await fetchCodexSubscriptionQuota(provider);
    expect(q.status).toBe("error");
    expect(q.error).toBe("missing_access_token");
  });
});

// ─── Dispatcher ────────────────────────────────────────────────────

describe("TP-QUOTA-09 dispatcher 路由", () => {
  it("非 tako/claude/codex 类型返回 unsupported", async () => {
    const provider: Provider = {
      id: "p1", name: "Custom", type: "custom",
      apiKey: "k", baseUrl: "https://x",
      createdAt: new Date().toISOString(),
    };
    const q = await getOfficialQuota(provider);
    expect(q.status).toBe("unsupported");
    expect(q.provider).toBe("custom");
  });
});

describe("TP-QUOTA-10 dispatcher 缓存", () => {
  it("60 秒内连续调用同一 provider 只 fetch 一次", async () => {
    const calls = mockFetch(() =>
      jsonResponse({
        session: { utilization: 10 },
        weekly: { utilization: 20 },
      })
    );
    const provider: Provider = {
      id: "p-cache", name: "Claude", type: "claude-subscription",
      authData: { credentials: { claudeAiOauth: { accessToken: "tok" } } },
      createdAt: new Date().toISOString(),
    };
    const q1 = await getOfficialQuota(provider);
    const q2 = await getOfficialQuota(provider);
    expect(q1).toBe(q2); // 同一对象（缓存）
    expect(calls).toHaveLength(1);
  });

  it("同一 provider 更换 API key 后不会命中旧账号缓存", async () => {
    let quotaRequests = 0;
    mockFetch((url, init) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/api/get-key-id")) {
        return jsonResponse({
          success: true,
          data: { id: body.apiKey === "cr_first" ? "101" : "202" },
        });
      }
      quotaRequests += 1;
      return jsonResponse({
        plan: { window_cost_limit: 100 },
        usage: { windowCost: body.apiId === "101" ? 10 : 20 },
      });
    });
    const base = {
      id: "p-key-change", name: "Tako", type: "tako" as const,
      createdAt: new Date().toISOString(),
    };

    const first = await getOfficialQuota({ ...base, apiKey: "cr_first" });
    const second = await getOfficialQuota({ ...base, apiKey: "cr_second" });

    expect(first.primary?.usedPct).toBe(10);
    expect(second.primary?.usedPct).toBe(20);
    expect(quotaRequests).toBe(2);
  });

  it("内存清空后磁盘缓存仍命中（模拟跨进程）", async () => {
    const calls = mockFetch(() =>
      jsonResponse({
        five_hour: { utilization: 33 },
        seven_day: { utilization: 44 },
      })
    );
    const provider: Provider = {
      id: "p-disk", name: "Claude", type: "claude-subscription",
      authData: { credentials: { claudeAiOauth: { accessToken: "tok" } } },
      createdAt: new Date().toISOString(),
    };

    // 第一次：网络
    const q1 = await getOfficialQuota(provider);
    expect(q1.primary?.usedPct).toBe(33);
    expect(calls).toHaveLength(1);

    // 模拟新进程：清掉内存缓存，但磁盘缓存还在
    _clearQuotaCache();

    const q2 = await getOfficialQuota(provider);
    expect(q2.primary?.usedPct).toBe(33);
    expect(calls).toHaveLength(1); // 没有第二次 fetch
  });
});
