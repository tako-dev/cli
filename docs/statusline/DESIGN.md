# statusline 模块设计

## 概述

Tako 把 `tako statusline` 注入 Claude Code 的 `settings.json`。Claude Code 每次刷新
状态栏时通过 stdin 传一份 JSON，Tako 渲染成单行：目录、git、模型、上下文、额度。

`⚡%` 不是 Claude Code 的 `used_percentage`，而是「距离自动压缩还剩多少」。
0% 对齐 Claude Code 的 compaction 触发点，不是模型物理上下文上限。

## 源文件

- `src/statusline/index.ts` - segment 注册和命令入口
- `src/statusline/inject.ts` - 注入/移除 Claude Code `statusLine` 配置
- `src/statusline/renderer.ts` - 单行拼接
- `src/statusline/segments/context.ts` - 上下文窗口和压缩阈值
- `src/statusline/segments/{directory,git,model,quota}.ts` - 其它 segment
- `src/statusline/types.ts` - Claude Code stdin 数据结构

## Claude Code 输入

`context_window` 里已经包含：

- `context_window_size`：当前模型的实际窗口（Claude Code 解析后的值）
- `current_usage`：最近一次 API 调用的 input / cache 读写 token
- `used_percentage` / `remaining_percentage`：Claude Code 自己按窗口算好的百分比

旧版本 Claude Code 可能没有 `context_window`，此时才回落到 transcript 解析。

## 上下文百分比

窗口优先级：

1. `context_window.context_window_size`
2. `TAKO_MODEL_CONTEXT_WINDOW`（Tako 启动 env）
3. models.dev / bundled catalog
4. 200K

自动压缩窗口再被 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 夹一次（取较小值），与 Claude
Code 的 `jb()` 行为一致。

阈值对齐 Claude Code 2.1.x：

```
threshold = window - min(maxOutputTokens, 20000) - 13000
```

statusline input 不带 `maxOutputTokens`，默认按 20000 上限算。

⚠️ 不要用 `min(usable - 20%, usable - 13000)`：那是 Claude Code 的
**precompute** 阈值（提前预计算摘要），不是真正触发 compaction 的阈值。旧实现
抄错后，1M 窗口会在约 793K 就显示 0%，而 Claude Code 实际到 967K 才压缩。

## 依赖

- `src/models/` - models.dev / bundled 模型目录
- `src/quota/` - 额度 segment 的缓存

## 已有测试

- `tests/unit.statusline-context.test.ts` - 窗口优先级、压缩阈值、剩余百分比
