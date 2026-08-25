import { homedir } from "os";
import { join } from "path";
import { ClientConfig, LaunchOption, registerClient } from "./base";
import { PROXY_BASE_URL } from "../config";
import type { ProviderContext, Provider } from "../providers/types";
import { parse, stringify } from "smol-toml";
import { loadCatalog, getTakoModels, filterChatModels } from "../models";
import { BUNDLED_ENTRIES } from "../models/bundled";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const CODEX_AUTH_PATH = join(CODEX_DIR, "auth.json");

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) &&
        result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cleanLegacyConfig(config: Record<string, any>): Record<string, any> {
  if (config.model_providers?.crs) delete config.model_providers.crs;
  if (config.model_provider === "crs") delete config.model_provider;
  if (config.openai_base_url) delete config.openai_base_url;
  const tako = config.model_providers?.tako;
  if (tako) {
    delete tako.wire_api;
    delete tako.request_max_retries;
    delete tako.stream_max_retries;
    delete tako.api_key;
    delete tako.env_key;
  }
  return config;
}

/** 清掉 tako provider 注入的 WS + features 标记。tako 以外的 provider 切换前调用。 */
function stripTakoWsFeatures(config: Record<string, any>): void {
  if (config.model_providers?.tako) delete config.model_providers.tako.supports_websockets;
  if (config.features) {
    delete config.features.multi_agent;
    delete config.features.responses_websockets_v2;
    if (Object.keys(config.features).length === 0) delete config.features;
  }
}

async function setupCodexConfigFiles(
  provider: ProviderContext,
  selectedOptionIds?: string[],
): Promise<void> {
  const fs = await import("fs/promises");
  try { await fs.mkdir(CODEX_DIR, { recursive: true }); } catch { /* exists */ }

  // --- 读取现有 config.toml ---
  let existing: Record<string, any> = {};
  try { existing = parse(await fs.readFile(CODEX_CONFIG_PATH, "utf-8")); } catch { /* noop */ }
  existing = cleanLegacyConfig(existing);

  if (provider.type === "codex-subscription") {
    // ─── 订阅直连：切换 model_provider 到默认，保留所有 provider 定义 ───
    delete existing.model_provider; // 不指定 = Codex 使用内置 ChatGPT OAuth
    existing.check_for_update_on_startup = false;
    existing.remote_compaction_v2 = false;
    stripTakoWsFeatures(existing);

    // auth.json：恢复该账号的 OAuth tokens（多账号切换核心）
    if (provider.authData) {
      await Bun.write(CODEX_AUTH_PATH, JSON.stringify(provider.authData, null, 2) + "\n");
    } else {
      await Bun.write(CODEX_AUTH_PATH, JSON.stringify({ OPENAI_API_KEY: null, auth_mode: "chatgpt" }, null, 2) + "\n");
    }
  } else {
    // ─── Tako / DeepSeek / 自定义代理：切换 model_provider，确保定义存在 ───
    let baseUrl: string;
    if (provider.type === "tako") {
      baseUrl = `${PROXY_BASE_URL}/v1`;
    } else if (provider.type === "deepseek") {
      baseUrl = "https://api.deepseek.com/v1";
    } else {
      baseUrl = `${provider.baseUrl}/v1`;
    }

    // 优先级：launcher 里勾的 model-* > provider.model > gpt-5.5 默认
    const optionModel = selectedOptionIds
      ?.find((id) => id.startsWith("model-"))
      ?.slice("model-".length);
    const model = optionModel || provider.model || "gpt-5.5";
    // GPT 系列走 Codex 内置元数据，不写 model_context_window（避免 par 数据错误带歪
    // Codex，比如曾经把 gpt-5.4 误标 105M）。其它模型 Codex 不认识，需要显式注入。
    // 优先级：bundled catalog → par 服务器返回的目录 → 用户在 provider 上录的 modelContextWindow
    const isGptModel = /^gpt[-.]/i.test(model);
    let ctxWindow: number | undefined;
    if (!isGptModel) {
      const meta = BUNDLED_ENTRIES.find((e) => e.id === model);
      ctxWindow = meta?.contextWindow;
      if (!ctxWindow && (provider.type === "tako" || provider.type === "custom") && provider.baseUrl) {
        const par = getTakoModels(provider.baseUrl, "openai")?.find((e) => e.id === model);
        if (par && par.contextWindow > 0) ctxWindow = par.contextWindow;
      }
      if (!ctxWindow) ctxWindow = provider.modelContextWindow;
    } else {
      // 切到 GPT 模型时清掉旧值，deepMerge 不会自动删 key
      delete existing.model_context_window;
    }
    const takoProvider: Record<string, any> = {
      name: "tako",
      base_url: baseUrl,
      requires_openai_auth: true,
    };
    if (provider.apiKey) {
      takoProvider.experimental_bearer_token = provider.apiKey;
    }
    // 不给 tako provider 开 WS。WS upgrade 是 GET,par 握手阶段拿不到 model 无法
    // 分流 → GPT 的 WS 会被错塞子进程转换 → codex "unsupported call" 死循环。
    // 全部走 POST /v1/responses(POST 带 model,par 能正确分流 GPT 直连 / 非 OpenAI
    // 经子进程)。所有 provider 切换都清掉旧 config 里残留的 WS 标记(旧版升级兜底)。
    stripTakoWsFeatures(existing);
    const cfg: Record<string, any> = {
      model_provider: "tako",
      model,
      check_for_update_on_startup: false,
      remote_compaction_v2: false,
      model_providers: {
        tako: takoProvider,
      },
    };
    if (ctxWindow) cfg.model_context_window = ctxWindow;
    existing = deepMerge(existing, cfg);
  }

  await Bun.write(CODEX_CONFIG_PATH, stringify(existing));
}

export const codexClient: ClientConfig = {
  id: "codex",
  name: "Codex",
  package: "@openai/codex",
  command: "codex",
  runtime: "bun",
  continueArg: "--continue",
  brandColor: "blue",

  getEnvVars(provider: ProviderContext) {
    // Codex 的 API key 通过 config.toml experimental_bearer_token 注入
    return {};
  },

  setupConfigFiles: setupCodexConfigFiles,

  launchOptions: (provider?: Provider) => buildCodexLaunchOptions(provider),
};

// ─── launchOptions 构造逻辑 ──────────────────────────────────────────

const CODEX_BASE_FLAGS: LaunchOption[] = [
  {
    id: "search",
    label: { en: "Web Search", zh: "网络搜索" },
    shortLabel: "Search",
    description: {
      en: "Enable real-time web search",
      zh: "启用实时网页搜索",
    },
    flag: "--search",
    args: ["--search"],
  },
  {
    id: "bypass-sandbox",
    label: { en: "Bypass Sandbox", zh: "绕过审批与沙箱" },
    shortLabel: "Bypass",
    description: {
      en: "DANGEROUS: skip all approvals & sandbox (use only in disposable envs)",
      zh: "危险：跳过所有审批与沙箱限制（仅限隔离/临时环境使用）",
    },
    flag: "--dangerously-bypass-approvals-and-sandbox",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
    defaultOn: true,
  },
];

/**
 * Codex 模型列表跟着 provider 走：
 *  - tako / codex-subscription / custom：GPT-5 系
 *  - deepseek：DeepSeek V4 系（OpenAI-compat 网关）
 */
const CODEX_MODEL_WHITELIST = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.3",
];

const CODEX_DEEPSEEK_WHITELIST = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

function ctxStrOf(ctx: number): string {
  if (ctx >= 1_000_000) return "1M";
  if (ctx > 0) return `${Math.round(ctx / 1000)}k`;
  return "?";
}

/**
 * 优先用 par 服务器返回的 openai 系模型目录（tako/custom provider）。
 * 没缓存（首次启动 / 网络失败）时回退到内置 whitelist。
 */
function buildDynamicCodexModels(provider: Provider): LaunchOption[] | null {
  if (!provider.baseUrl) return null;
  const raw = getTakoModels(provider.baseUrl, "openai");
  if (!raw || raw.length === 0) return null;
  const chat = filterChatModels(raw);
  if (chat.length === 0) return null;
  return chat.map((e) => ({
    id: `model-${e.id}`,
    label: { en: e.displayName, zh: e.displayName },
    shortLabel: e.displayName,
    description: {
      en: `Use ${e.displayName} (${ctxStrOf(e.contextWindow)} ctx)`,
      zh: `使用 ${e.displayName}（上下文 ${ctxStrOf(e.contextWindow)}）`,
    },
    flag: `--model ${e.id}`,
    args: ["--model", e.id],
    group: "model",
  }));
}

function buildCodexModelOptions(provider?: Provider): LaunchOption[] {
  loadCatalog();

  if (provider && (provider.type === "tako" || provider.type === "custom")) {
    const dynamic = buildDynamicCodexModels(provider);
    if (dynamic) return dynamic;
  }

  const ids = provider?.type === "deepseek" ? CODEX_DEEPSEEK_WHITELIST : CODEX_MODEL_WHITELIST;
  const out: LaunchOption[] = [];
  for (const id of ids) {
    const entry = BUNDLED_ENTRIES.find((e) => e.id === id);
    const ctxStr = ctxStrOf(entry?.contextWindow ?? 0);
    const pretty = entry?.displayName ?? id;
    // model + model_context_window 由 setupCodexConfigFiles 直接写进 config.toml
    // （它会读 selectedOptionIds 解析出 model-* 选项），命令行只留个 --model 做提示
    out.push({
      id: `model-${id}`,
      label: { en: pretty, zh: pretty },
      shortLabel: pretty,
      description: {
        en: `Use ${pretty} (${ctxStr} ctx)`,
        zh: `使用 ${pretty}（上下文 ${ctxStr}）`,
      },
      flag: `--model ${id}`,
      args: ["--model", id],
      group: "model",
    });
  }
  return out;
}

function buildCodexLaunchOptions(provider?: Provider): LaunchOption[] {
  return [...CODEX_BASE_FLAGS, ...buildCodexModelOptions(provider)];
}

registerClient(codexClient);
