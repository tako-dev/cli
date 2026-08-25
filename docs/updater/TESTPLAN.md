# updater 测试计划

## 已有覆盖

| 文件 | 内容 |
|---|---|
| `tests/unit.update-logic.test.ts` | 更新命令路径、参数、启动自动更新开关 |
| `tests/pre-release.test.ts` | 发布前检查 CLI 目录和更新命令不含 `-g` |

## 场景

### TP-UPD-01 更新命令

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-UPD-01a | CLI 更新命令 | 使用 Tako 本地 Bun，命令包含 `update tako-cli --latest` |
| TP-UPD-01b | CLI 安装命令 | 使用 `add tako-cli@latest` |
| TP-UPD-01c | CLI 安装参数 | 不额外添加全局安装或依赖裁剪参数 |

### TP-UPD-02 启动自动更新

| 编号 | 场景 | 期望 |
|---|---|---|
| TP-UPD-02a | dev 模式启动 | 不调用自动更新 |
| TP-UPD-02b | 非 dev 模式启动 | 调用自动更新 |
| TP-UPD-02c | 快捷启动路径 | 与交互式入口共用同一个开关，不额外绕过 |

## 运行方式

```bash
cd packages/cli

bun test tests/unit.update-logic.test.ts
bun run build
bun test tests/pre-release.test.ts
```
