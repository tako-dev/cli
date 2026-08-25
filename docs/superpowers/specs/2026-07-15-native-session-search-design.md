# Native Session Search and Resume Design

## 1. 背景

Tako 已经具备两类相邻但不同的能力：

- Launcher：统一启动 Claude Code、Codex、Gemini 等客户端。
- Agent Sessions：管理由 `tako agent` 创建的长时 agent session。

但用户日常直接使用 Claude Code、Codex、Gemini 时，各客户端会把原生会话历史保存在不同目录、使用不同格式，并提供不同的恢复方式。随着本地 session 数量增长，通过客户端自带的最近记录或目录过滤寻找旧 session 已经很困难。

本功能新增一个独立的 Native Sessions 模块，把各客户端已经存在的原生 session 聚合到同一个本地索引中，提供快速搜索、内容预览和一键续接。

本功能不替换 `src/agent/`：

- `src/agent/` 管理 Tako 主动创建并控制生命周期的 agent session。
- `src/sessions/` 只读取各客户端原生历史，并通过客户端原生命令恢复。

## 2. 目标

### 2.1 核心目标

1. 聚合 Claude Code、Codex、Gemini 的本地原生 session。
2. 支持低噪声默认搜索和可选深度全文搜索。
3. 支持按来源、项目、目录、时间范围过滤。
4. 在搜索结果中快速预览命中上下文和会话摘要。
5. 对具备原生恢复能力的客户端提供一键续接。
6. 全部索引和搜索在本机完成，不上传会话正文或搜索词。

### 2.2 非目标

第一版不包含：

- 云端同步和跨机器同步。
- embedding 或模型驱动的语义搜索。
- AI 自动生成 session 摘要。
- 修改、合并或重写客户端原生 session 文件。
- 为不支持原生恢复的客户端伪造恢复流程。
- 替代 Claude Code、Codex、Gemini 自身的 session 管理实现。

## 3. 用户入口

### 3.1 TUI 入口

- Launcher 首页最上方增加一个固定的 Session Search 行，不新增字母快捷键。
- 当焦点位于项目列表第一项时，再按一次 `↑` 进入 Session Search。
- 在 Session Search 中输入内容后，首页列表区域直接切换为 session 搜索结果。
- `Enter` 续接当前结果，`→` 查看详情，`Esc` 清空搜索并返回项目列表。
- `tako sessions` 直接打开同一组件的独立全屏模式，适合专门检索历史。

### 3.2 CLI 入口

```bash
tako sessions
tako sessions search "支付回调"
tako sessions search "HTTP 200 output_tokens=0" --deep
tako sessions search "metric center" --source codex --cwd seller_data_compass
tako sessions show <session-key>
tako sessions resume <session-key>
tako sessions index --status
tako sessions index --rebuild
tako sessions index --clear
```

`session-key` 使用带来源前缀的稳定键，例如：

```text
claude:901e820a-16ed-4e4b-8d00-5d597f770766
codex:019f648b-8827-70a2-9121-2bcea54193ae
gemini:4fe1b490-2049-4854-8223-61303ae4a738
```

避免不同客户端的原生 ID 相互冲突。

## 4. 用户体验

### 4.1 首页集成

```text
┌ Tako ─ Claude Code ─ provider/model                                  ┐
│                                                                       │
│   🔎 Search previous sessions...                                      │
│   ─────────────────────────────────────────────────────────────────   │
│ ▶ ~/projects/tako-cli                                                 │
│   ~/projects/storefront                                               │
│   ~/projects/campaign-workbench                                       │
│                                                                       │
│ ↑↓ projects · ←→ clients · Enter launch                              │
└───────────────────────────────────────────────────────────────────────┘
```

项目列表已经位于首页主要导航链路中，因此 Session Search 作为项目列表上方的一个可聚焦行：

```text
项目第一项 --按 ↑--> Session Search --按 ↓/Esc--> 项目第一项
```

进入搜索并输入内容后，项目列表区域原地切换为结果列表：

```text
┌ Search sessions: 支付回调                         [Default Search] ┐
│                                                                    │
│ ▶ Codex   seller_data_compass    修复支付宝回调签名失败   2d       │
│   Claude  payment investigation  回调字段排序问题         8d       │
│   Gemini  payment notes          支付接口排查             21d      │
│                                                                    │
│ ↑↓ select · Enter resume · → details · Esc back                   │
└────────────────────────────────────────────────────────────────────┘
```

搜索结果默认跨来源，不要求用户先进入单独页面或选择客户端。

### 4.2 最小键盘交互

| 按键 | 行为 |
|------|------|
| `↑` | 从项目列表第一项进入 Session Search；在结果中向上移动 |
| `↓` | 从 Session Search 返回项目列表；在结果中向下移动 |
| 普通字符 | Search 获得焦点后直接输入并即时搜索 |
| `Enter` | 使用当前配置续接 session |
| `→` | 查看完整只读会话和高级操作 |
| `←`、`Esc` | 返回搜索结果；再次按下则清空搜索并返回项目列表 |

搜索输入使用短 debounce，输入后直接更新结果，不要求额外提交。

默认路径只使用方向键、`Enter` 和 `Esc`。来源过滤、深度搜索、复制 ID、打开原文件、选择 provider/model 等低频能力全部放入详情页中的可视操作项，通过方向键选择，不再占用首页全局快捷键。

### 4.3 独立 Sessions 页面

执行 `tako sessions` 时复用首页搜索组件，但提供更大的结果和预览区域。交互仍保持一致：

- 输入即搜。
- `↑/↓` 选择。
- `Enter` 续接。
- `→` 查看详情。
- `Esc` 返回。

过滤条件和默认/深度搜索切换以界面控件形式展示，由方向键和 `Enter` 操作，不引入额外字母快捷键。

### 4.4 搜索结果

每条结果至少展示：

- 来源和来源图标。
- session 标题或首条有效用户提问。
- 项目名或工作目录。
- 最近活动时间。
- 用户消息数量。
- 命中字段和高亮片段。
- 续接能力状态。

续接能力状态分为：

- `direct`：可按原生 session ID 直接恢复。
- `partial`：只能恢复已保存 tag，或启动原目录并辅助复制上下文。
- `unsupported`：仅支持搜索和查看。

### 4.5 视觉规范

首页搜索必须看起来像 Launcher 的自然组成部分，而不是临时插入的表单。

#### 静止态

- 搜索行位于项目列表上方，与项目列表保持一个空行或细分隔线。
- 未聚焦时使用 dimColor，不抢当前客户端和项目选择的视觉主次。
- 使用现有终端字符和 Ink 颜色，不依赖终端对 emoji 宽度的一致支持。
- 前缀统一使用 `⌕`；检测到宽度计算不稳定时降级为 `Search sessions...` 纯文本。

#### 聚焦态

- 左侧出现 cyan `▶`，搜索文字和输入光标使用 cyan。
- 外围不使用完整边框，避免首页出现额外盒子层级；使用单行底色感或下划分隔表达焦点。
- placeholder 消失后，输入内容保持高对比度，尾部使用 inverse 空格作为光标。

#### 加载态

- 首次索引时搜索仍可输入。
- 搜索行右侧显示低干扰状态，例如 `indexing 238/1204`。
- 已有索引时后台刷新不遮挡结果，只显示 dimColor `refreshing`。
- 单来源失败以黄色状态提示，不把整个页面切换成错误页。

#### 结果列表

- 单条结果默认占两行，首行用于来源、项目、标题和时间，第二行用于命中片段。
- 选中项只高亮左侧指示符、标题和命中词，不整行反色，避免长文本闪烁。
- 来源使用稳定但克制的颜色：Claude 为 magenta、Codex 为 blue、Gemini 为 cyan。
- 命中词使用 yellow，时间和路径使用 dimColor。
- 标题为空时使用首条有效用户消息；仍为空时显示短 session ID。

示例：

```text
▶ Codex   seller_data_compass   修复支付宝回调签名失败             2d
  ...最终定位为 callback 字段排序和签名串不一致...

  Claude  payment investigation   回调接口偶发 401                 8d
  ...检查支付网关日志和 Authorization header...
```

#### 空状态

- 空搜索词：显示当前 cwd 和最近使用 session，文案为 `Recent sessions`。
- 无匹配：显示 `No matching sessions`，下一行提示减少关键词或进入详情筛选。
- 尚无索引：显示索引进度，不要求用户先运行独立命令。

#### 响应式布局

- 宽度小于 80 列时每条结果压缩为一行，隐藏 cwd 路径和消息数量。
- 宽度 80 到 119 列时使用两行结果，不展示右侧预览。
- 宽度至少 120 列时，独立 `tako sessions` 页面可以展示列表和右侧预览双栏。
- 首页始终保持单栏，避免破坏 Launcher 的稳定宽度。

#### 动效和刷新

- 不使用持续 spinner 导致终端整屏重绘。
- 搜索 debounce 建议 80 到 120ms。
- 后台索引完成后保持当前选中 session key，不按数组下标恢复选择。
- 结果变化时不清空输入、不重置到第一条，除非当前选中项已经消失。

## 5. 模块结构

```text
src/sessions/
├── cmd.ts
├── index.ts
├── types.ts
├── registry.ts
├── discovery.ts
├── parser-utils.ts
├── indexer.ts
├── database.ts
├── search.ts
├── resume.ts
├── adapters/
│   ├── claude.ts
│   ├── codex.ts
│   └── gemini.ts
└── migrations/
    └── 001-initial.ts

src/ui/ink/views/
├── SessionSearchPanel.tsx
├── SessionsView.tsx
├── SessionDetailView.tsx
└── SessionFilterView.tsx
```

职责划分：

- `adapters/*`：发现文件、解析原生格式、声明恢复能力。
- `indexer.ts`：协调增量扫描、解析和数据库事务。
- `database.ts`：数据库初始化、迁移和基础查询。
- `search.ts`：查询解析、过滤、FTS 排序和片段生成。
- `resume.ts`：通过现有 launcher/provider 能力构造和执行续接命令。
- `cmd.ts`：CLI 参数解析和无 TUI 输出。
- `SessionSearchPanel.tsx`：可嵌入 Launcher 首页，也可由独立 SessionsView 复用。
- TUI views：只消费统一查询和恢复接口，不读取原始文件。

## 6. 统一数据模型

```ts
export type NativeSessionSource = "claude" | "codex" | "gemini";

export type ResumeCapability = "direct" | "partial" | "unsupported";

export interface UnifiedSession {
  key: string;
  nativeId: string;
  source: NativeSessionSource;
  title?: string;
  cwd?: string;
  projectName?: string;
  createdAt?: number;
  updatedAt: number;
  model?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string;
  sourcePath: string;
  resumeCapability: ResumeCapability;
  resumeHint?: string;
}

export interface ParsedSessionMessage {
  ordinal: number;
  role: "user" | "assistant" | "tool" | "reasoning" | "system" | "other";
  timestamp?: number;
  text: string;
  defaultSearchable: boolean;
  deepSearchable: boolean;
}
```

默认不把 system/developer prompt 写入搜索文档。适配器可以读取这些记录用于识别格式，但应在标准化阶段丢弃。

## 7. Adapter 契约

```ts
export interface SessionFileCandidate {
  source: NativeSessionSource;
  path: string;
  size: number;
  mtimeMs: number;
  discoveryMetadata?: Record<string, unknown>;
}

export interface ParsedNativeSession {
  session: UnifiedSession;
  messages: ParsedSessionMessage[];
  parserVersion: number;
}

export interface ResumeCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SessionSourceAdapter {
  readonly source: NativeSessionSource;
  readonly parserVersion: number;
  discover(): AsyncIterable<SessionFileCandidate>;
  parse(candidate: SessionFileCandidate): Promise<ParsedNativeSession | null>;
  getResumeCapability(session: UnifiedSession): Promise<ResumeCapability>;
  buildResumeCommand(session: UnifiedSession): Promise<ResumeCommand | null>;
}
```

适配器必须容忍：

- 空文件和截断的最后一行。
- 单行 JSON 解析失败。
- 同一客户端不同版本产生的字段差异。
- 文件正在被客户端追加写入。
- session 缺失标题、时间、cwd 或 model。

单个文件失败不能中止整次索引，错误写入本地诊断表并继续处理其他文件。

## 8. 来源适配

### 8.1 Claude Code

发现目录：

```text
~/.claude/projects/**/*.jsonl
```

主要字段：

- `sessionId`
- `cwd`
- `timestamp`
- `type=user|assistant`
- `message.role`
- `message.content`
- `ai-title` 或可用标题记录

标题优先级：

1. 原生 AI title。
2. 第一条有效用户消息的第一行。
3. session ID 短格式。

直接续接命令：

```bash
claude --resume <session-id>
```

命令在原 session 的 `cwd` 下执行，并复用 Tako launcher 已选择的 provider、环境变量和启动参数。

### 8.2 Codex

发现目录：

```text
~/.codex/sessions/**/*.jsonl
```

主要字段：

- `session_meta.payload.id`
- `session_meta.payload.cwd`
- `session_meta.payload.cli_version`
- `response_item.payload.type=message`
- message role 和 input/output text
- `event_msg`
- `turn_context`

默认搜索排除 environment context、developer instructions 和 permissions instructions，避免所有 session 因公共模板产生无效命中。

直接续接命令：

```bash
codex resume <session-id> -C <cwd>
```

如果 cwd 已不存在，续接前提示用户选择：

- 使用当前目录继续。
- 选择其他目录。
- 取消。

### 8.3 Gemini CLI

发现目录以版本探测为准，第一版至少支持：

```text
~/.gemini/tmp/*/chats/session-*.json
~/.gemini/tmp/*/chats/session-*.jsonl
```

项目根目录可以从相邻 `.project_root` 文件补充。

主要字段：

- `sessionId`
- message `type`
- message `timestamp`
- message `content`

Gemini 不假设所有版本都支持通过 session ID 直接恢复。适配器启动时进行能力探测：

1. 如果客户端帮助信息明确支持按 ID 恢复，返回 `direct`。
2. 如果 session 存在 `/chat save` tag，可构造 `/chat resume <tag>`，返回 `partial`。
3. 其他情况返回 `partial` 或 `unsupported`，只允许在原目录启动 Gemini，并辅助复制最后一条用户消息。

不得通过修改原生 session 文件或依赖未公开内部接口伪造恢复。

MVP 实现选择保守降级：当前已识别的 Gemini JSON/JSONL 格式统一标记为 `unsupported`，仅允许搜索和查看详情；CLI `resume` 返回明确错误，不会启动一个新会话冒充续接。后续只有在公开稳定的恢复参数完成探测和测试后，才升级为 `direct` 或 `partial`。

## 9. 数据库设计

数据库位置：

```text
~/.tako/session-index/sessions.db
```

目录和数据库文件权限应限制为当前用户可读写。

### 9.1 sessions

```sql
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  native_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT,
  cwd TEXT,
  project_name TEXT,
  created_at INTEGER,
  updated_at INTEGER NOT NULL,
  model TEXT,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  assistant_message_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL UNIQUE,
  source_size INTEGER NOT NULL,
  source_mtime_ms INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  resume_capability TEXT NOT NULL,
  resume_hint TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);
```

### 9.2 messages

```sql
CREATE TABLE messages (
  session_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  timestamp INTEGER,
  text TEXT NOT NULL,
  default_searchable INTEGER NOT NULL,
  deep_searchable INTEGER NOT NULL,
  PRIMARY KEY (session_key, ordinal),
  FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);
```

### 9.3 默认搜索 FTS

```sql
CREATE VIRTUAL TABLE session_search USING fts5(
  session_key UNINDEXED,
  title,
  project_name,
  cwd,
  user_text,
  assistant_text,
  tokenize = 'unicode61'
);
```

### 9.4 深度搜索 FTS

```sql
CREATE VIRTUAL TABLE session_deep_search USING fts5(
  session_key UNINDEXED,
  ordinal UNINDEXED,
  role UNINDEXED,
  text,
  tokenize = 'unicode61'
);
```

深度搜索按消息或受控大小的消息块入库，不能把整个超长 session 合并成单个 FTS 文档。

### 9.5 source_files

```sql
CREATE TABLE source_files (
  source_path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  session_key TEXT,
  last_error TEXT,
  indexed_at INTEGER
);
```

第一版以文件级重新解析为正确性基线。只有在性能数据证明必要后，才增加 JSONL byte offset 增量解析；避免文件截断、重写和消息顺序变化造成索引错误。

## 10. 索引流程

### 10.1 首次索引

1. 初始化数据库和 schema migration。
2. 并行执行各 adapter 的文件发现。
3. 以有限并发解析候选文件。
4. 每个 session 在单个事务中替换 metadata、messages 和 FTS 文档。
5. 记录来源文件的 size、mtime、parserVersion。
6. 标记本次未发现的旧文件为 stale。
7. 完成后清理 stale session。

### 10.2 增量索引

文件满足任一条件时重新解析：

- 尚未进入 `source_files`。
- size 变化。
- mtime 变化。
- adapter parserVersion 变化。
- 上次解析失败。

Sessions 页面打开时：

1. 立即从现有索引返回结果。
2. 后台执行一次快速增量刷新。
3. 有变化时刷新列表并显示轻量状态。

搜索不阻塞等待索引完成。

### 10.3 并发和原子性

- 使用数据库锁或进程级 lock file，避免多个 Tako 进程同时重建索引。
- 普通搜索可以在索引更新期间读取上一个一致状态。
- 单个 session 的 metadata、messages、FTS 更新必须在同一事务中完成。
- 解析正在追加的 JSONL 时忽略不完整的尾行，下次增量刷新重试。

## 11. 搜索设计

### 11.1 默认搜索

覆盖：

- 标题。
- 项目名。
- cwd。
- 用户消息。
- assistant 最终回复及普通文本回复。

排除：

- system/developer prompt。
- reasoning/thinking。
- 工具参数和输出。
- 环境上下文模板。
- 权限和沙箱模板。

### 11.2 深度搜索

在默认范围基础上增加：

- reasoning/thinking。
- tool use 参数。
- tool result 和命令输出。
- 中间 assistant 消息。

深度搜索仍默认排除 system/developer prompt；如未来需要，应作为独立显式选项，而不是并入 `--deep`。

### 11.3 过滤条件

```ts
export interface SessionSearchFilter {
  sources?: NativeSessionSource[];
  cwdContains?: string;
  projectNames?: string[];
  updatedAfter?: number;
  updatedBefore?: number;
  resumeCapabilities?: ResumeCapability[];
}
```

CLI 示例：

```bash
tako sessions search "回调" --source claude,codex --after 30d
tako sessions search "starling" --project seller_data_compass_next
tako sessions search "curl 500" --deep --cwd ~/projects
```

### 11.4 排序

最终得分由以下部分组成：

1. FTS BM25 相关度。
2. 标题精确命中加权。
3. 用户消息命中高于 assistant 消息。
4. 当前工作目录精确匹配加权。
5. 当前项目名匹配加权。
6. 最近活动时间衰减加权。

相同得分时按 `updatedAt DESC` 排序。

无搜索词时不走 FTS，直接展示最近 session，并优先当前 cwd。

### 11.5 查询安全

用户输入不直接拼接为 SQL。查询层负责：

- 转义 FTS 特殊字符。
- 普通文本默认使用 token AND/phrase 组合。
- 过滤参数全部使用绑定变量。
- 无法解析的高级语法降级为字面文本查询。

## 12. 会话查看

只读详情页按标准化消息展示，不直接渲染原始 JSON：

- 用户消息。
- assistant 文本。
- 可折叠的 reasoning。
- 可折叠的工具调用和结果。
- 时间、模型、cwd、来源文件。

详情页支持：

- 在当前命中附近打开。
- 搜索 session 内文本。
- 复制单条消息。
- 复制原生 session ID。
- 打开原始文件。
- 从详情页续接。

超长 session 采用窗口化读取或分页，不能一次性把全部消息渲染进 Ink 组件。

## 13. 续接流程

### 13.1 通用流程

1. 根据 `session_key` 读取统一 metadata。
2. 调 adapter 重新检查当前客户端的恢复能力。
3. 检查原始 session 文件是否仍然存在。
4. 检查 cwd 是否存在。
5. 解析当前 Tako provider 和选中的启动参数。
6. 调用客户端现有 `setupConfigFiles` 和 launcher 准备逻辑。
7. 构造原生恢复命令。
8. 退出 Ink alternate screen，启动客户端。
9. 客户端退出后恢复或结束 Tako 流程，与现有 launcher 行为保持一致。

### 13.2 默认与高级续接

- `Enter`：使用当前已选择或默认 provider/model 续接。
- 需要调整 provider、model 或 launch option 时，先按 `→` 进入详情页，再选择“高级续接”。

原 session 的 model 只作为提示，不强制覆盖当前 provider 配置，因为原模型可能已经不可用，或原 session 来自非 Tako provider。

### 13.3 失败处理

明确区分：

- 原始文件消失。
- cwd 消失。
- 客户端未安装。
- 当前客户端版本不支持按 ID 恢复。
- provider 配置失败。
- 原生命令拒绝恢复该 session。

失败后保留当前搜索结果和选中项，允许用户修改 provider、cwd 或复制命令手工执行。

## 14. 配置

建议在 Tako config 中增加：

```json
{
  "sessions": {
    "enabledSources": ["claude", "codex", "gemini"],
    "deepIndexEnabled": true,
    "excludePaths": [],
    "excludeProjects": [],
    "maxFileSizeMb": 100,
    "refreshOnOpen": true
  }
}
```

行为：

- 超过大小限制的文件仍建立 metadata，可跳过深度索引并显示提示。
- 配置变化后，仅重建受影响来源或搜索层级。
- 关闭 deepIndex 时删除深度 FTS 数据，但保留默认搜索索引。

## 15. 隐私与安全

1. 会话正文和搜索词不发送到 analytics。
2. 索引文件和目录仅允许当前用户访问。
3. 默认不索引 system/developer prompt。
4. 不修改任何客户端原生 session 文件。
5. 不把 session 内容写入 Tako 普通日志。
6. CLI JSON 输出只在用户显式请求时返回消息正文。
7. 支持清空索引，清空不会删除原始 session。

清理命令：

```bash
tako sessions index --clear
```

## 16. 性能目标

以本地约 1,500 个 session 文件作为第一版基准：

- 有索引时打开 Sessions 页面：小于 300ms 显示首屏。
- 普通搜索：小于 100ms 返回前 50 条。
- 深度搜索：小于 300ms 返回前 50 条。
- 无变化时增量扫描：小于 1s 完成。
- 单个损坏文件不能影响其他 session 可用性。

首次索引允许后台运行并展示进度；用户可以在索引未完成时搜索已完成部分。

## 17. 测试策略

### 17.1 Adapter 单元测试

每个来源准备脱敏 fixture，覆盖：

- 正常 session。
- 缺少 title/cwd/timestamp。
- 多种消息内容结构。
- 损坏 JSON 行。
- 截断尾行。
- 空 session。
- 大型工具输出。
- 不应进入默认索引的 system/developer 内容。

### 17.2 数据库和搜索测试

- schema 初始化和 migration。
- session 原子替换。
- stale 清理。
- 默认与深度索引隔离。
- 中文、英文、路径和错误码搜索。
- 来源、cwd、项目、时间过滤。
- 标题和用户消息排序权重。
- FTS 特殊字符和 SQL 注入输入。

### 17.3 续接测试

- Claude 命令构造。
- Codex 命令构造。
- cwd 不存在时的降级。
- 客户端未安装。
- Gemini capability detection。
- provider/setupConfigFiles 复用。
- Windows 路径和参数转义。

### 17.4 TUI 测试

- 空索引、索引中、索引失败状态。
- 输入搜索和 debounce。
- 结果选择稳定性。
- 过滤器组合。
- 详情页窗口化展示。
- 续接前退出 terminal alternate screen。

## 18. 分阶段实施

### Phase 1：索引基础

- 定义类型和 adapter registry。
- 实现 Claude、Codex、Gemini parser。
- 建立 SQLite schema 和 migration。
- 实现增量文件级索引。
- 完成默认/深度搜索 API。

### Phase 2：CLI

- 增加 `tako sessions search/show/index`。
- 支持 human、JSON 输出。
- 加入过滤和诊断命令。

### Phase 3：TUI

- 在 Launcher 项目列表上方增加可聚焦的 Session Search 行。
- 实现可复用的 SessionSearchPanel、SessionsView、FilterView、DetailView。
- 实现搜索、预览、分页和索引状态。
- 保持首页主路径只依赖方向键、`Enter` 和 `Esc`。

### Phase 4：续接

- 复用 launcher/provider 配置流程。
- 实现 Claude、Codex direct resume。
- 实现 Gemini capability-aware fallback。
- 补齐跨平台参数与 terminal handoff。

### Phase 5：性能与发布

- 使用真实规模脱敏数据进行 benchmark。
- 优化大文件和超长 session。
- 补充用户文档、DESIGN、TESTPLAN 和升级说明。

## 19. 验收标准

第一版完成需满足：

1. 能发现并索引三个来源的有效原生 session。
2. 默认搜索不会因为公共 system/developer 模板产生大量错误结果。
3. 深度搜索能命中工具输出中的错误码、命令和日志。
4. 搜索结果支持来源、项目、cwd 和时间过滤。
5. 详情页能从命中位置查看标准化会话内容。
6. Claude 和 Codex session 能从搜索结果一键续接。
7. Gemini 不支持直接恢复时给出明确降级行为，而不是执行不可靠操作。
8. 原始 session 文件不会被修改。
9. 索引失败或单文件损坏不影响已有搜索结果。
10. 会话正文和搜索词不进入 analytics。

## 20. 后续演进

在第一版稳定后，可以按需求增加：

- 本地 embedding 语义搜索。
- session 收藏、别名和用户标签。
- 基于 git remote 的跨 worktree 项目归并。
- 根据 issue、分支、commit 自动关联 session。
- 可选的加密跨机器索引同步。
- 从搜索结果创建新的 Tako Agent Session，并附带选中历史作为上下文。
