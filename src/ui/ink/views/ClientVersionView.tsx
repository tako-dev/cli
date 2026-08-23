/**
 * 客户端版本管理：列出 npm 历史版本，选定后切换到该版本
 *
 * 布局：
 *   Tab 栏（横向）切 client → 下方列出该 client 的最近 N 个版本
 *   ↑↓ 选择版本，Enter 安装，Esc 返回
 */
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getAllClients } from "../../../clients";
import {
  listAvailableVersions,
  installAtVersion,
  getInstalledVersion,
  type VersionInfo,
} from "../../../installer-versions";
import { getLocale } from "../../../i18n";

const VISIBLE_VERSIONS = 12;

const TAB_STYLE: Record<string, { icon: string; color: string }> = {
  "claude-code": { icon: "✦", color: "yellow" },
  codex:         { icon: "◈", color: "blue" },
  gemini:        { icon: "◆", color: "cyan" },
  pi:            { icon: "π", color: "magenta" },
  "pi-web":      { icon: "◎", color: "magenta" },
};

interface VersionState {
  loading: boolean;
  error?: string;
  versions: VersionInfo[];
  current: string | null;
}

export function ClientVersionView({ onDone }: { onDone: () => void }) {
  const clients = getAllClients();
  const zh = getLocale() === "zh";
  const [tabIdx, setTabIdx] = useState(0);
  const [rowIdx, setRowIdx] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [stateByClient, setStateByClient] = useState<Record<string, VersionState>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const current = clients[tabIdx];

  const loadFor = useCallback(async (clientId: string) => {
    setStateByClient((prev) => ({
      ...prev,
      [clientId]: { loading: true, versions: [], current: null },
    }));
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    try {
      const [versions, installed] = await Promise.all([
        listAvailableVersions(client.package),
        getInstalledVersion(client),
      ]);
      const tagged = versions.map((v) => ({ ...v, isCurrent: v.version === installed }));
      setStateByClient((prev) => ({
        ...prev,
        [clientId]: { loading: false, versions: tagged, current: installed },
      }));
    } catch (e) {
      setStateByClient((prev) => ({
        ...prev,
        [clientId]: {
          loading: false,
          error: (e as Error).message,
          versions: [],
          current: null,
        },
      }));
    }
  }, [clients]);

  // 切到当前 tab 时若未加载就拉一次（不依赖 stateByClient，否则每次状态更新都触发）
  useEffect(() => {
    if (!current) return;
    if (!stateByClient[current.id]) {
      loadFor(current.id);
    }
    // 注意：stateByClient 故意不放进 deps；只在 tab 切换时检查"是否需要 load"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdx, current?.id]);

  // 仅在 tab 切换时重置位置，避免 load 完成后位置被冲掉
  useEffect(() => {
    setRowIdx(0);
    setScrollTop(0);
  }, [tabIdx]);

  // 自动清除提示
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(t);
  }, [message]);

  const state = current ? stateByClient[current.id] : undefined;
  const versions = state?.versions ?? [];

  const doInstall = useCallback(async (version: string) => {
    if (!current || installing) return;
    setInstalling(version);
    try {
      await installAtVersion(current, version);
      setMessage(zh ? `✓ 已切换到 ${version}` : `✓ Switched to ${version}`);
      // 重新加载该 client 的版本（更新 current 标记）
      await loadFor(current.id);
    } catch (e) {
      setMessage(zh ? `✗ 安装失败：${(e as Error).message}` : `✗ Install failed: ${(e as Error).message}`);
    } finally {
      setInstalling(null);
    }
  }, [current, installing, loadFor, zh]);

  useInput((input, key) => {
    if (installing) return; // 安装中不响应键
    if (key.escape || input === "q") { onDone(); return; }

    if (key.leftArrow) {
      setTabIdx((p) => (p > 0 ? p - 1 : clients.length - 1));
      return;
    }
    if (key.rightArrow) {
      setTabIdx((p) => (p < clients.length - 1 ? p + 1 : 0));
      return;
    }

    if (input === "r") { // 手动刷新
      if (current) loadFor(current.id);
      return;
    }

    if (!versions.length) return;
    const max = versions.length - 1;
    if (key.upArrow) {
      setRowIdx((p) => {
        const next = Math.max(0, p - 1);
        if (next < scrollTop) setScrollTop(next);
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setRowIdx((p) => {
        const next = Math.min(max, p + 1);
        if (next >= scrollTop + VISIBLE_VERSIONS) setScrollTop(next - VISIBLE_VERSIONS + 1);
        return next;
      });
      return;
    }
    if (key.return) {
      const v = versions[rowIdx];
      if (v && !v.isCurrent) doInstall(v.version);
    }
  });

  const tabColor = TAB_STYLE[current?.id]?.color || "white";
  const slice = versions.slice(scrollTop, scrollTop + VISIBLE_VERSIONS);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="round" borderColor="gray" paddingX={3}>
        <Text bold>📦 {zh ? "客户端版本管理" : "Client Versions"}</Text>
        {message && <Text color={message.startsWith("✓") ? "green" : "red"}>  {message}</Text>}
      </Box>

      {/* Tab */}
      <Box marginTop={1} gap={1} justifyContent="center">
        {clients.map((c, i) => {
          const s = TAB_STYLE[c.id] || { icon: "▪", color: "white" };
          const active = i === tabIdx;
          return (
            <Box key={c.id} borderStyle={active ? "bold" : "single"} borderColor={active ? s.color : "gray"} paddingX={2}>
              <Text bold={active} color={active ? s.color : undefined} dimColor={!active}>
                {s.icon} {c.name}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* 版本列表 */}
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={tabColor} paddingX={2} paddingY={1}>
        {!state || state.loading ? (
          <Text dimColor>{zh ? "加载中..." : "Loading..."}</Text>
        ) : state.error ? (
          <Text color="red">{zh ? "加载失败：" : "Failed: "}{state.error}</Text>
        ) : versions.length === 0 ? (
          <Text dimColor>{zh ? "暂无版本" : "No versions"}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{zh ? `共 ${versions.length} 个版本，当前安装：` : `${versions.length} versions, current: `}<Text color={tabColor}>{state.current ?? (zh ? "未安装" : "not installed")}</Text></Text>
            <Box marginTop={1} flexDirection="column">
              {slice.map((v, i) => {
                const absIdx = scrollTop + i;
                const focused = absIdx === rowIdx;
                const date = v.publishedAt ? v.publishedAt.slice(0, 10) : "";
                const marker = v.isCurrent ? (zh ? " ★ 当前" : " ★ current") : "";
                const installingThis = installing === v.version;
                const color = focused ? tabColor : v.isCurrent ? "green" : undefined;
                return (
                  <Box key={v.version} paddingLeft={1}>
                    <Text color={color} bold={focused} dimColor={!focused && !v.isCurrent}>
                      {focused ? "▶ " : "  "}{v.version.padEnd(16)}{date.padEnd(14)}{marker}
                      {installingThis ? (zh ? "  ⏳ 安装中..." : "  ⏳ installing...") : ""}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>←→</Text><Text dimColor>{zh ? "切换工具" : "switch"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "安装" : "install"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>r</Text><Text dimColor>{zh ? "刷新" : "refresh"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}
