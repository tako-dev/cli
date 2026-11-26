import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/clients";
import {
  AGY_DEFAULT_MANIFEST_BASE,
  AGY_FALLBACK_MANIFEST_BASE,
  checkAgyManagedUpdate,
  compareAgyVersions,
  computeFileSha512,
  evaluateAgyUpdateStatus,
  fetchAgyManifest,
  installAgyFromManifest,
  resolveAgyManifestUrl,
  resolveAgyManifestUrls,
  resolveAgyPlatform,
} from "../src/installer";

function buildMockAgyArchive(tmp: string, version: string, label: string): {
  payloadPath: string;
  sha512: Promise<string>;
} {
  const pkgSrc = join(tmp, `pkg-${label}`);
  mkdirSync(pkgSrc, { recursive: true });
  const isWin = process.platform === "win32";
  if (isWin) {
    const exePath = join(tmp, `agy-${label}.exe`);
    writeFileSync(exePath, `MZ-mock-agy-${version}`);
    return { payloadPath: exePath, sha512: computeFileSha512(exePath) };
  }
  writeFileSync(
    join(pkgSrc, "antigravity"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "mock-agy-${version}"\n`,
    { mode: 0o755 },
  );
  const tarName = `agy-${label}.tar.gz`;
  const tarPath = join(tmp, tarName);
  const res = Bun.spawnSync(["tar", "-czf", tarPath, "antigravity"], { cwd: pkgSrc });
  if (res.exitCode !== 0) {
    throw new Error(`tar failed: ${res.stderr.toString()}`);
  }
  return { payloadPath: tarPath, sha512: computeFileSha512(tarPath) };
}

describe("Antigravity (agy) managed CDN channel & independent updates", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-managed-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to Tako managed CDN primary + GitHub raw fallback and never falls back to uncontrolled upstream", () => {
    expect(AGY_DEFAULT_MANIFEST_BASE).toBe("https://dl.lven.asia/tako-switch/agy-cli/manifests");
    expect(AGY_FALLBACK_MANIFEST_BASE).toBe(
      "https://raw.githubusercontent.com/tako-dev/tako-switch/main/manifest/agy-cli/manifests",
    );

    const urls = resolveAgyManifestUrls({
      platform: "darwin",
      arch: "arm64",
      env: {},
    });
    expect(urls).toEqual([
      "https://dl.lven.asia/tako-switch/agy-cli/manifests/darwin_arm64.json",
      "https://raw.githubusercontent.com/tako-dev/tako-switch/main/manifest/agy-cli/manifests/darwin_arm64.json",
    ]);
    expect(resolveAgyManifestUrl({ platform: "darwin", arch: "arm64", env: {} })).toBe(urls[0]);

    const explicitOnly = resolveAgyManifestUrls({
      platform: "linux",
      arch: "x64",
      isMusl: false,
      env: { AGY_INSTALL_MANIFEST_BASE: "http://127.0.0.1:18080/manifests/" },
    });
    expect(explicitOnly).toEqual(["http://127.0.0.1:18080/manifests/linux_amd64.json"]);
  });

  it("compares agy versions and evaluates update / minSupported / rolling window status accurately", () => {
    expect(compareAgyVersions("1.5.17", "1.5.16")).toBe(1);
    expect(compareAgyVersions("1.5.17", "v1.5.17")).toBe(0);
    expect(compareAgyVersions("1.5.17-beta.1", "1.5.17")).toBe(-1);

    const manifest = {
      version: "1.5.17",
      url: "https://dl.lven.asia/apps/agy-cli/darwin_arm64/1.5.17/cli_mac_arm64.tar.gz",
      sha512: "a".repeat(128),
      minSupportedVersion: "1.5.16",
      supportedVersions: ["1.5.16", "1.5.17"],
      manifestUrl: "https://dl.lven.asia/tako-switch/agy-cli/manifests/darwin_arm64.json",
    };

    expect(evaluateAgyUpdateStatus("1.5.16", manifest)).toMatchObject({
      hasUpdate: true,
      belowMinSupported: false,
      aheadOfManaged: false,
    });
    expect(evaluateAgyUpdateStatus("1.5.15", manifest)).toMatchObject({
      hasUpdate: true,
      belowMinSupported: true,
      aheadOfManaged: false,
    });
    expect(evaluateAgyUpdateStatus("1.5.17", manifest)).toMatchObject({
      hasUpdate: false,
      belowMinSupported: false,
      aheadOfManaged: false,
    });
    expect(evaluateAgyUpdateStatus("1.5.18", manifest)).toMatchObject({
      hasUpdate: false,
      belowMinSupported: false,
      aheadOfManaged: true,
    });

    // Rolling window: canary version 1.5.18 explicitly allowed by gateway supportedVersions
    expect(
      evaluateAgyUpdateStatus("1.5.18", {
        ...manifest,
        supportedVersions: ["1.5.17", "1.5.18"],
      }),
    ).toMatchObject({
      hasUpdate: false,
      belowMinSupported: false,
      aheadOfManaged: false,
    });
  });

  it("fails over from primary manifest & archive URL to fallback URL while preserving SHA-512 verification", async () => {
    const platformKey = resolveAgyPlatform();
    const pkg = buildMockAgyArchive(tmp, "1.5.17", "failover");
    const sha512 = await pkg.sha512;
    const isWin = process.platform === "win32";
    const ext = isWin ? ".exe" : ".tar.gz";

    let primaryManifestHits = 0;
    let fallbackManifestHits = 0;
    let primaryArchiveHits = 0;
    let fallbackArchiveHits = 0;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/primary/${platformKey}.json`) {
          primaryManifestHits++;
          return new Response("primary unavailable", { status: 503 });
        }
        if (url.pathname === `/fallback/${platformKey}.json`) {
          fallbackManifestHits++;
          return Response.json({
            version: "1.5.17",
            url: `http://127.0.0.1:${server.port}/cdn/agy${ext}`,
            fallbackUrl: `http://127.0.0.1:${server.port}/gcs/agy${ext}`,
            sha512,
            minSupportedVersion: "1.5.16",
            supportedVersions: ["1.5.16", "1.5.17"],
            channel: "tako-managed",
          });
        }
        if (url.pathname === `/cdn/agy${ext}`) {
          primaryArchiveHits++;
          return new Response("cdn down", { status: 502 });
        }
        if (url.pathname === `/gcs/agy${ext}`) {
          fallbackArchiveHits++;
          return new Response(Bun.file(pkg.payloadPath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const manifest = await fetchAgyManifest({
        manifestBaseUrl: `http://127.0.0.1:${server.port}/primary`,
        fallbackManifestBaseUrl: `http://127.0.0.1:${server.port}/fallback`,
      });
      expect(primaryManifestHits).toBe(1);
      expect(fallbackManifestHits).toBe(1);
      expect(manifest.version).toBe("1.5.17");
      expect(manifest.minSupportedVersion).toBe("1.5.16");
      expect(manifest.supportedVersions).toEqual(["1.5.16", "1.5.17"]);
      expect(manifest.manifestUrl).toBe(`http://127.0.0.1:${server.port}/fallback/${platformKey}.json`);

      const targetDir = join(tmp, "bin-failover");
      const installed = await installAgyFromManifest(manifest, {
        targetDir,
        quiet: true,
      });
      expect(primaryArchiveHits).toBe(1);
      expect(fallbackArchiveHits).toBe(1);
      expect(existsSync(installed.binPath)).toBe(true);
      expect(installed.downloadUrl).toBe(`http://127.0.0.1:${server.port}/gcs/agy${ext}`);

      // Cache TTL hit + forceRefresh bypass
      const cachePath = join(tmp, "agy-update-check.json");
      const first = await checkAgyManagedUpdate({
        localVersion: "1.5.16",
        manifestBaseUrl: `http://127.0.0.1:${server.port}/fallback`,
        cachePath,
        ttlMs: 60_000,
      });
      expect(first?.hasUpdate).toBe(true);
      expect(fallbackManifestHits).toBe(2);

      const second = await checkAgyManagedUpdate({
        localVersion: "1.5.16",
        manifestBaseUrl: `http://127.0.0.1:${server.port}/fallback`,
        cachePath,
        ttlMs: 60_000,
      });
      expect(second?.hasUpdate).toBe(true);
      expect(fallbackManifestHits).toBe(2); // Served from cache

      const forced = await checkAgyManagedUpdate({
        localVersion: "1.5.16",
        manifestBaseUrl: `http://127.0.0.1:${server.port}/fallback`,
        cachePath,
        forceRefresh: true,
        ttlMs: 60_000,
      });
      expect(forced?.hasUpdate).toBe(true);
      expect(fallbackManifestHits).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  it("runs end-to-end `tako update agy` (--check, upgrade, up-to-date, ahead guard, --force rollback)", async () => {
    if (process.platform === "win32") return;

    const platformKey = resolveAgyPlatform();
    const pkg17 = buildMockAgyArchive(tmp, "1.5.17", "v17");
    const sha17 = await pkg17.sha512;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/manifests/${platformKey}.json`) {
          return Response.json({
            version: "1.5.17",
            url: `http://127.0.0.1:${server.port}/agy-1.5.17.tar.gz`,
            sha512: sha17,
            minSupportedVersion: "1.5.16",
            supportedVersions: ["1.5.16", "1.5.17"],
            channel: "tako-managed",
          });
        }
        if (url.pathname === "/agy-1.5.17.tar.gz") {
          return new Response(Bun.file(pkg17.payloadPath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
      const fakeHome = join(tmp, "home");
      const takoHome = join(tmp, "tako-home");
      const binDir = join(fakeHome, ".local", "bin");
      const agyBin = join(binDir, "agy");
      const shimBin = join(tmp, "shim-bin");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(takoHome, { recursive: true });
      mkdirSync(shimBin, { recursive: true });
      symlinkSync(process.execPath, join(shimBin, "bun"));

      // Pre-install older local agy 1.5.16
      writeFileSync(agyBin, `#!/bin/sh\necho "1.5.16"\n`, { mode: 0o755 });
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({ apiKey: "", apiId: "", telemetryEnabled: false, installedClients: {} }),
      );

      const cleanEnv: Record<string, string | undefined> = { ...process.env };
      delete cleanEnv.AGY_PATH;
      delete cleanEnv.AGY_INSTALL_DIR;
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        delete cleanEnv[k];
      }
      const env = {
        ...cleanEnv,
        HOME: fakeHome,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_INSTALL_MANIFEST_BASE: `http://127.0.0.1:${server.port}/manifests`,
        PATH: `${binDir}:${shimBin}:/usr/bin:/bin`,
      };

      const runCmd = async (args: string[]) => {
        const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      };

      // 1. --check --json detects available verified update without modifying binary
      const checkRes = await runCmd(["update", "agy", "--check", "--json"]);
      expect(checkRes.code).toBe(0);
      expect(JSON.parse(checkRes.stdout)).toMatchObject({
        ok: true,
        installed: true,
        localVersion: "1.5.16",
        latestVersion: "1.5.17",
        hasUpdate: true,
        belowMinSupported: false,
        aheadOfManaged: false,
        supportedVersions: ["1.5.16", "1.5.17"],
      });

      // 2. `tako update agy --json` upgrades 1.5.16 -> 1.5.17
      const upgradeRes = await runCmd(["update", "agy", "--json"]);
      expect(upgradeRes.code).toBe(0);
      expect(JSON.parse(upgradeRes.stdout)).toMatchObject({
        ok: true,
        updated: true,
        previousVersion: "1.5.16",
        version: "1.5.17",
        binPath: agyBin,
      });
      expect(Bun.spawnSync([agyBin, "--version"]).stdout.toString().trim()).toBe("1.5.17");
      const cfg = JSON.parse(readFileSync(join(takoHome, "config.json"), "utf8"));
      expect(cfg.installedClients.agy.version).toBe("1.5.17");

      // 3. Running again reports up_to_date
      const upToDateRes = await runCmd(["update", "agy", "--json"]);
      expect(upToDateRes.code).toBe(0);
      expect(JSON.parse(upToDateRes.stdout)).toMatchObject({
        ok: true,
        updated: false,
        reason: "up_to_date",
        localVersion: "1.5.17",
      });

      // 4. Ahead of managed (1.5.19) does not downgrade without --force
      writeFileSync(agyBin, `#!/bin/sh\necho "1.5.19"\n`, { mode: 0o755 });
      const aheadRes = await runCmd(["update", "agy", "--json"]);
      expect(aheadRes.code).toBe(0);
      expect(JSON.parse(aheadRes.stdout)).toMatchObject({
        ok: true,
        updated: false,
        reason: "ahead_of_managed",
        localVersion: "1.5.19",
        latestVersion: "1.5.17",
        aheadOfManaged: true,
      });
      expect(Bun.spawnSync([agyBin, "--version"]).stdout.toString().trim()).toBe("1.5.19");

      // 5. `--force` rolls back / aligns 1.5.19 -> managed 1.5.17
      const forceRes = await runCmd(["update", "agy", "--force", "--json"]);
      expect(forceRes.code).toBe(0);
      expect(JSON.parse(forceRes.stdout)).toMatchObject({
        ok: true,
        updated: true,
        previousVersion: "1.5.19",
        version: "1.5.17",
      });
      expect(Bun.spawnSync([agyBin, "--version"]).stdout.toString().trim()).toBe("1.5.17");
    } finally {
      server.stop(true);
    }
  }, 15000);
});
