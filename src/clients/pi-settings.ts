import { homedir } from "os";
import { dirname, join } from "path";
import { getClient, getClientEntryPath } from "./base";
import { createSpinner, log } from "../logger";
import { TAKO_DIR } from "../config";
import { ensureClientReady, getNodePath } from "../installer";
import type { ProviderContext } from "../providers/types";

export const PI_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const PI_PACKAGE = "git:github.com/Barrierml/tako-pi";
export const PI_GIT_DIR = join(homedir(), ".pi", "agent", "git", "github.com", "Barrierml", "tako-pi");
export const PI_CC_HEADER_PACKAGE = "npm:pi-cc-header";
export const PI_CLAUDE_CODE_UI_PACKAGE = "npm:pi-claude-code-ui";
export const PI_STYLE_PACKAGES = [PI_CC_HEADER_PACKAGE, PI_CLAUDE_CODE_UI_PACKAGE] as const;
export const PI_NPM_DIR = join(homedir(), ".pi", "agent", "npm", "node_modules");
export const PI_CC_HEADER_FILE = join(PI_NPM_DIR, "pi-cc-header", "extensions", "pi-cc-header.ts");

export const PI_CC_HEADER_STALE_GUARD = `try {
\t\tif (ctx.mode !== "tui") return;
\t} catch {
\t\treturn;
\t}`;
export const PI_CC_HEADER_STALE_UNGUARDED = `\tif (ctx.mode !== "tui") return;`;

const UPDATE_STAMP = join(TAKO_DIR, ".tako-pi-updated.json");

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function packageSource(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  return typeof rec?.source === "string" ? rec.source : "";
}

export function hasLocalTakoPi(packages: unknown): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((item) => packageSource(item) === "local/tako-pi");
}

export function hasTakoPi(packages: unknown): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((item) => {
    const source = packageSource(item);
    return source.includes("tako-pi") || source === "local/tako-pi";
  });
}

export function hasPackageSource(packages: unknown, needle: string): boolean {
  if (!Array.isArray(packages)) return false;
  return packages.some((item) => packageSource(item) === needle);
}

export function withDefaultPiPackages(packages: unknown): unknown[] {
  const next = Array.isArray(packages) ? [...packages] : [];
  if (!hasTakoPi(next)) next.push(PI_PACKAGE);
  for (const source of PI_STYLE_PACKAGES) {
    if (!hasPackageSource(next, source)) next.push(source);
  }
  return next;
}

export function npmPackageName(source: string): string {
  return source.replace(/^npm:/, "");
}

export function missingPiStylePackages(installedNames: Iterable<string>): string[] {
  const installed = new Set(installedNames);
  return PI_STYLE_PACKAGES.filter((source) => !installed.has(npmPackageName(source)));
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  const fs = await import("fs/promises");
  try {
    return JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  const fs = await import("fs/promises");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export function resolvePiLookupCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "where pi" : "which pi";
}

export function pickPiLookupPath(output: string, platform: NodeJS.Platform): string | undefined {
  const out = output
    .split("\n")
    .map((line) => line.trim().replace(/\r$/, ""))
    .filter(Boolean);
  if (platform !== "win32") return out[0];
  return out.find((p) => p.toLowerCase().endsWith(".cmd"))
    ?? out.find((p) => p.toLowerCase().endsWith(".exe"))
    ?? out[0];
}

export async function resolvePiBin(): Promise<string | null> {
  const pi = getClient("pi");
  if (pi) {
    const entry = await getClientEntryPath(pi);
    if (entry) return entry;
  }
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync(resolvePiLookupCommand(process.platform), { encoding: "utf8" });
    return pickPiLookupPath(out, process.platform) || null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  const fs = await import("fs/promises");
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function updatedToday(): Promise<boolean> {
  try {
    const data = await readJson(UPDATE_STAMP);
    return data.date === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

async function markUpdatedToday(): Promise<void> {
  await writeJson(UPDATE_STAMP, { date: new Date().toISOString().slice(0, 10) });
}

async function runPi(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const node = await getNodePath();
    const proc = Bun.spawn([node, bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PI_DISABLE_UPDATE_CHECK: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

export function planTakoPiAction(opts: {
  packages: unknown;
  installed: boolean;
  update: boolean;
  updatedToday: boolean;
  hasBin: boolean;
}): { packages: unknown[]; action: "none" | "install" | "update" } {
  const packages = withDefaultPiPackages(opts.packages);
  if (hasLocalTakoPi(packages) || !opts.hasBin) return { packages, action: "none" };
  if (!opts.installed) return { packages, action: "install" };
  if (opts.update && !opts.updatedToday) return { packages, action: "update" };
  return { packages, action: "none" };
}

/**
 * Ensure tako-pi is listed in ~/.pi/agent/settings.json.
 * First launch installs the public git package. Later launches pull updates
 * once a day. A local/tako-pi checkout is left alone.
 */
export async function ensureTakoPiPackage(opts?: { update?: boolean }): Promise<void> {
  const settings = await readJson(PI_SETTINGS_PATH);
  const plan = planTakoPiAction({
    packages: settings.packages,
    installed: await pathExists(PI_GIT_DIR),
    update: !!opts?.update,
    updatedToday: await updatedToday(),
    hasBin: !!(await resolvePiBin()),
  });
  if (JSON.stringify(plan.packages) !== JSON.stringify(settings.packages ?? [])) {
    settings.packages = plan.packages;
    await writeJson(PI_SETTINGS_PATH, settings);
  }
  if (plan.action === "none") return;

  const bin = await resolvePiBin();
  if (!bin) return;

  if (plan.action === "install") {
    const spin = createSpinner();
    spin.start("Installing tako-pi…");
    const result = await runPi(bin, ["install", PI_PACKAGE]);
    if (result.ok) {
      spin.stop("tako-pi installed");
      await markUpdatedToday();
    } else {
      spin.stop();
      log.warn(`tako-pi install failed: ${shortPiError(result.output)}`);
    }
    return;
  }

  const spin = createSpinner();
  spin.start("Updating tako-pi…");
  const result = await runPi(bin, ["update", "--extension", PI_PACKAGE]);
  if (result.ok) {
    spin.stop("tako-pi updated");
    await markUpdatedToday();
  } else {
    spin.stop();
    log.warn(`tako-pi update failed: ${shortPiError(result.output)}`);
  }
}

export function takoPiEnv(provider: ProviderContext): Record<string, string> {
  const common = {
    PI_DISABLE_UPDATE_CHECK: "1",
  };
  if (provider.type === "tako" || provider.type === "custom") {
    return {
      ...common,
      TAKO_BASE_URL: provider.baseUrl || "https://tako.shiroha.tech",
    };
  }
  return common;
}

export function applyPiSettings(
  settings: Record<string, unknown>,
  provider: ProviderContext,
  selectedOptionIds?: string[],
): { next: Record<string, unknown>; args: string[] } {
  const next = { ...settings };

  if (provider.type === "tako" || provider.type === "custom" || provider.type === "anthropic") {
    next.defaultProvider = "tako";
  }

  const optionModel = selectedOptionIds
    ?.find((id) => id.startsWith("model-"))
    ?.slice("model-".length);
  const model = optionModel || provider.model;
  if (model) next.defaultModel = model;

  if (!asRecord(next.compaction)) {
    next.compaction = {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    };
  }

  const args: string[] = [];
  if (model) args.push("--provider", "tako", "--model", model);
  return { next, args };
}

/**
 * Point Pi at Tako without wiping the user's other packages or skills.
 * Does not persist the API key — tako-pi reads ~/.tako/config.json itself.
 */
export async function setupPiConfigFiles(
  provider: ProviderContext,
  selectedOptionIds?: string[],
  context?: { forLaunch?: boolean },
): Promise<{ args?: string[] } | void> {
  const settings = await readJson(PI_SETTINGS_PATH);
  const { next, args } = applyPiSettings(settings, provider, selectedOptionIds);
  await writeJson(PI_SETTINGS_PATH, next);
  if (context?.forLaunch) {
    const pi = getClient("pi");
    if (pi) await ensureClientReady(pi);
  }
  await ensureTakoPiPackage({ update: !!context?.forLaunch });
  await ensurePiStylePackages();
  return args.length > 0 ? { args } : undefined;
}

export async function listInstalledNpmPackages(dir = PI_NPM_DIR): Promise<string[]> {
  const fs = await import("fs/promises");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scoped = await fs.readdir(join(dir, entry.name), { withFileTypes: true });
        for (const child of scoped) {
          if (child.isDirectory()) names.push(`${entry.name}/${child.name}`);
        }
        continue;
      }
      names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  }
}

async function ensurePiStylePackages(): Promise<void> {
  const bin = await resolvePiBin();
  if (!bin) return;
  const missing = missingPiStylePackages(await listInstalledNpmPackages());
  for (const source of missing) {
    const spin = createSpinner();
    spin.start(`Installing ${source}…`);
    const result = await runPi(bin, ["install", source]);
    if (result.ok) {
      spin.stop(`${source} installed`);
    } else {
      spin.stop();
      log.warn(`${source} install failed: ${shortPiError(result.output)}`);
    }
  }
  await patchPiCcHeaderStaleCtx();
}

function shortPiError(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) || output || "unknown error").slice(0, 300);
}

export function patchPiCcHeaderSource(source: string): { next: string; changed: boolean } {
  if (source.includes(PI_CC_HEADER_STALE_GUARD)) {
    return { next: source, changed: false };
  }
  if (!source.includes(PI_CC_HEADER_STALE_UNGUARDED)) {
    return { next: source, changed: false };
  }
  return {
    next: source.replace(PI_CC_HEADER_STALE_UNGUARDED, PI_CC_HEADER_STALE_GUARD),
    changed: true,
  };
}

export async function patchPiCcHeaderStaleCtx(path = PI_CC_HEADER_FILE): Promise<boolean> {
  const fs = await import("fs/promises");
  try {
    const source = await fs.readFile(path, "utf-8");
    const { next, changed } = patchPiCcHeaderSource(source);
    if (!changed) return false;
    await fs.writeFile(path, next);
    log.info("Patched pi-cc-header for Pi 0.84 stale ctx");
    return true;
  } catch {
    return false;
  }
}
