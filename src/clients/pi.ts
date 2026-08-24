import { ClientConfig, LaunchOption, registerClient } from "./base";
import type { Provider } from "../providers/types";
import { loadCatalog, getTakoModels, filterChatModels } from "../models";
import { BUNDLED_ENTRIES } from "../models/bundled";
import { setupPiConfigFiles, takoPiEnv } from "./pi-settings";

export { setupPiConfigFiles, takoPiEnv } from "./pi-settings";

export const PI_DEFAULT_MODEL = "grok-4.6";
const FALLBACK_MODELS = [PI_DEFAULT_MODEL, "mimo-v2.5", "kimi-k2.7-code"];

function ctxStrOf(ctx: number): string {
  if (ctx >= 1_000_000) return "1M";
  if (ctx > 0) return `${Math.round(ctx / 1000)}k`;
  return "?";
}

function buildDynamicPiModels(provider: Provider): LaunchOption[] | null {
  if (!provider.baseUrl) return null;
  const raw = getTakoModels(provider.baseUrl, "claude") ?? getTakoModels(provider.baseUrl, "openai");
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
    args: ["--provider", "tako", "--model", e.id],
    group: "model",
  }));
}

export function buildPiModelOptions(provider?: Provider): LaunchOption[] {
  loadCatalog();

  if (provider && (provider.type === "tako" || provider.type === "custom")) {
    const dynamic = buildDynamicPiModels(provider);
    if (dynamic) return dynamic;
  }

  const out: LaunchOption[] = [];
  for (const id of FALLBACK_MODELS) {
    const entry = BUNDLED_ENTRIES.find((e) => e.id === id);
    const pretty = entry?.displayName ?? id;
    out.push({
      id: `model-${id}`,
      label: { en: pretty, zh: pretty },
      shortLabel: pretty,
      description: {
        en: `Use ${pretty} (${ctxStrOf(entry?.contextWindow ?? 0)} ctx)`,
        zh: `使用 ${pretty}（上下文 ${ctxStrOf(entry?.contextWindow ?? 0)}）`,
      },
      flag: `--model ${id}`,
      args: ["--provider", "tako", "--model", id],
      group: "model",
    });
  }
  return out;
}

export const piClient: ClientConfig = {
  id: "pi",
  name: "Pi",
  package: "@earendil-works/pi-coding-agent",
  command: "pi",
  runtime: "node",
  continueArg: "--continue",
  brandColor: "magenta",

  getEnvVars: takoPiEnv,
  setupConfigFiles: setupPiConfigFiles,
  launchOptions: (provider?: Provider) => [
    {
      id: "web",
      label: { en: "Web UI", zh: "浏览器界面" },
      shortLabel: "Web",
      description: {
        en: "Open the same Pi sessions and plugins in the browser",
        zh: "用浏览器打开同一套 Pi 会话和插件",
      },
      flag: "--web",
      args: [],
    },
    {
      id: "no-session",
      label: { en: "No Session", zh: "不保存会话" },
      shortLabel: "Ephemeral",
      description: {
        en: "Do not write a session file",
        zh: "本次不写 session 文件",
      },
      flag: "--no-session",
      args: ["--no-session"],
    },
    ...buildPiModelOptions(provider),
  ],
};

registerClient(piClient);
