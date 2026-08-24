# installer 测试计划

## 已有覆盖

| 文件 | 内容 |
|---|---|
| `tests/unit.installer-detection.test.ts` | 安装状态判定（INV-INST-01）+ cache 隔离（INV-INST-02） |
| `tests/unit.pi-install.test.ts` | Pi / Pi Web 跨 OS 安装与启动合约（darwin / linux / win32） |
| `tests/unit.update-logic.test.ts` | 更新命令构造（路径在 tako 目录、无 -g、含 --latest） |
| `tests/unit.entry-resolution.test.ts` | bin 字段解析（对象/字符串/多命令/缺失） |
| `tests/unit.bun-progress.test.ts` | Bun install/update stdout+stderr drain 和 spinner 阶段 |

## 场景

### TP-INST-01 安装状态判定（`isPackageInstalledAt`）

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-INST-01a | 空目录 | 未安装（false） |
| TP-INST-01b | 只有占位 package.json，无 node_modules（2026-06-15 事故现场） | 未安装（false） |
| TP-INST-01c | `node_modules/<pkg>/package.json` 存在 | 已安装（true） |
| TP-INST-01d | node_modules 存在但目标包缺失 | 未安装（false） |

不变量 INV-INST-01：判定"已安装"看真正的包入口，不看占位 package.json。

### TP-INST-02 cache 隔离（`buildBunInstallEnv`）

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-INST-02a | 构造 env | 注入 `BUN_INSTALL_CACHE_DIR` = tako 专属 cache |
| TP-INST-02b | cache 路径 | 在 `.tako` 下，不含 `.bun/install/cache` |
| TP-INST-02c | registry | 透传到 `BUN_CONFIG_REGISTRY` |

不变量 INV-INST-02：tako 安装用独立 cache，与全局 bun store 隔离。

### TP-INST-03 失败不留半残状态（合约，代码审查保证）

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-INST-03a | 更新路径只删 lockfile，不删 node_modules | bun add 失败旧版本仍可用 |
| TP-INST-03b | 全新安装失败 | 清掉占位 package.json，目录回到未初始化 |

不变量 INV-INST-03：任何安装失败都不留"占位文件在 + node_modules 缺"的半残态。
注：依赖真实 bun 安装失败，难以纯单测，靠流程注释 + 与 INV-INST-01 配合（半残态被
判未安装会重装）兜底。

### TP-INST-04 Bun 输出流（`streamBunInstall`）

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-INST-04a | stderr 输出 resolving / lockfile | 输出被完整收集，spinner 阶段更新 |
| TP-INST-04b | stdout 输出 downloaded / installed | stdout 同样被 drain，避免 pipe buffer 卡住 |

### TP-INST-05 指定版本安装（`installAtVersion`）

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-INST-05a | 切换指定版本 | 使用 Tako Bun + 隔离 cache 执行 `bun add <pkg>@<version>` |
| TP-INST-05b | 切换失败 | 保留旧 `node_modules`，不删除可用旧版本 |
| TP-INST-05c | 切换成功后原生二进制 | 强制重新放置平台二进制，避免旧 exe 残留 |

### TP-INST-E2E 端到端（真实安装，CI nightly + release）

驱动脚本：`tests/e2e/installer-driver.ts`
GHA workflow：`.github/workflows/installer-e2e.yml`（Ubuntu / macOS / Windows × Codex / Pi / Pi Web）

`TAKO_E2E_CLIENT=codex|pi|pi-web` 选择客户端。Pi Web 会先装 Pi。

| 编号 | 场景 | 验证 | 不变量 |
|---|---|---|---|
| TP-INST-E2E-00b | Pi / Pi Web 先装 Tako Node | `~/.tako/node` 为 Node 22.22；国内 `cdn.npmmirror.com`，海外 `nodejs.org/dist` | — |
| TP-INST-E2E-01 | 全新安装 | Codex：原生二进制 >1MB；Pi / Pi Web：JS 入口存在 | — |
| TP-INST-E2E-02 | cache 隔离 | `$TAKO_HOME/bun/install-cache` 有内容 | INV-INST-02 |
| TP-INST-E2E-03 | 重复 ensure 幂等 | 第二次不报错、入口仍在 | — |
| TP-INST-E2E-04 | 半残自愈（事故复现） | rm node_modules → isClientInstalled=false → 重装成功 | INV-INST-01 |
| TP-INST-E2E-05 | 更新保留 node_modules | force update 后 node_modules 目录未重建 | INV-INST-03 |
| TP-INST-E2E-06 | installAtVersion 指定版本 | 重装同版本成功 | — |
| TP-INST-E2E-07 | launcher spawn | Codex/Pi `--version` 自行退出；输出匹配即过，Windows 上 `exit=null` 不算失败。Pi Web `--no-open` 等到 Ready 后杀进程 | — |
| TP-INST-E2E-08 | provider config 写入 | 仅 Codex 写 `~/.codex/config.toml`；Pi 不改用户机 settings | — |
| TP-INST-E2E-09 | PowerShell 7+ 可用 | Windows only | — |

## 运行方式

```bash
cd packages/cli

# 单测（快，秒级）
bun test tests/unit.installer-detection.test.ts
bun test tests/unit.*.test.ts

# e2e（慢，装真实 client，本地手动跑）
bun run test:e2e-installer
bun run test:e2e-installer:pi
bun run test:e2e-installer:pi-web

# CI 触发（GitHub Actions → workflow_dispatch 或 nightly schedule）
gh workflow run installer-e2e.yml --repo tako-dev/cli
```
