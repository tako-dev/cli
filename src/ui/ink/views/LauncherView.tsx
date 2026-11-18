/**
 * Launcher View
 *
 * 单容器：Header(服务商徽章 + 配额) → Tab → 未安装提示 / 搜索会话 / 项目列表 → 启动参数
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { getClientLaunchOptions } from "../../../clients/base";
import { GROK_DEFAULT_MODEL } from "../../../clients/grok";
import { PI_DEFAULT_MODEL } from "../../../clients/pi";
import { installAtVersion } from "../../../installer-versions";
import { setClientProvider, resolveProviderContext } from "../../../providers";
import { getLocale } from "../../../i18n";
import { getOfficialQuota, type OfficialQuota } from "../../../quota";
import { loadLauncherData } from "../../shared/launcher-data";
import {
  buildOptionRows,
  enabledWithProviderDefaultModel,
  EXPLICIT_DEFAULT_MODEL_SENTINEL,
  selectedArgs,
} from "../../shared/launch-options";
import { resolveModelPickerEntries } from "../../shared/model-picker";
import type { LauncherClientData, LauncherLoadResult, LauncherResult } from "../../shared/types";
import { nextLauncherFocus, type LauncherFocus } from "../launcher-keys";
import { ProviderPicker, GroupPicker } from "./LauncherPickers";
import {
  CLIENT_STYLE,
  DEFAULT_STYLE,
  LauncherClientTabs,
  LauncherFooter,
  LauncherOptionsSection,
  ProviderBadge,
  QuotaLine,
} from "./LauncherChrome";
import {
  LauncherSessionDetail,
  LauncherSessionResults,
  LauncherSessionSearchBox,
  sessionSourceColor,
  sessionSourceLabel,
  useLauncherSessionSearch,
} from "./LauncherSessionPane";
import { normalizeSessionSearchInput } from "../../../sessions/input";
import type { LaunchOption } from "../../../clients";

export type { LauncherResult } from "../../shared/types";
export { sessionSourceColor, sessionSourceLabel };

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

function LauncherViewInner({
  clients,
  defaultIdx,
  hasProviders,
  pickCounts,
  initialSessionSearch = false,
  onResult,
}: {
  clients: LauncherClientData[];
  defaultIdx: number;
  hasProviders: boolean;
  pickCounts: Record<string, number>;
  initialSessionSearch?: boolean;
  onResult: (r: LauncherResult) => void;
}) {
  const { stdout } = useStdout();
  const columns = stdout.columns || 80;
  const rows = stdout.rows || 30;
  const [clientIdx, setClientIdx] = useState(defaultIdx);
  const [focus, setFocus] = useState<LauncherFocus>(initialSessionSearch ? "search" : "projects");
  const [projectIdx, setProjectIdx] = useState(0);
  const [optionIdx, setOptionIdx] = useState(0);
  const [provIdx, setProvIdx] = useState(() => clients[defaultIdx]?.activeProvIdx || 0);
  const [enabled, setEnabled] = useState<Set<string>>(
    () => buildInitialEnabled(clients[defaultIdx]?.launchOptions ?? [], clients[defaultIdx]?.lastSelectedOptionIds ?? []),
  );
  const [installedMap, setInstalledMap] = useState<Record<string, boolean | undefined>>(
    () => Object.fromEntries(clients.map((c) => [c.client.id, c.installed])),
  );
  const [installingClient, setInstallingClient] = useState<string | null>(null);
  const [provMsg, setProvMsg] = useState("");
  const [pickingGroup, setPickingGroup] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [pickingProvider, setPickingProvider] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);
  const initialClientEffect = useRef(true);

  const current = clients[clientIdx];
  const projects = current.projects;
  const provs = current.providers;
  const cs = CLIENT_STYLE[current.client.id] || DEFAULT_STYLE;
  const zh = getLocale() === "zh";
  const isInstalled = installedMap[current.client.id] ?? current.installed;
  const currentProv = provs[provIdx];

  const exitSearchToProjects = useCallback(() => setFocus("projects"), []);
  const sessionSearch = useLauncherSessionSearch({
    currentCwd: projects[0]?.path,
    columns,
    rows,
    onExitSearch: exitSearchToProjects,
    onResult,
  });

  const options = React.useMemo(
    () => getClientLaunchOptions(current.client, currentProv),
    [current.client.id, currentProv?.id, currentProv?.type],
  );
  const optionRows = React.useMemo(() => buildOptionRows(options, zh), [options, zh]);
  const provName = currentProv?.name || (zh ? "未配置" : "N/A");

  const [quota, setQuota] = useState<OfficialQuota | null>(null);
  useEffect(() => {
    if (!currentProv) { setQuota(null); return; }
    let cancelled = false;
    getOfficialQuota(currentProv).then((q) => {
      if (!cancelled) setQuota(q);
    });
    return () => { cancelled = true; };
  }, [currentProv?.id, currentProv?.type]);

  useEffect(() => {
    if (initialClientEffect.current) { initialClientEffect.current = false; return; }
    setProjectIdx(0);
    setOptionIdx(0);
    setFocus("projects");
    setProvIdx(clients[clientIdx]?.activeProvIdx || 0);
    setPickingGroup(null);
    setModelQuery("");
    setPickingProvider(false);
    setEnabled(buildInitialEnabled(clients[clientIdx]?.launchOptions ?? [], clients[clientIdx]?.lastSelectedOptionIds ?? []));
  }, [clientIdx]);

  useEffect(() => {
    setEnabled((prev) => enabledWithProviderDefaultModel(
      prev,
      options,
      currentProv?.model,
      current.client.id === "pi" ? `model-${PI_DEFAULT_MODEL}`
        : current.client.id === "grok" ? `model-${GROK_DEFAULT_MODEL}`
        : undefined,
    ));
  }, [options, currentProv?.model]);

  const openGroupPicker = useCallback((group: string) => {
    const groupOpts = options.filter((o) => o.group === group);
    if (groupOpts.length === 0) return;
    setModelQuery("");
    setPickerIdx(0);
    setPickingGroup(group);
  }, [options]);

  const enterSearchFocus = useCallback(() => {
    sessionSearch.resetForSearchEntry();
    setFocus("search");
  }, [sessionSearch]);

  const triggerInstall = useCallback(async (launchAfter: boolean) => {
    if (installingClient) return;
    const target = current;
    const targetProject = projects[projectIdx];
    const selected = selectedArgs({ launchOptions: options, enabled });
    setInstallingClient(target.client.id);
    try {
      await installAtVersion(target.client, "latest");
      target.installed = true;
      setInstalledMap((prev) => ({ ...prev, [target.client.id]: true }));
      setProvMsg(zh ? `✓ ${target.client.name} 安装完成` : `✓ ${target.client.name} installed`);
      setTimeout(() => setProvMsg(""), 2500);
      if (launchAfter) {
        onResult({
          type: "launch",
          clientId: target.client.id,
          projectPath: targetProject.path,
          ...selected,
        });
      }
    } catch (e) {
      setProvMsg(zh ? `✗ 安装失败: ${(e as Error).message}` : `✗ Install failed: ${(e as Error).message}`);
      setTimeout(() => setProvMsg(""), 3500);
    } finally {
      setInstallingClient(null);
    }
  }, [installingClient, current, projects, projectIdx, options, enabled, zh, onResult]);

  useInput(useCallback((input: string, key: any) => {
    if (installingClient) return;

    // ─── 服务商快切 picker 模式 ───
    if (pickingProvider) {
      const pickerLen = provs.length + 1;
      if (key.escape || input === "q") { setPickingProvider(false); return; }
      if (key.upArrow) { setPickerIdx((p) => (p > 0 ? p - 1 : pickerLen - 1)); return; }
      if (key.downArrow) { setPickerIdx((p) => (p < pickerLen - 1 ? p + 1 : 0)); return; }
      if (input === "k") {
        const prov = pickerIdx < provs.length ? provs[pickerIdx] : undefined;
        if (prov && prov.type !== "claude-subscription" && prov.type !== "codex-subscription") {
          setPickingProvider(false);
          onResult({ type: "providers", clientId: current.client.id, rekeyProviderId: prov.id });
        }
        return;
      }
      if (input === "m") {
        setPickingProvider(false);
        onResult({ type: "providers", clientId: current.client.id });
        return;
      }
      if (key.return) {
        if (pickerIdx < provs.length) {
          const prov = provs[pickerIdx];
          setProvIdx(pickerIdx);
          (async () => {
            await setClientProvider(current.client.id, prov.id);
            if (current.client.setupConfigFiles) {
              try {
                await current.client.setupConfigFiles(resolveProviderContext(prov));
              } catch {
                setProvMsg(zh ? "⚠ 配置同步失败" : "⚠ Config sync failed");
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
          setPickingProvider(false);
          onResult({ type: "providers", clientId: current.client.id });
        }
      }
      return;
    }

    // ─── 模型 / 分组 picker 模式 ───
    if (pickingGroup) {
      const groupOpts = options.filter((o) => o.group === pickingGroup);
      const isModelGroup = pickingGroup === "model";
      const modelEntries = isModelGroup
        ? resolveModelPickerEntries(groupOpts, pickCounts, modelQuery, zh)
        : [];
      const pickerLen = isModelGroup ? modelEntries.length : groupOpts.length + 1;

      if (key.escape || (!isModelGroup && input === "q")) {
        setPickingGroup(null);
        setModelQuery("");
        return;
      }
      if (key.upArrow) {
        if (pickerLen === 0) return;
        setPickerIdx((p) => (p > 0 ? p - 1 : pickerLen - 1));
        return;
      }
      if (key.downArrow) {
        if (pickerLen === 0) return;
        setPickerIdx((p) => (p < pickerLen - 1 ? p + 1 : 0));
        return;
      }
      if (key.return) {
        if (isModelGroup) {
          const picked = modelEntries[pickerIdx];
          if (!picked) return;
          if (picked.kind === "default") {
            setEnabled((prev) => {
              const next = new Set(prev);
              for (const o of groupOpts) next.delete(o.id);
              next.add(EXPLICIT_DEFAULT_MODEL_SENTINEL);
              return next;
            });
          } else if (picked.option) {
            const optId = picked.option.id;
            setEnabled((prev) => {
              const next = new Set(prev);
              for (const o of groupOpts) next.delete(o.id);
              next.delete(EXPLICIT_DEFAULT_MODEL_SENTINEL);
              next.add(optId);
              return next;
            });
          }
        } else if (pickerIdx === 0) {
          setEnabled((prev) => {
            const next = new Set(prev);
            for (const o of groupOpts) next.delete(o.id);
            return next;
          });
        } else {
          const picked = groupOpts[pickerIdx - 1];
          if (picked) {
            setEnabled((prev) => {
              const next = new Set(prev);
              for (const o of groupOpts) next.delete(o.id);
              next.add(picked.id);
              return next;
            });
          }
        }
        setPickingGroup(null);
        setModelQuery("");
        return;
      }
      if (isModelGroup) {
        if (key.backspace || key.delete) {
          setModelQuery((value) => value.slice(0, -1));
          setPickerIdx(0);
          return;
        }
        const searchInput = normalizeSessionSearchInput(input, key);
        if (searchInput) {
          setModelQuery((value) => value + searchInput);
          setPickerIdx(0);
        }
      }
      return;
    }

    // ─── Tab / Shift+Tab 跨区切换 ───
    if (key.tab) {
      const next = nextLauncherFocus(focus, Boolean(key.shift), optionRows.length > 0);
      if (focus === "search" && next !== "search") {
        sessionSearch.clearDetail();
      }
      if (next === "search" && focus !== "search") {
        enterSearchFocus();
        return;
      }
      setFocus(next);
      return;
    }

    // ─── 搜索会话焦点区 ───
    if (focus === "search") {
      sessionSearch.handleSearchInput(input, key);
      return;
    }

    // ─── 非搜索 / 非 picker 快捷键 ───
    if (input === "/") { enterSearchFocus(); return; }
    if (input === "q") { onResult({ type: "exit" }); return; }
    if (input === "a") { onResult({ type: "agent" }); return; }
    if (input === "s") { onResult({ type: "stats" }); return; }
    if (input === "c") { onResult({ type: "config" }); return; }
    if (input === "l") { onResult({ type: "language" }); return; }
    if (input === "p") { setPickerIdx(provIdx); setPickingProvider(true); return; }
    if (input === "v") { onResult({ type: "client-versions", clientId: current.client.id }); return; }
    if (input === "m") { openGroupPicker("model"); return; }
    if (input === "i" && isInstalled === false) { void triggerInstall(false); return; }

    const num = parseInt(input, 10);
    if (num >= 1 && num <= clients.length) { setClientIdx(num - 1); return; }

    if (key.leftArrow) { setClientIdx((p) => (p > 0 ? p - 1 : clients.length - 1)); return; }
    if (key.rightArrow) { setClientIdx((p) => (p < clients.length - 1 ? p + 1 : 0)); return; }

    if (focus === "projects") {
      if (key.downArrow) {
        if (projectIdx < projects.length - 1) setProjectIdx((p) => p + 1);
        else if (optionRows.length > 0) { setFocus("options"); setOptionIdx(0); }
        return;
      }
      if (key.upArrow) {
        if (projectIdx > 0) setProjectIdx((p) => p - 1);
        else enterSearchFocus();
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
        setPickerIdx(provIdx);
        setPickingProvider(true);
      }
      return;
    }

    if (key.return) {
      if (focus === "options" && optionRows.length > 0) {
        const row = optionRows[optionIdx];
        if (row.kind === "group") { openGroupPicker(row.group); return; }
        if (row.kind === "provider") { setPickerIdx(provIdx); setPickingProvider(true); return; }
      }
      if (isInstalled === false) {
        void triggerInstall(true);
        return;
      }
      const project = projects[projectIdx];
      const selected = selectedArgs({ launchOptions: options, enabled });
      onResult({ type: "launch", clientId: current.client.id, projectPath: project.path, ...selected });
    }
  }, [
    installingClient, focus, clientIdx, projectIdx, optionIdx, provIdx, provs, current, projects,
    options, optionRows, enabled, clients, onResult, zh, pickingGroup, pickingProvider, pickerIdx,
    pickCounts, modelQuery, openGroupPicker, enterSearchFocus, triggerInstall, isInstalled, sessionSearch,
  ]));

  return (
    <Box flexDirection="column" paddingX={0} paddingY={0}>
      <Box flexDirection="column" borderStyle="round" borderColor={focus === "search" ? "cyan" : cs.color} paddingX={1} paddingY={0}>
        {/* Header */}
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold>🐙 Tako</Text>
            <Text dimColor>v{VERSION}</Text>
            <Text dimColor>│</Text>
            <ProviderBadge provider={currentProv} zh={zh} />
          </Box>
          <Box>
            {provMsg && <Text color={provMsg.startsWith("✗") || provMsg.startsWith("⚠") ? "yellow" : "green"}>{provMsg}</Text>}
            {!provMsg && quota && <QuotaLine quota={quota} zh={zh} />}
          </Box>
        </Box>

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

        {focus !== "search" && (
          <LauncherClientTabs
            clients={clients}
            clientIdx={clientIdx}
            color={cs.color}
            showInstallBanner={!pickingProvider && !pickingGroup && isInstalled === false}
            installing={installingClient === current.client.id}
            clientName={current.client.name}
            zh={zh}
          />
        )}

        {pickingProvider ? (
          <ProviderPicker provs={provs} provIdx={provIdx} pickerIdx={pickerIdx} color={cs.color} zh={zh} />
        ) : pickingGroup ? (
          <GroupPicker
            group={pickingGroup}
            options={options}
            enabled={enabled}
            pickerIdx={pickerIdx}
            color={cs.color}
            zh={zh}
            pickCounts={pickCounts}
            query={modelQuery}
          />
        ) : (
          <>
            <LauncherSessionSearchBox
              active={focus === "search"}
              sessionQuery={sessionSearch.sessionQuery}
              indexingSessions={sessionSearch.indexingSessions}
              sessionIndexError={sessionSearch.sessionIndexError}
              columns={columns}
              zh={zh}
            />

            {sessionSearch.sessionDetailKey && sessionSearch.sessionDetail ? (
              <LauncherSessionDetail
                sessionDetailKey={sessionSearch.sessionDetailKey}
                sessionDetail={sessionSearch.sessionDetail}
                columns={columns}
                zh={zh}
              />
            ) : focus === "search" ? (
              <LauncherSessionResults
                sessionWindow={sessionSearch.sessionWindow}
                sessionWindowStart={sessionSearch.sessionWindowStart}
                sessionPageSize={sessionSearch.sessionPageSize}
                sessionResultsLength={sessionSearch.sessionResults.length}
                sessionHasMore={sessionSearch.sessionHasMore}
                sessionIdx={sessionSearch.sessionIdx}
                columns={columns}
                zh={zh}
              />
            ) : (
              projects.map((p, i) => {
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
              })
            )}

            {focus !== "search" && optionRows.length > 0 && (
              <LauncherOptionsSection
                optionRows={optionRows}
                options={options}
                enabled={enabled}
                focusedArea={focus === "options"}
                optionIdx={optionIdx}
                color={cs.color}
                currentProv={currentProv}
                provName={provName}
                zh={zh}
              />
            )}
          </>
        )}
      </Box>

      <LauncherFooter
        focus={focus}
        resumeUnsupported={sessionSearch.sessionResults[sessionSearch.sessionIdx]?.session.resumeCapability === "unsupported"}
        zh={zh}
      />
    </Box>
  );
}

export function LauncherView({
  onResult,
  initialSessionSearch = false,
}: {
  onResult: (r: LauncherResult) => void;
  initialSessionSearch?: boolean;
}) {
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
