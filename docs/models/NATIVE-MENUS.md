# 原生模型菜单

Tako 启动器的模型列表与客户端内部的模型菜单是两个独立入口。Tako / custom provider 的启动器列表使用按服务地址、协议和凭据隔离的 `/v1/models` 缓存；客户端原生菜单使用各自公开的配置接口，不把同一份配置写给所有客户端。

## Claude Code

Claude Code 2.1.242 及以上支持 [`modelPicker`](https://code.claude.com/docs/en/settings-reference#modelpicker)。Tako 在启动时从真实受管客户端包读取版本，未知版本或低于该版本时不发送新字段。

当前账号的 chat 模型转换为 `modelPicker.options` 中的 `model`、`label` 和可选 `description`。模型 ID 与启动器保持一致，包括已有的 `[1m]` 规则。列表追加到内置选项，不设置 `replaceBuiltInOptions`。此字段只写入临时 `--settings` 文件，退出时随现有启动文件清理；不修改个人 `~/.claude/settings.json`。如果个人设置已有 `modelPicker`，Tako 不覆盖它。组织的模型允许列表和受管配置仍由 Claude Code 执行。

无账号目录、订阅直连或不支持的版本继续使用客户端原有菜单。

## Codex

已核实的保守支持基线为 Codex 0.162.1，依据该版本的 [`config.schema.json`](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/config.schema.json)。Tako / custom API-key provider 在受支持版本启动时，通过临时 `-c model_providers.tako.model_catalog_url=...` 参数启用现有推理地址下的 `/models?api_type=openai`。不把此新字段持久化到个人配置。

[Codex 原生目录协议](https://developers.openai.com/codex/model-catalogs)要求服务端返回完整的 `ModelsResponse`，包括模型指令和能力元数据。Codex 自己携带当前账号认证、实际 `client_version` 并验证响应；Tako 不伪造能力、指令或把简化缓存转换成原生目录。只有 OpenAI `data[]` 响应的服务并不满足原生目录协议：启动器仍可显示其模型，但内部菜单需要服务端支持 Codex 原生格式。

用户的 `model_catalog_json`、已有 `model_providers.tako.model_catalog_url` 和显式 `features.api_key_model_discovery = false` 保持优先；配置存在 profile 或启动参数选择 profile 时不注入目录覆盖，让 Codex 自行解析 profile 的目录设置。订阅直连、未知版本和旧版本也不注入此参数。不会移除用户目录文件、启用被用户关闭的发现或切换到其他目录服务。

## 其余客户端

Grok 已通过现有 `tako-*` 模型块接入原生菜单；个人模型和菜单过滤策略需要保留。Pi / Pi Web 的模型注册由现有 `tako-pi` 扩展提供，不在本次修改中新增第二个目录写入器。该外部扩展的账号隔离与配置保留需另行核验，CLI 的缓存修复不代表扩展缓存已修复。

Gemini 启动器从当前账号的 Gemini 原生 `/v1beta/models` 目录选择模型，只列出宣告 `generateContent` 的模型并传递原始 `--model` ID，不混用 OpenAI / Messages 目录。Gemini 0.51.0 及以上的内部 Manual 菜单通过低优先级 `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` 临时文件接入：保留继承的原默认文件内容（相对路径按实际目标项目解析；显式本次启动默认路径不注入覆盖），添加 `modelDefinitions`、显式 `customAliases[id].modelConfig.model` 和 `modelIdResolutions[id].default`，不继承默认推理参数，不修改高优先级系统文件或用户 HOME。最终启动地址、协议和凭据对应的缓存必须在一小时内；显式完整成功的空目录清除该账号旧列表，失败不更新缓存时间戳，过期目录不生成原生覆盖。退出后清理临时文件，不把上一账号目录持久化到个人设置。

用户、工作区或系统设置显式关闭动态菜单时不注入；任一层已有同名定义、别名或 ID 路由时跳过该模型。保留既有模型选择和默认设置；存在低层 `aliases` / `overrides` 集合时不注入目录。Gemini 内置与辅助任务别名不由远端目录接管。无法安全解析的 JSONC、损坏文件、超大配置或包含环境展开的文件均原样保留，不生成覆盖；缺少客户端版本也不注入。原有认证设置已正确时仍继续独立目录准备，但无法解析的个人认证设置不覆盖。发现和启动适配测试不代表真实客户端菜单、工具调用、辅助模型请求或真实服务上的推理已通过验收。

## 验证

`tests/unit.native-model-menus.test.ts` 覆盖版本门槛、当前账号 chat 列表、个人菜单保留、临时配置清理和 Codex 显式目录/关闭发现的保留。`tests/unit.gemini-native-menu.test.ts` 在隔离子进程调用真实 Gemini 适配器，覆盖默认文件保留、当前账号切换、目标项目禁用设置、配置冲突与过期目录不注入。测试使用临时目录和假凭据，不调用真实模型，不修改个人配置；它们不替代真实客户端菜单或推理验证。

可对独立安装的 `@google/gemini-cli-core@0.51.0` 运行 `bun tests/fixtures/gemini-core-resolution.ts <core-package-directory>`，离线检查实际 `ModelConfigService` 的菜单选项、原始 ID 路由与无默认生成参数继承；该检查不调用模型、不声称完整 TUI 或推理兼容。配置入口与优先级依据：[settings loader](https://github.com/google-gemini/gemini-cli/blob/v0.51.0/packages/cli/src/config/settings.ts)、[模型配置](https://github.com/google-gemini/gemini-cli/blob/v0.51.0/packages/core/src/services/modelConfigService.ts)、[内置别名](https://github.com/google-gemini/gemini-cli/blob/v0.51.0/packages/core/src/config/defaultModelConfigs.ts)。
