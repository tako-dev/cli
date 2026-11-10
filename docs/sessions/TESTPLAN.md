# sessions 测试计划

## 已有覆盖

`tests/unit.session-resume.test.ts`

| 编号 | 场景 | 断言 |
|---|---|---|
| TP-SESS-01 | Claude 恢复参数 | `["--resume", id]` |
| TP-SESS-02 | Codex 恢复参数 | `["resume", id, "-C", cwd]` |
| TP-SESS-03 | Grok 恢复参数 | `["--resume", id]` |
| TP-SESS-04 | Pi 恢复参数 | `["--session", id]` |
| TP-SESS-05 | Gemini 不支持恢复 | 抛错 |
| TP-SESS-06 | 原 cwd 存在 | 用原 cwd |
| TP-SESS-07 | 原 cwd 不存在 | 回退到 fallback cwd |
| TP-SESS-08 | source 文件不存在 | 抛错 |

`tests/unit.resume-launch-options.test.ts`

| 编号 | 场景 | 断言 |
|---|---|---|
| TP-RESUME-01 | 上次勾过 skip-permissions | 补 `--dangerously-skip-permissions` |
| TP-RESUME-02 | 上次没勾 | 不补 |
| TP-RESUME-03 | 无记忆 | 默认补 |
| TP-RESUME-04 | args 已带 flag | 不重复 |
| TP-RESUME-05 | Codex bypass-sandbox | 补 `--dangerously-bypass-approvals-and-sandbox` |
| TP-RESUME-06 | 无危险 flag 的 client | 不补 |
| TP-RESUME-07 | 恢复项目路径 | 传给项目历史读取 |
| TP-RESUME-08 | 按 session.model 恢复窗口 | tako catalog 262K |
| TP-RESUME-09 | provider.modelContextWindow | 只对 provider 自己的 model 生效 |
| TP-RESUME-10 | `[1m]` 变体 | 1M |
| TP-RESUME-11 | claude-subscription | 不注入 context env |

## 不变量

- INV-SESS-01：恢复路径必须把 `resume: true` 和 `resumeModelId` 传给 launcher。
- INV-SESS-02：危险跳过 flag 只在用户上次勾过、或没有历史时默认补；显式关掉要尊重。
- INV-SESS-03：恢复时按 session.model 解析窗口，不能用 provider.model 顶替。

## 运行

```bash
bun test tests/unit.session-resume.test.ts tests/unit.resume-launch-options.test.ts
```
