# launcher 测试计划

## 已有覆盖

| 文件 | 内容 |
|---|---|
| `tests/unit.terminal-control.test.ts` | 释放 stdin、重置终端模式、二次 settle |
| `tests/unit.terminal-prompt.test.ts` | TUI 退出后直接按键 prompt 前重新接管 stdin |
| `tests/unit.windows-handoff.test.ts` | Windows handoff 脚本生成、quoting、env、relaunch、UTF-8 BOM |
| `tests/unit.windows-wrapper.test.ts` | cmd/ps1 wrapper 创建并执行 handoff 文件 |
| `tests/platform.windows.test.ts` | Windows 路径和可执行文件扩展兼容 |

## 场景

### TP-LAUNCH-01 终端释放

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-LAUNCH-01a | stdin 是 TTY 且支持 raw mode | 移除 listeners、关闭 raw mode、pause stdin |
| TP-LAUNCH-01b | stdout 是 TTY | 写入终端模式重置序列，包含 bracketed paste off 和显示光标 |
| TP-LAUNCH-01c | settle 过程 | 释放 stdin 和重置终端模式各执行两次 |

### TP-LAUNCH-02 Windows handoff 脚本

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-LAUNCH-02a | command、args、cwd、env 含空格/引号 | PowerShell 单引号正确转义 |
| TP-LAUNCH-02b | env 为空 | 不写 `$env:`，由父进程继承 |
| TP-LAUNCH-02c | relaunchCommand 存在 | 在 finally 中先删除临时脚本，再重开 Tako |
| TP-LAUNCH-02d | 中文路径 | UTF-8 BOM 编码，PowerShell 5.1 不乱码 |
| TP-LAUNCH-02e | Windows console encoding | 设置 InputEncoding/OutputEncoding 为 UTF-8 |

### TP-LAUNCH-03 Windows wrapper

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-LAUNCH-03a | cmd wrapper | 设置 `TAKO_WINDOWS_HANDOFF_FILE`，Bun 退出后若文件存在则执行它 |
| TP-LAUNCH-03b | ps1 wrapper | 设置 handoff 文件并保留普通退出码 |

### TP-LAUNCH-04 平台兼容

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-LAUNCH-04a | Windows executable | 优先使用 `.exe`，其次 `.cmd` |
| TP-LAUNCH-04b | 跨平台路径 | Tako 目录和 Bun 路径始终是绝对路径 |

### TP-LAUNCH-05 终端 prompt

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-LAUNCH-05a | TUI teardown 后进入 confirm/pause prompt | prompt 前 ref stdin、移除旧 listeners、关闭 raw mode、pause |
| TP-LAUNCH-05b | cleanup 延迟后 | 再执行一次 stdin reclaim，防止旧 TUI cleanup 重新占用 |

## 运行方式

```bash
cd packages/cli

# launcher 相关快速回归
bun test tests/unit.terminal-control.test.ts tests/unit.terminal-prompt.test.ts tests/unit.windows-handoff.test.ts tests/unit.windows-wrapper.test.ts tests/platform.windows.test.ts

# 发版前总 gate
bun run build
bun test tests/pre-release.test.ts
```
