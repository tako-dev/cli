# statusline 测试计划

## 已有覆盖

`tests/unit.statusline-context.test.ts`

| 编号 | 场景 | 断言 |
|---|---|---|
| TP-CTX-01 | 启动 env 优先于 catalog | `resolveContextLimit("claude-opus-4-8[1m]", "950000") === 950000` |
| TP-CTX-02 | 非法 env 回落 catalog | `"0"` / `"not-a-number"` → 200000 |
| TP-CTX-03 | 未知模型回落 200K | 空 env + 未知 id → 200000 |
| TP-CTX-04 | 优先用 statusline input 的 `context_window_size` | input 1M + env 262K → 1M |
| TP-CTX-05 | 没有 `context_window_size` 才用启动 env | 空 input + env 262K → 262K |
| TP-CTX-06 | 没有 input/env 才用 catalog | 空 input + 空 env → 200K |
| TP-CTX-07 | 自动压缩窗口取 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 较小值 | 1M 窗口 + 450K env → 450K |
| TP-CTX-08 | 对齐 Claude Code compaction 阈值 | 950K→917K；272K→239K；1M→967K；272K/8192→250808 |
| TP-CTX-09 | usage 不含 output tokens | input + cache 读写，不含 output |
| TP-CTX-10 | 无 current_usage 返回 null | `current_usage: null` → null |
| TP-CTX-11 | 渲染剩余百分比 | 1M/109,809 tokens → 89% |
| TP-CTX-12 | 阈值前不显示 0% | threshold-1 → 1% |
| TP-CTX-13 | 阈值处显示 0% | threshold → 0% |

## 不变量

- INV-CTX-01：窗口优先级固定为 `context_window_size` → `TAKO_MODEL_CONTEXT_WINDOW` → catalog → 200K。
- INV-CTX-02：压缩阈值只减 `min(maxOutputTokens, 20000) + 13000`，不再乘 20% precompute buffer。
- INV-CTX-03：`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 只允许把窗口调低，不能调高。

## 运行

```bash
bun test tests/unit.statusline-context.test.ts
```
