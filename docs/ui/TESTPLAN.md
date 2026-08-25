# UI 测试计划

## 已有覆盖

| 文件 | 内容 |
|---|---|
| `tests/pre-release.test.ts` | 构建产物存在、单入口大小、OpenTUI 依赖不进入发布入口、smoke test |
| `tests/unit.windows-handoff.test.ts` | Windows handoff 脚本生成和重开 Tako |
| `tests/unit.terminal-control.test.ts` | 释放 stdin、重置终端模式、二次 settle |
| `tests/unit.terminal-prompt.test.ts` | TUI 退出后直接按键 prompt 前重新接管 stdin |

## 场景

### TP-UI-01 发布入口

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-UI-01a | 构建发布包 | 只生成 `dist/index.js` 作为 CLI 入口 |
| TP-UI-01b | 旧分包残留 | `dist/index-ink.js` 和 `dist/index-opentui.js` 不存在 |
| TP-UI-01c | 入口内容检查 | `dist/index.js` 不包含 `@opentui/core` 或 `index-opentui` |
| TP-UI-01d | smoke test | `bun dist/index.js --version` 正常退出并输出版本 |

### TP-UI-02 交互式启动

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-UI-02a | 非 TTY 启动 | 打印安装成功提示，不进入 Ink raw mode |
| TP-UI-02b | TTY 启动 | 进入 Ink 单实例主循环 |
| TP-UI-02c | Launcher 启动客户端 | Ink 退出后释放终端，再启动客户端 |

### TP-UI-03 Windows handoff

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-UI-03a | wrapper 提供 handoff 文件 | 写入 handoff 脚本后 CLI 退出 |
| TP-UI-03b | 客户端退出 | handoff 脚本重新启动 Tako 面板 |

## 运行方式

```bash
cd packages/cli

bun run build
bun test tests/pre-release.test.ts
bun test tests/unit.terminal-control.test.ts tests/unit.terminal-prompt.test.ts tests/unit.windows-handoff.test.ts
```
