# 发布测试计划

## 测试层级

| 层 | 文件 | 触发时机 | 耗时 |
|---|---|---|---|
| 单测 | `tests/unit.*.test.ts` | 每次 PR / push `main` | < 5s |
| Platform | `tests/platform.*.test.ts` | 每次 PR / push `main`（三平台） | < 2s |
| Pre-release | `tests/pre-release.test.ts` | PR Ubuntu + release | < 5s |
| Smoke test | ci.yml / release.yml “Smoke test built bundle” | PR Ubuntu + release | < 1s |
| e2e (三平台 × 三客户端) | `tests/e2e/installer-driver.ts` | nightly + release | 1-5 min |

## TP-REL: Pre-release checks（32 个断言）

运行：`bun test tests/pre-release.test.ts`（需先 `bun run build`）

| 编号 | 场景 | 验证 |
|---|---|---|
| TP-REL-01 | package.json 合法 | 存在 + JSON 可解析 |
| TP-REL-02 | 构建产物存在 | dist/index.js 存在 |
| TP-REL-03 | Shebang | dist/index.js 以 `#!/usr/bin/env bun` 开头 |
| TP-REL-04 | install.sh / install.ps1 存在 | 安装脚本就位 |
| TP-REL-05 | 构建大小合理 | 1KB < size < 1.5MB |
| TP-REL-06 | **Bundle smoke test** | `bun dist/index.js --version` exit 0 + 输出含 "Tako CLI" |

## TP-INST-E2E: 三平台 × 三客户端 e2e

运行：`bun run test:e2e-installer`（Codex）/ `bun run test:e2e-installer:pi` / `bun run test:e2e-installer:pi-web`

GHA：`.github/workflows/installer-e2e.yml`（nightly / 手动）和 `release.yml`（发版 gate）

| 编号 | 场景 | 不变量 |
|---|---|---|
| TP-INST-E2E-00 | Pi Web 先装 Pi | — |
| TP-INST-E2E-01 | 全新安装 Codex / Pi / Pi Web | 包入口 + Codex 原生二进制 >1MB |
| TP-INST-E2E-02 | cache 隔离 | INV-INST-02 |
| TP-INST-E2E-03 | 重复 ensure 幂等 | — |
| TP-INST-E2E-04 | 半残自愈 | INV-INST-01 |
| TP-INST-E2E-05 | 更新保留 node_modules | INV-INST-03 |
| TP-INST-E2E-06 | installAtVersion 指定版本 | — |
| TP-INST-E2E-07 | launcher spawn | Codex/Pi `--version`；Pi Web `--help` |
| TP-INST-E2E-08 | provider config 写入 | 仅 Codex |
| TP-INST-E2E-09 | PowerShell 7+ 可用 (Windows only) | — |

## TP-SMOKE: Bundle 启动验证

CI 中 release.yml Build 步骤后执行：

```bash
OUTPUT=$(bun dist/index.js --version)
echo "$OUTPUT" | grep -q "Tako CLI" || exit 1
```

防止 v0.3.2 类事故（构建成功但运行时缺模块）。

## 发布前必须通过的 gate

| Gate | 位置 | 阻断条件 |
|---|---|---|
| unit + platform | ci.yml（PR / push main，三平台） | 任一平台 FAIL |
| Build + smoke + pre-release | ci.yml Ubuntu | 构建失败 / bundle 无法启动 / 断言失败 |
| e2e 三平台 × 三客户端 | release.yml → e2e job | 任一组合 FAIL → publish 不执行 |
| Build / smoke / unit / pre-release | release.yml → publish job | 任一失败 → 阻断 |
| npm publish | release.yml → publish job | OIDC/registry/npm CLI 问题 → 阻断 |

## TP-REL-SCRIPT：release script 版本展开

`package.json` 的 `release` / `release:minor` 依赖 shell 内联命令读取版本：

```bash
node -p 'require("./package.json").version'
```

发版脚本变更后必须验证：

```bash
node -p "require('./package.json').scripts.release"
node -p "require('./package.json').scripts['release:minor']"
node -p 'require("./package.json").version'
```

实际展开的 script 中不应出现传给 Node 的 `require(\"./package.json\")`。

## TP-REL-PUBLISH：npm provenance 发布 CLI

release workflow 必须使用固定 npm 发布 CLI：

```bash
npx -y npm@11.5.1 --version
npx -y npm@11.5.1 publish --provenance --access public
```

不要用 `npm install -g npm@latest` 覆盖 runner 全局 npm，避免 npm CLI 依赖树漂移导致
`sigstore` 等 provenance 依赖缺失。

## 运行方式

```bash
cd packages/cli

# 本地验证（快速）
bun run build && bun test tests/pre-release.test.ts

# 本地 e2e（慢，装真实 codex）
bun run test:e2e-installer

# 触发 CI e2e（不发版）
gh workflow run installer-e2e.yml --repo tako-dev/cli

# 发版（自动触发全部 gate）
bun run release
```
