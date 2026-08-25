---
name: models
description: 模型目录模块——动态获取并缓存全网主流大模型的元数据（上下文窗口、显示名等）
type: module
---

# Models 模块设计

## 背景

旧实现 `statusline/segments/context.ts` 把 Claude 系列模型的上下文窗口硬编码在 `CONTEXT_LIMITS` 表里，新模型出现时要改代码。这次扩展到 GPT、Gemini、DeepSeek 等所有提供商，硬表难维护。

抽出独立的 **models 模块**，从 [models.dev](https://models.dev) 拉取全网模型目录（已包含 Anthropic / OpenAI / Google / xAI / DeepSeek / 月之暗面 等），按需查询。

## 数据源

**models.dev** ([sst/models.dev](https://github.com/sst/models.dev)) — 单一 endpoint，`GET https://models.dev/api.json`，返回 ~250+ 模型。

返回结构：

```json
{
  "<provider_id>": {
    "id": "anthropic",
    "name": "Anthropic",
    "models": {
      "claude-haiku-4-5": {
        "id": "claude-haiku-4-5",
        "name": "claude-haiku-4-5",
        "limit": { "context": 200000, "output": 64000 },
        "cost": { "input": 1, "output": 5 },
        "modalities": { "input": [...], "output": [...] },
        "attachment": true,
        "reasoning": true,
        "tool_call": true
      }
    }
  }
}
```

我们关心 `models[*].limit.context`，归一化到一张扁平 `Map<modelId, ModelEntry>`。

## 1M context beta 处理

models.dev **不**包含 `claude-sonnet-4-5:1m` 这种变体条目；Claude Code 启用 1M beta 时，传给 statusline 的 `model.id` 是 `claude-sonnet-4-5[1m]` 形式（方括号后缀）。

策略：**查询时识别 `[1m]` 后缀**，命中即覆盖到 1_000_000，不查表。所以模块对 1M 变体是"规则覆盖"而非"数据驱动"。

## 源文件结构

```
packages/cli/src/models/
├── types.ts                ModelEntry 类型
├── catalog.ts              对外 API：getModelEntry / refreshCatalog / loadCatalog
├── source.ts               拉取 models.dev + 解析归一化
├── bundled.ts              构建期生成的初始快照（fallback）
└── tako.ts                 par 实例的动态模型目录（Claude Code / Codex 下拉用）
```

## 核心类型

```ts
export interface ModelEntry {
  id: string;             // "claude-haiku-4-5"
  displayName: string;    // 来自 models.dev 的 name
  provider: string;       // "anthropic" / "openai" / "google" 等
  contextWindow: number;  // limit.context
  outputLimit?: number;   // limit.output
}
```

## 对外 API

```ts
/**
 * 同步查询单个模型条目。
 * 自动处理 [1m] / :1m 等变体后缀。
 * 找不到返回 undefined（调用方自行兜底）。
 */
export function getModelEntry(modelId: string): ModelEntry | undefined;

/**
 * 加载内存目录：
 *   1. 内存命中 → 直接返回
 *   2. 否则读 ~/.tako/models-cache.json（24h 内有效）
 *   3. 否则用 bundled snapshot
 *   始终非阻塞、不抛错。
 */
export function loadCatalog(): void;

/**
 * 异步从 models.dev 拉新快照，更新内存 + 磁盘缓存。
 * 失败静默（保留旧数据）。CLI 启动时 fire-and-forget 调一次。
 */
export async function refreshCatalog(): Promise<void>;
```

## 缓存策略

- **内存**：`Map<modelId, ModelEntry>`，模块单例，进程生命周期
- **磁盘**：`~/.tako/models-cache.json`，含 `{ fetchedAt, entries: ModelEntry[] }`
- **TTL**：24 小时。`loadCatalog()` 检查 ttl，过期则忽略磁盘缓存（让下次 `refreshCatalog()` 写新的）
- **首次启动**：内存为空 → `loadCatalog()` 试磁盘 → 试 bundled → 仍为空就给个空 Map（getModelEntry 返回 undefined，调用方 fallback）
- **统一规则**：所有失败路径都不抛错，调用方永远拿到一个能用的 catalog（哪怕是空的）

## ID 归一化

models.dev 的 model.id 不带前缀（如 `claude-haiku-4-5`），跟 Claude Code 传给 statusline 的形式一致。但 Codex/OpenRouter 等场景可能传 `anthropic/claude-haiku-4-5`，需归一化：

```ts
function normalize(modelId: string): { lookupId: string; is1m: boolean } {
  // 1. 去 [1m] / :1m 后缀（变体）
  const m1 = modelId.match(/^(.+?)(?:\[1m\]|:1m)$/i);
  const stripped = m1 ? m1[1] : modelId;
  // 2. 去 provider 前缀（"anthropic/xxx" → "xxx"）
  const m2 = stripped.match(/^[^\/]+\/(.+)$/);
  return { lookupId: m2 ? m2[1] : stripped, is1m: !!m1 };
}
```

## Bundled 快照生成

`bundled.ts` 由脚本 `scripts/build-models-bundle.ts` 在构建期或本地生成：

```bash
bun scripts/build-models-bundle.ts
```

脚本拉一次 models.dev → 提取核心字段 → 生成 `src/models/bundled.ts`：

```ts
// 自动生成，请勿手改
export const BUNDLED_AT = "2026-04-26T00:00:00Z";
export const BUNDLED_ENTRIES: ModelEntry[] = [
  { id: "claude-haiku-4-5", displayName: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200000 },
  ...
];
```

第一版我们先**手动跑一次**生成快照，CI/release 流程接入留作后续。

## par 动态模型目录（tako.ts）

`catalog.ts` 走的是 models.dev（全网静态目录，查上下文窗口）。`tako.ts` 走的是**当前 par 实例**真实暴露的模型列表，给 Claude Code / Codex 的模型下拉用——比客户端写死的 whitelist 准，且支持任意自定义 par 部署。

**请求**：`GET {baseUrl}/v1/models?client_version=tako-cli&api_type={claude|openai}`。`client_version` 让 par 走 **Codex 形态**返回（唯一带 `context_window` 的形态），`api_type` 过滤客户端能用的子集。

**缓存**：内存索引按 `baseUrl#apiType` 分桶 + 磁盘缓存 `~/.tako/tako-models-cache.json` + 1h TTL 后台刷新。失败静默保留旧数据。

**核心类型**：

```ts
export interface TakoModelEntry {
  id: string;
  displayName: string;
  description: string;
  contextWindow: number;
  sortOrder: number;
  category: string;   // 'chat' | 'image' | 'video' | 'audio' | … 来自 par 的 model_category
}
```

**非 chat 模型过滤**：par 给每个模型标 `model_category`（chat/image/video/audio）。纯生图/视频/音频模型不能在 Claude Code / Codex 里跑 chat，`filterChatModels()` 在 `buildDynamicClaudeModels` / `buildDynamicCodexModels` 里把它们剔除。`category` 缺省（旧 par / 旧缓存）按 `'chat'` 放行——向后兼容。

**对外 API**：`getTakoModels(baseUrl, apiType)` 同步读缓存；`refreshTakoModels` / `refreshAllTakoCatalogs` 异步刷新；`filterChatModels` 过滤非 chat；`parseCodexResponse` 解析 par 响应（导出供测试）。

## 不做的事

- **不引入 LiteLLM**：models.dev 已覆盖 1M base 模型，1M 变体由 `[1m]` 规则处理，不需要第二个数据源
- **不做 OpenRouter 兜底**：第一版只用 models.dev，失败时直接用 bundled
- **不缓存 cost / 模态等额外字段**：第一版只关心 `contextWindow`，省 cache 体积；将来加字段时往 `ModelEntry` 加属性即可

## 已有测试

- `tests/unit.models.test.ts` — `normalizeModelId`（`[1m]`/`:1m` 后缀、provider 前缀）
- `tests/unit.dynamic-model-options.test.ts` — par 动态目录：chat 模型按序进下拉、非 chat（image/video/audio）被 `filterChatModels` 剔除、`parseCodexResponse` 读 `model_category` 且缺省归一化为 `'chat'`
