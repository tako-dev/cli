import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import "../src/clients";
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  agyClient,
  buildAgyLaunchOptions,
  buildAgySkipPermissionsSettings,
} from "../src/clients/agy";
import { buildAgyStatusLineConfig } from "../src/statusline";
import type { LaunchOption } from "../src/clients/base";
import {
  resolveInheritedDangerousFlag,
  withInheritedDangerousFlag,
} from "../src/clients/dangerous-flags";
import { clearLocaleOverride, setLocale } from "../src/i18n";
import { resetLogHandler, setLogHandler } from "../src/logger";
import { buildPassthroughArgs } from "../src/quick-launch-args";
import { LauncherOptionsSection } from "../src/ui/ink/views/LauncherChrome";
import {
  buildOptionRows,
  EXPLICIT_DEFAULT_MODEL_SENTINEL,
} from "../src/ui/shared/launch-options";
import { resolveInitialClientOptionIds } from "../src/ui/shared/launcher-data";
import type { LauncherResult } from "../src/ui/shared/types";
import type { Provider } from "../src/providers/types";

const SAMPLE_PROV: Provider = {
  id: "prov-tako",
  name: "Tako",
  type: "tako",
  apiKey: "cr_main",
  agyApiKey: "cr_agy",
  baseUrl: "https://tako.example.test/v1",
  model: "claude-opus-4-6",
  createdAt: "2026-11-19T00:00:00.000Z",
};

function renderInkFrame(element: React.ReactElement): string {
  class CaptureOut extends EventEmitter {
    columns = 120;
    rows = 30;
    isTTY = true;
    frames: string[] = [];
    write(chunk: unknown) {
      this.frames.push(String(chunk));
      return true;
    }
  }
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {
      return stdin;
    },
    ref() {
      return stdin;
    },
    unref() {
      return stdin;
    },
  });
  const stdout = new CaptureOut() as unknown as NodeJS.WriteStream & { frames: string[] };
  const app = render(element, {
    stdout,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const frame = stdout.frames.at(-1) ?? "";
  app.unmount();
  stdin.destroy();
  return frame;
}

describe("resolveInitialClientOptionIds & loadLauncherData defaultOn preservation", () => {
  const options: LaunchOption[] = buildAgyLaunchOptions(SAMPLE_PROV);

  it("preserves defaultOn (skip-permissions) alongside provider.model on first launch (savedIds = [])", () => {
    const resolved = resolveInitialClientOptionIds([], options, "claude-opus-4-6");
    expect(resolved).toEqual(["skip-permissions", "model-claude-opus-4-6"]);
  });

  it("preserves defaultOn alongside fallbackModelId when savedIds = []", () => {
    const resolved = resolveInitialClientOptionIds(
      [],
      options,
      undefined,
      "model-gemini-3.8-flash",
    );
    expect(resolved).toEqual(["skip-permissions", "model-gemini-3.8-flash"]);
  });

  it("returns defaultOn flags when savedIds = [] and no default model applies", () => {
    const resolved = resolveInitialClientOptionIds([], options);
    expect(resolved).toEqual(["skip-permissions"]);
  });

  it("strictly respects user memory when skip-permissions was manually unchecked (savedIds > 0)", () => {
    const resolved = resolveInitialClientOptionIds(
      ["model-claude-sonnet-4-6", "removed-stale-flag"],
      options,
      "claude-opus-4-6",
    );
    expect(resolved).toEqual(["model-claude-sonnet-4-6"]);
    expect(resolved).not.toContain("skip-permissions");
  });

  it("respects EXPLICIT_DEFAULT_MODEL_SENTINEL without re-enabling unchecked skip-permissions", () => {
    const resolved = resolveInitialClientOptionIds(
      [EXPLICIT_DEFAULT_MODEL_SENTINEL],
      options,
      "claude-opus-4-6",
      "model-gemini-3.8-flash",
    );
    expect(resolved).toEqual([EXPLICIT_DEFAULT_MODEL_SENTINEL]);
  });

  it("populates skip-permissions + provider.model in loadLauncherData when config has no project history", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tako-launcher-data-"));
    try {
      const takoHome = join(tmp, ".tako");
      mkdirSync(takoHome, { recursive: true });
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "cr_main",
          agyApiKey: "cr_agy",
          apiId: "u1",
          installedClients: {},
          defaultProviderId: "p1",
          providers: [
            {
              id: "p1",
              name: "Tako",
              type: "tako",
              apiKey: "cr_main",
              agyApiKey: "cr_agy",
              baseUrl: "https://tako.example.test/v1",
              model: "claude-opus-4-6",
              createdAt: "2026-11-19T00:00:00.000Z",
              supportedClients: ["agy", "claude-code", "codex", "pi", "grok"],
            },
          ],
        }),
      );

      const modUrl = new URL("../src/ui/shared/launcher-data.ts", import.meta.url).href;
      const clientsUrl = new URL("../src/clients/index.ts", import.meta.url).href;
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `await import(${JSON.stringify(clientsUrl)});
           const { loadLauncherData } = await import(${JSON.stringify(modUrl)});
           const res = await loadLauncherData();
           const agy = res.clients.find((c) => c.client.id === "agy");
           console.log(JSON.stringify(agy?.lastSelectedOptionIds ?? null));`,
        ],
        {
          env: { ...process.env, TAKO_HOME: takoHome, TAKO_DEV: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out.trim())).toEqual(["skip-permissions", "model-claude-opus-4-6"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveGrokBin does not leak stderr when grok is missing (Bun.which and execSync fallback)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tako-grok-missing-"));
    try {
      const toolsDir = join(tmp, "tools");
      const grokUrl = new URL("../src/clients/grok.ts", import.meta.url).href;
      const otherPlatform = process.platform === "win32" ? "linux" : "win32";
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `process.env.PATH = "";
           const { resolveGrokBin } = await import(${JSON.stringify(grokUrl)});
           const fast = await resolveGrokBin({ home: ${JSON.stringify(tmp)}, toolsDir: ${JSON.stringify(toolsDir)} });
           const fallback = await resolveGrokBin({
             home: ${JSON.stringify(tmp)},
             toolsDir: ${JSON.stringify(toolsDir)},
             platform: ${JSON.stringify(otherPlatform)},
           });
           console.log(JSON.stringify({ fast, fallback }));`,
        ],
        {
          cwd: tmp,
          env: { ...process.env, TAKO_HOME: join(tmp, ".tako"), TAKO_DEV: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out.trim())).toEqual({ fast: null, fallback: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Session resume preserves lastSelectedOptionIds", () => {
  it("allows optional selectedOptionIds on LauncherResult and emits undefined from LauncherSessionPane", async () => {
    const checkType: LauncherResult = {
      type: "launch",
      clientId: "agy",
      args: ["--conversation", "123"],
      envVars: {},
      selectedOptionIds: undefined,
      resume: true,
    };
    expect(checkType.selectedOptionIds).toBeUndefined();

    const paneSource = readFileSync(
      join(import.meta.dir, "..", "src", "ui", "ink", "views", "LauncherSessionPane.tsx"),
      "utf8",
    );
    expect(paneSource).toContain("selectedOptionIds: undefined");
    expect(paneSource).not.toContain("selectedOptionIds: []");

    const tmp = mkdtempSync(join(tmpdir(), "tako-resume-preserve-"));
    try {
      const takoHome = join(tmp, ".tako");
      const workDir = join(tmp, "project");
      mkdirSync(takoHome, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "cr_main",
          apiId: "u1",
          installedClients: {},
        }),
      );

      const historyUrl = new URL("../src/project-history.ts", import.meta.url).href;
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { recordProjectLaunch, getLastSelectedOptionsForClient } = await import(${JSON.stringify(historyUrl)});
           await recordProjectLaunch(${JSON.stringify(workDir)}, "agy", ["skip-permissions", "model-claude-opus-4-6"]);
           await recordProjectLaunch(${JSON.stringify(workDir)}, "agy", undefined);
           console.log(JSON.stringify(await getLastSelectedOptionsForClient("agy", ${JSON.stringify(workDir)})));`,
        ],
        {
          env: { ...process.env, TAKO_HOME: takoHome, TAKO_DEV: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out.trim())).toEqual(["skip-permissions", "model-claude-opus-4-6"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Antigravity session-only --settings & workspace trust", () => {
  let tmp: string;
  let savedAgyHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-settings-"));
    savedAgyHome = process.env.AGY_HOME;
  });

  afterEach(() => {
    if (savedAgyHome === undefined) delete process.env.AGY_HOME;
    else process.env.AGY_HOME = savedAgyHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exports AGY_SKIP_PERMISSIONS_FLAG and builds session settings without touching disk settings.json", () => {
    expect(AGY_SKIP_PERMISSIONS_FLAG).toBe("--dangerously-skip-permissions");

    const agyHome = join(tmp, "agy-home");
    const realWorkDir = join(tmp, "real-project");
    const linkWorkDir = join(tmp, "link-project");
    mkdirSync(agyHome, { recursive: true });
    mkdirSync(realWorkDir, { recursive: true });
    if (process.platform !== "win32") {
      symlinkSync(realWorkDir, linkWorkDir);
    }
    const targetDir = process.platform === "win32" ? realWorkDir : linkWorkDir;
    const resolvedReal = realpathSync(targetDir);

    // 1. Missing settings.json -> does not write settings.json
    const missingSettingsPath = join(agyHome, "settings.json");
    const json1 = buildAgySkipPermissionsSettings(targetDir, agyHome);
    expect(existsSync(missingSettingsPath)).toBe(false);
    const parsed1 = JSON.parse(json1);
    expect(parsed1.allowNonWorkspaceAccess).toBe(true);
    expect(parsed1.toolPermission).toBe("always-proceed");
    expect(parsed1.trustedWorkspaces).toContain(targetDir);
    expect(parsed1.trustedWorkspaces).toContain(resolvedReal);
    expect(new Set(parsed1.trustedWorkspaces).size).toBe(parsed1.trustedWorkspaces.length);

    // 2. Existing settings.json -> preserves order, deduplicates, ignores non-strings, never mutates file
    const diskContent = JSON.stringify(
      {
        theme: "dark",
        trustedWorkspaces: ["/existing/one", 42, "/existing/two", "/existing/one", targetDir],
      },
      null,
      2,
    );
    writeFileSync(missingSettingsPath, diskContent, "utf8");

    process.env.AGY_HOME = agyHome;
    const json2 = buildAgySkipPermissionsSettings(targetDir);
    expect(readFileSync(missingSettingsPath, "utf8")).toBe(diskContent);
    const parsed2 = JSON.parse(json2);
    expect(parsed2).toEqual({
      trustedWorkspaces: Array.from(new Set(["/existing/one", "/existing/two", targetDir, resolvedReal])),
      allowNonWorkspaceAccess: true,
      toolPermission: "always-proceed",
      statusLine: buildAgyStatusLineConfig(),
    });

    // 3. Malformed settings.json + non-existent workingDir -> resilient fallback, file untouched
    const brokenContent = "{ invalid json";
    writeFileSync(missingSettingsPath, brokenContent, "utf8");
    const missingWorkDir = join(tmp, "does-not-exist");
    const parsed3 = JSON.parse(buildAgySkipPermissionsSettings(missingWorkDir, agyHome));
    expect(readFileSync(missingSettingsPath, "utf8")).toBe(brokenContent);
    expect(parsed3).toEqual({
      trustedWorkspaces: [missingWorkDir],
      allowNonWorkspaceAccess: true,
      toolPermission: "always-proceed",
      statusLine: buildAgyStatusLineConfig(),
    });

    // 4. Custom non-Tako statusLine in settings.json -> omits statusLine override in --settings
    writeFileSync(
      missingSettingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "/usr/local/bin/my-bar" } }),
      "utf8",
    );
    const parsed4 = JSON.parse(buildAgySkipPermissionsSettings(missingWorkDir, agyHome));
    expect(parsed4).toEqual({
      trustedWorkspaces: [missingWorkDir],
      allowNonWorkspaceAccess: true,
      toolPermission: "always-proceed",
    });
  });

  it("injects --settings in agyClient.setupConfigFiles on launch with statusLine & skip-permissions rules", async () => {
    const agyHome = join(tmp, "setup-agy-home");
    const workDir = join(tmp, "work");
    mkdirSync(agyHome, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    process.env.AGY_HOME = agyHome;

    const provider = { type: "tako" as const, baseUrl: "https://tako.example.test", apiKey: "cr_1" };

    // Non-launch (e.g. provider switch) -> undefined
    expect(await agyClient.setupConfigFiles?.(provider, ["skip-permissions"])).toBeUndefined();
    expect(
      await agyClient.setupConfigFiles?.(provider, ["skip-permissions"], { forLaunch: false, workingDir: workDir }),
    ).toBeUndefined();

    // Launch without skip-permissions (e.g. unchecked or --no-skip-permissions) -> undefined (pure argv)
    expect(
      await agyClient.setupConfigFiles?.(provider, ["model-claude-opus-4-6"], {
        forLaunch: true,
        launchArgs: ["--model", "claude-opus-4-6"],
        workingDir: workDir,
      }),
    ).toBeUndefined();
    expect(
      await agyClient.setupConfigFiles?.(provider, undefined, {
        forLaunch: true,
        launchArgs: ["-p", "hi"],
        workingDir: workDir,
      }),
    ).toBeUndefined();

    // User already supplied --settings or --settings=... -> undefined
    expect(
      await agyClient.setupConfigFiles?.(provider, ["skip-permissions"], {
        forLaunch: true,
        launchArgs: [AGY_SKIP_PERMISSIONS_FLAG, "--settings", '{"toolPermission":"ask"}'],
        workingDir: workDir,
      }),
    ).toBeUndefined();
    expect(
      await agyClient.setupConfigFiles?.(provider, ["skip-permissions"], {
        forLaunch: true,
        launchArgs: [AGY_SKIP_PERMISSIONS_FLAG, '--settings={"toolPermission":"ask"}'],
        workingDir: workDir,
      }),
    ).toBeUndefined();

    // Active via launchArgs (quick-launch / session resume)
    const fromArgs = await agyClient.setupConfigFiles?.(provider, undefined, {
      forLaunch: true,
      launchArgs: [AGY_SKIP_PERMISSIONS_FLAG],
      workingDir: workDir,
    });
    expect(fromArgs?.args?.[0]).toBe("--settings");
    expect(JSON.parse(fromArgs?.args?.[1] ?? "{}")).toMatchObject({
      allowNonWorkspaceAccess: true,
      toolPermission: "always-proceed",
    });

    // Active via selectedOptionIds (panel launch)
    const fromSelected = await agyClient.setupConfigFiles?.(provider, ["skip-permissions"], {
      forLaunch: true,
      launchArgs: [],
      workingDir: workDir,
    });
    expect(fromSelected?.args).toEqual(["--settings", buildAgySkipPermissionsSettings(workDir, agyHome)]);
  });
});

describe("Quick-launch --no-skip-permissions, --yolo, LauncherChrome flag visibility & startup log", () => {
  afterEach(() => {
    clearLocaleOverride();
    resetLogHandler();
  });

  it("supports --no-skip-permissions opt-out and strips it across dangerous-flags and buildPassthroughArgs", async () => {
    const withSavedSkip = { getLastSelectedOptionIds: async () => ["skip-permissions"] };
    const noSaved = { getLastSelectedOptionIds: async () => [] };

    expect(await resolveInheritedDangerousFlag("agy", ["--no-skip-permissions"], withSavedSkip)).toBeNull();
    expect(await resolveInheritedDangerousFlag("claude-code", ["--no-skip-permissions"], noSaved)).toBeNull();
    expect(await withInheritedDangerousFlag("agy", ["--no-skip-permissions", "-c"], withSavedSkip)).toEqual(["-c"]);

    expect(
      await buildPassthroughArgs("agy", ["agy", "--no-skip-permissions", "-p", "hi"], "agy", withSavedSkip),
    ).toEqual(["-p", "hi"]);
    expect(
      await buildPassthroughArgs("claude-code", ["--claude", "--no-skip-permissions", "-c"], "--claude", noSaved),
    ).toEqual(["-c"]);
    expect(
      await buildPassthroughArgs("codex", ["codex", "--no-skip-permissions"], "codex", noSaved),
    ).toEqual([]);
    expect(
      await buildPassthroughArgs("pi", ["pi", "--no-skip-permissions", "-c"], "pi", noSaved),
    ).toEqual(["-c"]);
  });

  it("normalizes --yolo to --dangerously-skip-permissions for agy without duplicates", async () => {
    const uncheckedHistory = { getLastSelectedOptionIds: async () => ["model-claude-opus-4-6"] };
    const checkedHistory = { getLastSelectedOptionIds: async () => ["skip-permissions"] };
    const emptyHistory = { getLastSelectedOptionIds: async () => [] };

    expect(await buildPassthroughArgs("agy", ["agy", "--yolo"], "agy", uncheckedHistory)).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(await buildPassthroughArgs("agy", ["--agy", "--yolo", "-p", "hi"], "--agy", emptyHistory)).toEqual([
      "--dangerously-skip-permissions",
      "-p",
      "hi",
    ]);
    expect(
      await buildPassthroughArgs(
        "agy",
        ["agy", "--yolo", "--dangerously-skip-permissions", "--yolo"],
        "agy",
        checkedHistory,
      ),
    ).toEqual(["--dangerously-skip-permissions"]);

    const quickLaunchSrc = readFileSync(
      join(import.meta.dir, "..", "src", "quick-launch-args.ts"),
      "utf8",
    );
    expect(quickLaunchSrc).toContain("agy");
    expect(quickLaunchSrc).toContain("skip-permissions → --dangerously-skip-permissions");
  });

  it("renders --dangerously-skip-permissions in LauncherOptionsSection when checked even if unfocused", () => {
    const options = buildAgyLaunchOptions(SAMPLE_PROV);
    const rows = buildOptionRows(options, true);

    const checkedUnfocused = renderInkFrame(
      React.createElement(LauncherOptionsSection, {
        optionRows: rows,
        options,
        enabled: new Set(["skip-permissions"]),
        focusedArea: false,
        optionIdx: 0,
        color: "green",
        currentProv: SAMPLE_PROV,
        provName: "Tako",
        zh: true,
      }),
    );
    expect(checkedUnfocused).toContain("◉");
    expect(checkedUnfocused).toContain("跳过权限确认");
    expect(checkedUnfocused).toContain("--dangerously-skip-permissions");

    const uncheckedUnfocused = renderInkFrame(
      React.createElement(LauncherOptionsSection, {
        optionRows: rows,
        options,
        enabled: new Set(),
        focusedArea: false,
        optionIdx: 0,
        color: "green",
        currentProv: SAMPLE_PROV,
        provName: "Tako",
        zh: true,
      }),
    );
    expect(uncheckedUnfocused).toContain("○");
    expect(uncheckedUnfocused).not.toContain("--dangerously-skip-permissions");
  });

  it("prints active dangerous flag in launchClientUnified startup log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tako-launch-log-"));
    const savedAgyPath = process.env.AGY_PATH;
    const savedAgyHome = process.env.AGY_HOME;
    try {
      const mockBin = join(tmp, process.platform === "win32" ? "agy.exe" : "agy");
      writeFileSync(mockBin, process.platform === "win32" ? "MZ" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      if (process.platform !== "win32") Bun.spawnSync([mockBin]);

      process.env.AGY_PATH = mockBin;
      process.env.AGY_HOME = join(tmp, "agy-home");

      const logs: string[] = [];
      setLocale("zh");
      setLogHandler({
        info: (m) => logs.push(m),
        warn: () => {},
        error: () => {},
        success: () => {},
        spin: () => ({ stop() {}, update() {} }),
      });

      const { launchClientUnified } = await import("../src/launcher");
      if (process.platform !== "win32") {
        await launchClientUnified(agyClient, {
          projectPath: tmp,
          args: ["--dangerously-skip-permissions", "--version"],
          providerContext: { type: "tako", baseUrl: "https://tako.example.test", apiKey: "cr_1" },
        });
        expect(logs).toContain("正在启动 Antigravity (agy) (--dangerously-skip-permissions)...");

        logs.length = 0;
        await launchClientUnified(agyClient, {
          projectPath: tmp,
          args: ["--version"],
          providerContext: { type: "tako", baseUrl: "https://tako.example.test", apiKey: "cr_1" },
        });
        expect(logs).toContain("正在启动 Antigravity (agy)...");
      }
    } finally {
      if (savedAgyPath === undefined) delete process.env.AGY_PATH;
      else process.env.AGY_PATH = savedAgyPath;
      if (savedAgyHome === undefined) delete process.env.AGY_HOME;
      else process.env.AGY_HOME = savedAgyHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
