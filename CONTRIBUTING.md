# Contributing to Tako CLI / 贡献指南

Thanks for your interest! / 感谢你的兴趣！

## Setup / 环境

```bash
bun install        # install deps / 安装依赖
bun run build      # build to dist/index.js / 构建
bun test           # run all tests / 跑全部测试
```

Requires [Bun](https://bun.sh) ≥ 1.3. / 需要 Bun ≥ 1.3。

## Testing / 测试

Two suites, both via `bun test`:

- `tests/unit.*.test.ts` — module-level logic / 模块逻辑
- `tests/integration.*.test.ts` — end-to-end / 端到端

Before opening a PR / 提 PR 前：

```bash
bun test                      # all green / 全绿
bun run build
bun test tests/pre-release.test.ts   # release gate / 发布门禁
```

GitHub Actions on `tako-dev/cli`:

- `ci.yml` — PR / push `main`：Ubuntu / macOS / Windows 跑 unit + platform；Ubuntu 再 build / smoke / pre-release
- `installer-e2e.yml` — nightly + 手动：三平台真实安装 Codex / Pi / Pi Web
- `release.yml` — tag `v*`：e2e 全过后再 publish


**New pure-logic function → add a unit test.** / 新增纯逻辑函数请配 1 条单测。
**Fixing a bug → add a regression test.** / 修 bug 请补回归测试。

## Pull Requests / 提交

- Keep PRs focused; one logical change per PR. / 一个 PR 一件事。
- Match the surrounding code style. / 与现有代码风格一致。
- Update relevant docs (`docs/`, `skills/`, README) when behavior changes. / 行为变更请同步文档。
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`). / 提交信息遵循 Conventional Commits。

## Project Layout / 项目结构

```
src/
  agent/       # multi-agent session management / 多 agent 会话
  clients/     # Claude Code / Codex / Gemini drivers / 各客户端驱动
  providers/   # provider resolution / 服务商解析
  models/      # bundled model catalog / 模型清单
  ui/ink/      # Ink TUI views / TUI 界面
docs/          # module design + test plans / 模块文档
skills/        # bundled Claude Code skills / 内置技能
tests/         # bun:test suites / 测试
```

## Reporting Issues / 反馈问题

Open an issue at https://github.com/tako-dev/cli/issues with repro steps,
your OS, and `tako --version`. / 在 issues 提交，附复现步骤、系统、版本号。
