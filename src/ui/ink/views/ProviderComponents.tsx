/**
 * Provider 管理用的共享组件和常量
 */

import React from "react";
import { Box, Text } from "ink";
import type { Provider, ProviderType } from "../../../providers/types";
import { PROVIDER_TYPE_NAMES, getDefaultModel, getModelChoices, SUBAGENT_MODEL_CC_DEFAULT } from "../../../providers/types";

// ─── Style constants ────────────────────────────────

export const PROV_STYLE: Record<ProviderType, { icon: string; color: string }> = {
  "claude-subscription": { icon: "✦", color: "yellow" },
  "codex-subscription":  { icon: "◈", color: "blue" },
  tako:                  { icon: "🐙", color: "cyan" },
  anthropic:             { icon: "△", color: "magenta" },
  deepseek:              { icon: "🔮", color: "blue" },
  xiaomi:                { icon: "🟠", color: "yellow" },
  custom:                { icon: "⚙", color: "gray" },
};

export const TAB_STYLE: Record<string, { icon: string; color: string }> = {
  "claude-code": { icon: "✦", color: "yellow" },
  codex:         { icon: "◈", color: "blue" },
  grok:          { icon: "✶", color: "white" },
  agy:           { icon: "▲", color: "green" },
  pi:            { icon: "π", color: "magenta" },
  "pi-web":      { icon: "◎", color: "magenta" },
};

export const ADD_TYPES: ProviderType[] = [
  "claude-subscription", "codex-subscription", "tako", "anthropic", "deepseek", "xiaomi", "custom",
];

// ─── Provider Card ──────────────────────────────────

export function ProviderCard({ provider, focused, bound, isDefault, zh }: {
  provider: Provider; focused: boolean; bound: boolean; isDefault: boolean; zh: boolean;
}) {
  const ps = PROV_STYLE[provider.type] || PROV_STYLE.custom;
  const typeName = zh ? PROVIDER_TYPE_NAMES[provider.type]?.zh : PROVIDER_TYPE_NAMES[provider.type]?.en;
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "bold" : "round"}
      borderColor={focused ? ps.color : (bound ? ps.color : "gray")}
      paddingX={2}
      paddingY={0}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={ps.color} bold>{ps.icon}</Text>
          <Text bold={focused || bound} color={focused ? ps.color : undefined}>{provider.name}</Text>
          {isDefault && <Text color="yellow">★ {zh ? "默认" : "default"}</Text>}
          {provider.builtin && <Text dimColor>[built-in]</Text>}
        </Box>
        <Box gap={1}>
          {bound
            ? <Text color={ps.color} bold>● {zh ? "已绑定" : "bound"}</Text>
            : <Text dimColor>○ {zh ? "未绑定" : "unbound"}</Text>
          }
        </Box>
      </Box>
      <Box gap={1}>
        <Text dimColor>{typeName}</Text>
        {provider.model && <Text dimColor>·</Text>}
        {provider.model && <Text dimColor>{provider.model}</Text>}
        {provider.email && <Text dimColor>·</Text>}
        {provider.email && <Text dimColor>{provider.email}</Text>}
        {provider.apiKey && <Text dimColor>·</Text>}
        {provider.apiKey && <Text dimColor>Key: {provider.apiKey.slice(0, 8)}•••</Text>}
      </Box>
      {focused && (
        <Box marginTop={0}>
          <Text color={ps.color} dimColor>
            Enter {zh ? "绑定到当前工具" : "bind to this tool"}
            {provider.type !== "claude-subscription" && provider.type !== "codex-subscription"
              ? `  ·  k ${zh ? "修改 Key" : "edit key"}`
              : ""}
            {"  ·  "}d {zh ? "详情/操作" : "detail/actions"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Input / Detail Screens ─────────────────────────

type Screen = "add-key" | "add-url" | "add-model" | "add-ctx";

export function InputScreen({ screen, addType, addKey, addUrl, addModel, addCtx, rowIdx, zh }: {
  screen: Screen; addType: ProviderType; addKey: string; addUrl: string; addModel: string; addCtx?: string; rowIdx: number; zh: boolean;
}) {
  const s = PROV_STYLE[addType] || PROV_STYLE.custom;
  const typeName = zh ? PROVIDER_TYPE_NAMES[addType]?.zh : PROVIDER_TYPE_NAMES[addType]?.en;
  const choices = screen === "add-model" ? getModelChoices(addType) : undefined;

  // 列表选择模式（如 DeepSeek 模型选择）
  if (choices) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box borderStyle="bold" borderColor={s.color} paddingX={3} paddingY={1} flexDirection="column">
          <Box gap={1} marginBottom={1}>
            <Text color={s.color} bold>{s.icon}</Text>
            <Text bold color={s.color}>{typeName}</Text>
            <Text dimColor>— {zh ? "选择模型" : "Select Model"}</Text>
          </Box>
          {choices.map((m, i) => {
            const focused = rowIdx === i;
            return (
              <Box key={m} paddingLeft={1} gap={1}>
                <Text color={focused ? s.color : undefined} bold={focused}>{focused ? "▸" : " "}</Text>
                <Text bold={focused} color={focused ? s.color : undefined}>{m}</Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
          <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "确认" : "confirm"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "取消" : "cancel"}</Text>
        </Box>
      </Box>
    );
  }

  // 自由输入模式
  const fieldLabel = screen === "add-key" ? (zh ? "输入 API Key" : "Enter API Key")
    : screen === "add-url" ? "Base URL"
    : screen === "add-ctx" ? (zh ? "上下文窗口（tokens，可留空）" : "Context Window (tokens, optional)")
    : (zh ? "模型" : "Model");
  const value = screen === "add-key" ? addKey
    : screen === "add-url" ? addUrl
    : screen === "add-ctx" ? (addCtx ?? "")
    : addModel;
  const defaultHint = screen === "add-url" ? "https://your-proxy.com"
    : screen === "add-ctx" ? (zh ? "如 200000；catalog 没有该模型时建议填写" : "e.g. 200000; recommended if model is unknown to catalog")
    : screen === "add-model" ? (getDefaultModel(addType) || (zh ? "留空使用默认" : "leave empty")) : undefined;
  const btnLabel = screen === "add-url" ? (zh ? "下一步" : "next")
    : screen === "add-ctx" ? (zh ? "保存" : "save")
    : screen === "add-model" ? (zh ? "保存" : "save")
    : (zh ? "确认" : "confirm");
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="bold" borderColor={s.color} paddingX={3} paddingY={1} flexDirection="column">
        <Box gap={1} marginBottom={1}>
          <Text color={s.color} bold>{s.icon}</Text>
          <Text bold color={s.color}>{typeName}</Text>
          <Text dimColor>— {fieldLabel}</Text>
        </Box>
        {screen === "add-key" && addType === "xiaomi" && (
          <Text dimColor>  {zh
            ? "sk- 开头走按量付费，tp- 开头走 Token Plan 订阅（自动识别）"
            : "sk- = pay-as-you-go, tp- = Token Plan subscription (auto-detected)"}</Text>
        )}
        {defaultHint && <Text dimColor>  {zh ? "默认" : "Default"}: {defaultHint}</Text>}
        <Box marginTop={defaultHint ? 1 : 0}>
          <Text color={s.color} bold>{"›"} </Text>
          <Text>{value || defaultHint || ""}</Text>
          <Text color={s.color}>█</Text>
        </Box>
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>Enter</Text><Text dimColor>{btnLabel}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "取消" : "cancel"}</Text>
      </Box>
    </Box>
  );
}

export function DetailScreen({ provider, defaultId, detailActions, detailIdx, zh }: {
  provider: Provider; defaultId?: string; detailActions: string[]; detailIdx: number; zh: boolean;
}) {
  const s = PROV_STYLE[provider.type] || PROV_STYLE.custom;
  const typeName = zh ? PROVIDER_TYPE_NAMES[provider.type]?.zh : PROVIDER_TYPE_NAMES[provider.type]?.en;
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="bold" borderColor={s.color} paddingX={3} paddingY={1} flexDirection="column">
        <Box gap={1}>
          <Text color={s.color} bold>{s.icon}</Text>
          <Text bold color={s.color}>{provider.name}</Text>
          {provider.id === defaultId && <Text color="yellow"> ★ {zh ? "默认" : "default"}</Text>}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box gap={1}>
            <Text dimColor>{zh ? "类型" : "Type"}:</Text>
            <Text>{typeName}</Text>
            {provider.builtin && <Text dimColor>[built-in]</Text>}
          </Box>
          {provider.model && (
            <Box gap={1}><Text dimColor>{zh ? "模型" : "Model"}:</Text><Text>{provider.model}</Text></Box>
          )}
          {provider.type !== "claude-subscription" && provider.type !== "codex-subscription" && (
            <Box gap={1}>
              <Text dimColor>{zh ? "子代理" : "Subagent"}:</Text>
              <Text>
                {provider.subagentModel === SUBAGENT_MODEL_CC_DEFAULT
                  ? (zh ? "Claude Code 默认" : "CC default")
                  : provider.subagentModel
                    ? provider.subagentModel
                    : (zh ? "跟随主模型" : "follow main")}
              </Text>
            </Box>
          )}
          {provider.email && (
            <Box gap={1}><Text dimColor>Email:</Text><Text>{provider.email}</Text></Box>
          )}
          {provider.apiKey && (
            <Box gap={1}><Text dimColor>Key:</Text><Text>{provider.apiKey.slice(0, 12)}•••</Text></Box>
          )}
          {provider.baseUrl && (
            <Box gap={1}><Text dimColor>URL:</Text><Text>{provider.baseUrl}</Text></Box>
          )}
        </Box>
      </Box>
      <Box gap={1} marginTop={1}>
        {detailActions.map((a, i) => {
          const label = a === "default" ? `⭐ ${zh ? "设为默认" : "Set Default"}`
            : a === "rekey" ? `🔑 ${zh ? "修改 Key" : "Change Key"}`
            : a === "submodel" ? `🧩 ${zh ? "子代理模型" : "Subagent Model"}`
            : a === "relogin" ? `🔄 ${zh ? "重新登录" : "Re-login"}`
            : a === "delete" ? `🗑️  ${zh ? "删除" : "Delete"}`
            : `← ${zh ? "返回" : "Back"}`;
          const focused = i === detailIdx;
          return (
            <Box key={a} borderStyle={focused ? "bold" : "round"} borderColor={focused ? "cyan" : "gray"} paddingX={2}>
              <Text bold={focused} color={focused ? "cyan" : undefined} dimColor={!focused}>{label}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>←→</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "确认" : "confirm"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}

export function AddTypeScreen({ rowIdx, zh }: { rowIdx: number; zh: boolean }) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="round" borderColor="gray" paddingX={3} paddingY={0}>
        <Text bold>➕ {zh ? "添加服务商" : "Add Provider"}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} gap={0}>
        {ADD_TYPES.map((tp, i) => {
          const s = PROV_STYLE[tp] || PROV_STYLE.custom;
          const focused = rowIdx === i;
          const typeName = zh ? PROVIDER_TYPE_NAMES[tp]?.zh : PROVIDER_TYPE_NAMES[tp]?.en;
          const isLogin = tp === "claude-subscription" || tp === "codex-subscription";
          return (
            <Box
              key={tp}
              borderStyle={focused ? "bold" : "round"}
              borderColor={focused ? s.color : "gray"}
              paddingX={2}
              paddingY={0}
            >
              <Box gap={1}>
                <Text color={s.color} bold>{s.icon}</Text>
                <Text bold={focused} color={focused ? s.color : undefined}>{typeName}</Text>
                {isLogin && <Text dimColor>({zh ? "登录授权" : "login auth"})</Text>}
                {!isLogin && <Text dimColor>({zh ? "填写 Key" : "enter key"})</Text>}
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "确认" : "confirm"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}

export function SubmodelScreen({
  provider,
  rowIdx,
  zh,
}: {
  provider: Provider;
  rowIdx: number;
  zh: boolean;
}) {
  const cur = provider.subagentModel;
  const curIdx = cur === SUBAGENT_MODEL_CC_DEFAULT ? 1 : cur ? 2 : 0;
  const items = [
    {
      key: "follow",
      label: zh ? "跟随主模型" : "Follow main model",
      desc: zh ? "subagent / 别名 / utility 全部锁定到主模型（推荐）" : "Pin subagent / alias / utility to main model (recommended)",
    },
    {
      key: "cc-default",
      label: zh ? "Claude Code 默认" : "Claude Code default",
      desc: zh ? "不锁定，由 Claude Code 自己解析（settings.json / 环境变量可接管）" : "No pinning; Claude Code resolves on its own (settings.json / env can take over)",
    },
    {
      key: "custom",
      label: zh ? "指定模型…" : "Custom model…",
      desc: zh ? "锁定到你填写的模型 ID（如主模型便宜 + subagent 强力）" : "Pin to a model ID you enter (e.g. cheap main + strong subagent)",
    },
  ];
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="bold" borderColor="cyan" paddingX={3} paddingY={1} flexDirection="column">
        <Box gap={1} marginBottom={1}>
          <Text bold color="cyan">🧩 {zh ? "子代理模型" : "Subagent Model"}</Text>
          <Text dimColor>— Claude Code</Text>
        </Box>
        {items.map((it, i) => {
          const focused = rowIdx === i;
          return (
            <Box key={it.key} flexDirection="column" paddingLeft={1}>
              <Box gap={1}>
                <Text color={focused ? "cyan" : undefined} bold={focused}>{focused ? "▸" : " "}</Text>
                <Text bold={focused} color={focused ? "cyan" : undefined}>
                  {it.label}{i === curIdx ? (zh ? "（当前）" : " (current)") : ""}
                </Text>
              </Box>
              {focused && <Text dimColor>  {it.desc}</Text>}
            </Box>
          );
        })}
        {curIdx === 2 && (
          <Box marginTop={1}><Text dimColor>{zh ? "当前指定" : "Current"}: {cur}</Text></Box>
        )}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "确认" : "confirm"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}

export function SubmodelCustomScreen({ subModelInput, zh }: { subModelInput: string; zh: boolean }) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="bold" borderColor="cyan" paddingX={3} paddingY={1} flexDirection="column">
        <Box gap={1} marginBottom={1}>
          <Text bold color="cyan">🧩 {zh ? "指定子代理模型" : "Custom Subagent Model"}</Text>
          <Text dimColor>— Claude Code</Text>
        </Box>
        <Text dimColor>  {zh ? "输入模型 ID；留空保存 = 恢复跟随主模型" : "Enter a model ID; save empty = follow main model"}</Text>
        <Box marginTop={1}>
          <Text color="cyan" bold>{"›"} </Text>
          <Text>{subModelInput}</Text>
          <Text color="cyan">█</Text>
        </Box>
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "保存" : "save"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}
