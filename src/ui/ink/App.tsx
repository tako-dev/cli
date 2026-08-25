/**
 * Tako CLI 根组件 — 单 Ink 实例，状态路由
 *
 * Ink 推荐模式：一个 render() 调用，用 React state 切换视图，
 * Ink 自动原地替换输出，无残留。
 *
 * 日志通过 setLogHandler 注入到 Ink 组件状态，不再直接写 console。
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Text } from "ink";
import { LauncherView, type LauncherResult } from "./views/LauncherView";
import { ProviderMenuView } from "./views/ProviderMenuView";
import { StatsViewComponent } from "./views/StatsView";
import { ApiKeyInputView } from "./views/ApiKeyInputView";
import { LanguageSelectView } from "./views/LanguageSelectView";
import { KeySetupGuide, shouldShowKeyGuide, dismissKeyGuide, type GuideAction } from "./views/KeySetupGuide";
import { ClientVersionView } from "./views/ClientVersionView";
import { AgentsView } from "./views/AgentsView";
import { setLogHandler, resetLogHandler } from "../../logger";

type View = "launcher" | "providers" | "stats" | "config" | "language" | "key-guide" | "client-versions" | "agents";

interface LogEntry { id?: number; text: string; type: "info" | "warn" | "error" | "success" | "spin" }

interface AppProps {
  onLaunch: (result: LauncherResult) => void;
  onExit: () => void;
  initialView?: View;
  initialSessionSearch?: boolean;
}

function App({ onLaunch, onExit, initialView = "launcher", initialSessionSearch = false }: AppProps) {
  const [view, setView] = useState<View>(initialView);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 首次渲染时检查是否需要展示 Key 引导
  const checkedRef = useRef(false);
  useEffect(() => {
    if (checkedRef.current || initialView !== "launcher") return;
    checkedRef.current = true;
    shouldShowKeyGuide().then((show) => { if (show) setView("key-guide"); });
  }, [initialView]);

  // 自动清除日志
  const pushLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev.slice(-4), entry]); // 最多保留5条
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLogs([]), 5000);
  }, []);

  // 注入 Ink 日志处理器
  useEffect(() => {
    let nextSpinId = 0;
    setLogHandler({
      info: (msg) => pushLog({ text: msg, type: "info" }),
      warn: (msg) => pushLog({ text: msg, type: "warn" }),
      error: (msg) => pushLog({ text: msg, type: "error" }),
      success: (msg) => pushLog({ text: msg, type: "success" }),
      spin: (msg) => {
        const id = ++nextSpinId;
        pushLog({ id, text: msg, type: "spin" });
        return {
          stop: (m?: string) => {
            // 移除 spin entry，必要时换成 success
            setLogs((prev) => {
              const next = prev.filter((e) => e.id !== id);
              if (m) next.push({ text: m, type: "success" });
              return next.slice(-5);
            });
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setLogs([]), 5000);
          },
          update: (m: string) => {
            setLogs((prev) => prev.map((e) => (e.id === id ? { ...e, text: m } : e)));
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setLogs([]), 5000);
          },
        };
      },
    });
    return () => resetLogHandler();
  }, [pushLog]);

  const goBack = useCallback(() => setView("launcher"), []);

  const LOG_COLOR: Record<string, string> = {
    info: "cyan", warn: "yellow", error: "red", success: "green", spin: "yellow",
  };
  const LOG_ICON: Record<string, string> = {
    info: "ℹ", warn: "⚠", error: "✗", success: "✓", spin: "⏳",
  };

  const content = (() => {
    switch (view) {
      case "launcher":
        return (
          <LauncherView
            initialSessionSearch={initialSessionSearch}
            onResult={(result) => {
              switch (result.type) {
                case "launch": onLaunch(result); break;
                case "agent": setView("agents"); break;
                case "providers": setView("providers"); break;
                case "stats": setView("stats"); break;
                case "config": setView("config"); break;
                case "language": setView("language"); break;
                case "exit": onExit(); break;
              }
            }}
          />
        );
      case "providers":
        return <ProviderMenuView onDone={(action) => {
          if (action === "client-versions") setView("client-versions");
          else goBack();
        }} />;
      case "agents":
        return <AgentsView onDone={goBack} />;
      case "client-versions":
        return <ClientVersionView onDone={() => setView("providers")} />;
      case "stats":
        return <StatsViewComponent onExit={goBack} />;
      case "config":
        return <ApiKeyInputView isReconfigure onDone={goBack} />;
      case "language":
        return <LanguageSelectView onDone={goBack} />;
      case "key-guide":
        return (
          <KeySetupGuide
            onDone={(action: GuideAction) => {
              if (action === "configure") {
                setView("config");
              } else {
                dismissKeyGuide(action).then(() => setView("launcher"));
              }
            }}
          />
        );
    }
  })();

  return (
    <Box flexDirection="column">
      {/* 日志区 — 显示在视图上方 */}
      {logs.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {logs.map((entry, i) => (
            <Text key={i} color={LOG_COLOR[entry.type]} dimColor={entry.type === "info"}>
              {LOG_ICON[entry.type]} {entry.text}
            </Text>
          ))}
        </Box>
      )}
      {content}
    </Box>
  );
}

export type { LauncherResult };

/**
 * 启动 Ink App，返回 Promise
 */
export function startApp(options: { initialSessionSearch?: boolean } = {}): Promise<LauncherResult | null> {
  return new Promise((resolve) => {
    let instance: ReturnType<typeof render> | null = null;

    function restoreStdin() {
      try {
        // 必须移除 ALL 事件监听器，否则残留的 listener 会和子进程争抢 stdin
        // Ink 内部可能挂载了 data / keypress / readable 等多种监听器
        process.stdin.removeAllListeners();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        // unref 确保 stdin 不阻止进程退出
        process.stdin.unref();
      } catch { /* ignore */ }
    }

    function handleLaunch(result: LauncherResult) {
      instance?.clear();
      instance?.unmount();
      instance = null;
      restoreStdin();
      resetLogHandler();
      resolve(result);
    }

    function handleExit() {
      instance?.clear();
      instance?.unmount();
      instance = null;
      restoreStdin();
      resetLogHandler();
      resolve(null);
    }

    instance = render(
      <App onLaunch={handleLaunch} onExit={handleExit} initialSessionSearch={options.initialSessionSearch} />
    );
  });
}

/**
 * 首次配置 API Key（无其他 Provider 时）
 */
export function startApiKeySetup(): Promise<boolean> {
  return new Promise((resolve) => {
    let instance: ReturnType<typeof render> | null = null;

    instance = render(
      <ApiKeyInputView
        isReconfigure={false}
        onDone={(ok) => {
          instance?.clear();
          instance?.unmount();
          try {
            process.stdin.removeAllListeners();
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.unref();
          } catch { /* ignore */ }
          resolve(ok);
        }}
      />
    );
  });
}
