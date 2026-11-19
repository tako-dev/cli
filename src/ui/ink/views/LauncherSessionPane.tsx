/**
 * Launcher 历史会话搜索状态 Hook 与详情面板子组件
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { openSessionDatabase, refreshSessionIndex } from "../../../sessions";
import type { SessionDatabase } from "../../../sessions/database";
import { normalizeSessionSearchInput } from "../../../sessions/input";
import { prepareResume } from "../../../sessions/resume";
import { searchSessions, type SessionSearchResult } from "../../../sessions/search";
import {
  sessionSourceColor,
  sessionSourceLabel,
  type ParsedSessionMessage,
  type UnifiedSession,
} from "../../../sessions/types";
import type { LauncherResult } from "../../shared/types";
import { truncateToWidth } from "../../../utils/display-width";

export { sessionSourceColor, sessionSourceLabel };

export function cleanSessionText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sessionAge(timestamp: number, zh: boolean): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}${zh ? "分钟前" : "m"}`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}${zh ? "小时前" : "h"}`;
  return `${Math.floor(diff / 86_400_000)}${zh ? "天前" : "d"}`;
}

export function sessionDayGroup(timestamp: number, zh: boolean): string {
  const days = Math.floor(Math.max(0, Date.now() - timestamp) / 86_400_000);
  if (days === 0) return zh ? "今天" : "Today";
  if (days === 1) return zh ? "昨天" : "Yesterday";
  if (days < 7) return zh ? "本周" : "This week";
  return zh ? "更早" : "Earlier";
}

export function useLauncherSessionSearch({
  currentCwd,
  columns,
  rows,
  onExitSearch,
  onResult,
}: {
  currentCwd?: string;
  columns: number;
  rows: number;
  onExitSearch: () => void;
  onResult: (result: LauncherResult) => void;
}) {
  const sessionPageSize = Math.max(2, Math.min(columns < 100 ? 4 : 6, Math.floor((rows - 12) / 2)));
  const [sessionQuery, setSessionQuery] = useState("");
  const [debouncedSessionQuery, setDebouncedSessionQuery] = useState("");
  const [sessionIdx, setSessionIdx] = useState(0);
  const sessionIdxRef = useRef(0);
  const [, setSelectedSessionKey] = useState<string | null>(null);
  const selectedSessionKeyRef = useRef<string | null>(null);
  const [sessionDb, setSessionDb] = useState<SessionDatabase | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  const [indexingSessions, setIndexingSessions] = useState(false);
  const [sessionIndexError, setSessionIndexError] = useState("");
  const [sessionDetailKey, setSessionDetailKey] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<{ session: UnifiedSession; messages: ParsedSessionMessage[] } | null>(null);
  const [sessionVisibleLimit, setSessionVisibleLimit] = useState(sessionPageSize);

  const sessionCandidates = React.useMemo(
    () => (sessionDb ? searchSessions(sessionDb, debouncedSessionQuery, { currentCwd, limit: sessionVisibleLimit + 1 }) : []),
    [sessionDb, debouncedSessionQuery, sessionTick, currentCwd, sessionVisibleLimit],
  );
  const sessionHasMore = sessionCandidates.length > sessionVisibleLimit;
  const sessionResults = React.useMemo(
    () => sessionCandidates.slice(0, sessionVisibleLimit),
    [sessionCandidates, sessionVisibleLimit],
  );
  const sessionWindowStart = Math.max(
    0,
    Math.min(sessionIdx - sessionPageSize + 1, Math.max(0, sessionResults.length - sessionPageSize)),
  );
  const sessionWindow = sessionResults.slice(sessionWindowStart, sessionWindowStart + sessionPageSize);

  useEffect(() => {
    const db = openSessionDatabase();
    let disposed = false;
    setSessionDb(db);
    setIndexingSessions(true);
    setSessionIndexError("");
    const refresh = refreshSessionIndex(db)
      .then(() => { if (!disposed) setSessionTick((value) => value + 1); })
      .catch((error) => { if (!disposed) setSessionIndexError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!disposed) setIndexingSessions(false); });
    return () => {
      disposed = true;
      setSessionDb(null);
      void refresh.finally(() => db.close());
    };
  }, []);

  useEffect(() => {
    if (!sessionQuery) { setDebouncedSessionQuery(""); return; }
    const timer = setTimeout(() => setDebouncedSessionQuery(sessionQuery), 120);
    return () => clearTimeout(timer);
  }, [sessionQuery]);

  useEffect(() => {
    setSessionVisibleLimit((value) => Math.max(value, sessionPageSize));
    setSessionIdx((value) => {
      const next = Math.max(0, Math.min(value, sessionVisibleLimit - 1));
      sessionIdxRef.current = next;
      return next;
    });
  }, [sessionPageSize, sessionVisibleLimit]);

  useEffect(() => {
    if (sessionResults.length === 0) {
      sessionIdxRef.current = 0;
      selectedSessionKeyRef.current = null;
      setSessionIdx(0);
      setSelectedSessionKey(null);
      return;
    }
    const preservedIndex = selectedSessionKeyRef.current
      ? sessionResults.findIndex((result) => result.session.key === selectedSessionKeyRef.current)
      : -1;
    const nextIndex = preservedIndex >= 0 ? preservedIndex : Math.min(sessionIdxRef.current, sessionResults.length - 1);
    const nextKey = sessionResults[nextIndex].session.key;
    sessionIdxRef.current = nextIndex;
    selectedSessionKeyRef.current = nextKey;
    setSessionIdx(nextIndex);
    setSelectedSessionKey(nextKey);
  }, [sessionResults]);

  useEffect(() => {
    if (!sessionDb || !sessionDetailKey) { setSessionDetail(null); return; }
    const session = sessionDb.getSession(sessionDetailKey);
    const messages = sessionDb
      .getRecentMessages(sessionDetailKey, 32)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-8);
    setSessionDetail(session ? { session, messages } : null);
  }, [sessionDb, sessionDetailKey]);

  const resetForSearchEntry = useCallback(() => {
    sessionIdxRef.current = 0;
    selectedSessionKeyRef.current = sessionResults[0]?.session.key ?? null;
    setSessionIdx(0);
    setSelectedSessionKey(selectedSessionKeyRef.current);
    setSessionVisibleLimit(sessionPageSize);
    setSessionDetailKey(null);
  }, [sessionResults, sessionPageSize]);

  const clearDetail = useCallback(() => setSessionDetailKey(null), []);

  const handleSearchInput = useCallback((input: string, key: any) => {
    if (sessionDetailKey && (key.escape || key.leftArrow)) { setSessionDetailKey(null); return; }
    if (key.escape || key.leftArrow) {
      setSessionQuery("");
      sessionIdxRef.current = 0;
      selectedSessionKeyRef.current = null;
      setSessionIdx(0);
      setSelectedSessionKey(null);
      onExitSearch();
      return;
    }
    if (key.rightArrow) {
      const selected = sessionResults.find((r) => r.session.key === selectedSessionKeyRef.current) ?? sessionResults[sessionIdxRef.current];
      if (selected) setSessionDetailKey(selected.session.key);
      return;
    }
    if (key.downArrow) {
      if (sessionResults.length === 0) return;
      if (sessionIdxRef.current >= sessionResults.length - 1 && sessionHasMore) {
        setSessionVisibleLimit((value) => value + sessionPageSize);
        sessionIdxRef.current += 1;
        setSessionIdx(sessionIdxRef.current);
      } else {
        sessionIdxRef.current = Math.min(sessionResults.length - 1, sessionIdxRef.current + 1);
        setSessionIdx(sessionIdxRef.current);
      }
      selectedSessionKeyRef.current = sessionResults[sessionIdxRef.current]?.session.key ?? null;
      setSelectedSessionKey(selectedSessionKeyRef.current);
      return;
    }
    if (key.upArrow) {
      sessionIdxRef.current = Math.max(0, sessionIdxRef.current - 1);
      setSessionIdx(sessionIdxRef.current);
      selectedSessionKeyRef.current = sessionResults[sessionIdxRef.current]?.session.key ?? null;
      setSelectedSessionKey(selectedSessionKeyRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      setSessionQuery((value) => value.slice(0, -1));
      sessionIdxRef.current = 0;
      selectedSessionKeyRef.current = null;
      setSessionIdx(0);
      setSelectedSessionKey(null);
      setSessionDetailKey(null);
      setSessionVisibleLimit(sessionPageSize);
      return;
    }
    if (key.return) {
      const selected = sessionResults.find((r) => r.session.key === selectedSessionKeyRef.current) ?? sessionResults[sessionIdxRef.current];
      if (!selected) return;
      if (selected.session.resumeCapability === "unsupported") { setSessionDetailKey(selected.session.key); return; }
      try {
        const prepared = prepareResume(selected.session, currentCwd);
        onResult({
          type: "launch",
          clientId: prepared.clientId,
          projectPath: prepared.projectPath,
          args: prepared.args,
          envVars: {},
          selectedOptionIds: undefined,
          resume: true,
          resumeModelId: selected.session.model,
        });
      } catch (error) {
        setSessionIndexError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const searchInput = normalizeSessionSearchInput(input, key);
    if (searchInput) {
      setSessionQuery((value) => value + searchInput);
      sessionIdxRef.current = 0;
      selectedSessionKeyRef.current = null;
      setSessionIdx(0);
      setSelectedSessionKey(null);
      setSessionDetailKey(null);
      setSessionVisibleLimit(sessionPageSize);
    }
  }, [sessionDetailKey, sessionResults, sessionHasMore, sessionPageSize, currentCwd, onExitSearch, onResult]);

  return {
    sessionQuery,
    sessionIdx,
    indexingSessions,
    sessionIndexError,
    sessionDetailKey,
    sessionDetail,
    sessionPageSize,
    sessionResults,
    sessionWindowStart,
    sessionWindow,
    sessionHasMore,
    resetForSearchEntry,
    clearDetail,
    handleSearchInput,
  };
}

export function LauncherSessionSearchBox({
  active,
  sessionQuery,
  indexingSessions,
  sessionIndexError,
  columns,
  zh,
}: {
  active: boolean;
  sessionQuery: string;
  indexingSessions: boolean;
  sessionIndexError: string;
  columns: number;
  zh: boolean;
}) {
  if (!active) {
    return (
      <Box paddingLeft={1}>
        <Text>  ⌕ </Text>
        <Text dimColor>
          {zh ? "搜索历史会话...（按 / 搜索）" : "Search previous sessions... (press /)"}
        </Text>
        {indexingSessions && <Text dimColor>  {zh ? "索引中" : "indexing"}</Text>}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>⌕ {zh ? "搜索历史会话" : "Search sessions"}</Text>
        {indexingSessions && <Text dimColor>{zh ? "索引中..." : "indexing..."}</Text>}
        {!indexingSessions && sessionIndexError && (
          <Text color="red">⚠ {truncateToWidth(sessionIndexError, Math.max(16, columns - 48))}</Text>
        )}
      </Box>
      <Box>
        <Text color="cyan" bold>› </Text>
        <Text bold={!!sessionQuery} dimColor={!sessionQuery}>
          {sessionQuery || (zh ? "输入关键词，留空浏览最近会话" : "Type to search, or browse recent sessions")}
        </Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}

export function LauncherSessionDetail({
  sessionDetailKey,
  sessionDetail,
  columns,
  zh,
}: {
  sessionDetailKey: string;
  sessionDetail: { session: UnifiedSession; messages: ParsedSessionMessage[] };
  columns: number;
  zh: boolean;
}) {
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text bold color="cyan">{sessionDetail.session.title ?? sessionDetailKey}</Text>
      <Text dimColor>{sessionDetail.session.cwd}</Text>
      {sessionDetail.session.resumeCapability === "unsupported" && (
        <Text color="yellow">
          {zh ? "此来源暂不支持直接续接，仅可搜索和查看。" : "This source is view-only and cannot be resumed yet."}
        </Text>
      )}
      {sessionDetail.messages.map((message) => (
        <Text key={message.ordinal}>
          <Text color={message.role === "user" ? "yellow" : "green"}>
            {message.role === "user" ? "You" : "AI"}:{" "}
          </Text>
          {message.text.replace(/\s+/g, " ").slice(0, Math.max(40, columns - 12))}
        </Text>
      ))}
    </Box>
  );
}

export function LauncherSessionResults({
  sessionWindow,
  sessionWindowStart,
  sessionPageSize,
  sessionResultsLength,
  sessionHasMore,
  sessionIdx,
  columns,
  zh,
}: {
  sessionWindow: SessionSearchResult[];
  sessionWindowStart: number;
  sessionPageSize: number;
  sessionResultsLength: number;
  sessionHasMore: boolean;
  sessionIdx: number;
  columns: number;
  zh: boolean;
}) {
  const width = Math.max(30, columns - 14);
  return (
    <>
      {sessionWindow.map((result, localIndex) => {
        const resultIndex = sessionWindowStart + localIndex;
        const focused = resultIndex === sessionIdx;
        const color = sessionSourceColor(result.session.source);
        const group = sessionDayGroup(result.session.updatedAt, zh);
        return (
          <Box key={result.session.key} paddingLeft={1} flexDirection="column">
            <Box>
              <Text color={focused ? "cyan" : undefined} bold={focused}>
                {focused ? "▸ " : "  "}
              </Text>
              <Text color="cyan">{group}</Text>
              <Text dimColor> · </Text>
              <Text color={color} bold>{sessionSourceLabel(result.session.source)}</Text>
              <Text dimColor>
                {" "}· {result.session.projectName ?? "未知项目"} · {sessionAge(result.session.updatedAt, zh)}  
              </Text>
              <Text bold={focused} color={focused ? "white" : undefined}>
                {truncateToWidth(
                  cleanSessionText(result.session.title ?? result.session.nativeId.slice(0, 8)),
                  Math.max(12, width - 36),
                )}
              </Text>
            </Box>
            <Text dimColor>{"    "}{truncateToWidth(cleanSessionText(result.snippet), width)}</Text>
          </Box>
        );
      })}
      <Box paddingLeft={4} marginTop={1}>
        <Text dimColor>
          {sessionResultsLength === 0
            ? (zh ? "暂无会话" : "No sessions")
            : `${sessionWindowStart + 1}-${Math.min(sessionWindowStart + sessionPageSize, sessionResultsLength)} / ${sessionResultsLength}${sessionHasMore ? "+" : ""}`}
          {sessionHasMore ? `  ·  ↓ ${zh ? "继续浏览" : "more"}` : ""}
        </Text>
      </Box>
    </>
  );
}
