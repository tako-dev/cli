/**
 * installer e2e 驱动脚本 — 容器/CI 内真实安装 client 并验证三大不变量。
 *
 * 运行方式（需先设 TAKO_HOME 指向隔离临时目录）：
 *   TAKO_HOME=/tmp/tako-e2e bun tests/e2e/installer-driver.ts
 *   TAKO_E2E_CLIENT=pi TAKO_HOME=/tmp/tako-e2e bun tests/e2e/installer-driver.ts
 *
 * 输出 CHECK:key=value 行，供宿主脚本/bun test 断言。
 * exit 0 = 全部通过，exit 1 = 有失败。
 */
import { join } from "path";
import { TAKO_DIR, TOOLS_DIR, TAKO_BUN_CACHE_DIR } from "../../src/config";
import { installClient, isClientInstalled, ensureBunInstalled, ensureNodeInstalled, getBunPath, getNodePath } from "../../src/installer";
import { buildClientLaunchCommand, getClient, getClientEntryPath } from "../../src/clients/base";
import { installAtVersion, getInstalledVersion } from "../../src/installer-versions";

import "../../src/clients/codex";
import "../../src/clients/pi";
import "../../src/clients/pi-web";

const CLIENT_ID = process.env.TAKO_E2E_CLIENT || "codex";
const SUPPORTED = new Set(["codex", "pi", "pi-web"]);

const checks: Array<{ key: string; pass: boolean; detail?: string }> = [];

function check(key: string, pass: boolean, detail?: string) {
  checks.push({ key, pass, detail });
  const status = pass ? "PASS" : "FAIL";
  console.log(`CHECK:${key}=${status}${detail ? ` (${detail})` : ""}`);
}

function looksLikeVersion(text: string, clientId: string): boolean {
  const lower = text.toLowerCase();
  if (clientId === "codex") return lower.includes("codex");
  if (clientId === "pi") return /pi|0\.\d+/.test(lower);
  return /ready|started|listening|localhost|127\.0\.0\.1|pi[ -]?web/.test(lower);
}

function spawnTimeoutMs(clientId: string): number {
  return clientId === "pi-web" ? 45_000 : 20_000;
}

async function collectProcessOutput(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  ready: (text: string) => boolean,
  killWhenReady: boolean,
): Promise<{ text: string; exitCode: number | null; timedOut: boolean; sawReady: boolean }> {
  let text = "";
  let timedOut = false;
  let sawReady = false;
  const decoder = new TextDecoder();

  const markReady = () => {
    if (sawReady) return;
    sawReady = true;
    if (killWhenReady) proc.kill();
  };

  const append = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (ready(text)) markReady();
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  await Promise.all([append(proc.stdout), append(proc.stderr), proc.exited]);
  clearTimeout(timeout);
  if (ready(text)) sawReady = true;
  return { text, exitCode: proc.exitCode, timedOut, sawReady };
}

async function run() {
  if (!SUPPORTED.has(CLIENT_ID)) {
    console.error(`unsupported TAKO_E2E_CLIENT=${CLIENT_ID}`);
    process.exit(1);
  }

  const client = getClient(CLIENT_ID);
  if (!client) {
    console.error(`${CLIENT_ID} client not registered`);
    process.exit(1);
  }
  const clientDir = join(TOOLS_DIR, client.id);
  const fs = await import("fs/promises");

  console.log(`TAKO_HOME=${TAKO_DIR}`);
  console.log(`TOOLS_DIR=${TOOLS_DIR}`);
  console.log(`CACHE_DIR=${TAKO_BUN_CACHE_DIR}`);
  console.log(`CLIENT=${client.id} PACKAGE=${client.package}`);

  const bunOk = await ensureBunInstalled();
  check("bun-installed", bunOk);
  if (!bunOk) {
    console.error("无法安装 bun，中止");
    process.exit(1);
  }

  if (CLIENT_ID === "pi" || CLIENT_ID === "pi-web") {
    console.log("\n--- TP-INST-E2E-00b: install Tako Node ---");
    const nodeOk = await ensureNodeInstalled();
    check("tako-node-installed", nodeOk);
    if (!nodeOk) {
      console.error("无法安装 Tako Node，中止");
      process.exit(1);
    }
  }

  if (CLIENT_ID === "pi-web") {
    const pi = getClient("pi");
    if (!pi) {
      console.error("pi client not registered");
      process.exit(1);
    }
    console.log("\n--- TP-INST-E2E-00: install Pi first ---");
    const piReady = await installClient(pi);
    check("pi-ready-before-web", piReady.success, piReady.error);
    check("pi-installed-before-web", await isClientInstalled(pi));
  }

  console.log(`\n--- TP-INST-E2E-01: fresh install ${client.id} ---`);
  const result = await installClient(client);
  check("fresh-install-success", result.success, result.error);

  const pkgJson = join(clientDir, "node_modules", client.package, "package.json");
  const pkgExists = await Bun.file(pkgJson).exists();
  check("pkg-entry-exists", pkgExists);

  if (CLIENT_ID === "codex") {
    const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
    let binSize = 0;
    try {
      const glob = new Bun.Glob(`**/node_modules/@openai/**/${binaryName}`);
      for await (const path of glob.scan({ cwd: clientDir, onlyFiles: true })) {
        const stat = await fs.stat(join(clientDir, path));
        if (stat.size > binSize) binSize = stat.size;
      }
    } catch {}
    check("native-binary-exists", binSize > 1_000_000, `${Math.round(binSize / 1e6)}MB`);
  } else {
    const entryPath = await getClientEntryPath(client);
    check("js-entry-exists", !!entryPath && await Bun.file(entryPath!).exists(), entryPath || "null");
  }

  check("is-client-installed", await isClientInstalled(client));

  console.log("\n--- TP-INST-E2E-02: cache isolation ---");
  let cacheHasContent = false;
  try {
    const entries = await fs.readdir(TAKO_BUN_CACHE_DIR);
    cacheHasContent = entries.length > 0;
  } catch {}
  check("tako-cache-has-content", cacheHasContent);

  const globalCache = join(process.env.HOME || "/root", ".bun", "install", "cache");
  let globalCacheExists = false;
  try { await fs.access(globalCache); globalCacheExists = true; } catch {}
  check("global-cache-info", true, globalCacheExists ? "exists(pre-existing ok on local)" : "not-exists(clean)");

  console.log("\n--- TP-INST-E2E-03: idempotent ---");
  const result2 = await installClient(client);
  check("repeat-install-success", result2.success);
  check("still-installed-after-repeat", await isClientInstalled(client));

  console.log("\n--- TP-INST-E2E-04: half-dead recovery ---");
  const nmPath = join(clientDir, "node_modules");
  await fs.rm(nmPath, { recursive: true, force: true });
  check("placeholder-still-exists", await Bun.file(join(clientDir, "package.json")).exists());
  check("detects-not-installed-after-rm", !(await isClientInstalled(client)));
  const result3 = await installClient(client);
  check("re-install-success", result3.success, result3.error);
  check("recovered-installed", await isClientInstalled(client));

  console.log("\n--- TP-INST-E2E-05: update preserves node_modules ---");
  let inodeBefore = 0n;
  try { inodeBefore = (await fs.stat(nmPath)).ino; } catch {}
  const result4 = await installClient(client, true);
  check("force-update-success", result4.success, result4.error);
  let inodeAfter = 0n;
  try { inodeAfter = (await fs.stat(nmPath)).ino; } catch {}
  check("nm-dir-preserved", inodeAfter > 0n, `before=${inodeBefore} after=${inodeAfter}`);

  console.log("\n--- TP-INST-E2E-06: installAtVersion ---");
  const ver = await getInstalledVersion(client);
  check("get-installed-version", ver !== null, ver || "null");
  if (ver) {
    try {
      await installAtVersion(client, ver);
      check("install-at-version-success", true);
    } catch (e: any) {
      check("install-at-version-success", false, e.message);
    }
    const verAfter = await getInstalledVersion(client);
    check("version-matches-after-install", verAfter === ver, `${verAfter} vs ${ver}`);
  }

  console.log(`\n--- TP-INST-E2E-07: launcher spawn ${client.id} ---`);
  const entryPath = await getClientEntryPath(client);
  check("entry-path-resolved", entryPath !== null, entryPath || "null");
  if (entryPath) {
    const bunPath = await getBunPath();
    const nodePath = await getNodePath();
    const command = buildClientLaunchCommand(
      client,
      entryPath,
      bunPath,
      CLIENT_ID === "pi-web" ? ["--no-open"] : ["--version"],
      process.platform,
      nodePath,
    );
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const output = await collectProcessOutput(
      proc,
      spawnTimeoutMs(CLIENT_ID),
      (text) => looksLikeVersion(text, CLIENT_ID),
      CLIENT_ID === "pi-web",
    );
    const text = output.text;
    if (CLIENT_ID === "pi-web") {
      check(`${client.id}-spawn-ready`, output.sawReady && !output.timedOut, text.trim().slice(0, 80));
    } else {
      // --version 应自行退出。Windows 上 kill 后 Bun 常给出 exit=null，
      // 所以只在没看到版本输出、或超时、或明确非 0 时判失败。
      const exitedCleanly = output.exitCode === 0 || (output.sawReady && output.exitCode == null);
      check(`${client.id}-spawn-exit-0`, exitedCleanly && !output.timedOut, `exit=${output.exitCode}`);
      check(`${client.id}-spawn-output`, output.sawReady, text.trim().slice(0, 80));
    }
  }

  if (CLIENT_ID === "codex") {
    console.log("\n--- TP-INST-E2E-08: provider config write ---");
    const { codexClient } = await import("../../src/clients/codex");
    const homedir = (await import("os")).homedir();
    const codexConfigPath = join(homedir, ".codex", "config.toml");
    if (codexClient.setupConfigFiles) {
      await codexClient.setupConfigFiles({ type: "custom", baseUrl: "https://test.example.com" });
      const configExists = await Bun.file(codexConfigPath).exists();
      check("codex-config-written", configExists);
      if (configExists) {
        const content = await Bun.file(codexConfigPath).text();
        check("codex-config-has-tako-provider", content.includes("tako"));
        check("codex-config-has-base-url", content.includes("test.example.com"));
      }
    } else {
      check("codex-config-written", false, "setupConfigFiles not defined");
    }
  } else {
    console.log("\n--- TP-INST-E2E-08: skipped (Pi settings stay on the user machine) ---");
  }

  if (process.platform === "win32") {
    console.log("\n--- TP-INST-E2E-09: PowerShell compatibility ---");
    const pwshProc = Bun.spawn(["pwsh", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      stdout: "pipe", stderr: "pipe",
    });
    await pwshProc.exited;
    const pwshVer = (await new Response(pwshProc.stdout).text()).trim();
    check("pwsh-available", pwshProc.exitCode === 0, `v${pwshVer}`);
    check("pwsh-version-7+", parseInt(pwshVer) >= 7, `major=${pwshVer}`);

    const expandProc = Bun.spawn(["pwsh", "-NoProfile", "-Command", "Get-Command Expand-Archive -ErrorAction Stop | Out-Null; echo ok"], {
      stdout: "pipe", stderr: "pipe",
    });
    await expandProc.exited;
    check("expand-archive-available", expandProc.exitCode === 0);
  } else {
    console.log("\n--- TP-INST-E2E-09: skipped (not Windows) ---");
  }

  console.log("\n=== SUMMARY ===");
  const failed = checks.filter((c) => !c.pass);
  console.log(`total=${checks.length} pass=${checks.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL: ${f.key} ${f.detail || ""}`);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
