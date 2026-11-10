# sessions 模块设计

## 概述

原生会话索引：扫描 Claude Code / Codex / Grok / Pi 的本地 transcript，统一成
`UnifiedSession`，供 `tako sessions` 搜索、预览和恢复。

## 源文件

- `src/sessions/index.ts` - 索引刷新入口
- `src/sessions/database.ts` - SQLite 索引（sessions / messages / source_files）
- `src/sessions/discovery.ts` - 各客户端 transcript 路径发现
- `src/sessions/adapters/*.ts` - Claude / Codex / Grok / Pi 解析
- `src/sessions/search.ts` - 关键词搜索
- `src/sessions/resume.ts` - 恢复参数与启动
- `src/sessions/cmd.ts` - `tako sessions` 命令

## 恢复流程

1. `prepareResume()` 检查 `sourcePath` 仍存在，优先用 transcript 里的原 cwd，
   不可用时回退到当前目录。
2. `resumeArgs()` 生成各客户端原生恢复参数：
   - Claude：`--resume <id>`
   - Codex：`resume <id> -C <cwd>`
   - Grok：`--resume <id>`
   - Pi：`--session <id>`
3. `launchClientUnified(..., { resume: true, resumeModelId: session.model })`：
   - 按项目历史补危险跳过 flag（Claude `--dangerously-skip-permissions`，
     Codex `--dangerously-bypass-approvals-and-sandbox`）
   - 按 `session.model` 恢复上下文窗口 env（`TAKO_MODEL_CONTEXT_WINDOW` /
     `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）

TUI 会话搜索和 `tako sessions resume` 都走这条路径。不要只传 args 而丢掉
`resume` / `resumeModelId`，否则恢复出来的 Claude 会回到 default 权限模式，
statusline 也会因为缺少窗口 env 回落到 models.dev。

## 依赖

- `src/launcher/` - 恢复时实际启动客户端
- `src/clients/` - 客户端注册和恢复参数
- `src/project-history.ts` - 项目历史里的启动选项

## 已有测试

- `tests/unit.session-resume.test.ts` - 各客户端恢复参数、cwd 回退
- `tests/unit.resume-launch-options.test.ts` - 危险 flag 继承、按模型恢复窗口 env
