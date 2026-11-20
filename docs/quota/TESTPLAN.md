---
name: quota-testplan
description: quota 模块测试计划
type: testplan
---

# Quota 模块测试计划

## 已有覆盖

- `tests/unit.quota.test.ts` 覆盖 dispatcher 与各 provider fetcher。
- `tests/unit.quota-command.test.ts` 覆盖 `tako quota` JSON 命令、stale `apiId` retry、缺配置错误和 provider/legacy credential 隔离。

## 测试场景

### TP-QUOTA-01：Tako fetcher 字段映射

- 输入：mock fetch 返回完整 `ParStatsResponse`（含 plan + usage）
- 期望：返回 `OfficialQuota` 中 `primary.usedPct` = round(windowCost / window_cost_limit * 100)，`daily.usedPct` 同理，`secondary.usedPct` 同理
- 边界：`window_cost_limit === 0` 时 `usedPct = 0`

### TP-QUOTA-02：Tako fetcher 缺少 apiId

- 输入：`getApiId()` 返回 null
- 期望：`status: "error"`，不发起 fetch

### TP-QUOTA-03：Claude fetcher 字段映射

- 输入：mock fetch 返回 `{ session: {utilization: 45, resets_at}, weekly: {utilization: 78, resets_at}, seven_day_opus: {utilization: 93, resets_at} }`
- 期望：`primary.usedPct === 45`，`secondary.usedPct === 78`，`modelLimits.opus.usedPct === 93`
- 验证 headers：`Authorization: Bearer ${token}`、`anthropic-beta: oauth-2025-04-20`

### TP-QUOTA-04：Claude fetcher 缺少 token

- 输入：`provider.authData` 为 undefined 或缺 `claudeAiOauth.accessToken`
- 期望：`status: "error"`，`hint` 提示需要重新登录

### TP-QUOTA-05：Claude fetcher 401 响应

- 输入：mock fetch 返回 401
- 期望：`status: "error"`，`hint` 提示 `claude /login`

### TP-QUOTA-06：Codex fetcher 字段映射

- 输入：mock fetch 返回 `{ plan_type: "plus", rate_limit: { primary_window: {used_percent: 45, reset_at: <unix>}, secondary_window: {used_percent: 72, reset_at: <unix>} } }`
- 期望：`primary.usedPct === 45`、`secondary.usedPct === 72`、`planType === "plus"`
- `resetsAt` 从 unix 秒转 ISO 字符串

### TP-QUOTA-07：Codex fetcher 缺少 token

- 输入：`provider.authData.tokens.access_token` 为 undefined
- 期望：`status: "error"`，`hint` 提示 `codex login`

### TP-QUOTA-08：Codex fetcher 携带 ChatGPT-Account-Id

- 输入：`provider.authData.tokens.account_id` 存在
- 期望：请求 header 中包含 `ChatGPT-Account-Id`

### TP-QUOTA-09：dispatcher 路由

- 输入：不同 `provider.type`
- 期望：`tako` → tako fetcher、`claude-subscription` → claude fetcher、`codex-subscription` → codex fetcher、其他类型 → `status: "unsupported"`

### TP-QUOTA-10：dispatcher 缓存

- 输入：连续调用同一个 provider
- 期望：60 秒内只发起一次 fetch，第二次返回缓存结果（`fetchedAt` 不变）
- 60 秒后再次调用：重新 fetch

### TP-QUOTA-11：超时处理

- 输入：mock fetch 卡住 6 秒
- 期望：5 秒后超时，返回 `status: "error"` 含错误信息

### TP-QUOTA-12：tako quota stale apiId retry

- 输入：provider 同时有 `apiKey` 和 stale `apiId`；第一次 quota 查询返回 error；`get-key-id` 返回 fresh `apiId`
- 期望：调用顺序为 stale `apiId` → resolve provider `apiKey` → fresh `apiId`，最终返回 `status: "ok"`

### TP-QUOTA-13：tako quota 不混用 legacy credentials

- 输入：legacy 顶层有 `apiKey/apiId`，Tako provider 只有自己的 `apiKey`
- 期望：命令不请求 legacy `apiId`，而是用 provider `apiKey` 解析 fresh provider `apiId`
- 防护：避免显示旧账号 quota

### TP-QUOTA-14：短预算超时共享与错误落盘（statusline 防 SIGKILL 回归）

- 输入：向 `getOfficialQuota` / 各 fetcher 传入较短 `timeoutMs`（模拟 statusline 2.5s 预算）并让上游请求卡死
- 期望：
  - Tako 串联步骤（`get-key-id` → `user-quota` → `user-stats`）共享总预算，第一步耗尽后不发起后续请求
  - Claude / Codex fetcher 在 `timeoutMs` 内及时中止并返回 `status: "error"`，且 `skipCodexRpc` 透传
  - 超时结果落盘到 `quota-cache.json`，60 秒内下一次跨进程调用直接命中缓存不再卡死

## 运行方式

```bash
cd packages/cli
bun test tests/unit.quota.test.ts
bun test tests/unit.quota-command.test.ts
```

bun:test 单测，不需要真实网络。通过替换全局 `fetch` 为 mock 函数来注入响应。
