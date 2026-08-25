/**
 * Launcher View
 *
 * 单容器：Header(服务商右上角,可聚焦切换) → Tab → 项目列表 → 启动参数
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { getAllClients, type ClientConfig, type LaunchOption } from "../../../clients";
import { getClientLaunchOptions } from "../../../clients/base";
import {
  getRecentProjectsForClient, getLastClientForCwd,
  getLastSelectedOptionsForClient,
  formatProjectPath, formatLastUsed, DISPLAY_PER_CLIENT,
} from "../../../project-history";
import {
  getProvidersForClient, getDefaultProvider, getClientProvider, setClientProvider,
  resolveProviderContext,
} from "../../../providers";
import type { Provider } from "../../../providers/types";
import { getLocale } from "../../../i18n";
import { getOfficialQuota, type OfficialQuota } from "../../../quota";
import { getModelPickCounts } from "../../../model-usage";
import { ProviderPicker, GroupPicker, initialModelPickerMode, visibleModelOptions } from "./LauncherPickers";
import { ModelGridPicker, buildGroupedGrid, getGridColumnCountForOptions, gridIndexOf } from "./ModelGridPicker";

const VERSION = process.env.VERSION || "dev";

/**
 * 计算启动面板的默认勾选集合（尊重记忆）：
 *  - 有记忆（lastSelectedOptionIds 非空）→ 用它初始化（用户手动关过就保持关）
 *  - 无记忆（首次）→ 默认勾选所有 defaultOn 的危险开关（默认全放行）
 */
export function buildInitialEnabled(
  launchOptions: LaunchOption[],
  lastSelectedOptionIds: string[],
): Set<string> {
  if (lastSelectedOptionIds.length > 0) return new Set(lastSelectedOptionIds);
  return new Set(launchOptions.filter((o) => o.defaultOn).map((o) => o.id));
}

export type LauncherResult =
  | { type: "launch"; clientId: string; projectPath?: string; args: string[]; envVars: Record<string, string>; selectedOptionIds: string[] }
  | { type: "agent" }
  | { type: "stats" }
  | { type: "config" }
  | { type: "language" }
  | { type: "providers" }
  | { type: "exit" };

const CLIENT_STYLE: Record<string, { icon: string; color: string }> = {
  "claude-code": { icon: "✦", color: "yellow" },
  codex:         { icon: "◈", color: "blue" },
  gemini:        { icon: "◆", color: "cyan" },
};
const DEFAULT_STYLE = { icon: "▪", color: "white" };

interface ProjectItem { label: string; hint: string; path?: string }
interface ClientData {
  client: ClientConfig;
  projects: ProjectItem[];
  providers: Provider[];    // 兼容的服务商列表
  activeProvIdx: number;    // 当前绑定的服务商 index
  launchOptions: LaunchOption[]; // 经 getClientLaunchOptions 扩充（含 Resume 等合成项）
  lastSelectedOptionIds: string[]; // 上次启动时勾选的 option id（从持久化恢复）
}

interface LoadResult {
  clients: ClientData[];
  defaultIdx: number;
  hasProviders: boolean;
  pickCounts: Record<string, number>;
}

async function loadData(): Promise<LoadResult> {
  const all = getAllClients();
  const lastId = await getLastClientForCwd();
  const defaultProv = await getDefaultProvider();
  const zh = getLocale() === "zh";

  const sorted = [...all].sort((a, b) => {
    if (a.id === lastId) return -1;
    if (b.id === lastId) return 1;
    return 0;
  });

  const clients: ClientData[] = [];
  for (const client of sorted) {
    const recent = await getRecentProjectsForClient(client.id, DISPLAY_PER_CLIENT, true);
    const cwd = process.cwd();
    const projects: ProjectItem[] = [
      { label: zh ? "在当前目录启动" : "Launch in current directory", hint: formatProjectPath(cwd, 45), path: cwd },
      ...recent.map((p) => ({
        label: formatProjectPath(p.path, 45),
        hint: formatLastUsed(p.lastLaunchedAt),
        path: p.path,
      })),
    ];
    const compatible = await getProvidersForClient(client.id);
    const bound = await getClientProvider(client.id);
    const active = bound || compatible.find((p) => p.id === defaultProv?.id) || compatible[0];
    const activeIdx = active ? compatible.findIndex((p) => p.id === active.id) : 0;
    const launchOptions = getClientLaunchOptions(client, active);
    const savedIds = await getLastSelectedOptionsForClient(client.id);
    // 过滤掉已失效的 option id（client 升级后某些 option 可能被移除）
    const validIds = launchOptions.map((o) => o.id);
    const lastSelectedOptionIds = savedIds.filter((id) => validIds.includes(id));
    clients.push({
      client,
      projects,
      providers: compatible,
      activeProvIdx: Math.max(activeIdx, 0),
      launchOptions,
      lastSelectedOptionIds,
    });
  }

  const hasProviders = clients.some((c) => c.providers.length > 0);
  let pickCounts: Record<string, number> = {};
  try {
    pickCounts = await getModelPickCounts();
  } catch {
    pickCounts = {};
  }
  return { clients, defaultIdx: 0, hasProviders, pickCounts };
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

type FocusArea = "projects" | "options";

/**
 * 选项区可见行：要么是一个 flag（直接勾选），要么是一个 group 入口（点进去选）。
 */
type OptionRow =
  | { kind: "flag"; opt: LaunchOption }
  | { kind: "group"; group: string; title: string }
  | { kind: "provider"; title: string };

function buildOptionRows(opts: LaunchOption[], zh: boolean): OptionRow[] {
  const rows: OptionRow[] = [];
  const seen = new Set<string>();
  for (const o of opts) {
    if (!o.group) {
      rows.push({ kind: "flag", opt: o });
    } else if (!seen.has(o.group)) {
      seen.add(o.group);
      const title = o.group === "model" ? (zh ? "模型" : "Model") : o.group;
      rows.push({ kind: "group", group: o.group, title });
    }
  }
  // 服务商入口固定放在最底部
  rows.push({ kind: "provider", title: zh ? "服务商" : "Provider" });
  return rows;
}

function getGroupSelection(opts: LaunchOption[], enabled: Set<string>, group: string): LaunchOption | undefined {
  return opts.find((o) => o.group === group && enabled.has(o.id));
}

function LauncherViewInner({ clients, defaultIdx, hasProviders, pickCounts, onResult }: {
  clients: ClientData[]; defaultIdx: number; hasProviders: boolean;
  pickCounts: Record<string, number>;
  onResult: (r: LauncherResult) => void;
}) {
  const { stdout } = useStdout();
  const [clientIdx, setClientIdx] = useState(defaultIdx);
  const [focus, setFocus] = useState<FocusArea>("projects");
  const [projectIdx, setProjectIdx] = useState(0);
  const [optionIdx, setOptionIdx] = useState(0);
  const [provIdx, setProvIdx] = useState(() => clients[defaultIdx]?.activeProvIdx || 0);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => buildInitialEnabled(clients[defaultIdx]?.launchOptions ?? [], clients[defaultIdx]?.lastSelectedOptionIds ?? [])
  );
  const [provMsg, setProvMsg] = useState("");
  /** 当前正在打开的 group picker（null = 主界面） */
  const [pickingGroup, setPickingGroup] = useState<string | null>(null);
  const [modelPickerMode, setModelPickerMode] = useState<"collapsed" | "grid">("collapsed");
  /** true = 服务商 picker（与 pickingGroup 互斥） */
  const [pickingProvider, setPickingProvider] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);

  const current = clients[clientIdx];
  const projects = current.projects;
  const provs = current.providers;
  const cs = CLIENT_STYLE[current.client.id] || DEFAULT_STYLE;
  const zh = getLocale() === "zh";

  const currentProv = provs[provIdx];

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
    setProjectIdx(0); setOptionIdx(0); setFocus("projects");
    setProvIdx(clients[clientIdx]?.activeProvIdx || 0);
    setPickingGroup(null);
    setModelPickerMode("collapsed");
    setPickingProvider(false);
    // 勾选状态也随工具切换：有记忆则恢复到该工具上次的选择，无记忆则默认全放行
    setEnabled(buildInitialEnabled(clients[clientIdx]?.launchOptions ?? [], clients[clientIdx]?.lastSelectedOptionIds ?? []));
  }, [clientIdx]);

  // provider 切换 / 初始加载：launchOptions 列表会变。
  //   1. 把 enabled 里已经失效的 option id 清掉（避免幽灵勾选）
  //   2. 若没有任何 model 被勾选，落到 provider.model 上（让 add provider 时挑的模型自动反映）
  useEffect(() => {
    const validIds = new Set(options.map((o) => o.id));
    const modelIds = new Set(options.filter((o) => o.group === "model").map((o) => o.id));
    const provModelOptionId = currentProv?.model ? `model-${currentProv.model}` : undefined;
    setEnabled((prev) => {
      const next = new Set<string>();
      let changed = false;
      let hasModel = false;
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
          if (modelIds.has(id)) hasModel = true;
        } else {
          changed = true;
        }
      }
      if (!hasModel && provModelOptionId && modelIds.has(provModelOptionId)) {
        next.add(provModelOptionId);
        changed = true;
      }
      return changed ? next : prev;
    });
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
          ? visibleModelOptions(groupOpts, enabled, pickCounts, false).list
          : groupOpts;
        initIdx = visible.findIndex((o) => o.id === cur.id) + 1;
      }
    }

    setPickerIdx(Math.max(0, initIdx));
    setModelPickerMode(mode);
    setPickingGroup(group);
  }, [enabled, options, pickCounts, stdout.columns, zh]);

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
        const rowsInOrder = grid.groups.flatMap((group) => group.rows);
        const pickerLen = grid.flat.length;
        if (input === "q") { setPickingGroup(null); setModelPickerMode("collapsed"); return; }
        if (key.escape) {
          if (initialModelPickerMode(groupOpts, pickCounts) === "grid") {
            setPickingGroup(null);
          } else {
            setModelPickerMode("collapsed");
            setPickerIdx(0);
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
        ? visibleModelOptions(groupOpts, enabled, pickCounts, false)
        : { list: groupOpts, hiddenCount: 0 };
      const pickerLen = visible.list.length + 1 + (visible.hiddenCount > 0 ? 1 : 0);
      if (key.escape || input === "q") { setPickingGroup(null); setModelPickerMode("collapsed"); return; }
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
          const initIdx = cur ? groupOpts.findIndex((o) => o.id === cur.id) : 0;
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
      const args: string[] = [];
      const envVars: Record<string, string> = {};
      const selectedOptionIds: string[] = [];
      for (const opt of options) {
        if (enabled.has(opt.id)) { args.push(...opt.args); if (opt.envVars) Object.assign(envVars, opt.envVars); selectedOptionIds.push(opt.id); }
      }
      onResult({ type: "launch", clientId: current.client.id, projectPath: project.path, args, envVars, selectedOptionIds });
    }
  }, [focus, clientIdx, projectIdx, optionIdx, provIdx, provs, currentProv, current, projects, options, optionRows, enabled, clients, onResult, zh, pickingGroup, pickingProvider, pickerIdx, pickCounts, modelPickerMode, stdout.columns, openGroupPicker]));

  return (
    <Box flexDirection="column" paddingX={0} paddingY={0}>

      {/* 主容器 */}
      <Box flexDirection="column" borderStyle="round" borderColor={cs.color} paddingX={1} paddingY={0}>

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

        {/* Tab 栏 */}
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

        <Divider color={cs.color} />

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
            expanded={pickingGroup !== "model"}
          />
        ) : (
          <>

        {/* 项目列表 */}
        {projects.map((p, i) => {
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
        {optionRows.length > 0 && (
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
        {focus === "options" ? (
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

export function LauncherView({ onResult }: { onResult: (r: LauncherResult) => void }) {
  const [data, setData] = useState<LoadResult | null>(null);
  useEffect(() => { loadData().then(setData); }, []);
  if (!data) return <Text dimColor>Loading...</Text>;
  return (
    <LauncherViewInner
      clients={data.clients}
      defaultIdx={data.defaultIdx}
      hasProviders={data.hasProviders}
      pickCounts={data.pickCounts}
      onResult={onResult}
    />
  );
}
