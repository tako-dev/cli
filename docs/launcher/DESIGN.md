# launcher 模块设计

## 概述

launcher 负责把 Tako 面板、快捷启动参数、Provider 配置和真实客户端进程串起来。
它的关键边界不是业务选择，而是终端所有权交接：启动 Claude Code、Codex 等交互式
TUI 前，父进程必须释放 stdin 和终端模式，避免子进程渲染出来但收不到键盘输入。

## 源文件

- `src/launcher/index.ts` - 统一入口，负责安装检查、Provider 解析、启动参数准备
- `src/launcher-legacy.ts` - 真实进程启动和平台分支
- `src/terminal-control.ts` - 启动外部交互式子进程前的终端释放
- `src/ui/shared/terminal.ts` - TUI 退出后的直接按键 prompt
- `src/windows-handoff.ts` - Windows handoff PowerShell 脚本生成
- `src/windows-wrapper.ts` - Windows cmd/ps1 wrapper 生成

## 核心流程

### 统一入口

`launchClientUnified` 先校验项目目录、调用 `ensureClientReady`，再解析 Provider 并让
client 写入必要配置文件。最终它把合并后的 args/env/providerContext 传给
`launcher-legacy.ts` 的 `launchClient`。

### Claude Code 启动配置覆盖

Claude Code 的用户 `settings.json` 可能写死 Provider 环境变量。launcher 不修改用户文件，
也不禁用 `user` setting source；Claude adapter 为每次启动生成只包含认证、Base URL 和所选
模型的最小 `--settings` overlay。这样命令行层只覆盖 Tako 拥有的字段，用户 skills/plugins
仍会加载，project/local 配置也不会被整份用户配置反向覆盖。

overlay 文件按 launch 唯一命名并限制访问权限。Unix 和直接启动路径在客户端退出后删除；
Windows wrapper handoff 把清理责任转交给 PowerShell 脚本，在 `finally` 中删除，避免并发
启动互相覆盖或凭据文件残留。

### Unix/macOS 直接启动

非 Windows 平台在启动前调用 `settleTerminalForExternalChild()`：

1. 移除父进程 stdin listeners
2. 关闭 raw mode
3. pause stdin
4. 重置鼠标、bracketed paste、alternate screen、颜色和光标显示
5. 延迟后重复释放一次，处理 prompt/TUI cleanup 重新占用 stdin 的情况

随后用 `Bun.spawnSync(..., stdio: "inherit")` 让客户端独占终端。

### Windows handoff

Windows 下 Bun 直接作为父进程启动交互式 TUI 时，子进程可能能渲染但无法稳定接收键盘。
因此支持两类 handoff：

- quick-launch：写入 wrapper 指定的 `TAKO_WINDOWS_HANDOFF_FILE` 后退出，外层 wrapper
  在 Bun 退出后执行 PowerShell 脚本启动客户端。
- 面板路径：同样写入 handoff 脚本，但脚本在客户端退出后再执行 `tako.cmd`，让用户回到
  Tako 面板。

写 handoff 脚本前同样调用 `settleTerminalForExternalChild()`，保证 wrapper 接手时终端
已从当前 TUI 状态恢复。handoff 脚本用 UTF-8 BOM 写入，兼容 Windows PowerShell 5.1
读取中文路径，并显式设置 Console input/output encoding 为 UTF-8，避免中文路径和输出
在 Windows 控制台里乱码。

### 终端 prompt

更新确认、公告暂停等直接读取按键的 prompt 走 `readTerminalKey`。在挂载 `data`
listener 前先调用 `settleStdinForTerminalPrompt()`，执行 ref、移除旧 listeners、关闭 raw mode、
pause，并在短延迟后重复一次。这样可以在 TUI teardown 后重新接管 stdin，避免 Windows 上
Claude 更新确认 prompt 显示出来但按键无响应。

## 依赖

- `installer.ts` - 启动前安装/更新客户端
- `providers/index.ts` - Provider 选择与上下文解析
- `clients/base.ts` - client entry/bin 路径解析
- `config.ts` - Tako 目录和已安装客户端信息
- `project-history.ts` - 项目历史与启动记录

## 已有测试

- `tests/unit.terminal-control.test.ts` - stdin/终端模式释放
- `tests/unit.terminal-prompt.test.ts` - 直接按键 prompt 前的 stdin reclaim
- `tests/unit.windows-handoff.test.ts` - handoff 脚本 quoting、env、relaunch、UTF-8 BOM
- `tests/unit.windows-wrapper.test.ts` - Windows wrapper handoff 文件路径和执行逻辑
- `tests/platform.windows.test.ts` - Windows 路径和可执行文件扩展兼容
- `tests/unit.claude-settings.test.ts` - Claude 最小 overlay、冲突字段与 setting source 保留
