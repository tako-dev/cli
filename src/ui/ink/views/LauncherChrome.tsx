/**
 * Launcher 装饰与子区域组件（Header 徽章、配额行、参数列表、底部快捷键栏）
 */
import React from "react";
import { Box, Text, useStdout } from "ink";
import type { LaunchOption } from "../../../clients";
import type { Provider } from "../../../providers/types";
import type { OfficialQuota } from "../../../quota";
import { apiErrorText } from "../../../api-error";
import { getGroupSelection } from "../../shared/launch-options";
import type { OptionRow } from "../../shared/types";
import type { LauncherClientData } from "../../shared/types";
import type { LauncherFocus } from "../launcher-keys";

export const CLIENT_STYLE: Record<string, { icon: string; color: string }> = {
  "claude-code": { icon: "✦", color: "yellow" },
  codex:         { icon: "◈", color: "blue" },
  agy:           { icon: "▲", color: "green" },
  grok:          { icon: "✶", color: "white" },
  pi:            { icon: "π", color: "magenta" },
  "pi-web":      { icon: "◎", color: "magenta" },
};
export const DEFAULT_STYLE = { icon: "▪", color: "white" };

export function Divider({ color }: { color?: string }) {
  const { stdout } = useStdout();
  const w = Math.max((stdout.columns || 80) - 6, 20);
  return <Box marginY={0}><Text dimColor color={color}>{"─".repeat(w)}</Text></Box>;
}

function remainColor(remainPct: number): string {
  return remainPct > 30 ? "green" : remainPct > 10 ? "yellow" : "red";
}

export function ProviderBadge({ provider, zh }: { provider: Provider | undefined; zh: boolean }) {
  if (!provider) {
    return <Text color="yellow">⚠ {zh ? "未绑定" : "no provider"}</Text>;
  }
  const TYPE_LABELS: Record<string, { zh: string; en: string; color: string; icon: string }> = {
    "tako":                  { zh: "Tako 代理",     en: "Tako Proxy",      color: "cyan",    icon: "🐙" },
    "claude-subscription":   { zh: "Claude 官方",   en: "Claude Official", color: "yellow",  icon: "✦"  },
    "codex-subscription":    { zh: "Codex 官方",    en: "Codex Official",  color: "blue",    icon: "◈"  },
    "anthropic":             { zh: "Anthropic 直连", en: "Anthropic Direct", color: "yellow", icon: "✦"  },
    "deepseek":              { zh: "DeepSeek",      en: "DeepSeek",        color: "magenta", icon: "◇"  },
    "xiaomi":                { zh: "小米 MiMo",     en: "Xiaomi MiMo",     color: "yellow",  icon: "🟠" },
    "custom":                { zh: "自定义",        en: "Custom",          color: "gray",    icon: "▪"  },
  };
  const meta = TYPE_LABELS[provider.type] ?? TYPE_LABELS.custom;
  const label = zh ? meta.zh : meta.en;
  let email = provider.email ?? "";
  if (email.length > 0) {
    const [local, domain] = email.split("@");
    if (local && domain) email = local.length > 14 ? `${local.slice(0, 12)}…@${domain}` : email;
  }
  return (
    <>
      <Text color={meta.color}>{meta.icon} {label}</Text>
      {email && <Text dimColor> · {email}</Text>}
    </>
  );
}

export function QuotaLine({ quota, zh }: { quota: OfficialQuota; zh: boolean }) {
  if (quota.status === "unsupported") return null;

  if (quota.status === "error") {
    return <Text dimColor>💰 {apiErrorText(quota.hint, zh ? "用量获取失败" : "quota unavailable")}</Text>;
  }

  if (quota.provider === "tako") {
    const hasLimits = !!(quota.primary?.costLimit || quota.secondary?.costLimit || quota.daily?.costLimit);
    if (!hasLimits) {
      const slot = quota.daily ?? quota.primary ?? quota.secondary;
      if (!slot) return null;
      const used = slot.costUsed ?? 0;
      return (
        <Text dimColor>
          💰 {zh ? "今日" : "Today"}: <Text color="green">${used.toFixed(2)}</Text>
        </Text>
      );
    }
  }

  const labelOf = (mins: number | undefined, fallbackH: number, fallbackD?: number): string => {
    if (mins && mins >= 1440) return `${Math.round(mins / 1440)}d`;
    if (mins) return `${Math.round(mins / 60)}h`;
    return fallbackD ? `${fallbackD}d` : `${fallbackH}h`;
  };
  const remainOf = (usedPct: number) => Math.max(0, Math.min(100, 100 - Math.round(usedPct)));

  const parts: React.ReactNode[] = [];
  const pushChunk = (key: string, label: string, usedPct: number) => {
    if (parts.length) parts.push(<Text key={`sep-${key}`} dimColor> · </Text>);
    const remain = remainOf(usedPct);
    parts.push(
      <React.Fragment key={key}>
        {`${label} 剩 `}<Text color={remainColor(remain)}>{remain}%</Text>
      </React.Fragment>,
    );
  };

  if (quota.primary) pushChunk("primary", labelOf(quota.primary.windowMinutes, 5), quota.primary.usedPct);
  if (quota.secondary) pushChunk("secondary", labelOf(quota.secondary.windowMinutes, 24, 7), quota.secondary.usedPct);
  if (quota.modelLimits?.opus) pushChunk("opus", "opus", quota.modelLimits.opus.usedPct);

  if (!parts.length) return null;
  return <Text dimColor>💰 {parts}</Text>;
}

export function LauncherClientTabs({
  clients,
  clientIdx,
  color,
  showInstallBanner,
  installing,
  clientName,
  zh,
}: {
  clients: LauncherClientData[];
  clientIdx: number;
  color: string;
  showInstallBanner: boolean;
  installing: boolean;
  clientName: string;
  zh: boolean;
}) {
  return (
    <>
      <Box marginTop={1} gap={1} justifyContent="center">
        <Text dimColor>‹</Text>
        {clients.map((cd, i) => {
          const s = CLIENT_STYLE[cd.client.id] || DEFAULT_STYLE;
          const active = i === clientIdx;
          return active ? (
            <Box key={cd.client.id} borderStyle="bold" borderColor={s.color} paddingX={1}>
              <Text color={s.color} bold>{s.icon} {cd.client.name}</Text>
            </Box>
          ) : (
            <Box key={cd.client.id} borderStyle="single" borderColor="gray" paddingX={1}>
              <Text dimColor>{s.icon} {cd.client.name}</Text>
            </Box>
          );
        })}
        <Text dimColor>›</Text>
      </Box>
      <Divider color={color} />
      {showInstallBanner && (
        <Box paddingLeft={1} gap={1}>
          {installing ? (
            <Text color="yellow">
              ⏳ {zh ? `正在安装 ${clientName}...` : `Installing ${clientName}...`}
            </Text>
          ) : (
            <Text color="yellow">
              ⚠ {zh
                ? `尚未安装 ${clientName} — 按 i 或直接回车一键安装`
                : `${clientName} is not installed — press i or Enter to install`}
            </Text>
          )}
        </Box>
      )}
    </>
  );
}

export function LauncherOptionsSection({
  optionRows,
  options,
  enabled,
  focusedArea,
  optionIdx,
  color,
  currentProv,
  provName,
  zh,
}: {
  optionRows: OptionRow[];
  options: LaunchOption[];
  enabled: Set<string>;
  focusedArea: boolean;
  optionIdx: number;
  color: string;
  currentProv: Provider | undefined;
  provName: string;
  zh: boolean;
}) {
  return (
    <>
      <Divider color={color} />
      {optionRows.map((row, idx) => {
        const focused = focusedArea && idx === optionIdx;
        if (row.kind === "flag") {
          const opt = row.opt;
          const on = enabled.has(opt.id);
          return (
            <Box key={opt.id} paddingLeft={1}>
              <Box flexGrow={1} gap={1}>
                <Text color={focused ? color : undefined} bold={focused}>
                  {focused ? "▸" : " "}
                </Text>
                <Text color={on ? color : undefined} bold={on}>{on ? "◉" : "○"}</Text>
                <Text bold={focused} color={focused ? color : undefined}>
                  {opt.label[zh ? "zh" : "en"] || opt.label.en}
                </Text>
                {focused && <Text dimColor>{opt.flag}</Text>}
              </Box>
              {focused && (
                <Text dimColor>{opt.description[zh ? "zh" : "en"] || opt.description.en}</Text>
              )}
            </Box>
          );
        }
        if (row.kind === "group") {
          const cur = getGroupSelection(options, enabled, row.group);
          const curLabel = cur ? cur.shortLabel : (zh ? "默认" : "Default");
          return (
            <Box key={`group-${row.group}`} paddingLeft={1}>
              <Box flexGrow={1} gap={1}>
                <Text color={focused ? color : undefined} bold={focused}>
                  {focused ? "▸" : " "}
                </Text>
                <Text bold={focused} color={focused ? color : undefined}>
                  {row.title}:
                </Text>
                <Text color={cur ? color : undefined}>
                  {curLabel}
                </Text>
                <Text dimColor>›</Text>
              </Box>
              {focused && (
                <Text dimColor>{zh ? "Enter 进入选择" : "Enter to pick"}</Text>
              )}
            </Box>
          );
        }
        return (
          <Box key="provider-entry" paddingLeft={1}>
            <Box flexGrow={1} gap={1}>
              <Text color={focused ? color : undefined} bold={focused}>
                {focused ? "▸" : " "}
              </Text>
              <Text bold={focused} color={focused ? color : undefined}>
                {row.title}:
              </Text>
              <Text color={currentProv ? color : "yellow"}>
                {currentProv ? provName : (zh ? "未配置" : "Not set")}
              </Text>
              <Text color="yellow">★</Text>
              <Text dimColor>›</Text>
            </Box>
            {focused && (
              <Text dimColor>{zh ? "Enter 切换或管理" : "Enter to switch / manage"}</Text>
            )}
          </Box>
        );
      })}
    </>
  );
}

export function LauncherFooter({
  focus,
  resumeUnsupported,
  zh,
}: {
  focus: LauncherFocus;
  resumeUnsupported: boolean;
  zh: boolean;
}) {
  return (
    <Box paddingX={2} marginTop={0} justifyContent="center" gap={2}>
      {focus === "search" ? (
        <>
          <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Enter</Text>
          <Text dimColor>{resumeUnsupported ? (zh ? "查看" : "open") : (zh ? "续接" : "resume")}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>→</Text><Text dimColor>{zh ? "详情" : "details"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Tab</Text><Text dimColor>{zh ? "切区" : "zone"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
        </>
      ) : focus === "options" ? (
        <>
          <Text dimColor bold>Space</Text><Text dimColor>{zh ? "开关" : "toggle"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "启动" : "launch"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Tab</Text><Text dimColor>{zh ? "切区" : "zone"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>/</Text><Text dimColor>{zh ? "搜会话" : "sessions"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>m</Text><Text dimColor>{zh ? "模型" : "model"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>p</Text><Text dimColor>{zh ? "服务商" : "provider"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>v</Text><Text dimColor>{zh ? "版本" : "version"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>q</Text><Text dimColor>{zh ? "退出" : "quit"}</Text>
        </>
      ) : (
        <>
          <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "启动" : "launch"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>Tab</Text><Text dimColor>{zh ? "切区" : "zone"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>/</Text><Text dimColor>{zh ? "搜会话" : "sessions"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>←→</Text><Text dimColor>{zh ? "切换工具" : "tool"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>m</Text><Text dimColor>{zh ? "模型" : "model"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>p</Text><Text dimColor>{zh ? "服务商" : "provider"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>v</Text><Text dimColor>{zh ? "版本" : "version"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>a</Text><Text dimColor>agent</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>s</Text><Text dimColor>{zh ? "统计" : "stats"}</Text>
          <Text dimColor>│</Text>
          <Text dimColor bold>q</Text><Text dimColor>{zh ? "退出" : "quit"}</Text>
        </>
      )}
    </Box>
  );
}
