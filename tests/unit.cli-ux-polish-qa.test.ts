import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import * as appMod from "../src/app";
import "../src/clients";
import { agyClient } from "../src/clients/agy";
import type { LaunchOption } from "../src/clients/base";
import { discoverNativeSessions } from "../src/sessions/discovery";
import { SessionDatabase } from "../src/sessions/database";
import { indexSessionCandidates } from "../src/sessions/indexer";
import { SESSION_PARSERS } from "../src/sessions/registry";
import { prepareResume, resumeArgs } from "../src/sessions/resume";
import { searchSessions } from "../src/sessions/search";
import { isNativeSessionSource, NATIVE_SESSION_SOURCES, type UnifiedSession } from "../src/sessions/types";
import * as launchOptionsMod from "../src/ui/shared/launch-options";
import { enabledWithProviderDefaultModel, selectedArgs } from "../src/ui/shared/launch-options";
import * as launcherDataMod from "../src/ui/shared/launcher-data";
import * as modelPickerMod from "../src/ui/shared/model-picker";
import { listedModelOptions } from "../src/ui/shared/model-picker";
import * as updaterMod from "../src/updater";
import { CURRENT_VERSION } from "../src/updater";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const V0355_BASELINE_SRC_FILES = new Set([
  "agent/cmd.ts", "agent/drivers/claude.ts", "agent/drivers/codex.ts", "agent/index.ts",
  "agent/manager.ts", "agent/policy.ts", "agent/printer.ts", "agent/storage.ts", "agent/types.ts",
  "analytics/client.ts", "analytics/events.ts", "analytics/index.ts", "analytics/properties.ts",
  "announcements.ts", "api-error.ts", "app.ts", "auth.ts", "bun-progress.ts", "changelog.ts",
  "clients/agy.ts", "clients/base.ts", "clients/claude-code.ts", "clients/claude-credentials.ts",
  "clients/codex.ts", "clients/dangerous-flags.ts", "clients/gemini-native.ts", "clients/gemini.ts",
  "clients/grok.ts", "clients/index.ts", "clients/pi-settings.ts", "clients/pi-web.ts", "clients/pi.ts",
  "config.ts", "error-format.ts", "i18n.ts", "index.ts", "installer-versions.ts", "installer.ts",
  "launcher-legacy.ts", "launcher/index.ts", "logger.ts", "model-usage.ts",
  "models/bundled.ts", "models/catalog.ts", "models/command.ts", "models/index.ts",
  "models/source.ts", "models/tako.ts", "models/types.ts", "project-history.ts",
  "providers/index.ts", "providers/types.ts", "quick-launch-args.ts",
  "quota/claude-subscription.ts", "quota/codex-subscription.ts", "quota/command.ts",
  "quota/index.ts", "quota/tako.ts", "quota/types.ts", "region.ts",
  "sessions/adapters/claude.ts", "sessions/adapters/codex.ts", "sessions/adapters/gemini.ts",
  "sessions/adapters/grok.ts", "sessions/adapters/pi.ts", "sessions/cmd.ts", "sessions/database.ts",
  "sessions/discovery.ts", "sessions/index.ts", "sessions/indexer.ts", "sessions/input.ts",
  "sessions/lock.ts", "sessions/parser-utils.ts", "sessions/registry.ts", "sessions/resume.ts",
  "sessions/search.ts", "sessions/types.ts",
  "skills/bundled/model-benchmark.ts", "skills/bundled/tako-agent.ts", "skills/command.ts", "skills/index.ts",
  "stats.ts", "statusline/colors.ts", "statusline/index.ts", "statusline/inject.ts",
  "statusline/renderer.ts", "statusline/segments/context.ts", "statusline/segments/directory.ts",
  "statusline/segments/git.ts", "statusline/segments/index.ts", "statusline/segments/model.ts",
  "statusline/segments/quota.ts", "statusline/types.ts", "terminal-control.ts",
  "ui/index.ts", "ui/ink/App.tsx", "ui/ink/index.ts", "ui/ink/useSwitchControls.ts",
  "ui/ink/views/AgentDetailView.tsx", "ui/ink/views/AgentsView.tsx", "ui/ink/views/ApiKeyInputView.tsx",
  "ui/ink/views/ClientVersionView.tsx", "ui/ink/views/KeySetupGuide.tsx",
  "ui/ink/views/LanguageSelectView.tsx", "ui/ink/views/LauncherPickers.tsx",
  "ui/ink/views/LauncherView.tsx", "ui/ink/views/ProviderComponents.tsx",
  "ui/ink/views/ProviderMenuView.tsx", "ui/ink/views/StatsView.tsx",
  "ui/providers.ts", "ui/shared/fuzzy.ts", "ui/shared/launch-options.ts", "ui/shared/launch.ts",
  "ui/shared/launcher-data.ts", "ui/shared/model-picker.ts", "ui/shared/terminal.ts",
  "ui/shared/types.ts", "updater.ts", "utils/display-width.ts", "utils/protocol.ts",
  "windows-handoff.ts", "windows-wrapper.ts",
]);

interface UpdateCacheShape {
  checkedAt: number;
  latestVersion: string | null;
  lastFailedVersion?: string;
  lastFailedAt?: number;
}

async function importOptionalModule<T = Record<string, unknown>>(relFromTests: string): Promise<T | null> {
  try {
    return (await import(relFromTests)) as T;
  } catch {
    return null;
  }
}

function countLines(filePath: string): number {
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) return 0;
  return raw.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) results.push(...walkSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) results.push(full);
  }
  return results;
}

function makeModelOption(modelId: string, label = modelId): LaunchOption {
  return {
    id: `model-${modelId}`,
    label: { en: label, zh: label },
    shortLabel: label,
    description: { en: `Use ${label}`, zh: `使用 ${label}` },
    flag: `--model ${modelId}`,
    args: ["--model", modelId],
    group: "model",
  };
}

describe("UX-01: Startup acceleration (TTL update-check cache & bare quick-launch subcommands)", () => {
  const originalFetch = globalThis.fetch;
  const originalSpawn = Bun.spawn;
  const originalExit = process.exit;
  let tmpDir: string;
  let cachePath: string;
  let savedRegion: string | undefined;

  function getUpdaterApi() {
    const u = updaterMod as Record<string, unknown>;
    expect(u.UPDATE_CHECK_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(typeof u._setUpdateCachePathForTest).toBe("function");
    expect(typeof u.readUpdateCheckCache).toBe("function");
    expect(typeof u.writeUpdateCheckCache).toBe("function");
    expect(typeof u.refreshUpdateCheckInBackground).toBe("function");
    expect(typeof u.checkAndUpdate).toBe("function");
    return {
      UPDATE_CHECK_TTL_MS: u.UPDATE_CHECK_TTL_MS as number,
      _setUpdateCachePathForTest: u._setUpdateCachePathForTest as (p: string | null) => void,
      readUpdateCheckCache: u.readUpdateCheckCache as () => UpdateCacheShape | null,
      writeUpdateCheckCache: u.writeUpdateCheckCache as (c: UpdateCacheShape) => void,
      refreshUpdateCheckInBackground: u.refreshUpdateCheckInBackground as () => Promise<UpdateCacheShape | null>,
      checkAndUpdate: u.checkAndUpdate as (opts?: { spawnBackgroundRefresh?: boolean }) => Promise<void>,
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-ux01-qa-"));
    cachePath = join(tmpDir, "nested", "update-check.json");
    savedRegion = process.env.TAKO_REGION;
    process.env.TAKO_REGION = "global";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.spawn = originalSpawn;
    process.exit = originalExit;
    const resetFn = (updaterMod as Record<string, unknown>)._setUpdateCachePathForTest;
    if (typeof resetFn === "function") (resetFn as (p: string | null) => void)(null);
    if (savedRegion === undefined) delete process.env.TAKO_REGION;
    else process.env.TAKO_REGION = savedRegion;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("UX01-UPD-01: exports TTL constant and reads/writes/recovers update-check.json cache", () => {
    const api = getUpdaterApi();
    api._setUpdateCachePathForTest(cachePath);

    expect(api.readUpdateCheckCache()).toBeNull();

    const sample: UpdateCacheShape = {
      checkedAt: 1_760_000_000_000,
      latestVersion: "0.3.56",
      lastFailedVersion: "0.3.57",
      lastFailedAt: 1_760_000_005_000,
    };
    api.writeUpdateCheckCache(sample);
    expect(api.readUpdateCheckCache()).toEqual(sample);

    writeFileSync(cachePath, "{not-valid-json", "utf8");
    expect(api.readUpdateCheckCache()).toBeNull();
  });

  it("UX01-UPD-02: cold cache skips blocking network (<30ms, 0 fetch when disabled; async write when enabled)", async () => {
    const api = getUpdaterApi();
    api._setUpdateCachePathForTest(cachePath);
    expect(api.readUpdateCheckCache()).toBeNull();

    let trapFetchCalls = 0;
    globalThis.fetch = (async () => {
      trapFetchCalls += 1;
      await Bun.sleep(5000);
      throw new Error("Cold-cache startup must not block on fetch");
    }) as typeof fetch;

    const t0 = performance.now();
    await api.checkAndUpdate({ spawnBackgroundRefresh: false });
    const coldDisabledMs = performance.now() - t0;

    expect(coldDisabledMs).toBeLessThan(30);
    expect(trapFetchCalls).toBe(0);
    expect(api.readUpdateCheckCache()).toBeNull();

    // Default background refresh: returns in <30ms despite 50ms simulated network, then writes update-check.json
    let bgFetchCalls = 0;
    globalThis.fetch = (async () => {
      bgFetchCalls += 1;
      await Bun.sleep(50);
      return Response.json({ version: CURRENT_VERSION });
    }) as typeof fetch;

    const t1 = performance.now();
    await api.checkAndUpdate();
    const bgReturnMs = performance.now() - t1;
    expect(bgReturnMs).toBeLessThan(30);

    let persisted: UpdateCacheShape | null = null;
    for (let i = 0; i < 40; i++) {
      persisted = api.readUpdateCheckCache();
      if (persisted) break;
      await Bun.sleep(20);
    }
    expect(bgFetchCalls).toBeGreaterThanOrEqual(1);
    expect(persisted).not.toBeNull();
    expect(persisted?.latestVersion).toBe(CURRENT_VERSION);
    expect(typeof persisted?.checkedAt).toBe("number");

    // Direct refreshUpdateCheckInBackground updates cache cleanly
    globalThis.fetch = (async () => Response.json({ version: "0.3.99" })) as typeof fetch;
    const directRefreshed = await api.refreshUpdateCheckInBackground();
    expect(directRefreshed?.latestVersion).toBe("0.3.99");
    expect(api.readUpdateCheckCache()?.latestVersion).toBe("0.3.99");
  });

  it("UX01-UPD-03: warm cache within 6h TTL with latestVersion <= CURRENT_VERSION makes zero fetch calls", async () => {
    const api = getUpdaterApi();
    api._setUpdateCachePathForTest(cachePath);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Warm TTL cache must not invoke fetch");
    }) as typeof fetch;

    for (const version of [CURRENT_VERSION, "0.0.0"]) {
      api.writeUpdateCheckCache({
        checkedAt: Date.now() - 60_000,
        latestVersion: version,
      });
      const t0 = performance.now();
      await api.checkAndUpdate();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(30);
      expect(fetchCalls).toBe(0);
    }
  });

  it("UX01-UPD-04: backs off without retrying or blocking when same version failed within 6h", async () => {
    const api = getUpdaterApi();
    api._setUpdateCachePathForTest(cachePath);
    const now = Date.now();
    api.writeUpdateCheckCache({
      checkedAt: now - 10_000,
      latestVersion: "99.0.0",
      lastFailedVersion: "99.0.0",
      lastFailedAt: now - 5_000,
    });

    let fetchCalls = 0;
    let spawnCalls = 0;
    let exitCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Should not fetch during failure backoff");
    }) as typeof fetch;
    Bun.spawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      throw new Error("Should not spawn bun update during failure backoff");
    }) as typeof Bun.spawn;
    process.exit = ((_code?: number) => {
      exitCalls += 1;
      throw new Error("Should not exit during failure backoff");
    }) as typeof process.exit;

    const t0 = performance.now();
    await api.checkAndUpdate({ spawnBackgroundRefresh: false });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(30);
    expect(fetchCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(exitCalls).toBe(0);
  });

  it("UX01-QL-01: resolveQuickLaunchClient supports bare subcommands & --flags without hijacking built-in commands", () => {
    const resolveQuickLaunchClient = (appMod as Record<string, unknown>).resolveQuickLaunchClient as
      | ((args: string[]) => {
          clientId: string;
          clientName: string;
          triggerArg: string;
          isSubcommand: boolean;
        } | null)
      | undefined;
    expect(typeof resolveQuickLaunchClient).toBe("function");

    const subcommandCases: Array<[string[], string, string, string]> = [
      [["agy"], "agy", "Antigravity (agy)", "agy"],
      [["agy", "-p", "hi"], "agy", "Antigravity (agy)", "agy"],
      [["claude", "--help"], "claude-code", "Claude Code", "claude"],
      [["claude-code"], "claude-code", "Claude Code", "claude-code"],
      [["codex"], "codex", "Codex", "codex"],
      [["pi"], "pi", "Pi", "pi"],
      [["pi-web"], "pi-web", "Pi Web", "pi-web"],
      [["grok"], "grok", "Grok Build", "grok"],
    ];
    for (const [args, clientId, clientName, triggerArg] of subcommandCases) {
      expect(resolveQuickLaunchClient!(args)).toEqual({
        clientId,
        clientName,
        triggerArg,
        isSubcommand: true,
      });
    }

    const flagCases: Array<[string[], string, string, string]> = [
      [["--agy"], "agy", "Antigravity (agy)", "--agy"],
      [["--agy", "-p", "hi"], "agy", "Antigravity (agy)", "--agy"],
      [["--claude"], "claude-code", "Claude Code", "--claude"],
      [["--codex"], "codex", "Codex", "--codex"],
      [["--pi"], "pi", "Pi", "--pi"],
      [["--pi-web"], "pi-web", "Pi Web", "--pi-web"],
      [["--grok"], "grok", "Grok Build", "--grok"],
    ];
    for (const [args, clientId, clientName, triggerArg] of flagCases) {
      expect(resolveQuickLaunchClient!(args)).toEqual({
        clientId,
        clientName,
        triggerArg,
        isSubcommand: false,
      });
    }

    for (const nonQuickArgs of [
      ["install", "agy"],
      ["models", "--refresh"],
      ["update"],
      ["sessions"],
      ["sessions", "agy"],
      ["quota"],
      ["agent"],
      ["skill", "list"],
      ["statusline"],
      [],
      ["--help"],
      ["-h"],
      ["--version"],
      ["-v"],
    ]) {
      expect(resolveQuickLaunchClient!(nonQuickArgs)).toBeNull();
    }
  });
});

describe("UX-02: Launcher panel ergonomics (Tab/Shift+Tab focus & explicit Default model persistence)", () => {
  it("UX02-KEY-01: nextLauncherFocus cycles forward/backward and skips options when hasOptions=false", async () => {
    const keysMod = await importOptionalModule<{
      nextLauncherFocus?: (
        current: "search" | "projects" | "options",
        reverse: boolean,
        hasOptions: boolean,
      ) => "search" | "projects" | "options";
    }>("../src/ui/ink/launcher-keys");
    expect(typeof keysMod?.nextLauncherFocus).toBe("function");
    const nextLauncherFocus = keysMod!.nextLauncherFocus!;

    // Forward with options: projects -> options -> search -> projects
    expect(nextLauncherFocus("projects", false, true)).toBe("options");
    expect(nextLauncherFocus("options", false, true)).toBe("search");
    expect(nextLauncherFocus("search", false, true)).toBe("projects");

    // Reverse with options: projects -> search -> options -> projects
    expect(nextLauncherFocus("projects", true, true)).toBe("search");
    expect(nextLauncherFocus("search", true, true)).toBe("options");
    expect(nextLauncherFocus("options", true, true)).toBe("projects");

    // Without options: skips options in both directions
    expect(nextLauncherFocus("projects", false, false)).toBe("search");
    expect(nextLauncherFocus("search", false, false)).toBe("projects");
    expect(nextLauncherFocus("projects", true, false)).toBe("search");
    expect(nextLauncherFocus("search", true, false)).toBe("projects");
  });

  it("UX02-MPK-01: resolveModelPickerEntries prepends { kind: 'default' } only when query is empty", () => {
    const m = modelPickerMod as Record<string, unknown>;
    expect(m.MODEL_PICKER_DEFAULT_ID).toBe("__default__");
    expect(typeof m.resolveModelPickerEntries).toBe("function");

    const resolveModelPickerEntries = m.resolveModelPickerEntries as (
      options: LaunchOption[],
      pickCounts: Record<string, number>,
      query: string,
      zh?: boolean,
    ) => Array<{ kind: "default" } | { kind: "model"; option: LaunchOption }>;

    const options = [
      makeModelOption("claude-opus-4-6", "Claude Opus 4.6"),
      makeModelOption("claude-sonnet-4-6", "Claude Sonnet 4.6"),
      makeModelOption("grok-4.6", "Grok 4.6"),
    ];
    const counts = { "model-claude-sonnet-4-6": 10, "model-claude-opus-4-6": 3 };

    const unfiltered = resolveModelPickerEntries(options, counts, "", true);
    const expectedOrder = listedModelOptions(options, counts, "", true);
    expect(unfiltered.length).toBe(expectedOrder.length + 1);
    expect(unfiltered[0]).toMatchObject({ kind: "default" });
    expect(unfiltered.slice(1)).toEqual(expectedOrder.map((option) => ({ kind: "model", option })));

    const filtered = resolveModelPickerEntries(options, counts, "sonnet", false);
    expect(filtered.some((entry) => entry.kind === "default")).toBe(false);
    expect(filtered).toEqual([{ kind: "model", option: options[1]! }]);

    expect(resolveModelPickerEntries(options, counts, "nonexistent-xyz", false)).toEqual([]);
  });

  it("UX02-OPT-01: EXPLICIT_DEFAULT_MODEL_SENTINEL blocks default model backfill and persists without --model", () => {
    const sentinel = (launchOptionsMod as Record<string, unknown>).EXPLICIT_DEFAULT_MODEL_SENTINEL;
    expect(sentinel).toBe("__default_model__");
    const EXPLICIT_DEFAULT = sentinel as string;

    const launchOptions: LaunchOption[] = [
      {
        id: "skip-permissions",
        label: { en: "Skip Permissions", zh: "跳过权限确认" },
        shortLabel: "Skip Perms",
        description: { en: "Skip perms", zh: "跳过权限" },
        flag: "--dangerously-skip-permissions",
        args: ["--dangerously-skip-permissions"],
        defaultOn: true,
      },
      makeModelOption("claude-sonnet-4-6", "Claude Sonnet 4.6"),
      makeModelOption("grok-4.6", "Grok 4.6"),
    ];

    const previous = new Set(["skip-permissions", EXPLICIT_DEFAULT, "stale-removed-flag"]);
    const resolved = enabledWithProviderDefaultModel(
      previous,
      launchOptions,
      "claude-sonnet-4-6",
      "model-grok-4.6",
    );

    expect(resolved.has(EXPLICIT_DEFAULT)).toBe(true);
    expect(resolved.has("skip-permissions")).toBe(true);
    expect(resolved.has("stale-removed-flag")).toBe(false);
    expect(resolved.has("model-claude-sonnet-4-6")).toBe(false);
    expect(resolved.has("model-grok-4.6")).toBe(false);

    const launchPayload = selectedArgs({
      launchOptions,
      enabled: new Set(["skip-permissions", EXPLICIT_DEFAULT]),
    });
    expect(launchPayload.args).toEqual(["--dangerously-skip-permissions"]);
    expect(launchPayload.args).not.toContain("--model");
    expect(launchPayload.selectedOptionIds).toContain("skip-permissions");
    expect(launchPayload.selectedOptionIds).toContain(EXPLICIT_DEFAULT);
  });
});

describe("UX-03: Antigravity (agy) native session indexing, search, resume & fast install check", () => {
  const cleanupPaths: string[] = [];
  const ENV_KEYS = ["HOME", "USERPROFILE", "PATH", "AGY_PATH", "AGY_INSTALL_DIR", "LOCALAPPDATA"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop()!;
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("UX03-AGY-01: registers 'agy' session source, strips XML envelopes, parses top-level & rejects subagents", async () => {
    expect(NATIVE_SESSION_SOURCES).toContain("agy" as never);
    expect(isNativeSessionSource("agy")).toBe(true);
    expect(typeof (SESSION_PARSERS as Record<string, unknown>).agy).toBe("function");

    const agyAdapter = await importOptionalModule<{
      isAgyTranscriptPath?: (path: string) => boolean;
      agyConversationIdFromPath?: (path: string) => string | undefined;
      stripAgyUserEnvelope?: (raw: string) => string;
      parseAgySessionText?: (text: string, sourcePath: string, cwd?: string) => ReturnType<typeof SESSION_PARSERS.claude>;
    }>("../src/sessions/adapters/agy");

    expect(typeof agyAdapter?.isAgyTranscriptPath).toBe("function");
    expect(typeof agyAdapter?.agyConversationIdFromPath).toBe("function");
    expect(typeof agyAdapter?.stripAgyUserEnvelope).toBe("function");
    expect(typeof agyAdapter?.parseAgySessionText).toBe("function");

    const uuid = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    const unixPath = `/Users/dev/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript.jsonl`;
    const winPath = `C:\\Users\\dev\\.gemini\\antigravity-cli\\brain\\${uuid}\\.system_generated\\logs\\transcript.jsonl`;
    const fullLogPath = `/Users/dev/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript_full.jsonl`;

    expect(agyAdapter!.isAgyTranscriptPath!(unixPath)).toBe(true);
    expect(agyAdapter!.isAgyTranscriptPath!(winPath)).toBe(true);
    expect(agyAdapter!.isAgyTranscriptPath!(fullLogPath)).toBe(false);
    expect(agyAdapter!.agyConversationIdFromPath!(unixPath)).toBe(uuid);
    expect(agyAdapter!.agyConversationIdFromPath!(winPath)).toBe(uuid);

    const wrappedInput = [
      "<USER_REQUEST>",
      "排查 webhook 签名超时与 retry 幂等锁问题",
      "</USER_REQUEST>",
      "<ADDITIONAL_METADATA>",
      "The current local time is: 2026-11-18T14:47:09+08:00.",
      "</ADDITIONAL_METADATA>",
      "<USER_SETTINGS_CHANGE>",
      "The user changed setting `Model Selection` from None to Claude Opus 4.6.",
      "</USER_SETTINGS_CHANGE>",
    ].join("\n");
    expect(agyAdapter!.stripAgyUserEnvelope!(wrappedInput)).toBe("排查 webhook 签名超时与 retry 幂等锁问题");

    const topSessionJsonl = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-18T06:47:09Z",
        content: wrappedInput,
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T06:47:18Z",
        model: "claude-opus-4-6",
        thinking: "先核对 HMAC-SHA256 时间戳窗口与 Redis 幂等锁 TTL。",
        content: "已定位原因：下游网关未设置连接超时，建议补充 5s AbortSignal.timeout。",
      }),
    ].join("\n");

    const parsedTop = agyAdapter!.parseAgySessionText!(topSessionJsonl, unixPath, "/work/pay-service");
    expect(parsedTop).not.toBeNull();
    expect(parsedTop?.session).toMatchObject({
      key: `agy:${uuid}`,
      nativeId: uuid,
      source: "agy",
      title: "排查 webhook 签名超时与 retry 幂等锁问题",
      cwd: "/work/pay-service",
      projectName: "pay-service",
      model: "claude-opus-4-6",
      userMessageCount: 1,
      assistantMessageCount: 1,
      resumeCapability: "direct",
    });

    const userMsg = parsedTop?.messages.find((m) => m.role === "user");
    expect(userMsg?.text).toBe("排查 webhook 签名超时与 retry 幂等锁问题");
    expect(userMsg?.text).not.toContain("USER_REQUEST");
    expect(userMsg?.text).not.toContain("ADDITIONAL_METADATA");

    const reasoningMsg = parsedTop?.messages.find((m) => m.role === "reasoning");
    expect(reasoningMsg).toMatchObject({
      role: "reasoning",
      defaultSearchable: false,
      deepSearchable: true,
    });
    expect(reasoningMsg?.text).toContain("HMAC-SHA256");

    // Subagent session (only SYSTEM_MESSAGE + PLANNER_RESPONSE + GENERIC, zero USER_INPUT) -> null
    const subagentUuid = "99999999-8888-4777-8666-555555555555";
    const subagentPath = `/Users/dev/.gemini/antigravity-cli/brain/${subagentUuid}/.system_generated/logs/transcript.jsonl`;
    const subagentJsonl = [
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-18T18:23:11Z",
        content: "<SYSTEM_MESSAGE>[Message] sender=parent content=Subagent task</SYSTEM_MESSAGE>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T18:23:15Z",
        model: "gemini-3.8-flash",
        thinking: "Subagent internal reasoning",
        tool_calls: [{ name: "read_file", args: { Path: "/work/pay-service/README.md" } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-18T18:23:16Z",
        content: "Showing lines 1-10...",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T18:23:20Z",
        model: "gemini-3.8-flash",
        content: "Subagent finished.",
      }),
    ].join("\n");

    expect(agyAdapter!.parseAgySessionText!(subagentJsonl, subagentPath, "/work/pay-service")).toBeNull();
  });

  it("UX03-AGY-02: E2E discovery + refreshSessionIndex + search + resume indexes only top-level agy sessions", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "tako-agy-e2e-home-"));
    cleanupPaths.push(tmpHome);

    const workspaceDir = join(tmpHome, "workspaces", "my pay-gateway");
    mkdirSync(workspaceDir, { recursive: true });
    const workspaceUri = pathToFileURL(workspaceDir).href;

    const agyAppDir = join(tmpHome, ".gemini", "antigravity-cli");
    mkdirSync(agyAppDir, { recursive: true });

    const topUuid = "11111111-2222-4333-8444-555555555555";
    const subDepthUuid = "22222222-3333-4444-8555-666666666666";
    const subParentOnlyUuid = "33333333-4444-4555-8666-777777777777";

    const writeTranscript = (id: string, lines: unknown[]) => {
      const logDir = join(agyAppDir, "brain", id, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      const file = join(logDir, "transcript.jsonl");
      writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
      return file;
    };

    const topTranscriptPath = writeTranscript(topUuid, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-18T10:00:00Z",
        content:
          "<USER_REQUEST>\n请定位跨境清结算 reconciliation_drift_409 异常\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nLocal time\n</ADDITIONAL_METADATA>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T10:01:00Z",
        model: "claude-sonnet-4-6",
        thinking: "deep_clue_ledger_cursor_skew",
        content: "根因是日切窗口分片游标偏移，已修复 reconciliation_drift_409。",
      },
    ]);
    // Also place transcript_full.jsonl alongside to ensure no duplicate candidate
    writeFileSync(
      join(agyAppDir, "brain", topUuid, ".system_generated", "logs", "transcript_full.jsonl"),
      readFileSync(topTranscriptPath, "utf8"),
    );

    writeTranscript(subDepthUuid, [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-18T10:00:10Z",
        content: "<SYSTEM_MESSAGE>subagent_secret_token_depth</SYSTEM_MESSAGE>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T10:00:20Z",
        model: "gemini-3.8-flash",
        content: "subagent_secret_token_depth done",
      },
    ]);

    writeTranscript(subParentOnlyUuid, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-18T10:00:30Z",
        content: "<USER_REQUEST>\nsubagent_parent_linked_noise\n</USER_REQUEST>",
      },
    ]);

    const summariesDb = new Database(join(agyAppDir, "conversation_summaries.db"), { create: true });
    summariesDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT "",
        preview text NOT NULL DEFAULT "",
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT "",
        source text NOT NULL DEFAULT "",
        project_id text NOT NULL DEFAULT "",
        agent_name text NOT NULL DEFAULT "",
        parent_conversation_id text NOT NULL DEFAULT "",
        nesting_depth integer NOT NULL DEFAULT 0,
        battle_id text NOT NULL DEFAULT "",
        winning_conversation_id text NOT NULL DEFAULT "",
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index integer NOT NULL DEFAULT -1,
        app_data_dir text NOT NULL DEFAULT "",
        raw_summary blob,
        group_id text NOT NULL DEFAULT ""
      );
    `);
    const insertSummary = summariesDb.query(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, parent_conversation_id, nesting_depth,
        last_user_input_time, last_user_input_step_index, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, 'DONE', 'CLI', ?, ?, ?, ?, ?)
    `);
    insertSummary.run(
      topUuid,
      "跨境清结算日切对账修复",
      "请定位跨境清结算 reconciliation_drift_409 异常",
      2,
      "2026-11-18T10:01:00Z",
      JSON.stringify([workspaceUri]),
      "",
      0,
      "2026-11-18T10:00:00Z",
      0,
      agyAppDir,
    );
    insertSummary.run(
      subDepthUuid,
      "Subagent Depth 1",
      "subagent",
      2,
      "2026-11-18T10:00:20Z",
      JSON.stringify([workspaceUri]),
      topUuid,
      1,
      "2026-11-18T10:00:10Z",
      -1,
      agyAppDir,
    );
    insertSummary.run(
      subParentOnlyUuid,
      "Subagent Parent Linked",
      "subagent",
      1,
      "2026-11-18T10:00:30Z",
      JSON.stringify([workspaceUri]),
      topUuid,
      0,
      "2026-11-18T10:00:30Z",
      0,
      agyAppDir,
    );
    summariesDb.close();

    // 1. Direct discoverNativeSessions(tmpHome) + indexSessionCandidates check
    const discovered = await discoverNativeSessions(tmpHome);
    const agyCandidates = discovered.filter((c) => (c.source as string) === "agy");
    expect(agyCandidates).toHaveLength(1);
    expect(agyCandidates[0]?.path).toBe(topTranscriptPath);
    expect(agyCandidates[0]?.cwd).toBe(workspaceDir);

    const directDbPath = join(tmpHome, "direct-index", "sessions.db");
    const directDb = new SessionDatabase(directDbPath);
    await indexSessionCandidates(directDb, discovered, SESSION_PARSERS);
    expect(directDb.listSessions().map((s) => s.key)).toEqual([`agy:${topUuid}`]);
    directDb.close();

    // 2. End-to-end refreshSessionIndex in isolated HOME=tmpHome subprocess (so os.homedir() === tmpHome)
    const e2eDbPath = join(tmpHome, "e2e-index", "sessions.db");
    const sessionsEntryUrl = pathToFileURL(join(SRC_ROOT, "sessions", "index.ts")).href;
    const refreshProc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(sessionsEntryUrl)});
         const db = m.openSessionDatabase(${JSON.stringify(e2eDbPath)});
         await m.refreshSessionIndex(db, ${JSON.stringify(tmpHome)});
         db.close();`,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const refreshErr = await new Response(refreshProc.stderr).text();
    expect(await refreshProc.exited).toBe(0);
    if (refreshErr.trim()) throw new Error(refreshErr);

    const db = new SessionDatabase(e2eDbPath);
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      const indexed = sessions[0]!;
      expect(indexed).toMatchObject({
        key: `agy:${topUuid}`,
        nativeId: topUuid,
        source: "agy" as UnifiedSession["source"],
        title: "跨境清结算日切对账修复",
        cwd: workspaceDir,
        projectName: "my pay-gateway",
        resumeCapability: "direct",
      });

      // Chinese & English search + deep reasoning search + zero subagent leakage
      expect(searchSessions(db, "跨境清结算").map((r) => r.session.key)).toEqual([`agy:${topUuid}`]);
      expect(searchSessions(db, "日切窗口").map((r) => r.session.key)).toEqual([`agy:${topUuid}`]);
      expect(searchSessions(db, "reconciliation_drift_409").map((r) => r.session.key)).toEqual([`agy:${topUuid}`]);
      expect(searchSessions(db, "deep_clue_ledger_cursor_skew")).toHaveLength(0);
      expect(searchSessions(db, "deep_clue_ledger_cursor_skew", { deep: true }).map((r) => r.session.key)).toEqual([
        `agy:${topUuid}`,
      ]);
      expect(searchSessions(db, "subagent_secret_token_depth", { deep: true })).toHaveLength(0);
      expect(searchSessions(db, "subagent_parent_linked_noise", { deep: true })).toHaveLength(0);

      // Resume args & prepareResume
      expect(resumeArgs(indexed)).toEqual({
        clientId: "agy",
        args: ["--conversation", topUuid],
      });
      expect(prepareResume(indexed)).toMatchObject({
        clientId: "agy",
        args: ["--conversation", topUuid],
        projectPath: workspaceDir,
      });
    } finally {
      db.close();
    }
  });

  it("UX03-FAST-01: isClientInstalledFast accurately detects missing & installed agyClient in milliseconds", async () => {
    const isClientInstalledFast = (launcherDataMod as Record<string, unknown>).isClientInstalledFast as
      | ((client: typeof agyClient) => boolean | Promise<boolean>)
      | undefined;
    expect(typeof isClientInstalledFast).toBe("function");

    const isolatedHome = mkdtempSync(join(tmpdir(), "tako-agy-fast-home-"));
    cleanupPaths.push(isolatedHome);

    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    process.env.PATH = "";
    delete process.env.AGY_PATH;
    delete process.env.AGY_INSTALL_DIR;
    process.env.LOCALAPPDATA = join(isolatedHome, "AppData", "Local");

    const t0 = performance.now();
    const missingResult = await isClientInstalledFast!(agyClient);
    const missingMs = performance.now() - t0;
    expect(missingResult).toBe(false);
    expect(missingMs).toBeLessThan(30);

    // Executable via AGY_PATH
    const customBin = join(isolatedHome, process.platform === "win32" ? "custom-agy.exe" : "custom-agy");
    writeFileSync(customBin, "#!/bin/sh\necho 'agy 1.2.3'\n", "utf8");
    if (process.platform !== "win32") chmodSync(customBin, 0o755);
    process.env.AGY_PATH = customBin;

    const t1 = performance.now();
    const viaAgyPath = await isClientInstalledFast!(agyClient);
    const viaAgyPathMs = performance.now() - t1;
    expect(viaAgyPath).toBe(true);
    expect(viaAgyPathMs).toBeLessThan(30);

    // Executable in HOME/.local/bin/agy with AGY_PATH unset
    delete process.env.AGY_PATH;
    const localBinDir = join(isolatedHome, ".local", "bin");
    mkdirSync(localBinDir, { recursive: true });
    const stdBin = join(localBinDir, process.platform === "win32" ? "agy.exe" : "agy");
    writeFileSync(stdBin, "#!/bin/sh\necho 'agy 1.2.3'\n", "utf8");
    if (process.platform !== "win32") chmodSync(stdBin, 0o755);

    const t2 = performance.now();
    const viaHomeLocal = await isClientInstalledFast!(agyClient);
    const viaHomeLocalMs = performance.now() - t2;
    expect(viaHomeLocal).toBe(true);
    expect(viaHomeLocalMs).toBeLessThan(30);
  });
});

describe("UX-04: Provider / API Key / Version view exports, initial props & <=600-line compliance", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("UX04-VIEW-01a: imports & renders ClientVersionView, ProviderMenuView, LauncherView with initialClientId / initialRekeyProviderId", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tako-ux04-views-"));
    cleanupDirs.push(tmpRoot);
    const tmpTakoHome = join(tmpRoot, ".tako");
    const tmpHome = join(tmpRoot, "home");
    mkdirSync(tmpTakoHome, { recursive: true });
    mkdirSync(tmpHome, { recursive: true });

    writeFileSync(
      join(tmpTakoHome, "config.json"),
      JSON.stringify(
        {
          apiKey: "cr_old_tako_key_123456",
          apiId: "uuid-qa",
          installedClients: {},
          defaultProviderId: "prov-rekey-qa",
          providers: [
            {
              id: "prov-rekey-qa",
              name: "Tako",
              type: "tako",
              builtin: true,
              apiKey: "cr_old_tako_key_123456",
              baseUrl: "https://tako.example.test/v1",
              createdAt: "2026-11-18T00:00:00.000Z",
              supportedClients: ["codex", "claude-code", "pi", "grok", "agy"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const script = `
      import React from "react";
      import { render } from "ink";
      import { EventEmitter } from "node:events";
      import { PassThrough } from "node:stream";
      import "./src/clients";
      import { ClientVersionView } from "./src/ui/ink/views/ClientVersionView";
      import { ProviderMenuView } from "./src/ui/ink/views/ProviderMenuView";
      import { LauncherView } from "./src/ui/ink/views/LauncherView";

      globalThis.fetch = (async () => Response.json({ versions: {}, "dist-tags": {}, data: {} })) as typeof fetch;

      function mountAndCapture(
        el: React.ReactElement,
        waitMs = 0,
        ready?: (frame: string) => boolean,
        maxWaitMs = 2000,
      ): Promise<string> {
        return new Promise((resolve) => {
          class Out extends EventEmitter {
            columns = 140;
            rows = 45;
            isTTY = true;
            frames: string[] = [];
            write(chunk: string) { this.frames.push(String(chunk)); return true; }
          }
          const stdin = Object.assign(new PassThrough(), {
            isTTY: true,
            setRawMode() { return stdin; },
            ref() { return stdin; },
            unref() { return stdin; },
          });
          const stdout = new Out() as any;
          const app = render(el, { stdout, stdin: stdin as any, debug: true, exitOnCtrlC: false, patchConsole: false });
          const finish = () => {
            const last = stdout.frames.at(-1) ?? "";
            app.unmount();
            stdin.destroy();
            resolve(last);
          };
          if (!ready) {
            setTimeout(finish, waitMs);
            return;
          }
          const deadline = Date.now() + Math.max(waitMs, maxWaitMs);
          const poll = () => {
            const last = stdout.frames.at(-1) ?? "";
            if (ready(last) || Date.now() >= deadline) {
              finish();
              return;
            }
            setTimeout(poll, 25);
          };
          setTimeout(poll, Math.min(waitMs, 25));
        });
      }

      const stripAnsi = (s: string) => s.replace(/\\u001b\\[[0-9;]*m/g, "").trim();

      const versionFrame = await mountAndCapture(
        React.createElement(ClientVersionView, { onDone: () => {}, initialClientId: "agy" }),
        30,
        (frame) => frame.includes("Antigravity (agy)"),
      );
      const providerTabFrame = await mountAndCapture(
        React.createElement(ProviderMenuView, { onDone: () => {}, initialClientId: "agy" }),
        40,
        (frame) => frame.includes("Antigravity (agy)"),
      );
      const providerRekeyFrame = await mountAndCapture(
        React.createElement(ProviderMenuView, {
          onDone: () => {},
          initialClientId: "agy",
          initialRekeyProviderId: "prov-rekey-qa",
        }),
        80,
        (frame) => /API Key|输入.*Key|Enter.*Key|更新.*Key|Update.*Key/i.test(frame) && !frame.includes("添加服务商") && !frame.includes("Add Provider"),
      );
      const launcherFrame = await mountAndCapture(
        React.createElement(LauncherView, { onResult: () => {} }),
        120,
        (frame) => {
          const clean = stripAnsi(frame);
          return clean.length > 0 && clean !== "Loading..." && /Tako/.test(clean);
        },
      );

      console.log(JSON.stringify({ versionFrame, providerTabFrame, providerRekeyFrame, launcherFrame }));
      process.exit(0);
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        TAKO_HOME: tmpTakoHome,
        TAKO_REGION: "global",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Ink view render subprocess failed (${exitCode}):\n${stderrText}\n${stdoutText}`);
    }

    const rendered = JSON.parse(stdoutText.trim().split("\n").pop()!) as {
      versionFrame: string;
      providerTabFrame: string;
      providerRekeyFrame: string;
      launcherFrame: string;
    };

    // LauncherView renders cleanly past Loading state
    expect(rendered.launcherFrame).toContain("Tako");

    // ClientVersionView & ProviderMenuView activate the 'Antigravity (agy)' tab when initialClientId='agy'
    expect(rendered.versionFrame).toMatch(/┃[^┃│\n]*Antigravity \(agy\)[^┃│\n]*┃/);
    expect(rendered.providerTabFrame).toMatch(/┃[^┃│\n]*Antigravity \(agy\)[^┃│\n]*┃/);

    // ProviderMenuView jumps directly into API key input screen when initialRekeyProviderId is supplied
    expect(rendered.providerRekeyFrame).toMatch(/API Key|输入.*Key|Enter.*Key|更新.*Key|Update.*Key/i);
    expect(rendered.providerRekeyFrame).not.toContain("添加服务商");
    expect(rendered.providerRekeyFrame).not.toContain("Add Provider");
  });

  it("UX04-VIEW-01b: enforces <= 600 lines on LauncherView.tsx, core views, and all newly added src files", () => {
    const launcherLines = countLines(join(SRC_ROOT, "ui", "ink", "views", "LauncherView.tsx"));
    const providerMenuLines = countLines(join(SRC_ROOT, "ui", "ink", "views", "ProviderMenuView.tsx"));
    const clientVersionLines = countLines(join(SRC_ROOT, "ui", "ink", "views", "ClientVersionView.tsx"));

    expect(launcherLines).toBeLessThanOrEqual(600);
    expect(providerMenuLines).toBeLessThanOrEqual(600);
    expect(clientVersionLines).toBeLessThanOrEqual(600);

    const allSrcFiles = walkSourceFiles(SRC_ROOT);
    const newlyAdded = allSrcFiles
      .map((abs) => ({ abs, rel: relative(SRC_ROOT, abs).replace(/\\/g, "/") }))
      .filter(({ rel }) => !V0355_BASELINE_SRC_FILES.has(rel));

    expect(newlyAdded.length).toBeGreaterThan(0);
    for (const file of newlyAdded) {
      const lines = countLines(file.abs);
      expect(lines).toBeLessThanOrEqual(600);
    }
  });
});
