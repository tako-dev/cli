// 回归测试 — 2026-06-15 事故：codex/claude-code 启动 fallback 到全局安装
//
// 不变量 INV-INST-01：判定"已安装"必须看真正的包入口
//   node_modules/<package>/package.json，而非 tako 在 bun add 之前写的占位
//   <clientDir>/package.json。
//
// 事故根因：旧 isClientInstalled 只检查占位 package.json。更新流程"先删
// node_modules 再 bun add"中途失败后，留下"占位文件在、node_modules 没"的
// 半残状态，被误判为"已安装" → 永不重装 → 启动 fallback 到全局二进制。
//
// 这些用例锁住合约：占位文件存在 ≠ 已安装；只有包入口存在才算装好。

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isPackageInstalledAt, buildBunInstallEnv } from "../src/installer";
import { TAKO_BUN_CACHE_DIR } from "../src/config";

const PKG = "@openai/codex";

describe("installer/isPackageInstalledAt — INV-INST-01", () => {
  let clientDir: string;

  beforeEach(async () => {
    clientDir = await mkdtemp(join(tmpdir(), "tako-installer-test-"));
  });

  afterEach(async () => {
    await rm(clientDir, { recursive: true, force: true });
  });

  it("空目录 → 未安装", async () => {
    expect(await isPackageInstalledAt(clientDir, PKG)).toBe(false);
  });

  it("只有占位 package.json（无 node_modules）→ 未安装（事故现场）", async () => {
    // 还原事故：tako 写过占位文件，但 node_modules 被删
    await writeFile(
      join(clientDir, "package.json"),
      JSON.stringify({ name: "tako-codex", private: true, dependencies: { [PKG]: "^0.137.0" } }),
    );
    expect(await isPackageInstalledAt(clientDir, PKG)).toBe(false);
  });

  it("node_modules/<pkg>/package.json 存在 → 已安装", async () => {
    const pkgDir = join(clientDir, "node_modules", PKG);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: PKG, version: "0.139.0" }));
    expect(await isPackageInstalledAt(clientDir, PKG)).toBe(true);
  });

  it("node_modules 存在但目标包缺失 → 未安装", async () => {
    await mkdir(join(clientDir, "node_modules", "@openai", "other-pkg"), { recursive: true });
    expect(await isPackageInstalledAt(clientDir, PKG)).toBe(false);
  });
});

describe("installer/buildBunInstallEnv — INV-INST-02 cache 隔离", () => {
  it("注入独立 BUN_INSTALL_CACHE_DIR（指向 tako 专属 cache）", () => {
    const env = buildBunInstallEnv("https://registry.example.com");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(TAKO_BUN_CACHE_DIR);
  });

  it("cache dir 在 tako 目录下，与全局 ~/.bun/install/cache 隔离", () => {
    const env = buildBunInstallEnv("https://registry.example.com");
    expect(env.BUN_INSTALL_CACHE_DIR).toContain(".tako");
    expect(env.BUN_INSTALL_CACHE_DIR).not.toContain(".bun/install/cache");
  });

  it("透传 registry", () => {
    const env = buildBunInstallEnv("https://registry.example.com");
    expect(env.BUN_CONFIG_REGISTRY).toBe("https://registry.example.com");
  });
});

describe("client version detection and semver comparison", () => {
  it("validates strict semver strings and rejects tags like latest", async () => {
    const { isStrictSemver } = await import("../src/installer");
    expect(isStrictSemver("0.170.0")).toBe(true);
    expect(isStrictSemver("v1.2.3")).toBe(true);
    expect(isStrictSemver("1.2.3-beta.1")).toBe(true);
    expect(isStrictSemver("latest")).toBe(false);
    expect(isStrictSemver("未知")).toBe(false);
    expect(isStrictSemver("")).toBe(false);
    expect(isStrictSemver(null)).toBe(false);
  });

  it("compares versions using semver rather than naive string inequality", async () => {
    const { isClientVersionOutdated } = await import("../src/installer");
    expect(isClientVersionOutdated("0.170.0", "0.170.0")).toBe(false);
    expect(isClientVersionOutdated("v0.170.0", "0.170.0")).toBe(false);
    expect(isClientVersionOutdated("0.170.0", "0.171.0")).toBe(true);
    expect(isClientVersionOutdated("0.171.0", "0.170.0")).toBe(false);
    expect(isClientVersionOutdated("0.170.0-alpha.1", "0.170.0")).toBe(true);
    expect(isClientVersionOutdated("latest", "0.170.0")).toBe(true);
    expect(isClientVersionOutdated(null, "0.170.0")).toBe(true);
    expect(isClientVersionOutdated("0.170.0", null)).toBe(false);
  });

  it("auto-heals stale 'latest' in config.json from node_modules package.json and avoids false update prompt", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const fakeHome = mkdtempSync(join(tmpdir(), "tako-version-heal-"));
    try {
      mkdirSync(join(fakeHome, "tools", "codex", "node_modules", "@openai", "codex"), { recursive: true });
      writeFileSync(
        join(fakeHome, "config.json"),
        JSON.stringify({
          apiKey: "",
          apiId: "",
          installedClients: {
            codex: { version: "latest", installedAt: "2026-11-19T17:29:31.806Z" },
          },
        }),
      );
      writeFileSync(
        join(fakeHome, "tools", "codex", "node_modules", "@openai", "codex", "package.json"),
        JSON.stringify({ name: "@openai/codex", version: "0.170.0" }),
      );

      const script = `
        import { codexClient } from "./src/clients/codex";
        import { getLocalVersion, needsUpdate } from "./src/installer";
        import { getInstalledVersion } from "./src/installer-versions";
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ version: "0.170.0" }), { status: 200 })) as unknown as typeof fetch;
        const local = await getLocalVersion(codexClient);
        const installed = await getInstalledVersion(codexClient);
        const outdatedSame = await needsUpdate(codexClient);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ version: "0.171.0" }), { status: 200 })) as unknown as typeof fetch;
        const outdatedNewer = await needsUpdate(codexClient);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ version: "0.169.0" }), { status: 200 })) as unknown as typeof fetch;
        const outdatedOlder = await needsUpdate(codexClient);
        console.log(JSON.stringify({ local, installed, outdatedSame, outdatedNewer, outdatedOlder }));
      `;
      const proc = Bun.spawn(["bun", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, TAKO_HOME: fakeHome, TAKO_REGION: "global" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode).toBe(0);
      if (exitCode !== 0) throw new Error(stderr);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toEqual({
        local: "0.170.0",
        installed: "0.170.0",
        outdatedSame: false,
        outdatedNewer: true,
        outdatedOlder: false,
      });

      const healedConfig = JSON.parse(readFileSync(join(fakeHome, "config.json"), "utf8"));
      expect(healedConfig.installedClients.codex.version).toBe("0.170.0");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
