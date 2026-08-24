/**
 * Launcher View
 *
 * 单容器：Header(服务商右上角,可聚焦切换) → Tab → 项目列表 → 启动参数
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { getClientLaunchOptions } from "../../../clients/base";
import { PI_DEFAULT_MODEL } from "../../../clients/pi";
import { setClientProvider, resolveProviderContext } from "../../../providers";
import type { Provider } from "../../../providers/types";
import { getLocale } from "../../../i18n";
import { getOfficialQuota, type OfficialQuota } from "../../../quota";
import { loadLauncherData } from "../../shared/launcher-data";
import {
  buildOptionRows,
  enabledWithProviderDefaultModel,
  getGroupSelection,
  selectedArgs,
  selectedArgsWithGroupOverride,
} from "../../shared/launch-options";
import {
  buildGroupedGrid,
  getGridColumnCountForOptions,
  gridIndexOf,
  initialModelPickerMode,
  modelPickerRowsInOrder,
  visibleModelOptions,
  type ModelPickerMode,
} from "../../shared/model-picker";
import type { LauncherClientData, LauncherLoadResult, LauncherResult } from "../../shared/types";
import { ProviderPicker, GroupPicker } from "./LauncherPickers";
import { ModelGridPicker } from "./ModelGridPicker";
import { openSessionDatabase, refreshSessionIndex } from "../../../sessions";
import { searchSessions } from "../../../sessions/search";
import { prepareResume } from "../../../sessions/resume";
import type { SessionDatabase } from "../../../sessions/database";
import type { ParsedSessionMessage, UnifiedSession } from "../../../sessions/types";
import { truncateToWidth } from "../../../utils/display-width";
import { normalizeSessionSearchInput } from "../../../sessions/input";

export type { LauncherResult } from "../../shared/types";

const VERSION = process.env.VERSION || "dev";

const CLIENT_STYLE: Record<string, { icon: string; color: string }> = {
  "claude-code": { icon: "✦", color: "yellow" },
  codex:         { icon: "◈", color: "blue" },
  gemini:        { icon: "◆", color: "cyan" },
  pi:            { icon: "π", color: "magenta" },
  "pi-web":      { icon: "◎", color: "magenta" },
};
const DEFAULT_STYLE = { icon: "▪", color: "white" };

function cleanSessionText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " [code] ").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim();
}

function sessionAge(timestamp: number, zh: boolean): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}${zh ? "分钟前" : "m"}`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}${zh ? "小时前" : "h"}`;
  return `${Math.floor(diff / 86_400_000)}${zh ? "天前" : "d"}`;
}

function sessionSourceLabel(source: UnifiedSession["source"]): string {
  if (source === "claude") return "Claude";
  if (source === "codex") return "Codex";
  if (source === "pi") return "Pi";
  return "Gemini";
}

function sessionSourceColor(source: UnifiedSession["source"]): string {
  if (source === "claude") return "magenta";
  if (source === "codex") return "blue";
  if (source === "pi") return "magenta";
  return "cyan";
}

function sessionDayGroup(timestamp: number, zh: boolean): string {
  const days = Math.floor(Math.max(0, Date.now() - timestamp) / 86_400_000);
  if (days === 0) return zh ? "今天" : "Today";
  if (days === 1) return zh ? "昨天" : "Yesterday";
  if (days < 7) return zh ? "本周" : "This week";
  return zh ? "更早" : "Earlier";
}

// ─── 分隔线 ─────────────────────────────────────────

function Divider({ color }: { color?: string }) {
  const { stdout } = useStdout();
  const w = Math.max((stdout.columns || 80) - 6, 20);
  return <Box marginY={0}><Text dimColor color={color}>{"─".repeat(w)}</Text></Box>;
}

// ─── Quota Line ──────────────────────────────────────

/** 已用百分比的色阶（用越多越红，给 Tako 金额制用） */
function pctColor(pct: number): string {
  return pct < 70 ? "green" : pct < 90 ? "yellow" : "red";
}

/** 剩余百分比的色阶（剩越少越红，给订阅类百分比制用） */
function remainColor(remainPct: number): string {
  return remainPct > 30 ? "green" : remainPct > 10 ? "yellow" : "red";
}

/** 紧凑展示当前 provider 类型 + 邮箱（如果有），用于头部 inline 标签 */
function ProviderBadge({ provider, zh }: { provider: Provider | undefined; zh: boolean }) {
  if (!provider) {
    return <Text color="yellow">⚠ {zh ? "未绑定" : "no provider"}</Text>;
  }
  const TYPE_LABELS: Record<string, { zh: string; en: string; color: string; icon: string }> = {
    "tako":                  { zh: "Tako 代理",     en: "Tako Proxy",      color: "cyan",   icon: "🐙" },
    "claude-subscription":   { zh: "Claude 官方",   en: "Claude Official", color: "yellow", icon: "✦"  },
    "codex-subscription":    { zh: "Codex 官方",    en: "Codex Official",  color: "blue",   icon: "◈"  },
    "anthropic":             { zh: "Anthropic 直连", en: "Anthropic Direct", color: "yellow", icon: "✦" },
    "deepseek":              { zh: "DeepSeek",      en: "DeepSeek",        color: "magenta", icon: "◇" },
    "xiaomi":                { zh: "小米 MiMo",     en: "Xiaomi MiMo",     color: "yellow",  icon: "🟠" },
    "custom":                { zh: "自定义",        en: "Custom",          color: "gray",    icon: "▪" },
  };
  const meta = TYPE_LABELS[provider.type] ?? TYPE_LABELS.custom;
  const label = zh ? meta.zh : meta.en;
  // 邮箱展示：截短到 @ 前 12 字符
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

function QuotaLine({ quota, zh }: { quota: OfficialQuota; zh: boolean }) {
  if (quota.status === "unsupported") return null;

  if (quota.status === "error") {
    return <Text dimColor>💰 {quota.hint || (zh ? "用量获取失败" : "quota unavailable")}</Text>;
  }

  // Tako 订阅模式（任意窗口有 costLimit）→ 走"剩余 %"展示，跟订阅类一致；
  // Tako 按量付费（无任何窗口限额）→ 展示已花费金额。
  if (quota.provider === "tako") {
    const hasLimits = !!(quota.primary?.costLimit || quota.secondary?.costLimit || quota.daily?.costLimit);
    if (hasLimits) {
      // 订阅模式 — 用 slot.windowMinutes 推导 label，与订阅类完全一致
      // fall through 到下面的 subscription 分支
    } else {
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

  // 订阅类：展示"剩余百分比"（订阅看花了多少钱没意义；剩多少配额才有用）
  // label 自动从 windowMinutes 推导：< 1440min → "{h}h"，>= 1440min → "{d}d"
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
      </React.Fragment>
    );
  };

  if (quota.primary) pushChunk("primary", labelOf(quota.primary.windowMinutes, 5), quota.primary.usedPct);
  if (quota.secondary) pushChunk("secondary", labelOf(quota.secondary.windowMinutes, 24, 7), quota.secondary.usedPct);
  if (quota.modelLimits?.opus) pushChunk("opus", "opus", quota.modelLimits.opus.usedPct);

  if (!parts.length) return null;
  return <Text dimColor>💰 {parts}</Text>;
}

// ─── Main ─────────────────────────────────────────────

type FocusArea = "search" | "projects" | "options";

function LauncherViewInner({ clients, defaultIdx, hasProviders, pickCounts, initialSessionSearch = false, onResult }: {
  clients: LauncherClientData[]; defaultIdx: number; hasProviders: boolean;
  pickCounts: Record<string, number>;
  initialSessionSearch?: boolean;
  onResult: (r: LauncherResult) => void;
}) {
  const { stdout } = useStdout();
  const [clientIdx, setClientIdx] = useState(defaultIdx);
  const [focus, setFocus] = useState<FocusArea>(initialSessionSearch ? "search" : "projects");
  const [projectIdx, setProjectIdx] = useState(0);
  const [optionIdx, setOptionIdx] = useState(0);
  const [provIdx, setProvIdx] = useState(() => clients[defaultIdx]?.activeProvIdx || 0);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(clients[defaultIdx]?.lastSelectedOptionIds ?? [])
  );
  const [provMsg, setProvMsg] = useState("");
  /** 当前正在打开的 group picker（null = 主界面） */
  const [pickingGroup, setPickingGroup] = useState<string | null>(null);
  const [modelPickerMode, setModelPickerMode] = useState<ModelPickerMode>("collapsed");
  /** true = 服务商 picker（与 pickingGroup 互斥） */
  const [pickingProvider, setPickingProvider] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);
  const [sessionQuery, setSessionQuery] = useState("");
  const [debouncedSessionQuery, setDebouncedSessionQuery] = useState("");
  const [sessionIdx, setSessionIdx] = useState(0);
  const sessionIdxRef = useRef(0);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const selectedSessionKeyRef = useRef<string | null>(null);
  const [sessionDb, setSessionDb] = useState<SessionDatabase | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  const [indexingSessions, setIndexingSessions] = useState(false);
  const [sessionIndexError, setSessionIndexError] = useState("");
  const [sessionDetailKey, setSessionDetailKey] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<{ session: UnifiedSession; messages: ParsedSessionMessage[] } | null>(null);
  const sessionPageSize = Math.max(2, Math.min((stdout.columns || 80) < 100 ? 4 : 6, Math.floor(((stdout.rows || 30) - 12) / 2)));
  const [sessionVisibleLimit, setSessionVisibleLimit] = useState(sessionPageSize);
  const initialClientEffect = useRef(true);

  const current = clients[clientIdx];
  const projects = current.projects;
  const provs = current.providers;
  const cs = CLIENT_STYLE[current.client.id] || DEFAULT_STYLE;
  const zh = getLocale() === "zh";

  const currentProv = provs[provIdx];
  const sessionCandidates = React.useMemo(() => sessionDb ? searchSessions(sessionDb, debouncedSessionQuery, { currentCwd: projects[0]?.path, limit: sessionVisibleLimit + 1 }) : [], [sessionDb, debouncedSessionQuery, sessionTick, projects, sessionVisibleLimit]);
  const sessionHasMore = sessionCandidates.length > sessionVisibleLimit;
  const sessionResults = React.useMemo(() => sessionCandidates.slice(0, sessionVisibleLimit), [sessionCandidates, sessionVisibleLimit]);
  const sessionWindowStart = Math.max(0, Math.min(sessionIdx - sessionPageSize + 1, Math.max(0, sessionResults.length - sessionPageSize)));
  const sessionWindow = sessionResults.slice(sessionWindowStart, sessionWindowStart + sessionPageSize);

  useEffect(() => {
    const db = openSessionDatabase();
    let disposed = false;
    setSessionDb(db); setIndexingSessions(true); setSessionIndexError("");
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
    const preservedIndex = selectedSessionKeyRef.current ? sessionResults.findIndex((result) => result.session.key === selectedSessionKeyRef.current) : -1;
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
    const messages = sessionDb.getRecentMessages(sessionDetailKey, 32).filter((message) => message.role === "user" || message.role === "assistant").slice(-8);
    setSessionDetail(session ? { session, messages } : null);
  }, [sessionDb, sessionDetailKey]);

  // launchOptions 是 provider-aware 的（DeepSeek 时会列 DeepSeek 模型），
  // 因此 currentProv 切换时需要重新计算
  const options = React.useMemo(
    () => getClientLaunchOptions(current.client, currentProv),
    [current.client.id, currentProv?.id, currentProv?.type]
  );

  // 选项区折叠后的可见行
  const optionRows = React.useMemo(() => buildOptionRows(options, zh), [options, zh]);

  const provName = currentProv?.name || (zh ? "未配置" : "N/A");

  // 官方用量（按 provider 类型自动分发；不支持的类型返回 unsupported）
  const [quota, setQuota] = useState<OfficialQuota | null>(null);
  useEffect(() => {
    if (!currentProv) { setQuota(null); return; }
    let cancelled = false;
    getOfficialQuota(currentProv).then((q) => {
      if (!cancelled) setQuota(q);
    });
    return () => { cancelled = true; };
  }, [currentProv?.id, currentProv?.type]);

  // 切换工具时重置
  useEffect(() => {
    if (initialClientEffect.current) { initialClientEffect.current = false; return; }
    setProjectIdx(0); setOptionIdx(0); setFocus("projects");
    setProvIdx(clients[clientIdx]?.activeProvIdx || 0);
    setPickingGroup(null);
    setModelPickerMode("collapsed");
    setPickingProvider(false);
    // 勾选状态也随工具切换，恢复到该工具上次的选择
    setEnabled(new Set(clients[clientIdx]?.lastSelectedOptionIds ?? []));
  }, [clientIdx]);

  // provider 切换 / 初始加载：launchOptions 列表会变。
  //   1. 把 enabled 里已经失效的 option id 清掉（避免幽灵勾选）
  //   2. 若没有任何 model 被勾选，落到 provider.model 上（让 add provider 时挑的模型自动反映）
  useEffect(() => {
    setEnabled((prev) => enabledWithProviderDefaultModel(
      prev,
      options,
      currentProv?.model,
      current.client.id === "pi" ? `model-${PI_DEFAULT_MODEL}` : undefined,
    ));
  }, [options, currentProv?.model]);

  const openGroupPicker = useCallback((group: string) => {
    const cur = getGroupSelection(options, enabled, group);
    const groupOpts = options.filter((o) => o.group === group);
    if (groupOpts.length === 0) return;

    const mode = group === "model" ? initialModelPickerMode(groupOpts, pickCounts) : "collapsed";
    let initIdx = 0;
    if (cur) {
      if (group === "model" && mode === "grid") {
        const ids = groupOpts.map((o) => o.id);
        const columnCount = getGridColumnCountForOptions(groupOpts, stdout.columns || 80, zh);
        initIdx = gridIndexOf(ids, cur.id, columnCount);
      } else {
        const visible = group === "model"
          ? visibleModelOptions(groupOpts, enabled, pickCounts).list
          : groupOpts;
        initIdx = visible.findIndex((o) => o.id === cur.id) + 1;
      }
    }

    setPickerIdx(Math.max(0, initIdx));
    setModelPickerMode(mode);
    setPickingGroup(group);
  }, [enabled, options, pickCounts, stdout.columns, zh]);

  const launchCurrentDirWithModel = useCallback((forcedOptionId?: string) => {
    const selected = selectedArgsWithGroupOverride({ launchOptions: options, enabled }, "model", forcedOptionId);
    onResult({
      type: "launch",
      clientId: current.client.id,
      projectPath: projects[0]?.path,
      ...selected,
    });
  }, [options, enabled, onResult, current.client.id, projects]);

  useInput(useCallback((input: string, key: any) => {
    // ─── 服务商 picker 模式 ───
    if (pickingProvider) {
      // 列表 = 所有兼容 provider + 一个「管理服务商」入口
      const pickerLen = provs.length + 1;
      if (key.escape || input === "q") { setPickingProvider(false); return; }
      if (key.upArrow) { setPickerIdx((p) => (p > 0 ? p - 1 : pickerLen - 1)); return; }
      if (key.downArrow) { setPickerIdx((p) => (p < pickerLen - 1 ? p + 1 : 0)); return; }
      if (key.return) {
        if (pickerIdx < provs.length) {
          const prov = provs[pickerIdx];
          setProvIdx(pickerIdx);
          (async () => {
            await setClientProvider(current.client.id, prov.id);
            // 切换 provider 时立即同步客户端配置文件（Codex 的 config.toml /
            // auth.json 等）— 否则配置只在真正 launch 时才写，跟用户预期不符
            if (current.client.setupConfigFiles) {
              try {
                await current.client.setupConfigFiles(resolveProviderContext(prov));
              } catch (e) {
                // 配置写入失败不阻塞绑定，但提示用户
                setProvMsg(zh ? `⚠ 配置同步失败` : `⚠ Config sync failed`);
                setTimeout(() => setProvMsg(""), 2500);
                return;
              }
            }
            current.activeProvIdx = pickerIdx;
            setProvMsg(zh ? `✓ 已绑定 ${prov.name}` : `✓ Bound ${prov.name}`);
            setTimeout(() => setProvMsg(""), 2000);
          })();
          setPickingProvider(false);
        } else {
          // 最后一项：管理服务商
          setPickingProvider(false);
          onResult({ type: "providers" });
        }
      }
      return;
    }

    // ─── 模型 picker 模式 ───
    if (pickingGroup) {
      const groupOpts = options.filter((o) => o.group === pickingGroup);
      const isModelGroup = pickingGroup === "model";

      if (isModelGroup && modelPickerMode === "grid") {
        const ids = groupOpts.map((o) => o.id);
        const columnCount = getGridColumnCountForOptions(groupOpts, stdout.columns || 80, zh);
        const grid = buildGroupedGrid(ids, columnCount);
        const rowsInOrder = modelPickerRowsInOrder(ids, columnCount);
        const pickerLen = grid.flat.length;
        if (input === "q") { setPickingGroup(null); setModelPickerMode("collapsed"); return; }
        if (input === "m") {
          const pickedId = grid.flat[pickerIdx];
          launchCurrentDirWithModel(pickedId);
          return;
        }
        if (key.escape) {
          if (initialModelPickerMode(groupOpts, pickCounts) === "grid") {
            setPickingGroup(null);
          } else {
            setModelPickerMode("collapsed");
            // 回到折叠态时把焦点还原到当前选中项（没有选中则落到「默认/清空」），
            // 而不是无脑跳回第一行。
            const cur = getGroupSelection(options, enabled, pickingGroup);
            const visibleList = visibleModelOptions(groupOpts, enabled, pickCounts).list;
            setPickerIdx(cur ? Math.max(0, visibleList.findIndex((o) => o.id === cur.id) + 1) : 0);
          }
          return;
        }
        if (pickerLen === 0) return;
        if (key.leftArrow) { setPickerIdx((p) => (p > 0 ? p - 1 : pickerLen - 1)); return; }
        if (key.rightArrow) { setPickerIdx((p) => (p < pickerLen - 1 ? p + 1 : 0)); return; }
        if (key.upArrow || key.downArrow) {
          setPickerIdx((p) => {
            let row = 0;
            let col = 0;
            let offset = 0;
            for (let i = 0; i < rowsInOrder.length; i++) {
              const rowLen = rowsInOrder[i].length;
              if (p < offset + rowLen) {
                row = i;
                col = p - offset;
                break;
              }
              offset += rowLen;
            }
            const nextRow = key.upArrow
              ? (row > 0 ? row - 1 : rowsInOrder.length - 1)
              : (row < rowsInOrder.length - 1 ? row + 1 : 0);
            const nextCol = Math.min(col, rowsInOrder[nextRow].length - 1);
            return rowsInOrder.slice(0, nextRow).reduce((sum, r) => sum + r.length, 0) + nextCol;
          });
          return;
        }
        if (key.return) {
          const pickedId = grid.flat[pickerIdx];
          const picked = groupOpts.find((o) => o.id === pickedId);
          if (picked) {
            setEnabled((prev) => {
              const next = new Set(prev);
              for (const o of groupOpts) next.delete(o.id);
              next.add(picked.id);
              return next;
            });
          }
          setPickingGroup(null);
          setModelPickerMode("collapsed");
        }
        return;
      }

      const visible = isModelGroup
        ? visibleModelOptions(groupOpts, enabled, pickCounts)
        : { list: groupOpts, hiddenCount: 0 };
      const pickerLen = visible.list.length + 1 + (visible.hiddenCount > 0 ? 1 : 0);
      if (key.escape || input === "q") { setPickingGroup(null); setModelPickerMode("collapsed"); return; }
      if (isModelGroup && input === "m") {
        if (pickerIdx === 0) {
          launchCurrentDirWithModel();
          return;
        }
        if (visible.hiddenCount > 0 && pickerIdx === visible.list.length + 1) return;
        const picked = visible.list[pickerIdx - 1];
        launchCurrentDirWithModel(picked?.id);
        return;
      }
      if (key.upArrow) { setPickerIdx((p) => (p > 0 ? p - 1 : pickerLen - 1)); return; }
      if (key.downArrow) { setPickerIdx((p) => (p < pickerLen - 1 ? p + 1 : 0)); return; }
      if (key.return) {
        if (pickerIdx === 0) {
          setEnabled((prev) => {
            const next = new Set(prev);
            for (const o of groupOpts) next.delete(o.id);
            return next;
          });
        } else if (isModelGroup && visible.hiddenCount > 0 && pickerIdx === visible.list.length + 1) {
          const cur = getGroupSelection(options, enabled, pickingGroup);
          const ids = groupOpts.map((o) => o.id);
          const columnCount = getGridColumnCountForOptions(groupOpts, stdout.columns || 80, zh);
          const initIdx = cur ? gridIndexOf(ids, cur.id, columnCount) : 0;
          setPickerIdx(Math.max(0, initIdx));
          setModelPickerMode("grid");
          return;
        } else {
          const picked = visible.list[pickerIdx - 1];
          setEnabled((prev) => {
            const next = new Set(prev);
            for (const o of groupOpts) next.delete(o.id);
            next.add(picked.id);
            return next;
          });
        }
        setPickingGroup(null);
        setModelPickerMode("collapsed");
      }
      return;
    }

    if (focus === "search") {
      if (sessionDetailKey && (key.escape || key.leftArrow)) { setSessionDetailKey(null); return; }
      if (key.escape || key.leftArrow) { setSessionQuery(""); sessionIdxRef.current = 0; selectedSessionKeyRef.current = null; setSessionIdx(0); setSelectedSessionKey(null); setFocus("projects"); return; }
      if (key.rightArrow) { const selected = sessionResults.find((result) => result.session.key === selectedSessionKeyRef.current) ?? sessionResults[sessionIdxRef.current]; if (selected) setSessionDetailKey(selected.session.key); return; }
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
      if (key.upArrow) { sessionIdxRef.current = Math.max(0, sessionIdxRef.current - 1); setSessionIdx(sessionIdxRef.current); selectedSessionKeyRef.current = sessionResults[sessionIdxRef.current]?.session.key ?? null; setSelectedSessionKey(selectedSessionKeyRef.current); return; }
      if (key.backspace || key.delete) { setSessionQuery((value) => value.slice(0, -1)); sessionIdxRef.current = 0; selectedSessionKeyRef.current = null; setSessionIdx(0); setSelectedSessionKey(null); setSessionDetailKey(null); setSessionVisibleLimit(sessionPageSize); return; }
      if (key.return) {
        const selected = sessionResults.find((result) => result.session.key === selectedSessionKeyRef.current) ?? sessionResults[sessionIdxRef.current]; if (!selected) return;
        if (selected.session.resumeCapability === "unsupported") { setSessionDetailKey(selected.session.key); return; }
        try {
          const prepared = prepareResume(selected.session, projects[0]?.path);
          onResult({ type: "launch", clientId: prepared.clientId, projectPath: prepared.projectPath, args: prepared.args, envVars: {}, selectedOptionIds: [] });
        } catch (error) {
          setSessionIndexError(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      const searchInput = normalizeSessionSearchInput(input, key);
      if (searchInput) { setSessionQuery((value) => value + searchInput); sessionIdxRef.current = 0; selectedSessionKeyRef.current = null; setSessionIdx(0); setSelectedSessionKey(null); setSessionDetailKey(null); setSessionVisibleLimit(sessionPageSize); }
      return;
    }

    if (input === "q") { onResult({ type: "exit" }); return; }
    if (input === "a") { onResult({ type: "agent" }); return; }
    if (input === "s") { onResult({ type: "stats" }); return; }
    if (input === "c") { onResult({ type: "config" }); return; }
    if (input === "l") { onResult({ type: "language" }); return; }
    if (input === "p") { onResult({ type: "providers" }); return; }
    if (input === "m") { openGroupPicker("model"); return; }

    const num = parseInt(input);
    if (num >= 1 && num <= clients.length) { setClientIdx(num - 1); return; }

    // ─── ←→ 切换工具 Tab ───
    if (key.leftArrow) { setClientIdx((p) => (p > 0 ? p - 1 : clients.length - 1)); return; }
    if (key.rightArrow) { setClientIdx((p) => (p < clients.length - 1 ? p + 1 : 0)); return; }

    // ─── ↑↓ 导航 ───
    if (focus === "projects") {
      if (key.downArrow) {
        if (projectIdx < projects.length - 1) setProjectIdx((p) => p + 1);
        else if (optionRows.length > 0) { setFocus("options"); setOptionIdx(0); }
        return;
      }
      if (key.upArrow) {
        if (projectIdx > 0) setProjectIdx((p) => p - 1);
        else {
          sessionIdxRef.current = 0;
          selectedSessionKeyRef.current = sessionResults[0]?.session.key ?? null;
          setSessionIdx(0);
          setSelectedSessionKey(selectedSessionKeyRef.current);
          setSessionVisibleLimit(sessionPageSize);
          setSessionDetailKey(null);
          setFocus("search");
        }
        return;
      }
    }
    if (focus === "options") {
      if (key.downArrow) {
        if (optionIdx < optionRows.length - 1) setOptionIdx((p) => p + 1);
        return;
      }
      if (key.upArrow) {
        if (optionIdx > 0) setOptionIdx((p) => p - 1);
        else { setFocus("projects"); setProjectIdx(projects.length - 1); }
        return;
      }
    }

    // Space：flag → 切换；group / provider → 打开对应 picker
    if (input === " " && focus === "options" && optionRows.length > 0) {
      const row = optionRows[optionIdx];
      if (row.kind === "flag") {
        setEnabled((prev) => {
          const next = new Set(prev);
          if (next.has(row.opt.id)) next.delete(row.opt.id);
          else next.add(row.opt.id);
          return next;
        });
      } else if (row.kind === "group") {
        openGroupPicker(row.group);
      } else {
        // provider
        setPickerIdx(provIdx);
        setPickingProvider(true);
      }
      return;
    }

    // Enter
    if (key.return) {
      // 在入口行按 Enter → 打开对应 picker（不启动）
      if (focus === "options" && optionRows.length > 0) {
        const row = optionRows[optionIdx];
        if (row.kind === "group") {
          openGroupPicker(row.group);
          return;
        }
        if (row.kind === "provider") {
          setPickerIdx(provIdx);
          setPickingProvider(true);
          return;
        }
      }

      // 启动
      const project = projects[projectIdx];
      const selected = selectedArgs({ launchOptions: options, enabled });
      onResult({ type: "launch", clientId: current.client.id, projectPath: project.path, ...selected });
    }
  }, [focus, clientIdx, projectIdx, optionIdx, provIdx, provs, currentProv, current, projects, options, optionRows, enabled, clients, onResult, zh, pickingGroup, pickingProvider, pickerIdx, pickCounts, modelPickerMode, stdout.columns, openGroupPicker, launchCurrentDirWithModel, sessionQuery, sessionIdx, selectedSessionKey, sessionResults, sessionDetailKey, sessionVisibleLimit, sessionPageSize, sessionHasMore]));

  return (
    <Box flexDirection="column" paddingX={0} paddingY={0}>

      {/* 主容器 */}
      <Box flexDirection="column" borderStyle="round" borderColor={focus === "search" ? "cyan" : cs.color} paddingX={1} paddingY={0}>

        {/* Header: 版本 · 账号类型 · 用量（服务商切换在底部入口） */}
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold>🐙 Tako</Text>
            <Text dimColor>v{VERSION}</Text>
            <Text dimColor>│</Text>
            <ProviderBadge provider={currentProv} zh={zh} />
          </Box>
          <Box>
            {provMsg && <Text color="green">{provMsg}</Text>}
            {!provMsg && quota && <QuotaLine quota={quota} zh={zh} />}
          </Box>
        </Box>

        {/* 未配置服务商提示 */}
        {!hasProviders && (
          <Box marginTop={1} justifyContent="center" gap={1}>
            <Text color="yellow">⚠</Text>
            <Text dimColor>
              {zh
                ? "未配置服务商 — 按 c 添加 API Key 或 p 管理服务商"
                : "No provider configured — press c for API Key or p to manage"}
            </Text>
          </Box>
        )}

        {/* Tab 栏：搜索模式隐藏，减少视觉干扰 */}
        {focus !== "search" && <Box marginTop={1} gap={1} justifyContent="center">
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
        </Box>}

        {focus !== "search" && <Divider color={cs.color} />}

        {pickingProvider ? (
          <ProviderPicker provs={provs} provIdx={provIdx} pickerIdx={pickerIdx} color={cs.color} zh={zh} />
        ) : pickingGroup === "model" && modelPickerMode === "grid" ? (
          <ModelGridPicker
            options={options.filter((o) => o.group === "model")}
            enabled={enabled}
            pickerIdx={pickerIdx}
            color={cs.color}
            zh={zh}
          />
        ) : pickingGroup ? (
          <GroupPicker
            group={pickingGroup}
            options={options}
            enabled={enabled}
            pickerIdx={pickerIdx}
            color={cs.color}
            zh={zh}
            pickCounts={pickCounts}
          />
        ) : (
          <>

        {focus === "search" ? (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1} marginBottom={1}>
            <Box justifyContent="space-between">
              <Text color="cyan" bold>⌕ {zh ? "搜索历史会话" : "Search sessions"}</Text>
              {indexingSessions && <Text dimColor>{zh ? "索引中..." : "indexing..."}</Text>}
              {!indexingSessions && sessionIndexError && <Text color="red">⚠ {truncateToWidth(sessionIndexError, Math.max(16, (stdout.columns || 80) - 48))}</Text>}
            </Box>
            <Box>
              <Text color="cyan" bold>› </Text>
              <Text bold={!!sessionQuery} dimColor={!sessionQuery}>{sessionQuery || (zh ? "输入关键词，留空浏览最近会话" : "Type to search, or browse recent sessions")}</Text>
              <Text inverse> </Text>
            </Box>
          </Box>
        ) : (
          <Box paddingLeft={1}>
            <Text>  ⌕ </Text><Text dimColor>{zh ? "搜索历史会话..." : "Search previous sessions..."}</Text>
            {indexingSessions && <Text dimColor>  {zh ? "索引中" : "indexing"}</Text>}
          </Box>
        )}

        {/* 项目列表 / Session 搜索结果 */}
        {sessionDetailKey && sessionDetail ? (
          <Box paddingLeft={2} flexDirection="column">
            <Text bold color="cyan">{sessionDetail.session.title ?? sessionDetailKey}</Text>
            <Text dimColor>{sessionDetail.session.cwd}</Text>
            {sessionDetail.session.resumeCapability === "unsupported" && <Text color="yellow">{zh ? "此来源暂不支持直接续接，仅可搜索和查看。" : "This source is view-only and cannot be resumed yet."}</Text>}
            {sessionDetail.messages.map((message) => (
              <Text key={message.ordinal}><Text color={message.role === "user" ? "yellow" : "green"}>{message.role === "user" ? "You" : "AI"}: </Text>{message.text.replace(/\s+/g, " ").slice(0, Math.max(40, (stdout.columns || 80) - 12))}</Text>
            ))}
          </Box>
        ) : focus === "search" ? sessionWindow.map((result, localIndex) => {
          const resultIndex = sessionWindowStart + localIndex;
          const focused = resultIndex === sessionIdx;
          const color = sessionSourceColor(result.session.source);
          const group = sessionDayGroup(result.session.updatedAt, zh);
          const width = Math.max(30, (stdout.columns || 80) - 14);
          return (
            <React.Fragment key={result.session.key}>
              <Box paddingLeft={1} flexDirection="column">
                <Box>
                  <Text color={focused ? "cyan" : undefined} bold={focused}>{focused ? "▸ " : "  "}</Text>
                  <Text color="cyan">{group}</Text><Text dimColor> · </Text>
                  <Text color={color} bold>{sessionSourceLabel(result.session.source)}</Text>
                  <Text dimColor> · {result.session.projectName ?? "未知项目"} · {sessionAge(result.session.updatedAt, zh)}  </Text>
                  <Text bold={focused} color={focused ? "white" : undefined}>{truncateToWidth(cleanSessionText(result.session.title ?? result.session.nativeId.slice(0, 8)), Math.max(12, width - 36))}</Text>
                </Box>
                <Text dimColor>{"    "}{truncateToWidth(cleanSessionText(result.snippet), width)}</Text>
              </Box>
            </React.Fragment>
          );
        }).concat([
          <Box key="session-window-status" paddingLeft={4} marginTop={1}>
            <Text dimColor>{sessionResults.length === 0 ? (zh ? "暂无会话" : "No sessions") : `${sessionWindowStart + 1}-${Math.min(sessionWindowStart + sessionPageSize, sessionResults.length)} / ${sessionResults.length}${sessionHasMore ? "+" : ""}`}{sessionHasMore ? `  ·  ↓ ${zh ? "继续浏览" : "more"}` : ""}</Text>
          </Box>
        ]) : projects.map((p, i) => {
          const focused = focus === "projects" && i === projectIdx;
          return (
            <Box key={i} paddingLeft={1}>
              <Box flexGrow={1} gap={1}>
                <Text color={focused ? cs.color : undefined} bold={focused}>
                  {focused ? "▸" : " "}
                </Text>
                <Text bold={focused} color={focused ? cs.color : undefined}>
                  {p.label}
                </Text>
              </Box>
              {p.hint ? <Text dimColor>{p.hint}</Text> : null}
            </Box>
          );
        })}

        {/* 选项区：启动参数（勾选）+ group 入口（如"模型 ›"） */}
        {focus !== "search" && optionRows.length > 0 && (
          <>
            <Divider color={cs.color} />
            {optionRows.map((row, idx) => {
              const focused = focus === "options" && idx === optionIdx;
              if (row.kind === "flag") {
                const opt = row.opt;
                const on = enabled.has(opt.id);
                // 不聚焦：只显示 ○/◉ + 标签（紧凑）
                // 聚焦：追加显示 flag 命令行 + description（详细）
                return (
                  <Box key={opt.id} paddingLeft={1}>
                    <Box flexGrow={1} gap={1}>
                      <Text color={focused ? cs.color : undefined} bold={focused}>
                        {focused ? "▸" : " "}
                      </Text>
                      <Text color={on ? cs.color : undefined} bold={on}>{on ? "◉" : "○"}</Text>
                      <Text bold={focused} color={focused ? cs.color : undefined}>
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
                      <Text color={focused ? cs.color : undefined} bold={focused}>
                        {focused ? "▸" : " "}
                      </Text>
                      <Text bold={focused} color={focused ? cs.color : undefined}>
                        {row.title}:
                      </Text>
                      <Text color={cur ? cs.color : undefined}>
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
              // provider 入口
              return (
                <Box key="provider-entry" paddingLeft={1}>
                  <Box flexGrow={1} gap={1}>
                    <Text color={focused ? cs.color : undefined} bold={focused}>
                      {focused ? "▸" : " "}
                    </Text>
                    <Text bold={focused} color={focused ? cs.color : undefined}>
                      {row.title}:
                    </Text>
                    <Text color={currentProv ? cs.color : "yellow"}>
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
        )}
          </>
        )}
      </Box>

      {/* Footer — 根据焦点区域动态变化 */}
      <Box paddingX={2} marginTop={0} justifyContent="center" gap={2}>
        {focus === "search" ? (
          <>
            <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>Enter</Text><Text dimColor>{sessionResults[sessionIdx]?.session.resumeCapability === "unsupported" ? (zh ? "查看" : "open") : (zh ? "续接" : "resume")}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>→</Text><Text dimColor>{zh ? "查看" : "details"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
          </>
        ) : focus === "options" ? (
          <>
            <Text dimColor bold>Space</Text><Text dimColor>{zh ? "开关" : "toggle"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "启动" : "launch"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>m</Text><Text dimColor>{zh ? "模型" : "model"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>←→</Text><Text dimColor>{zh ? "切换工具" : "switch tool"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>q</Text><Text dimColor>{zh ? "退出" : "quit"}</Text>
          </>
        ) : (
          <>
            <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "启动" : "launch"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>a</Text><Text dimColor>agent</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>m</Text><Text dimColor>{zh ? "模型" : "model"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>←→</Text><Text dimColor>{zh ? "切换工具" : "switch tool"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>p</Text><Text dimColor>{zh ? "服务商" : "service"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>s</Text><Text dimColor>{zh ? "统计" : "stats"}</Text>
            <Text dimColor>│</Text>
            <Text dimColor bold>q</Text><Text dimColor>{zh ? "退出" : "quit"}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export function LauncherView({ onResult, initialSessionSearch = false }: { onResult: (r: LauncherResult) => void; initialSessionSearch?: boolean }) {
  const [data, setData] = useState<LauncherLoadResult | null>(null);
  useEffect(() => { loadLauncherData(45).then(setData); }, []);
  if (!data) return <Text dimColor>Loading...</Text>;
  return (
    <LauncherViewInner
      clients={data.clients}
      defaultIdx={data.defaultIdx}
      hasProviders={data.hasProviders}
      pickCounts={data.pickCounts}
      initialSessionSearch={initialSessionSearch}
      onResult={onResult}
    />
  );
}
