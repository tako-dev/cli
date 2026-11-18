import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/clients";
import { getAllClients, getClient, getClientLaunchOptions } from "../src/clients/base";
import {
  AGY_CONFLICTING_ENV_KEYS,
  AgyClient,
  agyClient,
  agyStandardCandidates,
  buildAgyArgs,
  findAgyBinary,
  normalizeAgyGatewayUrl,
  normalizeAgyModelId,
  parseAgyVersion,
  prepareAgyEnv,
  resolveAgyApiKey,
  resolveAgyGatewayUrl,
} from "../src/clients/agy";
import {
  computeFileSha512,
  installAgy,
  installAgyFromManifest,
  isDirOnPath,
  resolveAgyInstallTarget,
  resolveAgyManifestUrl,
  resolveAgyPlatform,
} from "../src/installer";
import { buildPassthroughArgs } from "../src/quick-launch-args";
import { buildWindowsHandoffScript } from "../src/windows-handoff";
import { _resetTakoCatalog, _setCachePathForTest } from "../src/models/tako";
import type { Provider } from "../src/providers/types";

describe("Antigravity (agy) client registration", () => {
  it("registers AgyClient cleanly in the visible launcher list", () => {
    const ids = getAllClients().map((c) => c.id);
    expect(ids).toContain("agy");
    expect(AgyClient).toBe(agyClient);
    expect(getClient("agy")?.name).toBe("Antigravity (agy)");
    expect(getClient("agy")?.install).toBe("system");
    expect(getClient("agy")?.runtime).toBe("native");
    expect(getClient("agy")?.oneClickInstall).toBe(true);
    expect(getClient("agy")?.unsetEnvVars).toEqual(AGY_CONFLICTING_ENV_KEYS);
  });

  it("parses agy --version output", () => {
    expect(parseAgyVersion("1.5.11\n")).toBe("1.5.11");
    expect(parseAgyVersion("agy version 1.5.11-beta.1")).toBe("1.5.11-beta.1");
    expect(parseAgyVersion("unknown")).toBeNull();
  });
});

describe("Antigravity binary resolution", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-bin-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists expected standard locations on macOS/Linux and Windows", () => {
    expect(agyStandardCandidates("/Users/alice", "darwin", {})).toEqual([
      "/Users/alice/.local/bin/agy",
      "/Users/alice/.gemini/bin/agy",
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ]);

    expect(
      agyStandardCandidates("C:\\Users\\Alice", "win32", {
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      }),
    ).toEqual([
      "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe",
      "C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe",
      "C:\\Users\\Alice\\.local\\bin\\agy.exe",
    ]);
  });

  it("resolves AGY_PATH first, then PATH, then standard install paths", async () => {
    const explicitBin = join(tmp, "custom", "agy");
    const pathDir = join(tmp, "path-bin");
    const pathBin = join(pathDir, "agy");
    const homeDir = join(tmp, "home");
    const localBin = join(homeDir, ".local", "bin", "agy");

    mkdirSync(join(tmp, "custom"), { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });

    for (const p of [explicitBin, pathBin, localBin]) {
      writeFileSync(p, "#!/bin/sh\necho 1.5.11\n");
      chmodSync(p, 0o755);
    }

    // 1. AGY_PATH wins over PATH and ~/.local/bin
    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: explicitBin, PATH: pathDir },
      }),
    ).toBe(explicitBin);

    // 2. Invalid AGY_PATH falls through to PATH
    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: join(tmp, "missing-agy"), PATH: pathDir },
      }),
    ).toBe(pathBin);

    // 3. Empty PATH falls through to ~/.local/bin/agy
    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { PATH: join(tmp, "empty-dir") },
      }),
    ).toBe(localBin);
  });

  it("resolves Windows %LOCALAPPDATA%\\agy\\bin\\agy.exe when not on PATH", async () => {
    const localAppData = join(tmp, "LocalAppData");
    const winBin = join(localAppData, "agy", "bin", "agy.exe");
    mkdirSync(join(localAppData, "agy", "bin"), { recursive: true });
    writeFileSync(winBin, "MZ-mock");

    expect(
      await findAgyBinary({
        platform: "win32",
        home: join(tmp, "win-home"),
        env: { LOCALAPPDATA: localAppData, PATH: "" },
      }),
    ).toBe(winBin);
  });
});

describe("Antigravity environment & gateway URL preparation", () => {
  it("strips trailing slashes and /v1 or /v1beta suffixes from gateway URL", () => {
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1/")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1beta")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1beta/")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech///")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("http://127.0.0.1:9000/gw/v1")).toBe("http://127.0.0.1:9000/gw");
    expect(normalizeAgyGatewayUrl("http://127.0.0.1:9000/v10")).toBe("http://127.0.0.1:9000/v10");

    expect(
      resolveAgyGatewayUrl("https://tako.shiroha.tech/v1", {
        TAKO_AGY_GATEWAY_URL: "https://override.example.test/v1beta/",
      }),
    ).toBe("https://override.example.test");
  });

  it("computes gateway API key with TAKO_AGY_API_KEY > agyApiKey > apiKey precedence", () => {
    expect(
      resolveAgyApiKey({ agyApiKey: "cr_agy_cfg", apiKey: "cr_main" }, "cr_fallback", {
        TAKO_AGY_API_KEY: "cr_env_override",
      }),
    ).toBe("cr_env_override");

    expect(
      resolveAgyApiKey({ agyApiKey: "cr_agy_cfg", apiKey: "cr_main" }, "cr_fallback", {}),
    ).toBe("cr_agy_cfg");

    expect(
      resolveAgyApiKey({ apiKey: "cr_main" }, "cr_fallback", {}),
    ).toBe("cr_main");

    expect(resolveAgyApiKey({}, "cr_fallback", {})).toBe("cr_fallback");
  });

  it("clones baseEnv, deletes all conflicting Gemini/Google/AICode vars, and sets AGY_LLM_GATEWAY_*", () => {
    const parentEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/dev",
      GOOGLE_GEMINI_BASE_URL: "https://conflict.gemini.example",
      GEMINI_API_KEY: "conflict-gemini-key",
      GOOGLE_API_KEY: "conflict-google-key",
      AICODE_ENDPOINT_URL: "https://conflict.aicode.example",
    };

    const childEnv = prepareAgyEnv(parentEnv, {
      baseUrl: "https://tako.shiroha.tech/v1/",
      apiKey: "cr_main_key",
      agyApiKey: "cr_dedicated_agy_key",
    });

    // Original parentEnv untouched
    expect(parentEnv.GEMINI_API_KEY).toBe("conflict-gemini-key");

    // Conflicting keys completely deleted (not empty strings)
    for (const conflictKey of AGY_CONFLICTING_ENV_KEYS) {
      expect(Object.hasOwn(childEnv, conflictKey)).toBe(false);
    }

    expect(childEnv.PATH).toBe("/usr/bin:/bin");
    expect(childEnv.AGY_LLM_GATEWAY_URL).toBe("https://tako.shiroha.tech");
    expect(childEnv.AGY_LLM_GATEWAY_API_KEY).toBe("cr_dedicated_agy_key");
  });

  it("emits Remove-Item for conflicting env vars in Windows PowerShell handoff scripts", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe"],
      cwd: "C:\\work",
      unsetEnv: agyClient.unsetEnvVars,
      env: {
        AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
        AGY_LLM_GATEWAY_API_KEY: "cr_test",
      },
    });
    for (const key of AGY_CONFLICTING_ENV_KEYS) {
      expect(script).toContain(`Remove-Item -Path Env:${key} -ErrorAction SilentlyContinue`);
    }
    expect(script).toContain("$env:AGY_LLM_GATEWAY_URL = 'https://tako.shiroha.tech'");
  });
});

describe("Antigravity models, dangerous flag & quick-launch args", () => {
  let tmpDir: string;
  const BASE = "https://agy-models.example.test";
  const KEY = "cr_agy_models";
  const FP = createHash("sha256").update(KEY).digest("hex");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-agy-models-"));
    _setCachePathForTest(join(tmpDir, "models-cache.json"));
    _resetTakoCatalog();
    writeFileSync(
      join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE}#gemini#${FP}`]: {
            fetchedAt: Date.now(),
            entries: [
              {
                id: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                description: "Pro reasoning model",
                contextWindow: 1048576,
                sortOrder: 0,
                category: "chat",
              },
              {
                id: "gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                description: "Fast model",
                contextWindow: 1048576,
                sortOrder: 1,
                category: "chat",
              },
            ],
          },
        },
      }),
    );
  });

  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips models/ prefix in normalizeAgyModelId and buildAgyArgs", () => {
    expect(normalizeAgyModelId("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeAgyModelId("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(
      buildAgyArgs({ model: "models/gemini-2.5-pro", skipPermissions: true, extraArgs: ["-c"] }),
    ).toEqual(["--dangerously-skip-permissions", "--model", "gemini-2.5-pro", "-c"]);
  });

  it("exposes skip-permissions and stripped Gemini model options even when provider baseUrl has /v1", () => {
    const prov: Provider = {
      id: "p-agy",
      name: "Tako",
      type: "tako",
      baseUrl: `${BASE}/v1`,
      apiKey: "cr_unused_main",
      agyApiKey: KEY,
      createdAt: "2026-11-18T00:00:00.000Z",
    };

    const options = getClientLaunchOptions(agyClient, prov);
    expect(options[0]?.id).toBe("skip-permissions");
    expect(options[0]?.args).toEqual(["--dangerously-skip-permissions"]);
    expect(options[0]?.defaultOn).toBe(true);

    const modelOpts = options.filter((o) => o.group === "model");
    expect(modelOpts.map((o) => o.id)).toEqual(["model-gemini-2.5-pro", "model-gemini-2.5-flash"]);
    expect(modelOpts[0]?.args).toEqual(["--model", "gemini-2.5-pro"]);
  });

  it("wires --agy passthrough args with inherited --dangerously-skip-permissions and model normalization", async () => {
    expect(
      await buildPassthroughArgs("agy", ["--agy", "--model", "models/gemini-2.5-pro"], "--agy", {
        getLastSelectedOptionIds: async () => [],
      }),
    ).toEqual(["--dangerously-skip-permissions", "--model", "gemini-2.5-pro"]);

    expect(
      await buildPassthroughArgs("agy", ["--agy", "--model=models/gemini-2.5-flash"], "--agy", {
        getLastSelectedOptionIds: async () => ["model-gemini-2.5-flash"],
      }),
    ).toEqual(["--model=gemini-2.5-flash"]);

    expect(
      await buildPassthroughArgs("agy", ["--agy", "--dangerously-skip-permissions"], "--agy", {
        getLastSelectedOptionIds: async () => ["skip-permissions"],
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("Antigravity cross-platform one-click installer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-install-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps platform and arch to official manifest keys including linux musl", () => {
    expect(resolveAgyPlatform("darwin", "arm64")).toBe("darwin_arm64");
    expect(resolveAgyPlatform("darwin", "x64")).toBe("darwin_amd64");
    expect(resolveAgyPlatform("linux", "x64", { isMusl: false })).toBe("linux_amd64");
    expect(resolveAgyPlatform("linux", "arm64", { isMusl: false })).toBe("linux_arm64");
    expect(resolveAgyPlatform("linux", "x64", { isMusl: true })).toBe("linux_amd64_musl");
    expect(resolveAgyPlatform("linux", "arm64", { isMusl: true })).toBe("linux_arm64_musl");
    expect(resolveAgyPlatform("win32", "x64")).toBe("windows_amd64");
    expect(resolveAgyPlatform("win32", "arm64")).toBe("windows_arm64");
    expect(() => resolveAgyPlatform("freebsd" as NodeJS.Platform, "x64")).toThrow();
    expect(() => resolveAgyPlatform("darwin", "ia32")).toThrow();
  });

  it("resolves manifest URL and target path across Unix and Windows", () => {
    expect(
      resolveAgyManifestUrl({
        platform: "darwin",
        arch: "arm64",
        env: { AGY_INSTALL_MANIFEST_BASE: "http://127.0.0.1:19999/manifests/" },
      }),
    ).toBe("http://127.0.0.1:19999/manifests/darwin_arm64.json");

    expect(
      resolveAgyInstallTarget({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
      }),
    ).toEqual({
      binDir: "/Users/alice/.local/bin",
      binPath: "/Users/alice/.local/bin/agy",
    });

    expect(
      resolveAgyInstallTarget({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      }),
    ).toEqual({
      binDir: "C:\\Users\\Alice\\AppData\\Local\\agy\\bin",
      binPath: "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe",
    });

    expect(isDirOnPath("/Users/alice/.local/bin", "/usr/bin:/Users/alice/.local/bin/", "darwin")).toBe(true);
    expect(isDirOnPath("/Users/alice/.local/bin", "/usr/bin:/bin", "darwin")).toBe(false);
  });

  it("installs Unix .tar.gz and Windows .exe from local mock HTTP server and rejects sha512 mismatch", async () => {
    // Build a real .tar.gz containing an `antigravity` executable
    const pkgSrc = join(tmp, "pkg-src");
    mkdirSync(pkgSrc, { recursive: true });
    const mockBinaryBody = "#!/bin/sh\necho '1.5.11'\n";
    writeFileSync(join(pkgSrc, "antigravity"), mockBinaryBody, { mode: 0o755 });

    const tarballPath = join(tmp, "cli_mac_arm64.tar.gz");
    const tarRes = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", pkgSrc, "antigravity"]);
    expect(tarRes.exitCode).toBe(0);
    const tarballSha512 = await computeFileSha512(tarballPath);

    const winExePath = join(tmp, "cli_windows_x64.exe");
    writeFileSync(winExePath, "MZ-mock-antigravity-exe");
    const winSha512 = await computeFileSha512(winExePath);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/manifests/darwin_arm64.json") {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: tarballSha512,
          });
        }
        if (url.pathname === "/manifests/bad_sha.json") {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: "0".repeat(128),
          });
        }
        if (url.pathname === "/files/cli_mac_arm64.tar.gz") {
          return new Response(Bun.file(tarballPath));
        }
        if (url.pathname === "/files/cli_windows_x64.exe") {
          return new Response(Bun.file(winExePath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const base = `http://127.0.0.1:${server.port}/manifests`;

      // 1. Successful Unix install via installAgy + AGY_INSTALL_MANIFEST_BASE
      const unixTarget = join(tmp, "unix-target");
      const res = await installAgy({
        platform: "darwin",
        arch: "arm64",
        targetDir: unixTarget,
        env: { AGY_INSTALL_MANIFEST_BASE: base, PATH: "/usr/bin:/bin" },
        quiet: true,
      });
      expect(res.success).toBe(true);
      expect(res.version).toBe("1.5.11");
      expect(res.binPath).toBe(join(unixTarget, "agy"));
      expect(readFileSync(join(unixTarget, "agy"), "utf-8")).toBe(mockBinaryBody);
      expect(statSync(join(unixTarget, "agy")).mode & 0o111).toBeGreaterThan(0);

      // 2. Successful Windows .exe install via installAgyFromManifest
      const winTarget = join(tmp, "win-target");
      const winRes = await installAgyFromManifest(
        {
          version: "1.5.11",
          url: `http://127.0.0.1:${server.port}/files/cli_windows_x64.exe`,
          sha512: winSha512,
        },
        {
          platform: "win32",
          targetDir: winTarget,
          env: { PATH: "" },
          quiet: true,
        },
      );
      expect(winRes.binPath).toBe(join(winTarget, "agy.exe"));
      expect(readFileSync(join(winTarget, "agy.exe"), "utf-8")).toBe("MZ-mock-antigravity-exe");

      // 3. SHA-512 mismatch aborts cleanly without writing target binary
      const badTarget = join(tmp, "bad-target");
      await expect(
        installAgyFromManifest(
          {
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: "f".repeat(128),
          },
          {
            platform: "darwin",
            targetDir: badTarget,
            env: { PATH: "/usr/bin" },
            quiet: true,
          },
        ),
      ).rejects.toThrow(/sha512/i);
      expect(existsSync(join(badTarget, "agy"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("runs end-to-end CLI `tako install agy` and `tako --agy` with isolated env and config", async () => {
    const fakeHome = join(tmp, "e2e-home");
    const takoHome = join(tmp, "e2e-tako");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(takoHome, { recursive: true });

    // Create a mock `antigravity` script that prints env + argv JSON when invoked
    const pkgSrc = join(tmp, "e2e-pkg");
    mkdirSync(pkgSrc, { recursive: true });
    const dumpFile = join(tmp, "agy-dump.json");
    const mockScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("1.5.11");
  process.exit(0);
}
writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  AGY_LLM_GATEWAY_URL: process.env.AGY_LLM_GATEWAY_URL ?? null,
  AGY_LLM_GATEWAY_API_KEY: process.env.AGY_LLM_GATEWAY_API_KEY ?? null,
  hasGeminiBase: Object.hasOwn(process.env, "GOOGLE_GEMINI_BASE_URL"),
  hasGeminiKey: Object.hasOwn(process.env, "GEMINI_API_KEY"),
  hasGoogleKey: Object.hasOwn(process.env, "GOOGLE_API_KEY"),
  hasAicodeUrl: Object.hasOwn(process.env, "AICODE_ENDPOINT_URL"),
}));
`;
    writeFileSync(join(pkgSrc, "antigravity"), mockScript, { mode: 0o755 });
    const tarballPath = join(tmp, "e2e_agy.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tarballPath, "-C", pkgSrc, "antigravity"]).exitCode).toBe(0);
    const sha512 = await computeFileSha512(tarballPath);
    const platformKey = resolveAgyPlatform();

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/manifests/${platformKey}.json`) {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/e2e_agy.tar.gz`,
            sha512,
          });
        }
        if (url.pathname === "/e2e_agy.tar.gz") {
          return new Response(Bun.file(tarballPath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
      const shimBin = join(tmp, "shim-bin");
      mkdirSync(shimBin, { recursive: true });
      symlinkSync(process.execPath, join(shimBin, "bun"));
      const isolatedPath = `${shimBin}:/usr/bin:/bin`;

      // Step 1: `tako install agy` installs into fakeHome/.local/bin/agy
      const installProc = Bun.spawn([process.execPath, cliEntry, "install", "agy"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: fakeHome,
          TAKO_HOME: takoHome,
          TAKO_DEV: "1",
          AGY_INSTALL_MANIFEST_BASE: `http://127.0.0.1:${server.port}/manifests`,
          PATH: isolatedPath,
        },
      });
      const installOut = `${await new Response(installProc.stdout).text()}\n${await new Response(installProc.stderr).text()}`;
      expect(await installProc.exited).toBe(0);
      expect(existsSync(join(fakeHome, ".local", "bin", "agy"))).toBe(true);
      expect(installOut).toContain("tako --agy");

      // Step 2: Write Tako config with both apiKey and dedicated agyApiKey + /v1 baseUrl
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "cr_claude_main",
          agyApiKey: "cr_agy_dedicated",
          apiId: "uuid-e2e",
          installedClients: {},
          providers: [
            {
              id: "prov-1",
              name: "Tako",
              type: "tako",
              apiKey: "cr_claude_main",
              baseUrl: "https://tako.shiroha.tech/v1",
              createdAt: "2026-11-18T00:00:00.000Z",
              builtin: true,
            },
          ],
          defaultProviderId: "prov-1",
        }),
      );

      // Step 3: `tako --agy --model models/gemini-2.5-pro -p hi`
      const launchProc = Bun.spawn(
        [process.execPath, cliEntry, "--agy", "--model", "models/gemini-2.5-pro", "-p", "hi"],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: fakeHome,
            TAKO_HOME: takoHome,
            TAKO_DEV: "1",
            GOOGLE_GEMINI_BASE_URL: "https://polluted.example",
            GEMINI_API_KEY: "polluted-gemini",
            GOOGLE_API_KEY: "polluted-google",
            AICODE_ENDPOINT_URL: "https://polluted.aicode",
            PATH: isolatedPath,
          },
        },
      );
      expect(await launchProc.exited).toBe(0);
      const dumped = JSON.parse(readFileSync(dumpFile, "utf-8"));
      expect(dumped).toEqual({
        argv: ["--dangerously-skip-permissions", "--model", "gemini-2.5-pro", "-p", "hi"],
        AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
        AGY_LLM_GATEWAY_API_KEY: "cr_agy_dedicated",
        hasGeminiBase: false,
        hasGeminiKey: false,
        hasGoogleKey: false,
        hasAicodeUrl: false,
      });
    } finally {
      server.stop(true);
    }
  });
});
