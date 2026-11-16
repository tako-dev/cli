# CLI #29：模型目录资格与 Pi 依赖阶段交付

原始需求：<https://github.com/tako-dev/cli/issues/29>。本报告记录公开 `tako-dev/cli` 的未提交候选；不是所有客户端原生菜单、工具调用或真实推理均已通过的声明。

## 候选与环境

- 复核时刻：2026-11-16 17:46 CST（UTC+8）。
- 公开 remote：`https://github.com/tako-dev/cli.git`；分支 `ticket/c56729cd`。
- base / HEAD / 本地 `origin/main`：`320f41f68a30c91714519523af37253cb74db1b9`，CLI 0.3.50；没有新提交。
- 本轮实际环境：Darwin 24.1.0 / macOS 15.1 arm64，Bun 1.3.14（0d9b296a），Node v22.23.1，TypeScript 5.9.3。旧执行轮所记 Node 26.7.0 不是本轮运行环境。
- 代码／测试／模型文档共 14 个候选文件，SHA-256：`fdcac4b79569bdc8b76a715e8b316dcafb84bc780043f930abd6fef6eb33bffb`；逐文件摘要、计算时刻和基线见 [candidate-manifest.json](candidate-manifest.json)。证据日志和本报告不纳入此摘要。
- 已有 tracked 修改的完整差异见 [candidate-tracked.patch](candidate-tracked.patch)；两个未跟踪候选文件 `tests/unit.model-qualification.test.ts`、`docs/models/PI-DEPENDENCY.md` 由 manifest 单独固定，不包含在 tracked patch 内。
- 保留上一轮全部候选，在此基础上补齐跨协议资格回归、Pi/Grok 最小修复、测试隔离和说明文档；不 commit/push/tag/发布，不改私有同名仓、生产或真实个人配置。

## 本轮结论

1. 五个启动器按地址、账号和各自协议读取目录；已知完整空目录／筛选后没有合格模型时不重新显示静态模型。新增“只存在另一协议目录”的回归先复现 Pi/Grok 两项失败，再移除其跨协议目录 fallback。
2. Claude 原生菜单仅用最终启动身份的一小时内目录，保留个人／目标项目／祖先 project/local／显式设置中的菜单；Codex 保留显式 CLI 目录、路由、provider、profile 和禁用发现的选择。不将 OpenAI 简表伪造成 Codex/Gemini 原生目录。
3. Pi/Pi Web 仅补齐启动环境契约，没有新增 `models.json` 写入器。外部扩展固定版本仍有账号缓存、硬编码路由、偏好归属和配置覆盖缺口；交付 [PI-DEPENDENCY.md](../../models/PI-DEPENDENCY.md) 作为可独立派工的实现／验收契约。真实 Pi 注册／菜单未验。

## 实际命令、结果和耗时

所有测试在新临时 HOME / TAKO_HOME / XDG_CONFIG_HOME 下运行，目录网络用 mock／fixture，凭据为假值。原生适配器子进程另过滤凭据、路由和配置环境，并使用隔离 cwd。没有真实模型消费；未安装／运行外部 Pi 扩展。

| 门禁 | 本轮结果 | 耗时 | 实测 CST | 原始输出 |
|---|---|---|---|---|
| 指定五文件首轮回归 | 68 pass / 0 fail，261 assertions | real 0.17s | 17:35 | [resume-focused-tests.log](resume-focused-tests.log) |
| 新增跨协议负向回归，修复前 | 14 pass / 2 fail；Pi/Grok 误用另一协议的 ID | real 0.04s | 17:39 | [resume-protocol-before.log](resume-protocol-before.log) |
| 指定五文件，跨协议修复后 | 73 pass / 0 fail，266 assertions | real 0.08s | 17:42 | [resume-final-focused-tests.log](resume-final-focused-tests.log) |
| 最终完整聚焦矩阵（含测试隔离补强） | **211 pass / 0 fail**，630 assertions，14 文件 | real 0.16s | 17:44 | [resume-final-matrix.log](resume-final-matrix.log) |
| 最终 `bun run build` | exit 0，CLI 0.3.50，bundle 893.70 KB | real 0.06s | 17:44 | [resume-final-build.log](resume-final-build.log) |
| 最终 `tsc --noEmit -p tsconfig.json`（TS 5.9.3） | **exit 2，6 项错误**；未称通过 | real 0.91s | 17:44 | [resume-final-typecheck.log](resume-final-typecheck.log) |
| 同工具／配置检查原始 HEAD | 同样 6 项错误，与候选诊断逐条相同 | 未单独计时 | 17:36、17:44 比对 | [baseline](resume-typecheck-baseline.log)、[逐条比较](resume-typecheck-comparison.json) |
| `git diff --check` | exit 0 | 未单独计时 | 17:46 | 本轮终检输出另随交付回执 |

最终矩阵命令：

```bash
bun test \
  tests/unit.model-qualification.test.ts \
  tests/unit.dynamic-model-options.test.ts \
  tests/unit.native-model-menus.test.ts \
  tests/unit.pi-client.test.ts \
  tests/unit.tako-model-cache.test.ts \
  tests/unit.gemini-model-discovery.test.ts \
  tests/unit.gemini-native-menu.test.ts \
  tests/unit.grok-client.test.ts \
  tests/unit.claude-settings.test.ts \
  tests/unit.codex-settings.test.ts \
  tests/unit.claude-model-pin.test.ts \
  tests/unit.claude-1m-suffix.test.ts \
  tests/unit.windows-handoff.test.ts \
  tests/pre-release.test.ts
bun run build
tsc --noEmit -p tsconfig.json
```

仓库没有 typecheck script 或 TypeScript devDependency。本轮将 `typescript@5.9.3` 用 `npm install --prefix <新临时目录> --ignore-scripts --no-audit --no-fund --package-lock=false` 安装到独立目录；没有改 `package.json` / `bun.lock`。从本工作树执行该编译器。基线检查用 TypeScript CompilerHost `readFile` 对所有六个已修改 src 文件提供 `git show HEAD:<path>` 内容，其他源码、依赖和 tsconfig 相同；没有恢复或覆盖现有文件。

六项基线类型错误：`src/clients/grok.ts:332`（args optional/required）、`src/quota/command.ts:114` 两项、`src/quota/tako.ts:211` 两项、`src/stats.ts:88` 一项（ApiIdResult 属性收窄）。本轮未扩大范围修改它们；总体类型门禁仍不绿。

`pre-release` 的“现存配置结构”分支输出 `[SKIP] Config file does not exist`：隔离 HOME 没有真实配置，因此该分支未验；Bun 将提前 return 的该测试计入通过数。真实个人配置结构未被读取。211 的数量包含这一条，不能理解为 211 项均执行了全部分支。

旧日志 `before-*` / `after-*` 是前一轮留存材料，仅作历史失败／局部通过记录；不计入本轮 211 项。旧 `after-launcher-qualification.log` 曾记录错误的 Gemini fixture 假设（未声明 generateContent 资格的 image 条目）；本轮使用符合各协议的 fixture，不宣称该旧日志是全绿结果。

## 回归矩阵与资格边界

| Surface | 实际覆盖 | 本轮覆盖层级／版本 | 仍未验 |
|---|---|---|---|
| 共享目录缓存 | endpoint／账号／协议分桶、同身份去重、磁盘重载、旧无归属缓存忽略、完整空目录仅撤销当前桶、错误／不完整列表不续期、未来时间戳强制刷新、拒绝重定向 | 本地 CLI 源码 + mocked fetch | 多进程磁盘写入竞争、真实服务返回及推理能力 |
| Claude 启动器 | 当前账号 Messages chat 列表、上下文／[1m]、已知空与非 chat 不启用静态 fallback、错误协议 ID 不借用 | CLI 单测 | 实际完整启动器 TUI 的账号切换 |
| Claude 原生菜单适配 | 一小时时效、未来／过期不注入、最终 token/key／路由、个人／project/local／CLAUDE_CONFIG_DIR／显式 --settings 保留、临时文件返回及 fixture 清理 | 最低门槛 2.1.242；fixture package 元数据 2.1.316，**没有执行真实 Claude Code 包** | 真实 `/model` TUI、企业 managed settings、全部 flag 组合、SIGKILL 后残留 |
| Codex 启动器／原生目录参数 | 当前 OpenAI 桶、已知空不兜底；显式个人目录、profile、-c/--config、关闭发现保留；目录参数不持久化；既有模型选择保留 | 最低门槛 0.162.1；fixture package 元数据 0.166.0，**没有执行真实 Codex 包** | 服务端完整 ModelsResponse、真实 `/model` TUI 和推理／工具兼容 |
| Gemini 启动器／Manual 适配 | 原生 generateContent 目录、全分页／失败后页／重复 cursor、身份隔离、完整空撤销；新鲜目录、保留设置／禁用／冲突、临时 defaults | 本轮既有适配器 fixture，门槛 0.51.0 | 本轮未重跑 Gemini 真核心/TUI；Issue 中既有 0.51.0 实测仅作为历史证据 |
| Grok | 仅 OpenAI 桶、chat／既有家族过滤、已知空／不合格不兜底、不借 Messages 目录；保留非 tako-* 模型块和不落原始 key 的已有测试 | CLI helper／配置文件单测 | 真实 Grok 版本／TUI／工具能力；现有家族和 reasoning 元数据并非本轮实测能力证明 |
| Pi 启动器 | 仅 Messages 桶，不借 OpenAI ID；账号／地址隔离、已知空不兜底；保留原静态 fallback 于目录未知状态 | CLI helper 单测 | 静态 fallback 远端可用性；Pi 真核心、用户默认选择／恢复行为 |
| Pi / Pi Web 启动契约 | getEnvVars 返回当前 TAKO_BASE_URL／TAKO_API_KEY／TAKO_HOME；缺 key 显式空串；既有 packages、skills、compaction 合并单测 | 适配器对象／纯 helper，**没有执行 Pi/Pi Web** | 外部扩展是否消费字段、Web 子进程透传、账号缓存／偏好／models.json 保留；这些仍依赖外部修复 |
| 临时注入与退出 | Claude/Gemini adapter 的 cleanupFiles、fixture 删除；Windows handoff 生成脚本中清理位于 child 之后 | macOS 单测；Windows 仅脚本断言 | Windows/Linux 真实运行、所有退出路径、强杀后的清理；本轮无真实 TUI 截图 |

## Pi 外部依赖核验

2026-11-16 17:35–17:44 CST 只读 GitHub API：`Barrierml/tako-pi` 为 public，main 仍为 `a54aec7c0620e569b1026252d0bdca16ba272981`。回读该 SHA 的 provider/auth/package/model-picker 源码，确认共享缓存、`models.json` 整文件替换、固定官方路由与旧配置 key 命令，以及无账号归属的偏好。

没有向扩展仓写入、没有执行下载源码、没有修改用户 `models.json`。固定扩展版本忽略 CLI 的新身份字段，因此不能用 CLI 环境测试宣称 Pi 原生菜单已修。失败时该版本仍会回落无归属旧缓存，不能称安全降级。完整窄任务、缓存／路由／偏好契约及离线矩阵见 [PI-DEPENDENCY.md](../../models/PI-DEPENDENCY.md)。

## 阶段回帖与工单交接

- 本轮阶段评论：<https://github.com/tako-dev/cli/issues/29#issuecomment-6913165345>，实际作者 `Barrierml`，2026-11-16 17:56 CST 发布并回读。API 核对目标 Issue、作者及完整正文均一致；结果见 [stage-comment-receipt.json](stage-comment-receipt.json)。
- `hq ticket turn` 已记录本轮候选与验证结果。随后实际执行 `hq ticket done`，返回 **exit 2**：`拒绝 done：还有活进程：pid 65533 活着`，因此工单尚未进入 done。
- HQ 的 done 会先回收工作树；有活进程时拒绝，退出后则会强制删除工作树。保留本轮候选与全部验收日志的工作树外归档，并在最终 HQ turn 中登记路径和逐文件摘要；父方应在执行进程退出后，先确认完整归档可恢复，再完成施工阶段关单及独立验收交接。不通过终止自身进程或改写 HQ 数据绕过保护。

## 后继与回滚

- 本候选交独立 reviewer 按 base + candidate SHA 复核；本轮没有独立验收结论，不自签批准，不合入或发布。
- 父方另行授权 Pi 扩展实现／真核心菜单验收，及基线类型问题修复；Issue #29 保持未完成，不因本地候选通过测试关闭整个需求。
- 未提交候选回滚应按 manifest 文件逐项处理并保留证据，不运行 `git reset --hard` 或覆盖已有半成品。
- 本轮没有生产启用或发布，因此不存在需要执行的线上回滚。
