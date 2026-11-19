import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import "../src/clients";
import type { LaunchOption } from "../src/clients/base";
import type { Provider, ProviderContext } from "../src/providers/types";

const REPO_ROOT = join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function createInkHarness(element: React.ReactElement) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 35;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  const app = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  return {
    getOutput: () => output,
    send: (data: string) => {
      stdin.write(data);
    },
    unmount: () => app.unmount(),
  };
}

function createFakeAgyExecutable(dir: string): { fakeAgyBin: string; argvFile: string } {
  const captureJs = join(dir, "fake-agy-capture.mjs");
  const argvFile = join(dir, "captured-argv.json");
  const fakeAgyBin = join(dir, "mock-agy");

  writeFileSync(
    captureJs,
    [
      'import { writeFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      'if (argv.includes("--version")) {',
      '  console.log("0.2.99");',
      "  process.exit(0);",
      "}",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv, cwd: process.cwd() }));`,
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    fakeAgyBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(captureJs)} "$@"\n`,
    "utf8",
  );
  chmodSync(fakeAgyBin, 0o755);

  return { fakeAgyBin, argvFile };
}

function makeAgyTestOptions(): LaunchOption[] {
  return [
    {
      id: "skip-permissions",
      label: { en: "Skip Permissions", zh: "跳过权限确认" },
      shortLabel: "Skip Perms",
      description: {
        en: "Auto-approve all tool permission requests without prompting",
        zh: "自动批准所有工具权限请求，无需确认",
      },
      flag: "--dangerously-skip-permissions",
      args: ["--dangerously-skip-permissions"],
      defaultOn: true,
    },
    {
      id: "model-claude-opus-4-6",
      label: { en: "claude-opus-4-6", zh: "claude-opus-4-6" },
      shortLabel: "claude-opus-4-6",
      description: { en: "Use claude-opus-4-6", zh: "使用 claude-opus-4-6" },
      flag: "--model claude-opus-4-6",
      args: ["--model", "claude-opus-4-6"],
      group: "model",
    },
    {
      id: "model-claude-sonnet-4-6",
      label: { en: "claude-sonnet-4-6", zh: "claude-sonnet-4-6" },
      shortLabel: "claude-sonnet-4-6",
      description: { en: "Use claude-sonnet-4-6", zh: "使用 claude-sonnet-4-6" },
      flag: "--model claude-sonnet-4-6",
      args: ["--model", "claude-sonnet-4-6"],
      group: "model",
    },
  ];
}

describe("SKIP-01: First-launch defaultOn preservation contract (launcher-data.ts)", () => {
  it("TC-SKIP01-01: resolveInitialClientOptionIds keeps defaultOn 'skip-permissions' alongside providerModel / fallbackModelId on first launch", async () => {
    const launcherDataMod = (await import("../src/ui/shared/launcher-data")) as Record<string, unknown>;
    const launcherViewMod = await import("../src/ui/ink/views/LauncherView");

    expect(typeof launcherDataMod.resolveInitialClientOptionIds).toBe("function");
    const resolveInitialClientOptionIds = launcherDataMod.resolveInitialClientOptionIds as (
      savedIds: string[],
      launchOptions: LaunchOption[],
      providerModel?: string,
      fallbackModelId?: string,
    ) => string[];

    const launchOptions = makeAgyTestOptions();

    // First use (savedIds = []) + provider default model "claude-sonnet-4-6"
    const result = resolveInitialClientOptionIds([], launchOptions, "claude-sonnet-4-6");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain("skip-permissions");
    expect(result).toContain("model-claude-sonnet-4-6");

    const enabled = launcherViewMod.buildInitialEnabled(launchOptions, result);
    expect(enabled.has("skip-permissions")).toBe(true);
    expect(enabled.has("model-claude-sonnet-4-6")).toBe(true);

    // First use (savedIds = []) + fallbackModelId
    const fallbackResult = resolveInitialClientOptionIds(
      [],
      launchOptions,
      undefined,
      "model-claude-opus-4-6",
    );
    expect(fallbackResult).toContain("skip-permissions");
    expect(fallbackResult).toContain("model-claude-opus-4-6");
    const fallbackEnabled = launcherViewMod.buildInitialEnabled(launchOptions, fallbackResult);
    expect(fallbackEnabled.has("skip-permissions")).toBe(true);
    expect(fallbackEnabled.has("model-claude-opus-4-6")).toBe(true);
  });

  it("TC-SKIP01-02: resolveInitialClientOptionIds respects explicit user uncheck when savedIds only retains a model or sentinel", async () => {
    const launcherDataMod = (await import("../src/ui/shared/launcher-data")) as Record<string, unknown>;
    const launchOptionsMod = await import("../src/ui/shared/launch-options");
    const launcherViewMod = await import("../src/ui/ink/views/LauncherView");

    expect(typeof launcherDataMod.resolveInitialClientOptionIds).toBe("function");
    const resolveInitialClientOptionIds = launcherDataMod.resolveInitialClientOptionIds as (
      savedIds: string[],
      launchOptions: LaunchOption[],
      providerModel?: string,
      fallbackModelId?: string,
    ) => string[];

    const launchOptions = makeAgyTestOptions();

    // User unchecked skip-permissions and kept only model-claude-sonnet-4-6
    const uncheckedResult = resolveInitialClientOptionIds(
      ["model-claude-sonnet-4-6"],
      launchOptions,
      "claude-sonnet-4-6",
    );
    expect(uncheckedResult).not.toContain("skip-permissions");
    expect(uncheckedResult).toContain("model-claude-sonnet-4-6");

    const enabled = launcherViewMod.buildInitialEnabled(launchOptions, uncheckedResult);
    expect(enabled.has("skip-permissions")).toBe(false);
    expect(enabled.has("model-claude-sonnet-4-6")).toBe(true);

    // User unchecked skip-permissions and selected explicit client default model sentinel
    const sentinelResult = resolveInitialClientOptionIds(
      [launchOptionsMod.EXPLICIT_DEFAULT_MODEL_SENTINEL],
      launchOptions,
      "claude-sonnet-4-6",
    );
    expect(sentinelResult).not.toContain("skip-permissions");
    expect(sentinelResult).toContain(launchOptionsMod.EXPLICIT_DEFAULT_MODEL_SENTINEL);
    expect(sentinelResult).not.toContain("model-claude-sonnet-4-6");
  });

  it("TC-SKIP01-03: loadLauncherData() in isolated TAKO_HOME preserves agy skip-permissions when activeProvider sets a default model", async () => {
    const tmp = makeTempDir("tako-qa-skip01-e2e-");
    const takoHome = join(tmp, "tako-home");
    const isolatedHome = join(tmp, "home");
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });

    const { fakeAgyBin } = createFakeAgyExecutable(tmp);
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_test_key",
        apiId: "test-id",
        telemetryEnabled: false,
        installedClients: {},
        providers: [
          {
            id: "custom-agy",
            name: "Custom Gateway",
            type: "custom",
            apiKey: "sk-test-agy",
            baseUrl: "https://gateway.example.invalid/v1",
            model: "claude-sonnet-4-6",
            supportedClients: ["agy"],
          },
        ],
        defaultProviderId: "custom-agy",
      }),
      "utf8",
    );

    const script = `
      import "./src/clients";
      import { loadLauncherData } from "./src/ui/shared/launcher-data";
      import { buildInitialEnabled } from "./src/ui/ink/views/LauncherView";

      const loaded = await loadLauncherData(45);
      const agyEntry = loaded.clients.find((item) => item.client.id === "agy");
      if (!agyEntry) throw new Error("agy client entry missing from loadLauncherData");
      const enabled = buildInitialEnabled(agyEntry.launchOptions, agyEntry.lastSelectedOptionIds);
      console.log(JSON.stringify({
        lastSelectedOptionIds: agyEntry.lastSelectedOptionIds,
        enabled: [...enabled],
      }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: isolatedHome,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: fakeAgyBin,
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim().split("\n").pop()!) as {
      lastSelectedOptionIds: string[];
      enabled: string[];
    };
    expect(parsed.enabled).toContain("skip-permissions");
    expect(parsed.enabled).toContain("model-claude-sonnet-4-6");
  });
});

describe("SKIP-02: agy default --dangerously-skip-permissions & session-scoped --settings injection (clients/agy.ts)", () => {
  it("TC-SKIP02-01: exports AGY_SKIP_PERMISSIONS_FLAG & buildAgySkipPermissionsSettings without mutating global settings.json", async () => {
    const agyMod = (await import("../src/clients/agy")) as Record<string, unknown>;

    expect(agyMod.AGY_SKIP_PERMISSIONS_FLAG).toBe("--dangerously-skip-permissions");
    expect(typeof agyMod.buildAgySkipPermissionsSettings).toBe("function");

    const buildAgySkipPermissionsSettings = agyMod.buildAgySkipPermissionsSettings as (
      workingDir: string,
      agyHome?: string,
    ) => string;

    const tmp = makeTempDir("tako-qa-skip02-settings-");
    const agyHome = join(tmp, "agy-home");
    mkdirSync(agyHome, { recursive: true });

    const realWorkDir = join(tmp, "real-project");
    mkdirSync(realWorkDir, { recursive: true });
    const symlinkWorkDir = join(tmp, "symlink-project");
    symlinkSync(realWorkDir, symlinkWorkDir, "dir");

    const settingsPath = join(agyHome, "settings.json");
    const originalContent =
      '{\n  "trustedWorkspaces": [\n    "/existing/repo"\n  ],\n  "model": "claude-opus-4-6"\n}\n';
    writeFileSync(settingsPath, originalContent, "utf8");
    const beforeBytes = readFileSync(settingsPath);

    const jsonStr = buildAgySkipPermissionsSettings(symlinkWorkDir, agyHome);
    expect(typeof jsonStr).toBe("string");

    const parsed = JSON.parse(jsonStr) as {
      allowNonWorkspaceAccess?: boolean;
      toolPermission?: string;
      trustedWorkspaces?: string[];
    };
    expect(parsed.allowNonWorkspaceAccess).toBe(true);
    expect(parsed.toolPermission).toBe("always-proceed");
    expect(Array.isArray(parsed.trustedWorkspaces)).toBe(true);
    expect(parsed.trustedWorkspaces).toContain("/existing/repo");
    expect(parsed.trustedWorkspaces).toContain(symlinkWorkDir);
    expect(parsed.trustedWorkspaces).toContain(realpathSync(symlinkWorkDir));
    expect(new Set(parsed.trustedWorkspaces).size).toBe(parsed.trustedWorkspaces!.length);

    // Byte-for-byte immutability check on disk settings.json
    const afterBytes = readFileSync(settingsPath);
    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);

    // Deduplication check when tmpWorkDir and realpathSync(tmpWorkDir) are already in settings.json
    const dupHome = join(tmp, "agy-home-dup");
    mkdirSync(dupHome, { recursive: true });
    writeFileSync(
      join(dupHome, "settings.json"),
      JSON.stringify({
        trustedWorkspaces: ["/existing/repo", symlinkWorkDir, realpathSync(symlinkWorkDir)],
      }),
      "utf8",
    );
    const dupParsed = JSON.parse(buildAgySkipPermissionsSettings(symlinkWorkDir, dupHome)) as {
      trustedWorkspaces: string[];
    };
    expect(new Set(dupParsed.trustedWorkspaces).size).toBe(dupParsed.trustedWorkspaces.length);

    // Clean agyHome without settings.json must succeed and must not create settings.json on disk
    const emptyAgyHome = join(tmp, "agy-home-empty");
    mkdirSync(emptyAgyHome, { recursive: true });
    const emptyParsed = JSON.parse(buildAgySkipPermissionsSettings(symlinkWorkDir, emptyAgyHome)) as {
      allowNonWorkspaceAccess?: boolean;
      toolPermission?: string;
      trustedWorkspaces?: string[];
    };
    expect(emptyParsed.allowNonWorkspaceAccess).toBe(true);
    expect(emptyParsed.toolPermission).toBe("always-proceed");
    expect(emptyParsed.trustedWorkspaces).toContain(symlinkWorkDir);
    expect(emptyParsed.trustedWorkspaces).toContain(realpathSync(symlinkWorkDir));
    expect(existsSync(join(emptyAgyHome, "settings.json"))).toBe(false);
  });

  it("TC-SKIP02-02: agyClient.setupConfigFiles injects --settings only for launch with skip-permissions and yields to explicit --settings", async () => {
    const { agyClient } = await import("../src/clients/agy");
    expect(typeof agyClient.setupConfigFiles).toBe("function");

    const tmp = makeTempDir("tako-qa-skip02-setup-");
    const tmpWorkDir = join(tmp, "work");
    mkdirSync(tmpWorkDir, { recursive: true });

    const providerCtx: ProviderContext = {
      type: "custom",
      apiKey: "sk-test",
      baseUrl: "https://gateway.example.invalid/v1",
    };

    // 1a. forLaunch: true + launchArgs includes --dangerously-skip-permissions
    const byArgs = await agyClient.setupConfigFiles!(providerCtx, undefined, {
      forLaunch: true,
      launchArgs: ["--dangerously-skip-permissions"],
      workingDir: tmpWorkDir,
    });
    expect(byArgs).toBeDefined();
    expect(byArgs?.args?.[0]).toBe("--settings");
    expect(byArgs?.args).toHaveLength(2);
    const parsedByArgs = JSON.parse(byArgs!.args![1]) as Record<string, unknown>;
    expect(parsedByArgs.allowNonWorkspaceAccess).toBe(true);
    expect(parsedByArgs.toolPermission).toBe("always-proceed");
    expect(parsedByArgs.trustedWorkspaces).toEqual(
      expect.arrayContaining([tmpWorkDir, realpathSync(tmpWorkDir)]),
    );

    // 1b. forLaunch: true + selectedOptionIds includes "skip-permissions"
    const byOptionId = await agyClient.setupConfigFiles!(providerCtx, ["skip-permissions"], {
      forLaunch: true,
      launchArgs: [],
      workingDir: tmpWorkDir,
    });
    expect(byOptionId).toBeDefined();
    expect(byOptionId?.args?.[0]).toBe("--settings");
    expect(byOptionId?.args).toHaveLength(2);
    const parsedByOptionId = JSON.parse(byOptionId!.args![1]) as Record<string, unknown>;
    expect(parsedByOptionId.allowNonWorkspaceAccess).toBe(true);
    expect(parsedByOptionId.toolPermission).toBe("always-proceed");

    // 2. forLaunch: true but skip-permissions is NOT enabled -> undefined
    const withoutSkip = await agyClient.setupConfigFiles!(providerCtx, [], {
      forLaunch: true,
      launchArgs: [],
      workingDir: tmpWorkDir,
    });
    expect(withoutSkip).toBeUndefined();

    const modelOnly = await agyClient.setupConfigFiles!(providerCtx, ["model-claude-opus-4-6"], {
      forLaunch: true,
      launchArgs: ["--model", "claude-opus-4-6"],
      workingDir: tmpWorkDir,
    });
    expect(modelOnly).toBeUndefined();

    // 3. Explicit --settings or --settings=... passed by user -> undefined
    const explicitSeparate = await agyClient.setupConfigFiles!(providerCtx, ["skip-permissions"], {
      forLaunch: true,
      launchArgs: ["--dangerously-skip-permissions", "--settings", '{"toolPermission":"strict"}'],
      workingDir: tmpWorkDir,
    });
    expect(explicitSeparate).toBeUndefined();

    const explicitEquals = await agyClient.setupConfigFiles!(providerCtx, ["skip-permissions"], {
      forLaunch: true,
      launchArgs: ["--dangerously-skip-permissions", '--settings={"toolPermission":"strict"}'],
      workingDir: tmpWorkDir,
    });
    expect(explicitEquals).toBeUndefined();

    // 4. Non-launch scenario (provider switch config sync without forLaunch: true) -> undefined
    const nonLaunchNoCtx = await agyClient.setupConfigFiles!(providerCtx, ["skip-permissions"]);
    expect(nonLaunchNoCtx).toBeUndefined();

    const nonLaunchFalse = await agyClient.setupConfigFiles!(providerCtx, ["skip-permissions"], {
      forLaunch: false,
      launchArgs: ["--dangerously-skip-permissions"],
      workingDir: tmpWorkDir,
    });
    expect(nonLaunchFalse).toBeUndefined();
  });
});

describe("SKIP-03: Quick launch tako agy / tako --agy args & real subprocess E2E", () => {
  it("TC-SKIP03-01: buildPassthroughArgs('agy', ...) handles default skip-permissions, --yolo deduplication, and --no-skip-permissions opt-out", async () => {
    const { buildPassthroughArgs } = await import("../src/quick-launch-args");
    const noHistory = { getLastSelectedOptionIds: async () => [] };
    const uncheckedHistory = { getLastSelectedOptionIds: async () => ["model-claude-opus-4-6"] };
    const checkedHistory = { getLastSelectedOptionIds: async () => ["skip-permissions"] };

    // Default without history: both `tako agy` and `tako --agy` emit ["--dangerously-skip-permissions"]
    expect(await buildPassthroughArgs("agy", ["agy"], "agy", noHistory)).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(await buildPassthroughArgs("agy", ["--agy"], "--agy", noHistory)).toEqual([
      "--dangerously-skip-permissions",
    ]);

    // Passing --yolo normalizes to a single "--dangerously-skip-permissions" with no "--yolo"
    const yoloSubcmd = await buildPassthroughArgs(
      "agy",
      ["agy", "--yolo", "-p", "hi"],
      "agy",
      noHistory,
    );
    expect(yoloSubcmd.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(1);
    expect(yoloSubcmd).not.toContain("--yolo");
    expect(yoloSubcmd.slice(-2)).toEqual(["-p", "hi"]);

    const yoloFlag = await buildPassthroughArgs(
      "agy",
      ["--agy", "--yolo", "-p", "hi"],
      "--agy",
      uncheckedHistory,
    );
    expect(yoloFlag.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(1);
    expect(yoloFlag).not.toContain("--yolo");
    expect(yoloFlag.slice(-2)).toEqual(["-p", "hi"]);

    const yoloAndExplicit = await buildPassthroughArgs(
      "agy",
      ["agy", "--yolo", "--dangerously-skip-permissions", "-p", "hi"],
      "agy",
      checkedHistory,
    );
    expect(yoloAndExplicit.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(1);
    expect(yoloAndExplicit).not.toContain("--yolo");

    // Passing --no-skip-permissions strips both --no-skip-permissions and --dangerously-skip-permissions
    expect(
      await buildPassthroughArgs("agy", ["agy", "--no-skip-permissions", "-p", "hi"], "agy", noHistory),
    ).toEqual(["-p", "hi"]);
    expect(
      await buildPassthroughArgs(
        "agy",
        ["--agy", "--no-skip-permissions", "-p", "hi"],
        "--agy",
        checkedHistory,
      ),
    ).toEqual(["-p", "hi"]);
  });

  it("TC-SKIP03-02: real subprocess E2E via launchClientUnified(agyClient, ...) delivers both --dangerously-skip-permissions and --settings JSON to agy", async () => {
    if (process.platform === "win32") return;

    const tmp = makeTempDir("tako-qa-skip03-e2e-");
    const takoHome = join(tmp, "tako-home");
    const isolatedHome = join(tmp, "home");
    const tmpWorkDir = join(tmp, "workspace-alpha");
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(join(isolatedHome, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(tmpWorkDir, { recursive: true });

    const globalSettingsPath = join(isolatedHome, ".gemini", "antigravity-cli", "settings.json");
    const globalSettingsRaw = '{"trustedWorkspaces":["/preexisting/repo"],"model":"claude-opus-4-6"}\n';
    writeFileSync(globalSettingsPath, globalSettingsRaw, "utf8");
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_test_key",
        apiId: "test-id",
        telemetryEnabled: false,
        installedClients: {},
      }),
      "utf8",
    );

    const { fakeAgyBin, argvFile } = createFakeAgyExecutable(tmp);

    const script = `
      import "./src/clients";
      import { agyClient } from "./src/clients/agy";
      import { launchClientUnified } from "./src/launcher";

      const result = await launchClientUnified(agyClient, {
        args: ["--dangerously-skip-permissions"],
        projectPath: ${JSON.stringify(tmpWorkDir)},
        providerContext: {
          type: "custom",
          apiKey: "sk-test-e2e",
          baseUrl: "https://gateway.example.invalid/v1",
        },
      });
      console.log(JSON.stringify(result));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: isolatedHome,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: fakeAgyBin,
      },
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const launchRes = JSON.parse(stdout.trim().split("\n").pop()!) as { success: boolean };
    expect(launchRes.success).toBe(true);

    expect(existsSync(argvFile)).toBe(true);
    const captured = JSON.parse(readFileSync(argvFile, "utf8")) as {
      argv: string[];
      cwd: string;
    };

    expect(captured.argv).toContain("--dangerously-skip-permissions");
    const settingsIdx = captured.argv.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const rawSettingsJson = captured.argv[settingsIdx + 1];
    expect(typeof rawSettingsJson).toBe("string");

    const settingsPayload = JSON.parse(rawSettingsJson) as {
      allowNonWorkspaceAccess?: boolean;
      toolPermission?: string;
      trustedWorkspaces?: string[];
    };
    expect(settingsPayload.allowNonWorkspaceAccess).toBe(true);
    expect(settingsPayload.toolPermission).toBe("always-proceed");
    expect(settingsPayload.trustedWorkspaces).toContain(tmpWorkDir);
    expect(settingsPayload.trustedWorkspaces).toContain(realpathSync(tmpWorkDir));

    // User's global settings.json in HOME must remain untouched
    expect(readFileSync(globalSettingsPath, "utf8")).toBe(globalSettingsRaw);
  });

  it("TC-SKIP03-03: CLI E2E `tako agy -p hi` injects skip-permissions + --settings while `tako agy --no-skip-permissions -p hi` omits both", async () => {
    if (process.platform === "win32") return;

    const tmp = makeTempDir("tako-qa-skip03-cli-");
    const takoHome = join(tmp, "tako-home");
    const isolatedHome = join(tmp, "home");
    const tmpWorkDir = join(tmp, "workspace-cli");
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(tmpWorkDir, { recursive: true });

    const { fakeAgyBin, argvFile } = createFakeAgyExecutable(tmp);
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_test_key",
        apiId: "test-id",
        telemetryEnabled: false,
        installedClients: {},
        providers: [
          {
            id: "custom-agy",
            name: "Custom Gateway",
            type: "custom",
            apiKey: "sk-test-cli",
            baseUrl: "https://gateway.example.invalid/v1",
            supportedClients: ["agy"],
          },
        ],
        defaultProviderId: "custom-agy",
      }),
      "utf8",
    );

    const indexPath = join(REPO_ROOT, "src", "index.ts");
    const baseEnv = {
      ...process.env,
      HOME: isolatedHome,
      TAKO_HOME: takoHome,
      TAKO_DEV: "1",
      AGY_PATH: fakeAgyBin,
    };

    // 1. Default `tako agy -p hi`
    const p1 = Bun.spawn([process.execPath, indexPath, "agy", "-p", "hi"], {
      cwd: tmpWorkDir,
      stdout: "pipe",
      stderr: "pipe",
      env: baseEnv,
    });
    expect(await p1.exited).toBe(0);
    const cap1 = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[] };
    expect(cap1.argv).toContain("--dangerously-skip-permissions");
    expect(cap1.argv).toContain("--settings");
    expect(cap1.argv.slice(-2)).toEqual(["-p", "hi"]);

    rmSync(argvFile, { force: true });

    // 2. Opt-out `tako agy --no-skip-permissions -p hi`
    const p2 = Bun.spawn(
      [process.execPath, indexPath, "agy", "--no-skip-permissions", "-p", "hi"],
      {
        cwd: tmpWorkDir,
        stdout: "pipe",
        stderr: "pipe",
        env: baseEnv,
      },
    );
    expect(await p2.exited).toBe(0);
    const cap2 = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[] };
    expect(cap2.argv).toEqual(["-p", "hi"]);
  });
});

describe("SKIP-04: LauncherOptionsSection unfocused flag visibility & session-resume memory preservation", () => {
  it("TC-SKIP04-01: Ink renders '--dangerously-skip-permissions' in LauncherOptionsSection when skip-permissions is enabled even if unfocused (focusedArea=false)", async () => {
    const { buildAgyLaunchOptions } = await import("../src/clients/agy");
    const { buildOptionRows } = await import("../src/ui/shared/launch-options");
    const { LauncherOptionsSection } = await import("../src/ui/ink/views/LauncherChrome");

    const provider: Provider = {
      id: "custom-agy",
      name: "Custom Gateway",
      type: "custom",
      apiKey: "sk-test",
      baseUrl: "https://gateway.example.invalid/v1",
      supportedClients: ["agy"],
    };
    const options = buildAgyLaunchOptions(provider);
    const enabled = new Set<string>(["skip-permissions"]);

    for (const zh of [true, false]) {
      const optionRows = buildOptionRows(options, zh);
      const harness = createInkHarness(
        React.createElement(LauncherOptionsSection, {
          optionRows,
          options,
          enabled,
          focusedArea: false,
          optionIdx: 0,
          color: "green",
          currentProv: provider,
          provName: provider.name,
          zh,
        }),
      );
      try {
        const plain = stripAnsi(harness.getOutput());
        expect(plain).toContain("◉");
        expect(plain).toContain("--dangerously-skip-permissions");
      } finally {
        harness.unmount();
      }
    }
  });

  it("TC-SKIP04-02: recordProjectLaunch(projectPath, 'agy', undefined) and native agy session resume do not overwrite saved ['skip-permissions'] memory", async () => {
    if (process.platform === "win32") return;

    const tmp = makeTempDir("tako-qa-skip04-resume-");
    const takoHome = join(tmp, "tako-home");
    const isolatedHome = join(tmp, "home");
    const projectPath = join(tmp, "project-beta");
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    const { fakeAgyBin, argvFile } = createFakeAgyExecutable(tmp);

    // Seed isolated config with a custom provider so LauncherView & handleLaunchResult run offline
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_test_key",
        apiId: "test-id",
        telemetryEnabled: false,
        installedClients: {},
        providers: [
          {
            id: "custom-agy",
            name: "Custom Gateway",
            type: "custom",
            apiKey: "sk-test-resume",
            baseUrl: "https://gateway.example.invalid/v1",
            supportedClients: ["agy"],
          },
        ],
        defaultProviderId: "custom-agy",
      }),
      "utf8",
    );

    // Seed a native agy transcript inside isolatedHome for session search & resume
    const convId = "11111111-2222-3333-4444-555555555555";
    const transcriptDir = join(
      isolatedHome,
      ".gemini",
      "antigravity-cli",
      "brain",
      convId,
      ".system_generated",
      "logs",
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          source: "SYSTEM",
          type: "SYSTEM_PROMPT",
          created_at: "2026-11-18T10:00:00Z",
          content: `Active Workspaces:\n- ${projectPath}\nCommand Working Directory: ${projectPath}`,
        }),
        JSON.stringify({
          step_index: 1,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-11-18T10:01:00Z",
          content: "<USER_REQUEST>验证续接不冲掉 skip-permissions 记忆</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          model: "claude-opus-4-6",
          created_at: "2026-11-18T10:02:00Z",
          content: "好的，已记录。",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const script = `
      import React from "react";
      import { render } from "ink";
      import { PassThrough } from "node:stream";
      import "./src/clients";
      import { getLastSelectedOptionsForClient, recordProjectLaunch } from "./src/project-history";
      import { LauncherView } from "./src/ui/ink/views/LauncherView";
      import { handleLaunchResult } from "./src/ui/shared/launch";

      const projectPath = ${JSON.stringify(projectPath)};
      await recordProjectLaunch(projectPath, "agy", ["skip-permissions"]);
      const afterInitial = await getLastSelectedOptionsForClient("agy", projectPath);

      await recordProjectLaunch(projectPath, "agy", undefined);
      const afterUndefined = await getLastSelectedOptionsForClient("agy", projectPath);

      let output = "";
      let resumeResult = null;
      const stdout = new PassThrough();
      stdout.columns = 120;
      stdout.rows = 35;
      stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
      const stdin = new PassThrough();
      stdin.isTTY = true;
      stdin.setRawMode = () => stdin;
      stdin.ref = () => stdin;
      stdin.unref = () => stdin;

      const app = render(
        React.createElement(LauncherView, {
          initialSessionSearch: true,
          onResult: (res) => { resumeResult = res; },
        }),
        { stdout, stdin, debug: true, exitOnCtrlC: false },
      );

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !output.includes("验证续接不冲掉")) {
        await Bun.sleep(40);
      }
      stdin.write("\\r");
      const enterDeadline = Date.now() + 1500;
      while (Date.now() < enterDeadline && !resumeResult) {
        await Bun.sleep(25);
      }
      app.unmount();

      if (!resumeResult || resumeResult.type !== "launch") {
        throw new Error("Expected LauncherView session Enter to emit launch result, got: " + JSON.stringify(resumeResult));
      }

      await handleLaunchResult(resumeResult);
      const afterResume = await getLastSelectedOptionsForClient("agy", projectPath);

      console.log(JSON.stringify({
        afterInitial,
        afterUndefined,
        afterResume,
      }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: isolatedHome,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: fakeAgyBin,
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const summary = JSON.parse(stdout.trim().split("\n").pop()!) as {
      afterInitial: string[];
      afterUndefined: string[];
      afterResume: string[];
    };
    expect(summary.afterInitial).toEqual(["skip-permissions"]);
    expect(summary.afterUndefined).toEqual(["skip-permissions"]);
    expect(summary.afterResume).toEqual(["skip-permissions"]);

    expect(existsSync(argvFile)).toBe(true);
    const captured = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[] };
    expect(captured.argv).toContain("--dangerously-skip-permissions");
    expect(captured.argv).toContain("--settings");
    expect(captured.argv).toContain("--conversation");
    expect(captured.argv).toContain(convId);
  });
});

describe("SKIP-05: agy bottom statusLine rendering, config injection & skip-permissions integration", () => {
  it("TC-SKIP05-01: buildStatusLineCommand, buildAgyStatusLineConfig, injectAgyStatusLineConfig & removeAgyStatusLineConfig respect existing fields and custom statusLine", async () => {
    const injectMod = (await import("../src/statusline/inject")) as Record<string, unknown>;
    const statuslineMod = (await import("../src/statusline")) as Record<string, unknown>;

    const buildStatusLineCommand = (injectMod.buildStatusLineCommand ??
      statuslineMod.buildStatusLineCommand) as (() => string) | undefined;
    const buildAgyStatusLineConfig = (injectMod.buildAgyStatusLineConfig ??
      statuslineMod.buildAgyStatusLineConfig) as
      | (() => { type: string; command: string; stack_with_default: boolean })
      | undefined;
    const injectAgyStatusLineConfig = (injectMod.injectAgyStatusLineConfig ??
      statuslineMod.injectAgyStatusLineConfig) as ((agyHome?: string) => Promise<void>) | undefined;
    const removeAgyStatusLineConfig = (injectMod.removeAgyStatusLineConfig ??
      statuslineMod.removeAgyStatusLineConfig) as ((agyHome?: string) => Promise<void>) | undefined;

    expect(typeof buildStatusLineCommand).toBe("function");
    expect(typeof buildAgyStatusLineConfig).toBe("function");
    expect(typeof injectAgyStatusLineConfig).toBe("function");
    expect(typeof removeAgyStatusLineConfig).toBe("function");

    const prevVersion = process.env.VERSION;
    process.env.VERSION = "dev";
    try {
      const cmd = buildStatusLineCommand!();
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("statusline");

      const cfg = buildAgyStatusLineConfig!();
      expect(cfg).toMatchObject({
        type: "command",
        stack_with_default: true,
      });
      expect(typeof cfg.command).toBe("string");
      expect(cfg.command).toContain("statusline");

      // 1. Injects Tako statusLine while preserving model & trustedWorkspaces, then cleanly removes it
      const tmp = makeTempDir("tako-qa-skip05-inject-");
      const agyHome = join(tmp, "agy-home");
      mkdirSync(agyHome, { recursive: true });
      const settingsPath = join(agyHome, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            model: "claude-opus-4-6",
            trustedWorkspaces: ["/existing/repo-a", "/existing/repo-b"],
          },
          null,
          2,
        ),
        "utf8",
      );

      await injectAgyStatusLineConfig!(agyHome);
      const injected = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        model?: string;
        trustedWorkspaces?: string[];
        statusLine?: { type?: string; command?: string; stack_with_default?: boolean };
      };
      expect(injected.model).toBe("claude-opus-4-6");
      expect(injected.trustedWorkspaces).toEqual(["/existing/repo-a", "/existing/repo-b"]);
      expect(injected.statusLine).toBeDefined();
      expect(injected.statusLine?.type).toBe("command");
      expect(injected.statusLine?.stack_with_default).toBe(true);
      expect(injected.statusLine?.command).toContain("statusline");

      await removeAgyStatusLineConfig!(agyHome);
      const removed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        model?: string;
        trustedWorkspaces?: string[];
        statusLine?: unknown;
      };
      expect(removed.statusLine).toBeUndefined();
      expect(removed.model).toBe("claude-opus-4-6");
      expect(removed.trustedWorkspaces).toEqual(["/existing/repo-a", "/existing/repo-b"]);

      // 2. Never overwrites or removes a user's custom non-Tako statusLine
      const customAgyHome = join(tmp, "agy-home-custom");
      mkdirSync(customAgyHome, { recursive: true });
      const customSettingsPath = join(customAgyHome, "settings.json");
      const customStatusLine = { type: "command", command: "echo my-custom-bar" };
      writeFileSync(
        customSettingsPath,
        JSON.stringify(
          {
            model: "claude-sonnet-4-6",
            trustedWorkspaces: ["/custom/workspace"],
            statusLine: customStatusLine,
          },
          null,
          2,
        ),
        "utf8",
      );

      await injectAgyStatusLineConfig!(customAgyHome);
      const afterInjectCustom = JSON.parse(readFileSync(customSettingsPath, "utf8")) as {
        model?: string;
        trustedWorkspaces?: string[];
        statusLine?: unknown;
      };
      expect(afterInjectCustom.statusLine).toEqual(customStatusLine);
      expect(afterInjectCustom.model).toBe("claude-sonnet-4-6");
      expect(afterInjectCustom.trustedWorkspaces).toEqual(["/custom/workspace"]);

      await removeAgyStatusLineConfig!(customAgyHome);
      const afterRemoveCustom = JSON.parse(readFileSync(customSettingsPath, "utf8")) as {
        statusLine?: unknown;
      };
      expect(afterRemoveCustom.statusLine).toEqual(customStatusLine);
    } finally {
      if (prevVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = prevVersion;
    }
  });

  it("TC-SKIP05-02: renderStatusLine & statusLineUsageTokens support agy 1.5.12 input protocol, PLANNER_RESPONSE transcript tokens, 'Opus 4.6', and total_input_tokens fallback", async () => {
    const tmp = makeTempDir("tako-qa-skip05-render-");
    const takoHome = join(tmp, "tako-home");
    const isolatedHome = join(tmp, "home");
    const tmpWorkDir = join(tmp, "agy-statusline-repo");
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(tmpWorkDir, { recursive: true });

    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "",
        apiId: "",
        telemetryEnabled: false,
        installedClients: {},
        providers: [],
      }),
      "utf8",
    );

    const agyTranscriptPath = join(tmp, "transcript.jsonl");
    writeFileSync(
      agyTranscriptPath,
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content: "<USER_REQUEST>hello</USER_REQUEST>",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          input_tokens: 40000,
          cache_read_tokens: 10000,
          output_tokens: 500,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const missingTranscriptPath = join(tmp, "non-existent-transcript.jsonl");

    const script = `
      delete process.env.TAKO_MODEL_CONTEXT_WINDOW;
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

      import { renderStatusLine } from "./src/statusline";
      import { statusLineUsageTokens } from "./src/statusline/segments/context";

      const transcriptInput = {
        product: "antigravity",
        cwd: ${JSON.stringify(tmpWorkDir)},
        workspace: { current_dir: ${JSON.stringify(tmpWorkDir)} },
        model: { id: "claude-opus-4-6", display_name: "claude-opus-4-6" },
        transcript_path: ${JSON.stringify(agyTranscriptPath)},
        context_window: {
          total_input_tokens: 0,
          total_output_tokens: 0,
          context_window_size: 200000,
          used_percentage: 0,
          remaining_percentage: 100,
          current_usage: null,
        },
      };

      const renderedFromTranscript = await renderStatusLine(transcriptInput);

      const fallbackInput = {
        product: "antigravity",
        cwd: ${JSON.stringify(tmpWorkDir)},
        workspace: { current_dir: ${JSON.stringify(tmpWorkDir)} },
        model: { id: "claude-opus-4-6", display_name: "claude-opus-4-6" },
        transcript_path: ${JSON.stringify(missingTranscriptPath)},
        context_window: {
          total_input_tokens: 30000,
          total_output_tokens: 400,
          context_window_size: 200000,
          used_percentage: 15,
          remaining_percentage: 85,
          current_usage: null,
        },
      };

      const usageTokens30k = statusLineUsageTokens(fallbackInput);
      const renderedFromTotalInput = await renderStatusLine(fallbackInput);

      console.log(JSON.stringify({
        renderedFromTranscript,
        usageTokens30k,
        renderedFromTotalInput,
      }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: isolatedHome,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim().split("\n").pop()!) as {
      renderedFromTranscript: string;
      usageTokens30k: number | null;
      renderedFromTotalInput: string;
    };

    const plainTranscriptLine = stripAnsi(parsed.renderedFromTranscript);
    expect(plainTranscriptLine).toContain("agy-statusline-repo");
    expect(plainTranscriptLine).toContain("Opus 4.6");
    expect(plainTranscriptLine).not.toContain("100%");
    // 50,000 tokens (40k input + 10k cache_read) out of 200k window:
    // auto-compact threshold (167k) => ceil(117/167*100) = 71%; raw 200k => 75%.
    const pct50kMatch = plainTranscriptLine.match(/\b(\d+)%/);
    expect(pct50kMatch).not.toBeNull();
    expect(["71%", "75%"]).toContain(pct50kMatch![0]);

    // Fallback when transcript_path is absent and total_input_tokens = 30000
    expect(parsed.usageTokens30k).toBe(30000);
    const plainFallbackLine = stripAnsi(parsed.renderedFromTotalInput);
    expect(plainFallbackLine).toContain("agy-statusline-repo");
    expect(plainFallbackLine).toContain("Opus 4.6");
    expect(plainFallbackLine).not.toContain("100%");
    // 30,000 tokens out of 200k window: auto-compact threshold (167k) => 83%; raw 200k => 85%.
    const pct30kMatch = plainFallbackLine.match(/\b(\d+)%/);
    expect(pct30kMatch).not.toBeNull();
    expect(["83%", "85%"]).toContain(pct30kMatch![0]);
  });

  it("TC-SKIP05-03: buildAgySkipPermissionsSettings embeds statusLine with stack_with_default: true when user has no custom statusLine", async () => {
    const agyMod = (await import("../src/clients/agy")) as Record<string, unknown>;
    expect(typeof agyMod.buildAgySkipPermissionsSettings).toBe("function");

    const buildAgySkipPermissionsSettings = agyMod.buildAgySkipPermissionsSettings as (
      workingDir: string,
      agyHome?: string,
    ) => string;

    const prevVersion = process.env.VERSION;
    process.env.VERSION = "dev";
    try {
      const tmp = makeTempDir("tako-qa-skip05-skipsettings-");
      const agyHome = join(tmp, "agy-home");
      const tmpWorkDir = join(tmp, "work");
      mkdirSync(agyHome, { recursive: true });
      mkdirSync(tmpWorkDir, { recursive: true });

      writeFileSync(
        join(agyHome, "settings.json"),
        JSON.stringify({ model: "claude-opus-4-6", trustedWorkspaces: ["/existing/repo"] }),
        "utf8",
      );

      const parsed = JSON.parse(buildAgySkipPermissionsSettings(tmpWorkDir, agyHome)) as {
        statusLine?: { type?: string; command?: string; stack_with_default?: boolean };
      };
      expect(parsed.statusLine).toBeDefined();
      expect(parsed.statusLine?.stack_with_default).toBe(true);
      expect(typeof parsed.statusLine?.command).toBe("string");
      expect(parsed.statusLine?.command).toContain("statusline");

      // If user has a custom non-Tako statusLine in settings.json, do not override it with Tako's command
      const customHome = join(tmp, "agy-home-custom");
      mkdirSync(customHome, { recursive: true });
      writeFileSync(
        join(customHome, "settings.json"),
        JSON.stringify({
          model: "claude-opus-4-6",
          statusLine: { type: "command", command: "echo my-custom-bar" },
        }),
        "utf8",
      );
      const parsedCustom = JSON.parse(buildAgySkipPermissionsSettings(tmpWorkDir, customHome)) as {
        statusLine?: { command?: string };
      };
      if (parsedCustom.statusLine !== undefined) {
        expect(parsedCustom.statusLine.command).toBe("echo my-custom-bar");
      }
    } finally {
      if (prevVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = prevVersion;
    }
  });
});
