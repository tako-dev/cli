import { apiErrorText } from "./api-error";
import { PROXY_BASE_URL, updateConfig } from "./config";
import { t } from "./i18n";
import { track, identify, reset as resetAnalytics } from "./analytics";
import { getProviders, addProvider, updateProvider } from "./providers";
import { getDefaultSupportedClients } from "./providers/types";

/**
 * 验证 API Key 格式
 * Key 必须以 cr_ 开头
 */
export function validateKeyFormat(key: string): boolean {
  return key.startsWith("cr_") && key.length > 10;
}

interface ValidateKeyResponse {
  success: boolean;
  data?: {
    id: string;
  };
  error?: string;
}

/**
 * 通过 API 验证 Key 是否有效
 * 调用中转站的 get-key-id 接口
 */
export async function validateKeyWithApi(
  key: string
): Promise<{ valid: boolean; apiId?: string; error?: string }> {
  try {
    const response = await fetch(
      `${PROXY_BASE_URL}/apiStats/api/get-key-id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: key }),
      }
    );

    const data: ValidateKeyResponse = await response.json();

    if (data.success && data.data?.id) {
      return { valid: true, apiId: data.data.id };
    }

    return { valid: false, error: apiErrorText(data, t("auth.validationFailed")) };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : t("auth.networkError"),
    };
  }
}

/**
 * 完整的 Key 验证流程
 * 1. 格式验证
 * 2. API 验证
 * 3. 保存到配置
 */
export async function validateAndSaveKey(
  key: string
): Promise<{ success: boolean; error?: string }> {
  // 格式验证
  if (!validateKeyFormat(key)) {
    track("api_key_validated", { success: false, error_type: "invalid_format" });
    return { success: false, error: t("auth.invalidFormat") };
  }

  // API 验证
  const result = await validateKeyWithApi(key);

  if (!result.valid) {
    track("api_key_validated", { success: false, error_type: "api_validation_failed" });
    return { success: false, error: result.error };
  }

  // 保存��配置
  await updateConfig({
    apiKey: key,
    apiId: result.apiId!,
  });

  // 确保 Tako provider 存在
  await ensureTakoProvider(key, result.apiId!);

  // 验证成功后识别用户
  track("api_key_validated", { success: true });
  resetAnalytics(); // 重置以便用新 apiId 发送 identify
  identify();

  return { success: true };
}

/**
 * 确保 Tako provider 存在，不存在则创建，已存在则更新 key
 */
async function ensureTakoProvider(apiKey: string, apiId: string): Promise<void> {
  const providers = await getProviders();
  const existing = providers.find((p) => p.type === "tako");

  if (existing) {
    await updateProvider(existing.id, { apiKey, apiId });
  } else {
    await addProvider({
      name: "Tako 官方",
      type: "tako",
      apiKey,
      baseUrl: PROXY_BASE_URL,
      apiId,
      supportedClients: getDefaultSupportedClients("tako"),
      builtin: true,
    });
  }
}
