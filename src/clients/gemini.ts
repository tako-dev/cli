import { homedir } from "os";
import { join } from "path";
import { ClientConfig, registerClient, type LaunchOption } from "./base";
import type { ProviderContext, Provider } from "../providers/types";
import { getTakoModels } from "../models/tako";

const GEMINI_DIR = join(homedir(), ".gemini");
const GEMINI_SETTINGS_PATH = join(GEMINI_DIR, "settings.json");

/**
 * 预写 ~/.gemini/settings.json，跳过首次 onboarding 的 auth 选择。
 * 只写 Tako 必需的字段，保留用户已有的其他设置。
 */
async function setupGeminiConfigFiles(): Promise<void> {
  const fs = await import("fs/promises");

  try {
    await fs.mkdir(GEMINI_DIR, { recursive: true });
  } catch { /* already exists */ }

  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await fs.readFile(GEMINI_SETTINGS_PATH, "utf-8"));
  } catch { /* file doesn't exist or parse error */ }

  // 确保 auth 类型已设为 gemini-api-key，跳过 onboarding
  const auth = settings.security?.auth || {};
  if (auth.selectedType === "gemini-api-key") {
    return; // 已正确配置，无需修改
  }

  settings.selectedAuthType = "gemini-api-key";
  settings.security = {
    ...settings.security,
    auth: {
      ...auth,
      selectedType: "gemini-api-key",
    },
  };

  await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Launcher models come only from this credential's Gemini-native generateContent catalog. */
export function buildGeminiModelOptions(provider?: Provider): LaunchOption[] {
  if (!provider || (provider.type !== "tako" && provider.type !== "custom") || !provider.baseUrl) return [];
  const models = getTakoModels(provider.baseUrl, "gemini", provider.apiKey);
  if (!models) return [];
  return models.map((entry) => ({
    id: `model-${entry.id}`,
    label: { en: entry.displayName, zh: entry.displayName },
    shortLabel: entry.displayName,
    description: { en: entry.description || `Use ${entry.displayName}`, zh: entry.description || `使用 ${entry.displayName}` },
    flag: `--model ${entry.id}`,
    args: ["--model", entry.id],
    group: "model",
  }));
}

export const geminiClient: ClientConfig = {
  id: "gemini",
  name: "Gemini CLI",
  package: "@google/gemini-cli",
  command: "gemini",
  runtime: "bun", // Gemini CLI 是 JS 应用，需要用 Bun 运行（系统 Node 版本可能过低）
  brandColor: "cyan",

  getEnvVars(provider: ProviderContext) {
    return {
      GEMINI_API_KEY: provider.apiKey!,
      GOOGLE_GEMINI_BASE_URL: provider.baseUrl || "https://tako.shiroha.tech",
    };
  },

  setupConfigFiles: setupGeminiConfigFiles,
  launchOptions: buildGeminiModelOptions,
};

// 自动注册
registerClient(geminiClient);
