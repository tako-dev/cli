<p align="center">
  <img src="https://img.shields.io/npm/v/tako-cli?color=blue&label=version" alt="version" />
  <img src="https://img.shields.io/npm/dm/tako-cli?color=green" alt="downloads" />
  <img src="https://img.shields.io/github/license/tako-dev/cli" alt="license" />
</p>

<h1 align="center">🐙 Tako CLI</h1>

<p align="center">
  <b>AI Coding Tools Launcher</b> — unified interface for Claude Code, Codex, Gemini & more<br/>
  <b>AI 编码工具启动器</b> — 统一管理 Claude Code、Codex、Gemini 等 AI 开发工具
</p>

---

## Why Tako? / 为什么用 Tako

- 🚀 **One launcher, every tool** — switch between Claude Code, Codex, Gemini in one TUI; no more juggling separate installs / 一个启动器管所有工具，不用分别折腾安装
- 🤖 **Multi-agent sessions** — run, monitor, and approve persistent agent sessions from the CLI; perfect for fan-out tasks / 多 agent 会话，CLI 里批量派活/监控/审批，适合并行任务
- 🔄 **Per-session model switching** — swap models via env var without polluting global config / 按会话切模型，不污染全局配置
- 🔌 **Provider-agnostic** — Tako API, Anthropic, DeepSeek, Xiaomi, or your own endpoint / 任意服务商，含自定义端点
- 🇨🇳 **China-optimized** — auto mirror detection + npmmirror acceleration / 自动镜像检测加速

## Table of Contents / 目录

- [Quick Install / 快速安装](#quick-install--快速安装)
- [Usage / 使用方式](#usage--使用方式)
- [Agent Session Management / Agent 会话管理](#agent-session-management--agent-会话管理)
- [Skills / 技能](#skills--技能)
- [Features / 功能特性](#features--功能特性)
- [Documentation / 文档](#documentation--文档)
- [Development / 开发](#development--开发)

## What it looks like / 效果一览

```console
$ tako
🐙 Tako — AI Coding Tools Launcher

  ▸ Claude Code   claude-sonnet-4-6   ● ready
    Codex         gpt-5.5             ● ready
    Gemini        gemini-2.5-pro      ● ready

  [←→] switch   [↑↓] projects   [a] agents   [p] providers   [Enter] launch

$ tako agent run claude --name fix-tests --json \
    --prompt "find and fix the failing auth tests"
→ run a1b2c3d4 (claude claude-sonnet-4-6)
  $ go test ./...
  ✗ FAILED (exit 1)
◀ turn done
{"sid":"a1b2c3d4-...","status":"ok","text":"Fixed 2 tests in auth_test.go"}
```

---

## Quick Install / 快速安装

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/tako-cli/install.sh | bash
```

Or via npm / 或通过 npm：

```bash
npm install -g tako-cli
```

> China users: Tako automatically detects your region and uses npmmirror for fast installs.
> 国内用户：Tako 自动检测网络环境并使用 npmmirror 镜像加速安装。

---

## Usage / 使用方式

```bash
tako                          # Interactive TUI launcher / 交互式启动器
tako --claude                 # Quick-launch Claude Code / 快速启动 Claude Code
tako --codex                  # Quick-launch Codex / 快速启动 Codex
tako --gemini                 # Quick-launch Gemini CLI / 快速启动 Gemini
```

### TUI Shortcuts / TUI 快捷键

| Key | Action |
|-----|--------|
| `←→` | Switch between tools / 切换工具 |
| `↑↓` | Navigate projects & options / 选择项目和选项 |
| `Enter` | Launch / 启动 |
| `a` | Agent management / Agent 管理 |
| `p` | Provider settings / 服务商管理 |
| `q` | Quit / 退出 |

---

## Agent Session Management / Agent 会话管理

Manage persistent AI agent sessions from CLI or TUI. Sessions survive shell restarts.

从 CLI 或 TUI 管理持久化的 AI agent 会话。会话跨 shell 重启保持。

### Native Session Search / 原生会话搜索

Launcher 项目列表第一项按 `↑` 即可进入历史会话搜索，统一检索 Claude Code、Codex 和 Gemini 的本地 session。搜索框留空时直接浏览最近会话，Claude/Codex 按 `Enter` 续接，Gemini 按 `Enter` 查看详情，按 `→` 均可查看最近对话。

```bash
tako sessions search "支付回调"
tako sessions search "upstream timeout" --deep
tako sessions resume codex:<session-id>
tako sessions index --status
tako sessions index --rebuild
tako sessions index --clear
```

索引完全保存在本机 `~/.tako/session-index/`，目录权限为 `0700`、数据库文件权限为 `0600`。默认搜索排除 system/developer prompt；`--deep` 才包含工具输出和 reasoning。当前 Gemini 历史仅支持搜索和查看，不会伪装成可续接会话。

```bash
tako agent run claude --prompt "fix the failing tests" --json  # One-shot task / 一次性任务
tako agent start claude --model claude-sonnet-4-6   # Create session / 创建会话
tako agent list [--status idle --name-prefix fg-]    # List + filter / 列出+筛选
tako agent send <sid> "your prompt"                  # Send message / 发送消息
tako agent attach <sid>                              # Live-tail log / 实时跟踪
tako agent show <sid> --errors-only                  # Inspect failures / 查看失败详情
tako agent cancel <sid>                              # Cancel current turn / 中止当前轮
tako agent close <sid> [--purge]                     # Close session / 关闭会话
```

**Advanced / 高级：**

```bash
tako agent start codex --approval external           # External approval mode / 外置审批
tako agent approve <sid> <id> allow --rule "^curl"   # Approve + whitelist / 审批+加白
tako agent wait <sid> --json                         # Block until decision point / 阻塞到决策点
tako agent policy <sid> show                         # View policy / 查看策略
```

In TUI, press `a` to open the Agent page — create, monitor, send messages, and approve tool calls visually.

在 TUI 中按 `a` 进入 Agent 管理页 — 可视化创建、监控、发送消息和审批工具调用。

---

## Skills / 技能

Tako bundles reusable skills that enhance Claude Code's capabilities. Install them to your project and Claude Code picks them up automatically.

Tako 内置可复用技能，增强 Claude Code 的能力。安装到项目后 Claude Code 自动识别。

### Install via CLI / 通过 CLI 安装

```bash
tako skill list               # List available skills / 列出可用技能
tako skill install --all      # Install all / 全部安装
tako skill install tako-agent # Install specific / 安装指定技能
```

### Install via GitHub / 通过 GitHub 安装

Copy the skill file directly from this repo into your project:

直接从仓库复制 skill 文件到你的项目：

```bash
# tako-agent skill
mkdir -p .claude/skills/tako-agent
curl -fsSL https://raw.githubusercontent.com/tako-dev/cli/main/skills/tako-agent/SKILL.md \
  -o .claude/skills/tako-agent/SKILL.md

# model-benchmark skill
mkdir -p .claude/skills/model-benchmark
curl -fsSL https://raw.githubusercontent.com/tako-dev/cli/main/skills/model-benchmark/SKILL.md \
  -o .claude/skills/model-benchmark/SKILL.md
```

### Available Skills / 可用技能

| Skill | Description | 描述 |
|-------|-------------|------|
| 🤖 `tako-agent` | Agent session management — start/resume/monitor/close sessions | Agent 会话管理 — 启动/续接/监控/关闭会话 |
| 📊 `model-benchmark` | Model capability scores from E2E testing across 16 models | 16 模型端到端评测能力评分 |

---

## Features / 功能特性

| Feature | Description |
|---------|-------------|
| 🚀 **Unified Launcher** | One TUI for Claude Code, Codex, Gemini |
| 🤖 **Agent Sessions** | Multi-session, persistent, approval workflow |
| 🔄 **Model Switching** | Per-session via env var, doesn't pollute global settings |
| 🔌 **Provider Management** | Tako API, Anthropic, DeepSeek, Xiaomi, custom |
| 📦 **Bundled Skills** | Install to `.claude/skills/` for agent enhancement |
| 🇨🇳 **China Optimized** | Auto mirror detection, npmmirror acceleration |

---

## Documentation / 文档

| Topic | Link |
|-------|------|
| 📖 Agent module design / Agent 模块设计 | [`docs/agent/DESIGN.md`](docs/agent/DESIGN.md) |
| 🧪 Agent test plan / 测试计划 | [`docs/agent/TESTPLAN.md`](docs/agent/TESTPLAN.md) |
| 💰 Quota module / 用量模块 | [`docs/quota/DESIGN.md`](docs/quota/DESIGN.md) |
| 🚢 Release runbook / 发版手册 | [`docs/release/RUNBOOK.md`](docs/release/RUNBOOK.md) |
| Maintainer release rule | Releases are tag-driven through GitHub Actions; see [`AGENTS.md`](AGENTS.md) before publishing. |
| 🤖 tako-agent skill | [`skills/tako-agent/SKILL.md`](skills/tako-agent/SKILL.md) |
| 📊 Model benchmark & picker / 选模型指南 | [`skills/model-benchmark/SKILL.md`](skills/model-benchmark/SKILL.md) |
| 🐛 Issues & feedback | [GitHub Issues](https://github.com/tako-dev/cli/issues) |

---

## Development / 开发

```bash
bun install
bun run build
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. / 完整流程见 CONTRIBUTING.md。

---

## License

MIT
