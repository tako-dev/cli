# Pi / Pi Web：外部模型目录依赖与后续执行契约

## 范围与固定证据

此文是交给外部依赖维护方的**完整实现／验收契约**，不是已应用到扩展的补丁，也不是 Pi 全链路通过声明。

2026-11-16 只读 GitHub API 核验 `Barrierml/tako-pi` 为 **public**，默认分支 `main`，HEAD 为 [`a54aec7c0620e569b1026252d0bdca16ba272981`](https://github.com/Barrierml/tako-pi/commit/a54aec7c0620e569b1026252d0bdca16ba272981)，提交时间 2026-08-23T14:28:56Z。固定版本文件：

- [`extensions/tako-provider.ts`](https://github.com/Barrierml/tako-pi/blob/a54aec7c0620e569b1026252d0bdca16ba272981/extensions/tako-provider.ts)：`CACHE_PATH` 是全账号共用的 `~/.pi/agent/tako-models-cache.json`；`readCache()` 不检查账号／地址／时效，又回读 `models.json.providers.tako`。`writeCache()` 整文件替换 `models.json`，会删除其他 provider；完整空列表被当作失败。
- [`lib/tako-auth.ts`](https://github.com/Barrierml/tako-pi/blob/a54aec7c0620e569b1026252d0bdca16ba272981/lib/tako-auth.ts)：固定 `TAKO_BASE` 和 `~/.tako/config.json.apiKey`，不读取 CLI 选择的启动凭据、`TAKO_BASE_URL` 或 `TAKO_HOME`。
- [`extensions/tako-model-picker.ts`](https://github.com/Barrierml/tako-pi/blob/a54aec7c0620e569b1026252d0bdca16ba272981/extensions/tako-model-picker.ts)：全局偏好 `tako-model-prefs.json` 只有 provider/model/window/effort，没有服务地址／账号归属。同名模型可能继承另一账号偏好。
- [`package.json`](https://github.com/Barrierml/tako-pi/blob/a54aec7c0620e569b1026252d0bdca16ba272981/package.json)：版本 `0.1.0`，MIT，未固定兼容 Pi 核心版本。CLI 安装源是 `git:github.com/Barrierml/tako-pi`，不能仅凭版本号判定已修。

CLI 本轮只调整公开 `tako-dev/cli`：`takoPiEnv()` 向 Pi / Pi Web **子进程环境**传入选中的 `TAKO_API_KEY`、现有 `TAKO_BASE_URL` 和解析后的 `TAKO_HOME`；缺 key 传空串，避免继承旧 key。它不写 key 到个人文件，不向外部服务发送数据，不添加第二个 `models.json` 写入器。**以上固定扩展版本忽略这些新凭据字段，故 CLI 单侧变更不能修复 Pi 原生菜单。**

2026-11-16 17:35 CST 恢复轮再次只读核实仓库为 public，`main` 仍指向上述 SHA；并回读固定版本的 provider、auth 与 package 文件。未安装或执行外部扩展，Pi 核心／Pi Web 的真实版本、菜单、环境透传及工具调用均**未验**。

## 依赖不可用时的实际降级

| 条件 | 当前 CLI／固定扩展行为 | 本轮资格结论 |
|---|---|---|
| CLI 有当前账号的 Messages 目录 | 启动器只用 `claude` 桶的 chat 模型；不再借用同账号的 OpenAI 桶 | 只证明启动选项来源；扩展仍可能忽略启动身份 |
| CLI 完整目录为空／只有非 chat 模型 | 启动器返回空模型组选项，不重新填静态模型 | 不改个人菜单；不证明 Pi 已清理自己的旧注册 |
| CLI 没有当前账号的 Messages 目录 | 保留旧版静态启动器选项；这些选项没有远端资格证明 | 不把静态名称视为可用模型；不会以 OpenAI 目录补齐 |
| Pi 未安装／扩展安装或更新失败 | 现有安装流程尝试准备组件；扩展安装失败会告警，CLI 没有内置备用目录注册器 | 自动模型菜单不可保证；不创建第二个 `models.json` 写入器 |
| 固定扩展目录请求失败、无 key 或成功空列表 | 其旧实现回落全账号共用缓存，再读已有 `models.json`；没有数据则不注册 tako | 这是已核实的依赖缺口，**不能称账号安全降级** |
| 普通 custom 服务不支持 Tako 目录／Messages 协议 | CLI 不用其他协议目录伪装 Messages 资格；固定扩展仍有硬编码官方路由 | 不宣称该服务兼容 Pi；需独立声明协议并完成下述任务 |

本轮不删除缓存、不覆盖用户的 `models.json`、不自动替换扩展或用户 provider。用户已有其他 provider 仍由 Pi 负责；本轮未运行外部扩展，不能证明其实际加载／保留行为。需要可靠账号隔离时，Pi 自动目录保持待验，使用已单独验证的客户端路径；不得把旧缓存显示出来等同于已修复。

## 窄后续任务（由父方另行授权／派单）

**标题**：`Barrierml/tako-pi`：消费启动账号，隔离目录缓存，移除破坏性 models.json 写入。

**仓库／基线**：先核 remote 为 `https://github.com/Barrierml/tako-pi.git` 且仍公开，在其独立 worktree 从最新核实的 main 开始，记录与上述 SHA 的差异；不得复用私有 `Barrierml/tako-cli`。本 CLI 工单不授予该仓写权限。

**改动面**：`lib/tako-auth.ts`、`extensions/tako-provider.ts`、`extensions/tako-model-picker.ts`，及该扩展自己的离线单测／兼容性文档。不扩至搜索／配额／计费，不改真实用户 profile，不自动部署或发布。

### 1. 单一身份与路由对象

启动时只解析一次，目录刷新、注册和每次请求使用同一个不可变上下文：

```typescript
interface TakoLaunchIdentity {
  gatewayBaseUrl: string; // 仅已声明支持 Tako 网关协议的根地址
  messagesBaseUrl: string;
  catalogUrl: string;
  apiKey: string; // 只在内存和进程环境；禁止日志／URL／磁盘
  accountFingerprint: string; // SHA-256(apiKey)
}
```

规则：

1. `Object.hasOwn(process.env, "TAKO_API_KEY")` 为真时，使用该值；**空串表示明确无凭据，禁止回落旧账号**。未设置时才允许独立运行 Pi 的旧配置来源，路径按 `TAKO_HOME || ~/.tako` 解析。不得把当前 `config.apiKey` 当成 CLI 已选 provider 的 key。
2. `TAKO_BASE_URL` 非空时是唯一可用根地址，修剪末尾 `/`；不能把失败的 custom 地址换成官方地址。只允许 http(s)，禁止 URL 的 userinfo／fragment／凭据 query。Standalone 无覆盖时可保留旧官方地址。环境覆盖存在但为空或非法时 fail closed，不读取别处账号继续请求。
3. 仅对**明确支持 Tako 网关协议**的根地址派生 `/v1/models?client_version=tako-cli&api_type=claude` 与 `/api`。普通 Anthropic API base URL 不能凭名称推定有该目录或 `/api`；如需支持，先独立声明／验证其目录和推理路由契约，未获资格则不注册远端目录、不改路由。
4. `registerProvider("tako", ...)` 的认证来自同一内存身份或进程环境 getter（按所验证 Pi SDK 的接口），移除硬编码 `!node ... ~/.tako/config.json` 命令。绝不在注册时用 A 目录、请求时再读 B key。
5. 派生 API URL 不跟随重定向；总超时 8 秒；所有测试仅假 key / loopback / fixture，禁止真实模型消费。

### 2. 新缓存 v2：未知、成功空、失败不可混淆

```typescript
interface AccountCatalogSnapshot<Model> {
  version: 2;
  buckets: Record<string, { fetchedAt: number; models: Model[] }>;
}
// key = normalizedGatewayBaseUrl + "#claude#" + sha256(apiKey)
// fetch result = Model[] | null;
// [] = 完整成功且当前账号没有合格模型；null = 网络／协议／不完整响应失败。
```

- 内存、磁盘、并发中的请求都按相同 key 分桶。只合并同 key 请求，A/B 可并发；换 key、换地址、换协议不能复用。
- v1 或无账号归属的旧缓存**忽略但不删除**，不迁移成任何新账号；旧 `models.json` 中的 tako 模型没有身份来源，不能当账号目录 fallback。
- 只发布完整列表。Codex-shaped gateway `models[].slug`、OpenAI `data[].id` 分别解析；顶层 schema／ID 坏了保留原桶和原时间戳，不把非协议响应当空列表。`has_more=true` 时必须按已验证协议取完页，或拒绝整次刷新；不能把第一页提交。不要用 OpenAI 目录冒充 Codex / Gemini 原生菜单语义。
- `[]` 要覆盖当前桶并清除它的注册列表；不影响其他账号。网络失败只能保留**同账号且仍在一小时内**的快照，过期／未来时间戳不获得原生菜单资格、不续期；现存用户模型由 Pi 自己解析。
- 只收合格 chat 模型，保留原始 ID；不要从名称猜工具／图像／reasoning 能力。未知能力按已经验证的 Pi provider 最小契约处理，不宣称工具调用通过。
- 写磁盘权限 0600，同目录临时文件 + atomic rename；若保留共享快照，读合并写须跨进程锁，或采用每身份独立文件以避免并发丢桶。任何写失败不应毁掉旧完整文件。

### 3. 不再覆盖 models.json；保存用户选择

推荐、最小且无所有权歧义的方案：**删除扩展对 `~/.pi/agent/models.json` 的所有写入，只用 `registerProvider` + 扩展自己的 v2 缓存**。不迁移／删除旧文件，不把 CLI 也变成写入器。由真实 Pi 核心验明手写 provider 与动态注册的优先级；存在用户自定义 tako provider 或显式禁用时让用户配置优先，不在无法判断时强行注册。

- 安装包／skills／compaction／默认选择／用户自定义模型和过滤项均不因目录刷新被重置。
- `tako-model-prefs.json` 新偏好按身份 + provider + model 分桶；无归属旧偏好不套给新账号。session 自带的显式选择按 Pi 自身恢复策略保留，不用另一账号全局偏好覆盖。
- 对 Pi Web 验证其实际子进程／SDK 的环境透传和注册生命周期；不能因为复用 CLI helper 就称 Web 已通过。

### 4. 必须交付的离线验收矩阵

| 场景 | 必须断言 |
|---|---|
| 同地址 A→B→A、相同模型名 | 目录／请求凭据／偏好均隔离；无旧 key 命令回读 |
| 同 key 不同地址、两协议 | 不共享目录；失败不切官方路由 |
| 空 key、legacy／损坏缓存 | 不回落另一账号；原文件未改 |
| 同身份并发与跨身份并发／磁盘重载 | 无串桶、无部分写入；磁盘无原始 key |
| 成功空目录、协议过滤后空目录 | 只清当前账号旧模型；完整空不算网络失败 |
| 超时／401／500／坏 JSON／后续页失败／重复 cursor | 不提交部分结果、不更新时间戳、不用其他账号兜底 |
| 过期／未来时间戳 | 不获得原生菜单资格，重新发现 |
| 原 models.json 包含多个 provider、手写 tako／关闭项 | 字节不变；显式用户配置保留 |
| Terminal 与 Pi Web 的真实固定核心 | 注册列表含正确 fixture 独立条目，原始 ID／当前假凭据路由一致，退出进程／端口已清理 |

验收报告必须写实际 Pi / Pi Web / SDK / Node 版本、平台、exact base/head、命令和原始输出、原生菜单截图／终端捕获；使用 fixture 的结果不得等同于真实推理或工具资格。注册/菜单离线通过后，真实推理／工具兼容仍是单独授权与预算的任务。

**父方完成条件**：另单获授权实现，独立 reviewer 按 SHA 验收，并验证 CLI 本轮环境契约与修复后扩展匹配；在此之前 issue #29 的 Pi 部分保持未完成，不能通过重复发布 CLI 宣称收口。
