import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TAKO_DIR } from "../config";
import { getFreshTakoModels } from "../models/tako";
import { clientVersionMeets, getInstalledClientVersion } from "../installer";
import type { ProviderContext } from "../providers/types";
import type { ClientConfig, ClientLaunchSetup, ClientLaunchSetupContext } from "./base";

export const GEMINI_NATIVE_MENU_MIN_VERSION = "0.51.0";
// v0.51.0 config/defaultModelConfigs.ts: never replace built-in or auxiliary model aliases.
const RESERVED_ALIASES = new Set([
  "auto", "pro", "flash", "flash-lite", "auto-gemini-3", "auto-gemini-2.5",
  "base", "chat-base", "chat-base-2.5", "chat-base-3",
  "gemini-pro", "gemini-flash", "gemini-flash-lite",
  "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools", "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash",
  "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-2.5-flash-base", "gemini-3-flash-base", "gemini-3.5-flash-base",
  "classifier", "prompt-completion", "fast-ack-helper", "edit-corrector", "summarizer-default", "summarizer-shell",
  "web-search", "web-fetch", "web-fetch-fallback", "loop-detection", "loop-detection-double-check",
  "llm-edit-fixer", "next-speaker-checker", "context-snapshotter", "agent-history-provider-summarizer",
  "chat-compression-3-pro", "chat-compression-3-flash", "chat-compression-3.1-flash-lite",
  "chat-compression-2.5-pro", "chat-compression-2.5-flash", "chat-compression-2.5-flash-lite", "chat-compression-default",
]);
const MAP_NAMES = ["modelDefinitions", "customAliases", "modelIdResolutions"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing is an empty settings layer; unreadable, JSONC and malformed files are never rewritten. */
export async function readGeminiSettings(path: string): Promise<Record<string, unknown> | null> {
  try {
    if ((await stat(path)).size > 1024 * 1024) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return record(parsed) ? parsed : null;
  } catch (error) {
    return record(error) && error.code === "ENOENT" ? {} : null;
  }
}

/** Build a defaults layer without taking ownership of existing routing or disabling choices. */
export function mergeGeminiNativeModels(
  defaults: Record<string, unknown>, layers: Record<string, unknown>[],
  models: { id: string; displayName: string }[],
): Record<string, unknown> | null {
  const owned = new Set<string>();
  for (const layer of [defaults, ...layers]) {
    if (layer.experimental !== undefined) {
      if (!record(layer.experimental) || layer.experimental.dynamicModelConfiguration === false) return null;
    }
    if (layer.modelConfigs === undefined) continue;
    if (!record(layer.modelConfigs)) return null;
    // Explicit low-level collections can affect every model, not just matching definition IDs.
    if (layer.modelConfigs.aliases !== undefined || layer.modelConfigs.overrides !== undefined) return null;
    for (const name of MAP_NAMES) {
      const map = layer.modelConfigs[name];
      if (map === undefined) continue;
      if (!record(map)) return null;
      for (const id of Object.keys(map)) owned.add(id);
    }
  }
  const additions = models.filter(model => !owned.has(model.id) && !RESERVED_ALIASES.has(model.id)
    && !model.id.startsWith("_") && !["__proto__", "constructor", "prototype"].includes(model.id));
  if (!additions.length) return null;
  const output = structuredClone(defaults);
  const configs = record(output.modelConfigs) ? output.modelConfigs : {};
  const definitions = record(configs.modelDefinitions) ? configs.modelDefinitions : {};
  const aliases = record(configs.customAliases) ? configs.customAliases : {};
  const resolutions = record(configs.modelIdResolutions) ? configs.modelIdResolutions : {};
  for (const model of additions) {
    definitions[model.id] = { displayName: model.displayName, tier: "custom", isVisible: true, isPreview: false };
    aliases[model.id] = { modelConfig: { model: model.id } };
    resolutions[model.id] = { default: model.id };
  }
  output.experimental = { ...record(output.experimental) ? output.experimental : {}, dynamicModelConfiguration: true };
  output.modelConfigs = { ...configs, modelDefinitions: definitions, customAliases: aliases, modelIdResolutions: resolutions };
  return output;
}

/** Fresh credential-scoped Gemini models enter the low-precedence Manual menu for this launch only. */
export async function setupGeminiNativeMenu(
  client: ClientConfig, provider: ProviderContext, context?: ClientLaunchSetupContext,
): Promise<ClientLaunchSetup | undefined> {
  if (!context?.forLaunch || (provider.type !== "tako" && provider.type !== "custom")) return;
  // Explicit per-launch defaults remain authoritative in the launcher's final env merge.
  if (context.launchEnvVars?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH !== undefined) return;
  if (!clientVersionMeets(await getInstalledClientVersion(client), GEMINI_NATIVE_MENU_MIN_VERSION)) return;
  const env = { ...process.env, ...context.launchEnvVars };
  const baseUrl = env.GOOGLE_GEMINI_BASE_URL ?? provider.baseUrl;
  const key = env.GEMINI_API_KEY ?? provider.apiKey;
  if (!baseUrl || !key) return;
  const models = getFreshTakoModels(baseUrl, "gemini", key);
  if (!models?.length) return;
  const workingDir = context.workingDir ?? process.cwd();
  const system = resolve(workingDir, env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (platform() === "darwin"
    ? "/Library/Application Support/GeminiCli/settings.json"
    : platform() === "win32" ? "C:\\ProgramData\\gemini-cli\\settings.json" : "/etc/gemini-cli/settings.json"));
  const defaults = resolve(workingDir, env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || join(dirname(system), "system-defaults.json"));
  const files = [defaults, system, join(homedir(), ".gemini/settings.json"), join(workingDir, ".gemini/settings.json")];
  const layers = await Promise.all(files.map(readGeminiSettings));
  const readable: Record<string, unknown>[] = [];
  for (const layer of layers) {
    if (layer === null) return;
    // Refuse environment-expanded settings rather than guessing ownership before Gemini expands them.
    if (JSON.stringify(layer).includes("$")) return;
    readable.push(layer);
  }
  const merged = mergeGeminiNativeModels(readable[0]!, readable.slice(1), models);
  if (!merged) return;
  const directory = join(TAKO_DIR, "gemini", "launch-defaults");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { envVars: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: file }, cleanupFiles: [file] };
}
