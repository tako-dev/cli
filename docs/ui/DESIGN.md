# UI 模块设计

## 概述

UI 模块提供 Tako 的交互式启动器。当前发布通道只使用 Ink 后端，入口为 `src/ui/index.ts`。
之前的 OpenTUI 后端已从发布构建中回滚，避免继续安装 `@opentui/core` 原生依赖和加载
OpenTUI 分发文件。

## 源文件

- `src/index.ts` - CLI 可执行入口，注册 signal/beforeExit handler 并启动 Ink UI
- `src/app.ts` - 命令分发、快捷启动、非 TTY 保护和交互式入口调度
- `src/ui/index.ts` - Ink 主循环，处理 launcher 结果和 Windows handoff
- `src/ui/ink/` - Ink 组件、视图和按键控制
- `src/ui/shared/` - UI 与 launcher 共用的数据加载、启动选项和终端 prompt
- `scripts/build.ts` - 单入口构建，生成 `dist/index.js`

## 核心逻辑

`src/index.ts` 导入 `runCliWithHandlers(main)`，由 `src/app.ts` 统一处理命令行参数。
当进入交互式模式时，`main()` 会先执行 provider 迁移、检测、模型目录刷新和公告检查，
再启动 Ink 单实例主循环。

Launcher 返回 `launch` 结果后，Ink 会先 unmount，再调用共享启动逻辑释放终端并启动真实
客户端。Windows wrapper 提供 `TAKO_WINDOWS_HANDOFF_FILE` 时，面板路径会写入 handoff
脚本并退出，让外层 shell 接管客户端进程，客户端退出后再回到 Tako 面板。

## 回滚边界

OpenTUI 回滚包含：

- 移除 `@opentui/core` optional dependency
- 移除 OpenTUI 入口和后端源码
- 构建产物恢复为单个 `dist/index.js`
- pre-release 检查不再要求 `index-opentui.js`
- 构建前清理 `dist`，防止旧 OpenTUI 分包文件残留进发布包

## 依赖

- `ink` / `@inkjs/ui` / `react` - 交互式 UI 渲染
- `src/launcher/index.ts` - 客户端启动
- `src/providers/index.ts` - provider 配置和迁移
- `src/terminal-control.ts` - 终端释放
- `src/windows-handoff.ts` - Windows handoff 脚本

## 已有测试

- `tests/pre-release.test.ts` - 构建产物、shebang、smoke test 和源码完整性
- `tests/unit.windows-handoff.test.ts` - Windows 面板 handoff
- `tests/unit.terminal-control.test.ts` - 启动外部客户端前的终端释放
- `tests/unit.terminal-prompt.test.ts` - TUI 退出后的直接按键 prompt
