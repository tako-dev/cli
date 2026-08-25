# installer 模块设计

## 概述

`installer.ts` 负责把各 AI 编码工具（Claude Code、Codex 等）安装到 **tako 隔离目录**
`~/.tako/tools/<id>/`，与系统全局安装隔离。同时管理 tako 专属 Bun 运行时
（`~/.tako/bun`），保证不依赖系统 Node/Bun。

核心职责：

- 安装 / 升级 tako 专属 Bun（国内走 npmmirror，海外走官方脚本）
- 安装 / 更新 client 包（`bun add <pkg>@latest` 到隔离目录）
- 按用户指定版本切换 client 包（`tako install <client> <version>`）
- 确保平台原生二进制就位（Bun 不自动装 optionalDependencies）
- 检测"已安装 / 需更新"状态，驱动启动前的 ensure 流程

## 源文件

- `src/installer.ts` — 主逻辑
- `src/installer-versions.ts` — 版本相关
- `src/clients/base.ts` — `getClientDir` / `getClientEntryPath`（路径解析）

## 核心逻辑

### 安装状态判定（INV-INST-01）

- `isPackageInstalledAt(clientDir, packageName)` — 纯函数，判定依据是真正的包入口
  `node_modules/<package>/package.json` 是否存在。
- `isClientInstalled(client)` — 包装上者，clientDir 取 `getClientDir(client.id)`。

**为什么不看 `<clientDir>/package.json`**：那是 `installClient` 在 `bun add` 之前
写的占位文件，存在 ≠ 包装好了。见下方事故。

### cache 隔离（INV-INST-02）

- `buildBunInstallEnv(registry)` — 构造 bun 安装 env，注入独立
  `BUN_INSTALL_CACHE_DIR = ~/.tako/bun/install-cache`。
- tako 所有 `bun add`（installClient 主安装、ensurePlatformDep 平台包）都用它。
- 与全局 `~/.bun/install/cache` 隔离，全局 bun 卸载 / `bun pm cache rm` 不再波及
  tako 隔离目录的 node_modules。

### 安装流程 `installClient`

1. 确保 Bun 已装
2. 写占位 `<clientDir>/package.json`（若不存在）
3. **若 isInstalled（更新路径）**：只删 lockfile，**保留 node_modules**（INV-INST-03）
4. `bun add <pkg>@latest`（cwd=clientDir，env 经 `buildBunInstallEnv` 注入 registry+cache）
5. **失败处理（INV-INST-03）**：全新安装失败清掉占位 package.json；更新失败保留旧
   node_modules（工具仍可用）
6. `ensurePlatformDep` + `placeNativeBinary` 补原生二进制
7. 写 `installedClients[id].version` 到 config

### 指定版本安装 `installAtVersion`

`installer-versions.ts` 的 `installAtVersion(client, version)` 和普通更新路径共享同一套
Bun 运行时、registry 和 cache 隔离配置。它只删除 lockfile，保留 `node_modules`，避免
指定版本安装失败后旧版本也不可用。安装成功后会调用
`ensureNativeBinary(client, { reinstallOnFailure: false, forcePlace: true })`，强制重新放置
平台原生二进制，避免 package.json 已切到新版本但旧 `claude.exe` 仍留在 bin 路径。

### Bun 输出流

所有 `bun add/update` 的 pipe 模式输出都通过 `streamBunInstall()` 同时 drain stderr 和
stdout。这样既能刷新 spinner 阶段，也能避免 Windows 下 stdout/stderr pipe buffer 塞满后
子进程卡住。

### 启动前 ensure `ensureClientReady`

- 未安装 → `installClient`
- 已安装 → `ensureNativeBinary`（修 stub 二进制）+ 检查更新（节流：一天一次弹窗）

## 已知事故与不变量

### 2026-06-15：codex/claude-code 启动 fallback 到全局安装

**现象**：启动 codex 报 ENOENT（全局 codex 二进制损坏）。

**根因（三层叠加）**：
- A. 假隔离：`bun add` 未设独立 `BUN_INSTALL_CACHE_DIR`，与全局 cache 共享。
- B. 更新非原子：先删 node_modules 再 `bun add`，失败即留半残状态。
- C. 误判：旧 `isClientInstalled` 只看占位 package.json，半残状态被判"已装"，
  永不重装 → 启动时 `launcher-legacy.ts` fallback 到全局 `which <cmd>`。

**已修**：
- 缺陷 C — `isClientInstalled` 改为检查真正的包入口（INV-INST-01）。
- 缺陷 A — `bun add` 注入独立 `BUN_INSTALL_CACHE_DIR`（INV-INST-02）。
- 缺陷 B — 更新不再删 node_modules、失败不留半残状态（INV-INST-03）。

## 依赖

- `region.ts` — registry / 镜像选择
- `bun-progress.ts` — 安装进度流式解析
- `config.ts` — `TOOLS_DIR` / `TAKO_BUN_DIR` / `installedClients`
- `clients/base.ts` — 路径解析与安全检查

## 已有测试

- `tests/unit.installer-detection.test.ts` — INV-INST-01 安装状态判定
- `tests/unit.update-logic.test.ts` — 更新命令构造（路径、无 -g、--latest）
- `tests/unit.entry-resolution.test.ts` — bin 字段解析
- `tests/unit.bun-progress.test.ts` — Bun stdout/stderr 同时 drain
