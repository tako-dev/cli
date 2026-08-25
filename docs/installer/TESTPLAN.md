# installer 测试计划

## 已有覆盖

| 文件 | 内容 |
|---|---|
| `tests/unit.installer-detection.test.ts` | 安装状态判定（INV-INST-01）+ cache 隔离（INV-INST-02） |
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

### TP-INST-E2E 端到端（真实 codex 安装，CI nightly）

驱动脚本：`tests/e2e/installer-driver.ts`
GHA workflow：`.github/workflows/cli-installer-e2e.yml`（Linux + Windows 并行）

| 编号 | 场景 | 验证 | 不变量 |
|---|---|---|---|
| TP-INST-E2E-01 | 全新安装 codex | node_modules 包入口存在；平台二进制 >1MB | — |
| TP-INST-E2E-02 | cache 隔离 | `$TAKO_HOME/bun/install-cache` 有内容 | INV-INST-02 |
| TP-INST-E2E-03 | 重复 ensure 幂等 | 第二次不报错、二进制仍在 | — |
| TP-INST-E2E-04 | 半残自愈（事故复现） | rm node_modules → isClientInstalled=false → 重装成功 | INV-INST-01 |
| TP-INST-E2E-05 | 更新保留 node_modules | force update 后 node_modules 目录未重建 | INV-INST-03 |

## 运行方式

```bash
cd packages/cli

# 单测（快，秒级）
bun test tests/unit.installer-detection.test.ts
bun test tests/unit.*.test.ts

# e2e（慢，装真实 codex ~200MB，本地手动跑）
bun run test:e2e-installer

# CI 触发（GitHub Actions → workflow_dispatch 或 nightly schedule）
gh workflow run cli-installer-e2e.yml
```
