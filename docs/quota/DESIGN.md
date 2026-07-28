---
name: quota
description: 统一的官方用量获取模块，覆盖 Tako / Claude 订阅 / Codex 订阅
type: module
---

# Quota 模块设计

## 背景与目标

LauncherView 头部展示当前 provider 的实时用量额度（5 小时窗口、周窗口等）。

旧实现（`stats.ts:getQuotaStats()`）只能取 Tako 代理后端的额度，硬编码 `provider.type === "tako"` 才显示。当用户绑定 `claude-subscription` / `codex-subscription` 等其他 provider 时，整行用量条消失。

本模块抽象出统一的 `getOfficialQuota(provider)` 接口，按 provider.type 分发到对应 fetcher，覆盖：

- `tako` — 通过 provider API key 解析数字用户 ID，再查询 Tako 代理 quota/stats 接口
- `claude-subscription` — Anthropic OAuth `/api/oauth/usage`
- `codex-subscription` — ChatGPT `backend-api/wham/usage`
- 其他类型（`anthropic` / `deepseek` / `custom`）— 返回 `unsupported`

## 源文件结构

```
packages/cli/src/quota/
├── types.ts                    OfficialQuota / QuotaSlot 类型
├── index.ts                    dispatcher + 60s 内存/磁盘缓存
├── tako.ts                     Tako 代理 fetcher
├── command.ts                  tako quota JSON 命令
├── claude-subscription.ts      Claude OAuth fetcher
└── codex-subscription.ts       Codex OAuth fetcher
```

## 核心类型

```ts
type QuotaSlot = {
  usedPct: number;        // 0-100
  resetsAt?: string;      // ISO 8601
  costLimit?: number;     // 仅 Tako 提供
  costUsed?: number;
};

interface OfficialQuota {
  provider: ProviderType;
  status: "ok" | "error" | "unsupported";
  primary?: QuotaSlot;    // 5h 窗口
  secondary?: QuotaSlot;  // 7d 窗口
  daily?: QuotaSlot;      // Tako 独有
  modelLimits?: { opus?: QuotaSlot };  // Claude Pro/Max 专属
  planType?: string;      // "plus" / "pro" / "max" 等
  hint?: string;          // unsupported / error 时给用户的引导文案
  error?: string;
  fetchedAt: number;      // Date.now()
}
```

字段命名说明：把上游三家不同的窗口名（Tako=window, Claude=session, Codex=primary_window）统一成 `primary` / `secondary`，UI 不用关心 provider 类型。

## 各 fetcher 实现要点

### Tako (`tako.ts`)

- 身份解析：从当前 `tako` provider 读取 `apiKey`，调用 `POST {PROXY_BASE_URL}/apiStats/api/get-key-id`，只接受正整数形式的 `data.id`
- 用量查询：先调用 `POST {PROXY_BASE_URL}/apiStats/api/user-quota`；端点无完整 quota 数据时回落到 `/apiStats/api/user-stats`
- 查询 Body：`{ apiId }`，其中 `apiId` 是本次由 provider API key 解析出的数字用户 ID
- 不读取 provider 中保存的旧 `apiId`，也不读取顶层 legacy `config.apiKey` / `config.apiId`
- 5s 超时
- 字段映射：`usage.windowCost / plan.window_cost_limit → primary`、`usage.weeklyCost / plan.weekly_cost_limit → secondary`、`usage.dailyCost / plan.daily_cost_limit → daily`
- 用量百分比 `usedPct = round(used / limit * 100)`，`limit === 0` 视为无限制（usedPct = 0）

### Tako quota command (`command.ts`)

`tako quota` 是脚本接口，stdout 固定输出一行 JSON：

- 成功：`{ provider: "tako", status: "ok", fiveHour?, daily?, weekly?, fetchedAt }`
- 失败：`{ provider: "tako", status: "error", error, message, hint? }`

凭证选择不变量：

1. 必须存在 `config.providers[].type === "tako"`，并且该 provider 必须有 `apiKey`。
2. 每次查询先通过 `POST /apiStats/api/get-key-id` 把当前 provider API key 解析为数字用户 ID。
3. quota 请求只使用本次解析出的数字 ID；忽略 provider 保存的旧 `apiId`。
4. 不 fallback 到 legacy 顶层 `config.apiKey` / `config.apiId`，也不混用两套凭证。

`apiId` 是 Tako APIStats 系统中当前 API key 对应的数字用户 ID。解析响应必须是正整数形式的字符串；旧 PAR UUID 会作为 `bad_payload` 拒绝，不会用于 quota 查询或写回配置。

### Claude Subscription (`claude-subscription.ts`)

- Endpoint：`GET https://api.anthropic.com/api/oauth/usage`
- Headers：
  - `Authorization: Bearer ${accessToken}`
  - `anthropic-beta: oauth-2025-04-20`
- Token 来源：`provider.authData.credentials.claudeAiOauth.accessToken`
- 字段映射：`session → primary`、`weekly → secondary`、`seven_day_opus → modelLimits.opus`
- 401 时返回 `status: "error"` + `hint: "OAuth 已过期，请运行 claude /login 重新登录"`，不做自动刷新（原因见 TESTPLAN）

### Codex Subscription (`codex-subscription.ts`)

- Endpoint：`GET https://chatgpt.com/backend-api/wham/usage`
- Headers：
  - `Authorization: Bearer ${accessToken}`
  - `User-Agent: Tako-CLI`
  - `Accept: application/json`
  - `ChatGPT-Account-Id: ${accountId}`（可选，从 `tokens.account_id` 读）
- Token 来源：`provider.authData.tokens.access_token`
- 字段映射：`rate_limit.primary_window → primary`、`rate_limit.secondary_window → secondary`、`plan_type → planType`
- 401 时返回 `status: "error"` + `hint: "OAuth 已过期，请运行 codex login 重新登录"`

## Dispatcher (`index.ts`)

```ts
export async function getOfficialQuota(provider: Provider): Promise<OfficialQuota>;
```

- 60 秒双层缓存：进程内 `Map` + `~/.tako/quota-cache.json` 跨进程磁盘缓存。基础 key 为 `${provider.type}:${provider.id}`；Tako 额外拼接 API key 的 SHA-256 短指纹，换 key 后不会读到旧账号缓存
- 按 `provider.type` 分发：
  - `tako` → `fetchTakoQuota`
  - `claude-subscription` → `fetchClaudeSubscriptionQuota(provider)`
  - `codex-subscription` → `fetchCodexSubscriptionQuota(provider)`
  - 其他 → 返回 `{ status: "unsupported" }`
- 每个 fetcher 自己处理超时（5s）和异常，dispatcher 不做 try/catch

## UI 接入（LauncherView）

`LauncherView.tsx` 的 `isTako` 判断删除：

```ts
useEffect(() => {
  if (!currentProv) { setQuota(null); return; }
  getOfficialQuota(currentProv).then(setQuota);
}, [currentProv?.id]);
```

`<QuotaLine>` 根据 `quota.status` 决定渲染：
- `ok` — 渲染 primary / secondary 进度条
- `error` — 显示 hint 文案（dim 色）
- `unsupported` — 不渲染

## 不做的事

- **不实现 token 自动刷新**。原因：Tako 启动时已通过 `syncClaudeSubscription` / Codex auth.json 同步从上游 CLI 拿最新 token；如果上游也过期了，让用户重新登录比维护两套刷新逻辑稳。
- **不解析本地 jsonl 日志**作为离线兜底。第一版只走在线 API；如果在线挂了就显示错误。
- **磁盘缓存仅用于 60s 跨进程复用**。Claude Code statusline 每次刷新都会启动新进程，因此使用 `~/.tako/quota-cache.json`；过期后重新请求，不作为离线长期兜底。

## 依赖

- `Provider` / `ProviderType`：`packages/cli/src/providers/types.ts`
- `PROXY_BASE_URL`：`packages/cli/src/config.ts`
- Tako provider / `apiKey`：`packages/cli/src/providers/types.ts`
- 旧 `getQuotaStats()` 在迁移完成后从 `stats.ts` 删除，留下 `getUserStats()`（详细统计页用）

## 已有测试

见 `tests/unit.quota.test.ts` 与 `tests/unit.quota-command.test.ts`。
