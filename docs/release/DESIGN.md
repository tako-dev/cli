# 发布流程设计

## 概述

tako-cli 的发布完全自动化：本地打 tag → GHA 自动跑 e2e + build + publish。
无需本地 npm 登录态，无需手动操作 npmjs.com。

## 发布链路

```
本地: bun run release
  │  bump patch → commit → tag v0.x.y → git push + tags
  ▼
GHA: .github/workflows/release.yml (tag v* 触发)
  │
  ├─ e2e job (三平台并行, fail-fast)
  │   ├─ ubuntu-latest   ✓  9 个 installer e2e check
  │   ├─ macos-latest    ✓
  │   └─ windows-latest  ✓  + PowerShell 兼容
  │
  └─ publish job (e2e 全过后)
      ├─ bun install
      ├─ bun run build
      ├─ Smoke test: bun dist/index.js --version
      ├─ Pre-release checks (32 个断言)
      └─ npx -y npm@11.5.1 publish --provenance (OIDC trusted publishing)
```

## 本地命令

```bash
cd packages/cli
bun run release        # patch: 0.3.x → 0.3.(x+1)
bun run release:minor  # minor: 0.x.y → 0.(x+1).0
```

## 认证方式

**OIDC Trusted Publishing**（无需 token）：
- npmjs.com 包 Settings → Trusted Publisher 已配置（tako-dev/cli/release.yml）
- GHA workflow 声明 `permissions: { id-token: write }`
- npm >= 11.5.1（workflow 中用 `npx -y npm@11.5.1 ...` 固定发布 CLI）
- `npm publish --provenance` 自动获取 OIDC id-token

详细踩坑记录：`my-documents/incidents/2026-06-15-npm-oidc-publish-tako-cli.md`

## 源文件

- `.github/workflows/release.yml` — CI 发布 workflow
- `.github/workflows/installer-e2e.yml` — nightly e2e（独立于 release）
- `scripts/bump.ts` — 版本号更新
- `scripts/release-gate.sh` — 手动本地 pre-check（可选）
- `tests/pre-release.test.ts` — 构建产物验证（含 smoke test）
- `tests/e2e/installer-driver.ts` — 三平台 e2e 驱动
- `docs/release/RUNBOOK.md` — 发版操作手册与误 tag 清理流程

## 事故与教训

### v0.3.2 — react-devtools-core ENOENT (2026-06-15)

**现象**：用户 `tako` 启动报 `Cannot find package 'react-devtools-core'`。
**根因**：`Bun.build({ external: [...] })` 在单文件分发场景下，外部包运行时不存在。
**修复**：构建前 stub 该模块（空 no-op），bundler inline 进 bundle。
**防护**：pre-release smoke test 验证 `bun dist/index.js --version` 不报错。

### v0.3.4 — 非 TTY 环境 Ink 崩溃

**现象**：`install.sh | bash` 安装后自动启动 tako，pipe 环境无 TTY，Ink 报 Raw mode error。
**修复**：进入 TUI 前检查 `process.stdin.isTTY`，非终端优雅提示退出。

### v0.3.6 — release script quoting 导致误 tag

**现象**：`bun run release` 中 `node -p` 版本读取失败，生成了错误 tag `v`。
**根因**：`package.json` script 中单引号内部保留了 `\"` 反斜杠，Node 收到 `require(\"./package.json\")`。
**修复**：将 script 中版本表达式改为实际执行 `require("./package.json").version`。
**防护**：发版后必须核对 `git ls-remote --tags origin 'refs/tags/v*'` 和 `npm view tako-cli version dist-tags.latest --json`；误 tag 清理步骤见 `RUNBOOK.md`。

### v0.3.22 — npm@latest provenance 缺 sigstore

**现象**：三平台 e2e、build、unit、pre-release 全过，但 `npm publish --provenance`
失败，报 `Cannot find module 'sigstore'`。
**根因**：workflow 用 `npm install -g npm@latest` 覆盖 runner 全局 npm，npm CLI 依赖树
漂移后 `libnpmpublish` 运行时找不到 `sigstore`。
**修复**：不再全局升级 npm；发布步骤改用 `npx -y npm@11.5.1 publish --provenance --access public`。
**防护**：workflow 先执行 `npx -y npm@11.5.1 --version`，发版后继续核对 npm latest。

## 回滚

npm 不支持真正的版本回滚（unpublish 有时间限制）。如果发了坏版本：
1. 立刻发 hotfix（bump patch + tag + push）
2. 告知用户 `bun install -g tako-cli@latest` 更新
