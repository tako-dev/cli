import { homedir } from "os";
import { join } from "path";
import { ClientConfig, registerClient, type LaunchOption, type ClientLaunchSetupContext } from "./base";
import { readGeminiSettings, setupGeminiNativeMenu } from "./gemini-native";
import type { ProviderContext, Provider } from "../providers/types";
import { getTakoModels } from "../models/tako";

const GEMINI_DIR = join(homedir(), ".gemini");
const GEMINI_SETTINGS_PATH = join(GEMINI_DIR, "settings.json");

/**
 * 预写 ~/.gemini/settings.json，跳过首次 onboarding 的 auth 选择。
 * 只写 Tako 必需的字段，保留用户已有的其他设置。
 */
async function setupGeminiConfigFiles(
  provider: ProviderContext, _selectedOptionIds?: string[], context?: ClientLaunchSetupContext,
) {
  const fs = await import("fs/promises");
  const settings = await readGeminiSettings(GEMINI_SETTINGS_PATH);
  // Gemini accepts JSONC; leave files we cannot parse intact for its own loader.
  if (settings === null) return;
  const security = settings.security;
  if (security !== undefined && (security === null || typeof security !== "object" || Array.isArray(security))) return;
  const securityFields = (security ?? {}) as Record<string, unknown>;
  const auth = securityFields.auth;
  if (auth !== undefined && (auth === null || typeof auth !== "object" || Array.isArray(auth))) return;
  const authFields = (auth ?? {}) as Record<string, unknown>;
  if (authFields.selectedType !== "gemini-api-key") {
    await fs.mkdir(GEMINI_DIR, { recursive: true });
    settings.selectedAuthType = "gemini-api-key";
    settings.security = { ...securityFields, auth: { ...authFields, selectedType: "gemini-api-key" } };
    await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  }
  return setupGeminiNativeMenu(geminiClient, provider, context);
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
