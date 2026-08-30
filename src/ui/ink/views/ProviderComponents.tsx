/**
 * Provider 管理用的共享组件和常量
 */

import React from "react";
import { Box, Text } from "ink";
import type { Provider, ProviderType } from "../../../providers/types";
import { PROVIDER_TYPE_NAMES, getDefaultModel, getModelChoices } from "../../../providers/types";

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
  gemini:        { icon: "◆", color: "cyan" },
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
          <Text color={ps.color} dimColor>Enter {zh ? "绑定到当前工具" : "bind to this tool"}  ·  d {zh ? "详情/操作" : "detail/actions"}</Text>
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
