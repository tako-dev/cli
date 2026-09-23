/**
 * Provider 管理 — 主组件（逻辑 + list/add-type 渲染）
 * 卡片/输入/详情渲染在 ProviderComponents.tsx
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getLocale } from "../../../i18n";
import {
  getProviders, getDefaultProvider, addProvider, updateProvider, deleteProvider,
  setDefaultProvider, setClientProvider, getClientProvider,
  detectProviders, mergeDetectedProviders,
} from "../../../providers";
import { getAllClients } from "../../../clients";
import { isProviderCompatible, SUBAGENT_MODEL_CC_DEFAULT } from "../../../providers/types";
import type { Provider, ProviderType } from "../../../providers/types";
import { PROVIDER_TYPE_NAMES, getDefaultSupportedClients, getDefaultModel, getDefaultBaseUrl, getModelChoices } from "../../../providers/types";
import { BUNDLED_ENTRIES } from "../../../models/bundled";
import { track, identify, reset as resetAnalytics } from "../../../analytics";
import { PROV_STYLE, TAB_STYLE, ADD_TYPES, ProviderCard, InputScreen, DetailScreen } from "./ProviderComponents";

type Screen = "list" | "detail" | "add-type" | "add-key" | "add-url" | "add-model" | "add-ctx" | "submodel" | "submodel-custom" | "scanning" | "logging-in";

// ─── Main Component ─────────────────────────────────

type DoneAction = "client-versions" | undefined;

function ProviderMenuComponent({ onDone }: { onDone: (action?: DoneAction) => void }) {
  const [screen, setScreen] = useState<Screen>("list");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultId, setDefaultIdState] = useState<string | undefined>();
  const [clientBindings, setClientBindings] = useState<Record<string, string | undefined>>({});
  const [tabIdx, setTabIdx] = useState(0);
  const [rowIdx, setRowIdx] = useState(0);
  const [detailIdx, setDetailIdx] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("");
  const [addType, setAddType] = useState<ProviderType>("tako");
  const [addKey, setAddKey] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addCtx, setAddCtx] = useState("");
  const [subModelInput, setSubModelInput] = useState("");
  const zh = getLocale() === "zh";

  const clients = getAllClients();
  const currentClient = clients[tabIdx];
  const tabColor = TAB_STYLE[currentClient?.id]?.color || "white";

  const compatible = currentClient
    ? providers.filter((p) => isProviderCompatible(p, currentClient.id))
    : [];
  const boundId = clientBindings[currentClient?.id] || defaultId;
  const totalRows = compatible.length + 4; // providers + add + scan + versions + back

  const selectedProv = providers.find((p) => p.id === selectedId);
  const isSubscription = selectedProv?.type === "claude-subscription" || selectedProv?.type === "codex-subscription";
  const detailActions = selectedProv ? [
    ...(selectedProv.id !== defaultId ? ["default"] as const : []),
    ...(isSubscription ? ["relogin"] as const : []),
    // Claude Code 子代理模型三态（跟随主模型 / CC 默认 / 指定模型）只对 API key 类 provider 有意义
    ...(!isSubscription ? ["submodel"] as const : []),
    ...(selectedProv.builtin ? ["rekey"] as const : ["delete"] as const),
    "back" as const,
  ] : ["back" as const];

  const refresh = useCallback(async () => {
    const list = await getProviders();
    const def = await getDefaultProvider();
    setProviders(list);
    setDefaultIdState(def?.id);
    const bindings: Record<string, string | undefined> = {};
    for (const c of getAllClients()) {
      const bound = await getClientProvider(c.id);
      bindings[c.id] = bound?.id;
    }
    setClientBindings(bindings);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setRowIdx(0); }, [tabIdx]);
  useEffect(() => {
    if (message) { const timer = setTimeout(() => setMessage(""), 3000); return () => clearTimeout(timer); }
  }, [message]);

  // ─── Action helpers ───────────────────

  const finishAdd = useCallback(async () => {
    if (selectedId && providers.find((p) => p.id === selectedId)?.builtin) {
      await updateProvider(selectedId, { apiKey: addKey });
      setMessage(zh ? "Key 已更新" : "Key updated");
      await refresh(); setScreen("list"); setRowIdx(0); return;
    }
    const name = PROVIDER_TYPE_NAMES[addType]?.[zh ? "zh" : "en"] || addType;
    const url = addUrl || getDefaultBaseUrl(addType);
    const model = addModel || getDefaultModel(addType);
    const ctxNum = addCtx ? parseInt(addCtx, 10) : NaN;
    const modelContextWindow = Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : undefined;
    await addProvider({ name, type: addType, apiKey: addKey, baseUrl: url, model, modelContextWindow, supportedClients: getDefaultSupportedClients(addType) });
    track("provider_added", { provider_type: addType, method: "manual" });
    resetAnalytics(); identify();
    setMessage(zh ? "已添加" : "Added");
    setAddCtx("");
    await refresh(); setScreen("list"); setRowIdx(0);
  }, [addType, addKey, addUrl, addModel, addCtx, zh, refresh, selectedId, providers]);

  const doScan = useCallback(async () => {
    setScreen("scanning");
    const detected = await detectProviders();
    const added = await mergeDetectedProviders(detected);
    if (added > 0) { resetAnalytics(); identify(); }
    setMessage(zh ? `扫描完成，新增 ${added} 个` : `Scan done, ${added} added`);
    await refresh(); setScreen("list"); setRowIdx(0);
  }, [refresh, zh]);

  const [loginTool, setLoginTool] = useState<"claude" | "codex">("claude");

  const doLogin = useCallback(async (tool: "claude" | "codex") => {
    setLoginTool(tool);
    setScreen("logging-in");
    const cmd = tool === "claude" ? ["claude", "auth", "login", "--claudeai"] : ["codex", "login"];
    // pipe stdout/stderr 避免污染 Ink 渲染，stdin inherit 保留交互能力
    const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const { invalidateQuotaCache } = await import("../../../quota");
    if (tool === "claude") {
      try {
        const chk = Bun.spawn(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
        const txt = await new Response(chk.stdout).text(); await chk.exited;
        const st = JSON.parse(txt.trim());
        if (st.loggedIn && st.authMethod === "claude.ai") {
          const email = st.email || ""; const sub = st.subscriptionType || "pro";
          const nm = `Claude ${sub.charAt(0).toUpperCase() + sub.slice(1)}${email ? ` (${email})` : ""}`;
          // 从 keychain 读最新 OAuth 凭据
          const { readClaudeAuth } = await import("../../../clients/claude-credentials");
          const snap = await readClaudeAuth();
          const authData = snap.credentials || snap.oauthAccount
            ? { credentials: snap.credentials, oauthAccount: snap.oauthAccount }
            : undefined;

          const existing = providers.find((p) => p.type === "claude-subscription" && p.email === email);
          if (!existing) {
            await addProvider({ name: nm, type: "claude-subscription", email, subscriptionType: sub, supportedClients: getDefaultSupportedClients("claude-subscription"), authData });
            setMessage(zh ? "Claude 订阅已添加" : "Claude subscription added");
          } else {
            // 账号已存在 — 用最新 keychain 数据更新 authData，并清掉用量缓存
            await updateProvider(existing.id, { authData });
            invalidateQuotaCache(existing.id, "claude-subscription");
            setMessage(zh ? "已更新 tokens" : "Tokens updated");
          }
        } else { setMessage(zh ? "登录失败" : "Login failed"); }
      } catch { setMessage(zh ? "检测失败" : "Detection failed"); }
    } else {
      try {
        const fs = await import("fs/promises"); const { homedir } = await import("os"); const { join } = await import("path");
        const auth = JSON.parse(await fs.readFile(join(homedir(), ".codex", "auth.json"), "utf-8"));
        if (auth.auth_mode === "chatgpt" && auth.tokens?.access_token) {
          let email = "";
          try { email = JSON.parse(atob(auth.tokens.id_token.split(".")[1])).email || ""; } catch {}
          // 按 email 去重（支持多账号）
          const existing = providers.find((p) => p.type === "codex-subscription" && p.email === email);
          if (!existing) {
            await addProvider({ name: email ? `Codex Plus (${email})` : "Codex Subscription", type: "codex-subscription", email: email || undefined, supportedClients: getDefaultSupportedClients("codex-subscription"), authData: auth });
            setMessage(zh ? "Codex 订阅已添加" : "Codex subscription added");
          } else {
            // 账号已存在 — 更新 tokens（可能刷新了），同时清掉用量缓存
            await updateProvider(existing.id, { authData: auth });
            invalidateQuotaCache(existing.id, "codex-subscription");
            setMessage(zh ? "已更新 tokens" : "Tokens updated");
          }
        } else { setMessage(zh ? "登录失败" : "Login failed"); }
      } catch { setMessage(zh ? "检测失败" : "Detection failed"); }
    }
    await refresh(); setScreen("list"); setRowIdx(0);
  }, [providers, zh, refresh]);

  // ─── Keyboard ─────────────────────────

  useInput(useCallback((input: string, key: any) => {
    if (screen === "list") {
      if (key.escape || input === "q") { onDone(); return; }
      if (key.leftArrow) { setTabIdx((p) => (p > 0 ? p - 1 : clients.length - 1)); return; }
      if (key.rightArrow) { setTabIdx((p) => (p < clients.length - 1 ? p + 1 : 0)); return; }
      const num = parseInt(input);
      if (num >= 1 && num <= clients.length) { setTabIdx(num - 1); return; }
      if (key.upArrow) { setRowIdx((p) => (p > 0 ? p - 1 : totalRows - 1)); return; }
      if (key.downArrow) { setRowIdx((p) => (p < totalRows - 1 ? p + 1 : 0)); return; }
      if (key.return) {
        if (rowIdx < compatible.length) {
          const prov = compatible[rowIdx];
          setClientProvider(currentClient.id, prov.id).then(() => {
            // 绑定后自动返回主页
            onDone();
          });
        } else if (rowIdx === compatible.length) { setScreen("add-type"); setRowIdx(0); }
        else if (rowIdx === compatible.length + 1) { doScan(); }
        else if (rowIdx === compatible.length + 2) { onDone("client-versions"); }
        else { onDone(); }
        return;
      }
      if ((input === "d" || input === "e") && rowIdx < compatible.length) {
        setSelectedId(compatible[rowIdx].id); setScreen("detail"); setDetailIdx(0);
      }
      return;
    }
    if (screen === "detail") {
      if (key.leftArrow) { setDetailIdx((p) => (p > 0 ? p - 1 : detailActions.length - 1)); return; }
      if (key.rightArrow) { setDetailIdx((p) => (p < detailActions.length - 1 ? p + 1 : 0)); return; }
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (key.return) {
        const a = detailActions[detailIdx];
        if (a === "back") { setScreen("list"); setRowIdx(0); return; }
        if (a === "default") { setDefaultProvider(selectedId).then(() => { setMessage(zh ? "已设为默认" : "Set as default"); refresh(); setScreen("list"); setRowIdx(0); }); }
        if (a === "delete") { deleteProvider(selectedId).then(() => { setMessage(zh ? "已删除" : "Deleted"); refresh(); setScreen("list"); setRowIdx(0); }); }
        if (a === "rekey") { setAddType(selectedProv?.type || "tako"); setAddKey(""); setScreen("add-key"); setRowIdx(0); }
        if (a === "submodel") {
          const cur = selectedProv?.subagentModel;
          setRowIdx(cur === SUBAGENT_MODEL_CC_DEFAULT ? 1 : cur ? 2 : 0);
          setSubModelInput(cur && cur !== SUBAGENT_MODEL_CC_DEFAULT ? cur : "");
          setScreen("submodel");
        }
        if (a === "relogin") {
          // 重跑订阅登录流程；登录成功后 doLogin 内部会更新 authData
          const tool = selectedProv?.type === "codex-subscription" ? "codex" : "claude";
          setScreen("list"); setRowIdx(0);
          doLogin(tool);
        }
      }
      return;
    }
    if (screen === "submodel") {
      if (key.escape) { setScreen("detail"); setDetailIdx(0); return; }
      if (key.upArrow) { setRowIdx((p) => (p > 0 ? p - 1 : 2)); return; }
      if (key.downArrow) { setRowIdx((p) => (p < 2 ? p + 1 : 0)); return; }
      if (key.return) {
        const done = (msg: string) => { setMessage(msg); refresh(); setScreen("detail"); setDetailIdx(0); };
        if (rowIdx === 0) {
          updateProvider(selectedId, { subagentModel: undefined })
            .then(() => done(zh ? "子代理模型：跟随主模型" : "Subagent: follow main"));
        } else if (rowIdx === 1) {
          updateProvider(selectedId, { subagentModel: SUBAGENT_MODEL_CC_DEFAULT })
            .then(() => done(zh ? "子代理模型：Claude Code 默认" : "Subagent: CC default"));
        } else {
          setScreen("submodel-custom");
        }
        return;
      }
      return;
    }
    if (screen === "submodel-custom") {
      if (key.escape) { setScreen("submodel"); return; }
      if (key.return) {
        const v = subModelInput.trim();
        updateProvider(selectedId, { subagentModel: v || undefined })
          .then(() => {
            setMessage(v
              ? (zh ? `子代理模型：${v}` : `Subagent: ${v}`)
              : (zh ? "子代理模型：跟随主模型" : "Subagent: follow main"));
            refresh(); setScreen("detail"); setDetailIdx(0);
          });
        return;
      }
      if (key.backspace || key.delete) { setSubModelInput((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl) { setSubModelInput((p) => p + input); }
      return;
    }
    if (screen === "add-type") {
      if (key.upArrow) { setRowIdx((p) => (p > 0 ? p - 1 : ADD_TYPES.length - 1)); return; }
      if (key.downArrow) { setRowIdx((p) => (p < ADD_TYPES.length - 1 ? p + 1 : 0)); return; }
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (key.return) {
        const sel = ADD_TYPES[rowIdx]; setAddType(sel);
        if (sel === "claude-subscription") { doLogin("claude"); return; }
        if (sel === "codex-subscription") { doLogin("codex"); return; }
        setAddKey(""); setAddUrl(""); setAddModel(getDefaultModel(sel) || "");
        setScreen("add-key"); setRowIdx(0);
      }
      return;
    }
    if (screen === "add-key") {
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (key.return && addKey) {
        // custom 需要填 URL；deepseek/anthropic/tako/xiaomi 走模型选择
        if (addType === "custom") { setScreen("add-url"); }
        else if (addType === "deepseek" || addType === "anthropic" || addType === "tako" || addType === "xiaomi") { setScreen("add-model"); setRowIdx(0); }
        else { finishAdd(); }
        return;
      }
      if (key.backspace || key.delete) { setAddKey((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl) { setAddKey((p) => p + input); }
      return;
    }
    if (screen === "add-url") {
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (key.return) { setScreen("add-model"); setRowIdx(0); return; }
      if (key.backspace || key.delete) { setAddUrl((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl) { setAddUrl((p) => p + input); }
      return;
    }
    if (screen === "add-model") {
      const choices = getModelChoices(addType);
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (choices) {
        // 列表选择模式 — catalog 已经有 metadata，无需再问 ctx window
        if (key.upArrow) { setRowIdx((p) => (p > 0 ? p - 1 : choices.length - 1)); return; }
        if (key.downArrow) { setRowIdx((p) => (p < choices.length - 1 ? p + 1 : 0)); return; }
        if (key.return) { setAddModel(choices[rowIdx]); setTimeout(() => finishAdd(), 0); return; }
      } else {
        // 自由输入模式：catalog 里查得到 → 直接完成；查不到 → 让用户录 ctx window
        if (key.return) {
          const id = addModel.trim();
          if (id && BUNDLED_ENTRIES.some((e) => e.id === id)) {
            finishAdd();
          } else {
            setScreen("add-ctx");
          }
          return;
        }
        if (key.backspace || key.delete) { setAddModel((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl) { setAddModel((p) => p + input); }
      }
      return;
    }
    if (screen === "add-ctx") {
      if (key.escape) { setScreen("list"); setRowIdx(0); return; }
      if (key.return) { finishAdd(); return; }
      if (key.backspace || key.delete) { setAddCtx((p) => p.slice(0, -1)); return; }
      // 仅接受数字
      if (input && !key.ctrl && /^[0-9]$/.test(input)) { setAddCtx((p) => p + input); }
      return;
    }
  }, [screen, rowIdx, detailIdx, compatible, totalRows, clients.length, currentClient, selectedId, selectedProv, detailActions, addType, addKey, addUrl, addModel, addCtx, subModelInput, onDone, doScan, doLogin, finishAdd, refresh, zh]));

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  if (screen === "scanning" || screen === "logging-in") {
    const ls = screen === "logging-in"
      ? PROV_STYLE[loginTool === "claude" ? "claude-subscription" : "codex-subscription"]
      : { icon: "⏳", color: "yellow" };
    const msg = screen === "scanning"
      ? (zh ? "正在扫描本地订阅..." : "Scanning local subscriptions...")
      : (zh ? "正在登录，请在浏览器中完成授权..." : "Logging in, please authorize in browser...");
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box borderStyle="round" borderColor={ls.color} paddingX={3} paddingY={1} flexDirection="column" alignItems="center">
          <Text color={ls.color} bold>{ls.icon} {msg}</Text>
          {screen === "logging-in" && <Text dimColor>{zh ? "完成后将自动返回" : "Will return automatically when done"}</Text>}
        </Box>
      </Box>
    );
  }

  if (screen === "add-key" || screen === "add-url" || screen === "add-model" || screen === "add-ctx") {
    return <InputScreen screen={screen} addType={addType} addKey={addKey} addUrl={addUrl} addModel={addModel} addCtx={addCtx} rowIdx={rowIdx} zh={zh} />;
  }

  if (screen === "add-type") {
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

  if (screen === "submodel" && selectedProv) {
    const cur = selectedProv.subagentModel;
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

  if (screen === "submodel-custom" && selectedProv) {
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

  if (screen === "detail" && selectedProv) {
    return <DetailScreen provider={selectedProv} defaultId={defaultId} detailActions={detailActions as string[]} detailIdx={detailIdx} zh={zh} />;
  }

  // ═══════════════════════════════════════
  // List screen (main)
  // ═══════════════════════════════════════

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>

      {/* ═══ Banner ═══ */}
      <Box borderStyle="round" borderColor="gray" paddingX={3} paddingY={0}>
        <Text bold>⚡ {zh ? "管理服务商" : "Manage Providers"}</Text>
        {message && <Text color="green">  ✓ {message}</Text>}
      </Box>

      {/* ═══ 工具 Tab 切换 ═══ */}
      <Box marginTop={1} gap={1} justifyContent="center">
        <Text dimColor>‹</Text>
        {clients.map((c, i) => {
          const s = TAB_STYLE[c.id] || { icon: "▪", color: "white" };
          const active = i === tabIdx;
          return (
            <Box
              key={c.id}
              borderStyle={active ? "bold" : "single"}
              borderColor={active ? s.color : "gray"}
              paddingX={2}
            >
              <Text color={active ? s.color : undefined} bold={active} dimColor={!active}>
                {s.icon} {c.name}
              </Text>
            </Box>
          );
        })}
        <Text dimColor>›</Text>
      </Box>

      {/* ═══ 服务商卡片区 ═══ */}
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={tabColor} paddingX={1} paddingY={1}>
        {compatible.length === 0 && (
          <Box paddingX={2} paddingY={1} justifyContent="center">
            <Text dimColor>{zh ? "暂无兼容的服务商，请添加" : "No compatible providers yet"}</Text>
          </Box>
        )}
        {compatible.map((p, i) => (
          <ProviderCard
            key={p.id}
            provider={p}
            focused={rowIdx === i}
            bound={p.id === boundId}
            isDefault={p.id === defaultId}
            zh={zh}
          />
        ))}
      </Box>

      {/* ═══ 操作区 ═══ */}
      <Box marginTop={1} gap={1}>
        {[
          { id: "add",      offset: 0, icon: "➕", label: zh ? "添加服务商" : "Add Provider" },
          { id: "scan",     offset: 1, icon: "🔍", label: zh ? "扫描订阅" : "Scan" },
          { id: "versions", offset: 2, icon: "📦", label: zh ? "客户端版本管理" : "Client Versions" },
          { id: "back",     offset: 3, icon: "←",  label: zh ? "返回" : "Back" },
        ].map((btn) => {
          const focused = rowIdx === compatible.length + btn.offset;
          return (
            <Box
              key={btn.id}
              borderStyle={focused ? "bold" : "round"}
              borderColor={focused ? "cyan" : "gray"}
              paddingX={2}
            >
              <Text bold={focused} color={focused ? "cyan" : undefined} dimColor={!focused}>
                {btn.icon} {btn.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* ═══ Footer ═══ */}
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} justifyContent="center" gap={2}>
        <Text dimColor bold>←→</Text><Text dimColor>{zh ? "切换工具" : "switch"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>↑↓</Text><Text dimColor>{zh ? "选择" : "select"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Enter</Text><Text dimColor>{zh ? "绑定" : "bind"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>d</Text><Text dimColor>{zh ? "详情" : "detail"}</Text>
        <Text dimColor>│</Text>
        <Text dimColor bold>Esc</Text><Text dimColor>{zh ? "返回" : "back"}</Text>
      </Box>
    </Box>
  );
}

export { ProviderMenuComponent as ProviderMenuView };
