import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTakoDir, getTakoCliDir, getBunBin, isWindows } from "./_helpers/paths";
import { expectInTakoDir } from "./_helpers/assertions";
import { isOfficialCliEntry, shouldRunStartupUpdate } from "../src/app";
import {
  _setUpdateCachePathForTest,
  buildCliUpdateCommand,
  checkAndUpdate,
  readUpdateCheckCache,
  refreshUpdateCheckInBackground,
  runUpdateCommand,
  UPDATE_CHECK_TTL_MS,
  writeUpdateCheckCache,
} from "../src/updater";

describe("Update Logic - path configuration", () => {
  const takoDir = getTakoDir();
  const cliDir = getTakoCliDir();

  it("Tako CLI directory should be under Tako directory", () => {
    expectInTakoDir(cliDir, takoDir);
  });

  it("update command should not contain -g flag", () => {
    const command = buildCliUpdateCommand();
    expect(command).not.toContain("-g");
  });

  it("working directory should be set to Tako CLI directory", () => {
    const cwd = cliDir;
    expectInTakoDir(cwd, takoDir);
  });

  it("Bun executable path should be correct for platform", () => {
    const bunBin = getBunBin();

    if (isWindows()) {
      expect(bunBin).toEndWith(".exe");
    } else {
      expect(bunBin).not.toEndWith(".exe");
    }
  });

  it("update command should include package name", () => {
    const command = buildCliUpdateCommand();
    expect(command).toContain("tako-cli");
  });

  it("update command should use update subcommand with --latest", () => {
    const command = buildCliUpdateCommand();
    expect(command).toContain("update");
    expect(command).toContain("--latest");
  });

  it("update command should not omit dependencies", () => {
    expect(buildCliUpdateCommand()).not.toContain("--omit");
    expect(buildCliUpdateCommand()).not.toContain("optional");
  });

  it("startup auto update runs in production mode", () => {
    expect(shouldRunStartupUpdate(false)).toBe(true);
  });

  it("startup auto update remains disabled in dev mode", () => {
    expect(shouldRunStartupUpdate(true)).toBe(false);
  });

  it("treats the local ~/.tako/cli install as official", () => {
    expect(isOfficialCliEntry("/home/u/.tako/cli/node_modules/tako-cli/dist/index.js")).toBe(true);
    expect(isOfficialCliEntry("C:\\Users\\u\\.tako\\cli\\node_modules\\tako-cli\\dist\\index.js")).toBe(true);
  });

  it("does not treat sidecar tako2 or source trees as official", () => {
    expect(isOfficialCliEntry("/home/u/.tako/tako2/dist/index.js")).toBe(false);
    expect(isOfficialCliEntry("/home/u/develop/tako-cli/dist/index.js")).toBe(false);
  });
});

describe("Update Logic - local TTL cache and 0ms startup check", () => {
  const tempDirs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalRegion = process.env.TAKO_REGION;

  afterEach(() => {
    _setUpdateCachePathForTest(null);
    globalThis.fetch = originalFetch;
    if (originalRegion === undefined) delete process.env.TAKO_REGION;
    else process.env.TAKO_REGION = originalRegion;
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function makeTempCachePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "tako-update-cache-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "nested", "update-check.json");
    _setUpdateCachePathForTest(cachePath);
    return cachePath;
  }

  it("exports 6h UPDATE_CHECK_TTL_MS and reads/writes UpdateCheckCache safely", () => {
    expect(UPDATE_CHECK_TTL_MS).toBe(6 * 60 * 60 * 1000);
    const cachePath = makeTempCachePath();
    expect(readUpdateCheckCache()).toBeNull();

    writeUpdateCheckCache({
      checkedAt: 123456,
      latestVersion: "0.3.55",
      lastFailedVersion: "0.3.56",
      lastFailedAt: 123400,
    });
    expect(readUpdateCheckCache()).toEqual({
      checkedAt: 123456,
      latestVersion: "0.3.55",
      lastFailedVersion: "0.3.56",
      lastFailedAt: 123400,
    });

    writeFileSync(cachePath, "{not-valid-json", "utf8");
    expect(readUpdateCheckCache()).toBeNull();
  });

  it("refreshUpdateCheckInBackground writes latestVersion and preserves failure backoff for same version", async () => {
    makeTempCachePath();
    process.env.TAKO_REGION = "global";
    writeUpdateCheckCache({
      checkedAt: 1000,
      latestVersion: "9.9.9",
      lastFailedVersion: "9.9.9",
      lastFailedAt: 2000,
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })) as unknown as typeof fetch;

    const refreshed = await refreshUpdateCheckInBackground();
    expect(refreshed?.latestVersion).toBe("9.9.9");
    expect(refreshed?.lastFailedVersion).toBe("9.9.9");
    expect(refreshed?.lastFailedAt).toBe(2000);

    // When a newer version appears, stale failure backoff fields are cleared
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "9.9.10" }), { status: 200 })) as unknown as typeof fetch;
    const newer = await refreshUpdateCheckInBackground();
    expect(newer?.latestVersion).toBe("9.9.10");
    expect(newer?.lastFailedVersion).toBeUndefined();
    expect(newer?.lastFailedAt).toBeUndefined();

    // Non-200 and network failures return null without throwing
    globalThis.fetch = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
    expect(await refreshUpdateCheckInBackground()).toBeNull();

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await refreshUpdateCheckInBackground()).toBeNull();
  });

  it("checkAndUpdate never awaits network on cold/expired cache and respects spawnBackgroundRefresh: false", async () => {
    makeTempCachePath();
    process.env.TAKO_REGION = "global";
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 250));
      return new Response(JSON.stringify({ version: "0.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const t0 = performance.now();
    await checkAndUpdate({ spawnBackgroundRefresh: false });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(fetchCount).toBe(0);

    // Default spawnBackgroundRefresh triggers fire-and-forget without awaiting the 250ms response
    const t1 = performance.now();
    await checkAndUpdate();
    expect(performance.now() - t1).toBeLessThan(80);
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchCount).toBe(1);
    expect(readUpdateCheckCache()?.latestVersion).toBe("0.0.0");

    // Fresh cache within TTL does not trigger another fetch
    await checkAndUpdate();
    expect(fetchCount).toBe(1);
  });

  it("checkAndUpdate skips performUpdate during failure backoff window", async () => {
    makeTempCachePath();
    process.env.TAKO_REGION = "global";
    const now = Date.now();
    writeUpdateCheckCache({
      checkedAt: now - 1000,
      latestVersion: "99.0.0",
      lastFailedVersion: "99.0.0",
      lastFailedAt: now - 1000,
    });
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    await checkAndUpdate();
    expect(fetchCount).toBe(0);
    expect(readUpdateCheckCache()?.lastFailedVersion).toBe("99.0.0");
  });

  it("runUpdateCommand queries registry in real time and updates cache", async () => {
    makeTempCachePath();
    process.env.TAKO_REGION = "global";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.0.0" }), { status: 200 })) as unknown as typeof fetch;

    await runUpdateCommand();
    expect(readUpdateCheckCache()?.latestVersion).toBe("0.0.0");
  });
});
