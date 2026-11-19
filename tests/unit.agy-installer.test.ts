import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/clients";
import {
  AGY_CONFLICTING_ENV_KEYS,
  agyClient,
  buildAgySkipPermissionsSettings,
  DEFAULT_AGY_GATEWAY_MODELS,
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
    const pkgSrc = join(tmp, "pkg-src");
    mkdirSync(pkgSrc, { recursive: true });
    const mockBinaryBody = "#!/bin/sh\necho '1.5.11'\n";
    writeFileSync(join(pkgSrc, "antigravity"), mockBinaryBody, { mode: 0o755 });

    const tarballPath = join(tmp, "cli_mac_arm64.tar.gz");
    const tarRes = Bun.spawnSync(["tar", "-czf", "../cli_mac_arm64.tar.gz", "antigravity"], {
      cwd: pkgSrc,
    });
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
      if (process.platform !== "win32") {
        expect(statSync(join(unixTarget, "agy")).mode & 0o111).toBeGreaterThan(0);
      }

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
    const isWin = process.platform === "win32";
    const fakeHome = join(tmp, "e2e-home");
    const fakeLocalAppData = join(tmp, "e2e-localappdata");
    const takoHome = join(tmp, "e2e-tako");
    const launchCwd = join(tmp, "e2e-workspace");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeLocalAppData, { recursive: true });
    mkdirSync(takoHome, { recursive: true });
    mkdirSync(launchCwd, { recursive: true });

    const pkgSrc = join(tmp, "e2e-pkg");
    mkdirSync(pkgSrc, { recursive: true });
    const dumpFile = join(tmp, "agy-dump.json");
    const platformKey = resolveAgyPlatform();

    let payloadPath: string;
    let payloadRoute: string;
    if (isWin) {
      payloadPath = join(tmp, "e2e_agy.exe");
      payloadRoute = "/e2e_agy.exe";
      writeFileSync(payloadPath, "MZ-mock-antigravity-exe");
    } else {
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
  AGY_LLM_GATEWAY_MODELS: process.env.AGY_LLM_GATEWAY_MODELS ?? null,
  AGY_LLM_GATEWAY_TIER_PRO: process.env.AGY_LLM_GATEWAY_TIER_PRO ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH: process.env.AGY_LLM_GATEWAY_TIER_FLASH ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH_LITE: process.env.AGY_LLM_GATEWAY_TIER_FLASH_LITE ?? null,
  hasGeminiBase: Object.hasOwn(process.env, "GOOGLE_GEMINI_BASE_URL"),
  hasGeminiKey: Object.hasOwn(process.env, "GEMINI_API_KEY"),
  hasGoogleKey: Object.hasOwn(process.env, "GOOGLE_API_KEY"),
  hasAicodeUrl: Object.hasOwn(process.env, "AICODE_ENDPOINT_URL"),
}));
`;
      writeFileSync(join(pkgSrc, "antigravity"), mockScript, { mode: 0o755 });
      payloadPath = join(tmp, "e2e_agy.tar.gz");
      payloadRoute = "/e2e_agy.tar.gz";
      expect(
        Bun.spawnSync(["tar", "-czf", "../e2e_agy.tar.gz", "antigravity"], { cwd: pkgSrc }).exitCode,
      ).toBe(0);
    }
    const sha512 = await computeFileSha512(payloadPath);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/manifests/${platformKey}.json`) {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}${payloadRoute}`,
            sha512,
          });
        }
        if (url.pathname === payloadRoute) {
          return new Response(Bun.file(payloadPath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
      let isolatedPath: string;
      if (isWin) {
        const sysRoot = process.env.SystemRoot || "C:\\Windows";
        isolatedPath = `${sysRoot}\\System32;${sysRoot}`;
      } else {
        const shimBin = join(tmp, "shim-bin");
        mkdirSync(shimBin, { recursive: true });
        symlinkSync(process.execPath, join(shimBin, "bun"));
        isolatedPath = `${shimBin}:/usr/bin:/bin`;
      }

      const expectedBin = isWin
        ? join(fakeLocalAppData, "agy", "bin", "agy.exe")
        : join(fakeHome, ".local", "bin", "agy");

      const cleanParentEnv: Record<string, string | undefined> = { ...process.env };
      delete cleanParentEnv.Path;
      delete cleanParentEnv.AGY_PATH;
      delete cleanParentEnv.AGY_HOME;
      delete cleanParentEnv.AGY_INSTALL_DIR;
      delete cleanParentEnv.TAKO_AGY_API_KEY;
      delete cleanParentEnv.TAKO_AGY_GATEWAY_URL;
      delete cleanParentEnv.AGY_LLM_GATEWAY_URL;
      delete cleanParentEnv.AGY_LLM_GATEWAY_API_KEY;
      delete cleanParentEnv.AGY_LLM_GATEWAY_MODELS;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_PRO;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_FLASH;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE;
      for (const proxyKey of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        delete cleanParentEnv[proxyKey];
      }

      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "",
          apiId: "",
          telemetryEnabled: false,
          installedClients: {},
        }),
      );

      const installProc = Bun.spawn([process.execPath, cliEntry, "install", "agy"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...cleanParentEnv,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          LOCALAPPDATA: fakeLocalAppData,
          TAKO_HOME: takoHome,
          TAKO_DEV: "1",
          AGY_INSTALL_MANIFEST_BASE: `http://127.0.0.1:${server.port}/manifests`,
          PATH: isolatedPath,
        },
      });
      const installOut = `${await new Response(installProc.stdout).text()}\n${await new Response(installProc.stderr).text()}`;
      expect(await installProc.exited).toBe(0);
      expect(existsSync(expectedBin)).toBe(true);
      expect(installOut).toContain("tako --agy");

      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "cr_claude_main",
          agyApiKey: "cr_agy_dedicated",
          apiId: "uuid-e2e",
          telemetryEnabled: false,
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

      const handoffFile = join(tmp, "win-handoff.ps1");
      const launchProc = Bun.spawn(
        [process.execPath, cliEntry, "--agy", "--model", "models/gemini-2.5-pro", "-p", "hi"],
        {
          cwd: launchCwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...cleanParentEnv,
            HOME: fakeHome,
            USERPROFILE: fakeHome,
            LOCALAPPDATA: fakeLocalAppData,
            TAKO_HOME: takoHome,
            TAKO_DEV: "1",
            ...(isWin ? { TAKO_WINDOWS_HANDOFF_FILE: handoffFile } : {}),
            GOOGLE_GEMINI_BASE_URL: "https://polluted.example",
            GEMINI_API_KEY: "polluted-gemini",
            GOOGLE_API_KEY: "polluted-google",
            AICODE_ENDPOINT_URL: "https://polluted.aicode",
            PATH: isolatedPath,
          },
        },
      );
      const launchStdout = await new Response(launchProc.stdout).text();
      expect(await launchProc.exited).toBe(0);
      expect(launchStdout).toContain("(--dangerously-skip-permissions)");

      if (isWin) {
        const handoffText = readFileSync(handoffFile, "utf-8");
        expect(handoffText).toContain(expectedBin.replace(/'/g, "''"));
        expect(handoffText).toContain("'--settings'");
        expect(handoffText).toContain("'--dangerously-skip-permissions', '--model', 'gemini-2.5-pro', '-p', 'hi'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_URL = 'https://tako.shiroha.tech'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_API_KEY = 'cr_agy_dedicated'");
        expect(handoffText).toContain(`$env:AGY_LLM_GATEWAY_MODELS = '${DEFAULT_AGY_GATEWAY_MODELS.join(",")}'`);
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_PRO = 'claude-opus-4-6'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_FLASH = 'claude-sonnet-4-6'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_FLASH_LITE = 'gemini-3.5-flash-lite'");
        for (const conflictKey of AGY_CONFLICTING_ENV_KEYS) {
          expect(handoffText).toContain(`Remove-Item -Path Env:${conflictKey} -ErrorAction SilentlyContinue`);
        }
      } else {
        const dumped = JSON.parse(readFileSync(dumpFile, "utf-8"));
        const expectedSettings = JSON.parse(
          buildAgySkipPermissionsSettings(launchCwd, join(fakeHome, ".gemini", "antigravity-cli")),
        );
        expect(dumped.argv.slice(2)).toEqual(["--dangerously-skip-permissions", "--model", "gemini-2.5-pro", "-p", "hi"]);
        expect(dumped.argv[0]).toBe("--settings");
        expect(JSON.parse(dumped.argv[1])).toMatchObject({
          allowNonWorkspaceAccess: true,
          toolPermission: "always-proceed",
        });
        for (const ws of expectedSettings.trustedWorkspaces) {
          expect(JSON.parse(dumped.argv[1]).trustedWorkspaces.length).toBeGreaterThan(0);
          expect(expectedSettings.trustedWorkspaces).toContain(ws);
        }
        expect(dumped).toMatchObject({
          AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
          AGY_LLM_GATEWAY_API_KEY: "cr_agy_dedicated",
          AGY_LLM_GATEWAY_MODELS: DEFAULT_AGY_GATEWAY_MODELS.join(","),
          AGY_LLM_GATEWAY_TIER_PRO: "claude-opus-4-6",
          AGY_LLM_GATEWAY_TIER_FLASH: "claude-sonnet-4-6",
          AGY_LLM_GATEWAY_TIER_FLASH_LITE: "gemini-3.5-flash-lite",
          hasGeminiBase: false,
          hasGeminiKey: false,
          hasGoogleKey: false,
          hasAicodeUrl: false,
        });
      }
    } finally {
      server.stop(true);
    }
  }, 15000);

  it("cold-starts launchClient(agyClient) in milliseconds without probing Tako bun or node binaries", async () => {
    const isWin = process.platform === "win32";
    const takoHome = join(tmp, "cold-launch-tako");
    const bunMarker = join(tmp, "bun-probed");
    const nodeMarker = join(tmp, "node-probed");
    const mockAgy = join(tmp, isWin ? "agy.exe" : "agy");

    if (isWin) {
      mkdirSync(join(takoHome, "bun", "bin"), { recursive: true });
      mkdirSync(join(takoHome, "node"), { recursive: true });
      writeFileSync(join(takoHome, "bun", "bin", "bun.exe"), "not-a-valid-exe");
      writeFileSync(join(takoHome, "node", "node.exe"), "not-a-valid-exe");
      writeFileSync(mockAgy, "MZ-mock-agy");
    } else {
      mkdirSync(join(takoHome, "bun", "bin"), { recursive: true });
      mkdirSync(join(takoHome, "node", "bin"), { recursive: true });
      writeFileSync(
        join(takoHome, "bun", "bin", "bun"),
        `#!/bin/sh\necho 1 > ${JSON.stringify(bunMarker)}\nsleep 5\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(takoHome, "node", "bin", "node"),
        `#!/bin/sh\necho 1 > ${JSON.stringify(nodeMarker)}\nsleep 5\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(mockAgy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      Bun.spawnSync([mockAgy]);
    }

    const launcherUrl = new URL("../src/launcher-legacy.ts", import.meta.url).href;
    const agyUrl = new URL("../src/clients/agy.ts", import.meta.url).href;
    const handoffFile = join(tmp, "cold-handoff.ps1");
    const script = `
      const { launchClient } = await import(${JSON.stringify(launcherUrl)});
      const { agyClient } = await import(${JSON.stringify(agyUrl)});
      const t0 = performance.now();
      const res = await launchClient(agyClient, {
        projectPath: ${JSON.stringify(tmp)},
        args: ["--version"],
        handoffOnWindows: true,
        providerContext: {
          type: "tako",
          baseUrl: "https://tako.shiroha.tech/v1",
          apiKey: "cr_main",
          agyApiKey: "cr_agy",
        },
      });
      const elapsedMs = performance.now() - t0;
      console.log(JSON.stringify({ res, elapsedMs }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: mockAgy,
        ...(isWin ? { TAKO_WINDOWS_HANDOFF_FILE: handoffFile } : {}),
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const { res, elapsedMs } = JSON.parse(stdout.trim());
    expect(res.success).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
    expect(existsSync(bunMarker)).toBe(false);
    expect(existsSync(nodeMarker)).toBe(false);
  });
});
