import { homedir } from "os";
import { dirname, join } from "path";
import { parse, stringify } from "smol-toml";
import { ClientConfig, LaunchOption, parsePathLookup, pathLookupCommand, registerClient } from "./base";
import type { Provider, ProviderContext } from "../providers/types";
import { PROXY_BASE_URL, TOOLS_DIR } from "../config";
import { loadCatalog, getTakoModels, filterChatModels, LOCAL_MODEL_OVERRIDES } from "../models";

export const GROK_DEFAULT_MODEL = "grok-4.6";
export const GROK_API_ENV_KEY = "TAKO_GROK_API_KEY";
export const GROK_MANAGED_PREFIX = "tako-";
export const GROK_INSTALL_SCRIPT_URL = "https://x.ai/cli/install.sh";

const GROK_DIR = join(homedir(), ".grok");
const GROK_CONFIG_PATH = join(GROK_DIR, "config.toml");

export const GROK_FALLBACK_MODELS = [
  { id: "grok-4.6", displayName: "Grok 4.6", contextWindow: 500000 },
  { id: "grok-4.5", displayName: "Grok 4.5", contextWindow: 500000 },
  { id: "composer-2.5", displayName: "Composer 2.5", contextWindow: 0 },
] as const;

export function grokBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "grok.exe" : "grok";
}

export function grokBinCandidates(
  home: string,
  toolsDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const name = grokBinaryName(platform);
  return [
    join(toolsDir, "grok", "bin", name),
    join(home, ".grok", "bin", name),
    join(home, ".local", "bin", name),
  ];
}

export function parseGrokVersion(output: string): string | null {
  const match = output.match(/grok\s+(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/i);
  return match?.[1] ?? null;
}

export function isGrokFamilyModel(id: string): boolean {
  if (/^cursor-/i.test(id)) return false;
  return /^(grok[-_.]|composer-2\.5$)/i.test(id);
}

export function takoGrokModelId(slug: string): string {
  return slug.startsWith(GROK_MANAGED_PREFIX) ? slug : `${GROK_MANAGED_PREFIX}${slug}`;
}

export function takoGrokSlug(logicalId: string): string {
  return logicalId.startsWith(GROK_MANAGED_PREFIX)
    ? logicalId.slice(GROK_MANAGED_PREFIX.length)
    : logicalId;
}

export function resolveGrokBaseUrl(provider: Pick<ProviderContext, "type" | "baseUrl">): string {
  if (provider.type === "tako") return `${PROXY_BASE_URL.replace(/\/+$/, "")}/v1`;
  const base = (provider.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return `${PROXY_BASE_URL.replace(/\/+$/, "")}/v1`;
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function buildGrokModelBlock(opts: {
  slug: string;
  displayName?: string;
  baseUrl: string;
  contextWindow?: number;
}): Record<string, unknown> {
  const pretty = opts.displayName ?? opts.slug;
  const block: Record<string, unknown> = {
    model: opts.slug,
    base_url: opts.baseUrl,
    name: `${pretty} via Tako`,
    description: `${pretty} through Tako`,
    env_key: GROK_API_ENV_KEY,
    api_backend: "responses",
    supports_reasoning_effort: isGrokFamilyModel(opts.slug),
  };
  if (opts.contextWindow && opts.contextWindow > 0) {
    block.context_window = opts.contextWindow;
  }
  return block;
}

export function applyTakoGrokModels(
  existing: Record<string, any>,
  models: Record<string, Record<string, unknown>>,
): Record<string, any> {
  const next = { ...existing };
  const current = {
    ...(next.model && typeof next.model === "object" && !Array.isArray(next.model)
      ? next.model
      : {}),
  };
  for (const key of Object.keys(current)) {
    if (key.startsWith(GROK_MANAGED_PREFIX)) delete current[key];
  }
  Object.assign(current, models);
  next.model = current;
  return next;
}

function ctxStrOf(ctx: number): string {
  if (ctx >= 1_000_000) return "1M";
  if (ctx > 0) return `${Math.round(ctx / 1000)}k`;
  return "?";
}

export function collectGrokCatalogModels(provider?: Provider): Array<{
  id: string;
  displayName: string;
  contextWindow: number;
}> {
  loadCatalog();
  if (provider && (provider.type === "tako" || provider.type === "custom") && provider.baseUrl) {
    const raw = getTakoModels(provider.baseUrl, "openai") ?? getTakoModels(provider.baseUrl, "claude");
    const chat = raw ? filterChatModels(raw).filter((entry) => isGrokFamilyModel(entry.id)) : [];
    if (chat.length > 0) {
      return chat.map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        contextWindow: entry.contextWindow > 0
          ? entry.contextWindow
          : (LOCAL_MODEL_OVERRIDES[entry.id]?.contextWindow ?? 0),
      }));
    }
  }

  return GROK_FALLBACK_MODELS.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    contextWindow: LOCAL_MODEL_OVERRIDES[entry.id]?.contextWindow ?? entry.contextWindow,
  }));
}

export function resolveSelectedGrokSlug(
  selectedOptionIds: string[] | undefined,
  providerModel: string | undefined,
  catalog: Array<{ id: string }>,
): string {
  const fromOption = selectedOptionIds
    ?.find((id) => id.startsWith("model-"))
    ?.slice("model-".length);
  if (fromOption) return takoGrokSlug(fromOption);

  const ids = new Set(catalog.map((entry) => entry.id));
  if (providerModel && ids.has(takoGrokSlug(providerModel))) return takoGrokSlug(providerModel);
  if (ids.has(GROK_DEFAULT_MODEL)) return GROK_DEFAULT_MODEL;
  return catalog[0]?.id ?? GROK_DEFAULT_MODEL;
}

export function buildGrokModelOptions(provider?: Provider): LaunchOption[] {
  return collectGrokCatalogModels(provider).map((entry) => ({
    id: `model-${entry.id}`,
    label: { en: entry.displayName, zh: entry.displayName },
    shortLabel: entry.contextWindow > 0
      ? `${entry.displayName} · ${ctxStrOf(entry.contextWindow)} ctx`
      : entry.displayName,
    description: {
      en: `Use ${entry.displayName} via Tako (${ctxStrOf(entry.contextWindow)} ctx)`,
      zh: `经 Tako 使用 ${entry.displayName}（上下文 ${ctxStrOf(entry.contextWindow)}）`,
    },
    flag: `--model ${takoGrokModelId(entry.id)}`,
    args: ["-m", takoGrokModelId(entry.id)],
    group: "model",
  }));
}

export function mapGrokPassthroughModel(modelId: string): string {
  const slug = takoGrokSlug(modelId);
  if (isGrokFamilyModel(slug) || GROK_FALLBACK_MODELS.some((entry) => entry.id === slug)) {
    return takoGrokModelId(slug);
  }
  return modelId;
}

export async function resolveGrokBin(opts?: {
  home?: string;
  toolsDir?: string;
  platform?: NodeJS.Platform;
  lookup?: () => Promise<string | undefined>;
}): Promise<string | null> {
  const home = opts?.home ?? homedir();
  const toolsDir = opts?.toolsDir ?? TOOLS_DIR;
  const platform = opts?.platform ?? process.platform;
  const fs = await import("fs/promises");

  for (const candidate of grokBinCandidates(home, toolsDir, platform)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  if (opts?.lookup) {
    return (await opts.lookup()) ?? null;
  }

  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(pathLookupCommand("grok", platform), { encoding: "utf8" });
    return parsePathLookup(output, platform) ?? null;
  } catch {
    return null;
  }
}

export async function readGrokVersion(binPath?: string): Promise<string | null> {
  const resolved = binPath ?? await resolveGrokBin();
  if (!resolved) return null;
  try {
    const proc = Bun.spawn([resolved, "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = `${await new Response(proc.stdout).text()} ${await new Response(proc.stderr).text()}`;
    await proc.exited;
    return parseGrokVersion(text);
  } catch {
    return null;
  }
}

export async function installGrokOfficial(version?: string): Promise<{ success: boolean; error?: string }> {
  if (process.platform === "win32") {
    try {
      const { execSync } = await import("node:child_process");
      execSync("where bash", { encoding: "utf8" });
    } catch {
      return {
        success: false,
        error: "Grok Build 官方安装脚本需要 Git Bash。也可先手动安装：https://x.ai/cli/install.sh",
      };
    }
  }

  const fs = await import("fs/promises");
  const binDir = join(TOOLS_DIR, "grok", "bin");
  await fs.mkdir(binDir, { recursive: true });

  let script: string;
  try {
    const res = await fetch(GROK_INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      return { success: false, error: `下载 Grok 安装脚本失败：HTTP ${res.status}` };
    }
    script = await res.text();
  } catch (error) {
    return {
      success: false,
      error: `无法下载 ${GROK_INSTALL_SCRIPT_URL}：${error instanceof Error ? error.message : "网络错误"}`,
    };
  }

  const scriptPath = join(binDir, "install.sh");
  await fs.writeFile(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

  const args = version && version !== "latest"
    ? ["bash", scriptPath, version]
    : ["bash", scriptPath];
  const proc = Bun.spawn(args, {
    cwd: binDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GROK_BIN_DIR: binDir },
  });
  const output = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;
  if (code !== 0) {
    return {
      success: false,
      error: `Grok 官方安装失败（exit ${code}）。也可手动执行：curl -fsSL ${GROK_INSTALL_SCRIPT_URL} | bash${version && version !== "latest" ? ` -s ${version}` : ""}\n${output.slice(0, 400).trim()}`,
    };
  }

  const installed = await resolveGrokBin();
  if (!installed) {
    return { success: false, error: "安装脚本已跑完，但找不到 grok 二进制" };
  }
  return { success: true };
}

export async function writeGrokConfigFile(
  provider: ProviderContext,
  _selectedOptionIds: string[] | undefined,
  configPath: string,
): Promise<{ args?: string[] }> {
  const fs = await import("fs/promises");
  await fs.mkdir(dirname(configPath), { recursive: true });

  let existing: Record<string, any> = {};
  try {
    existing = parse(await fs.readFile(configPath, "utf-8"));
  } catch {
    // new file
  }

  const baseUrl = resolveGrokBaseUrl(provider);
  const catalog = collectGrokCatalogModels({
    id: "tmp",
    name: "tmp",
    type: provider.type,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    createdAt: "",
  });
  const blocks: Record<string, Record<string, unknown>> = {};
  for (const entry of catalog) {
    blocks[takoGrokModelId(entry.id)] = buildGrokModelBlock({
      slug: entry.id,
      displayName: entry.displayName,
      baseUrl,
      contextWindow: entry.contextWindow,
    });
  }

  const next = applyTakoGrokModels(existing, blocks);
  await fs.writeFile(configPath, `${stringify(next)}\n`, { encoding: "utf-8", mode: 0o600 });

  // 不在这里回传 -m/--model。picker / --grok 透传各会带一次；
  // setup 再带一次会触发 grok: argument cannot be used multiple times。
  return {};
}

async function setupGrokConfigFiles(
  provider: ProviderContext,
  selectedOptionIds?: string[],
): Promise<{ args: string[] }> {
  return writeGrokConfigFile(provider, selectedOptionIds, GROK_CONFIG_PATH);
}

export const grokClient: ClientConfig = {
  id: "grok",
  name: "Grok Build",
  package: "system:grok",
  command: "grok",
  runtime: "native",
  install: "system",
  continueArg: "--continue",
  brandColor: "white",
  resolveBin: () => resolveGrokBin(),
  readSystemVersion: () => readGrokVersion(),
  installSystem: (version?: string) => installGrokOfficial(version),

  getEnvVars(provider: ProviderContext) {
    return {
      [GROK_API_ENV_KEY]: provider.apiKey ?? "",
    };
  },

  setupConfigFiles: setupGrokConfigFiles,

  launchOptions: (provider?: Provider) => [
    {
      id: "always-approve",
      label: { en: "Always Approve", zh: "始终批准" },
      shortLabel: "Approve",
      description: {
        en: "Auto-approve all tool executions",
        zh: "自动批准全部工具执行",
      },
      flag: "--always-approve",
      args: ["--always-approve"],
    },
    ...buildGrokModelOptions(provider),
  ],
};

registerClient(grokClient);
