import { PROXY_BASE_URL, loadConfig } from "./config";
import { resolveTakoApiId } from "./quota/tako";

interface UserStatsResponse {
  success: boolean;
  data?: {
    id: string;
    name: string;
    usage: {
      total: {
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheCreateTokens: number;
        cacheReadTokens: number;
        allTokens: number;
        requests: number;
        cost: number;
        formattedCost: string;
      };
    };
    limits: {
      currentDailyCost: number;
      currentTotalCost: number;
      currentWindowRequests: number;
    };
  };
  error?: string;
  message?: string;
}

interface ModelStatsItem {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  allTokens: number;
  costs: {
    total: number;
  };
  formatted: {
    total: string;
  };
}

interface ModelStatsResponse {
  success: boolean;
  data?: ModelStatsItem[];
  period?: string;
  error?: string;
  message?: string;
}

export interface UsageStats {
  totalRequests: number;
  totalCost: string;
  todayCost: string;
  modelStats: Array<{
    model: string;
    requests: number;
    cost: string;
  }>;
}

/**
 * 获取用户用量统计
 */
export async function getUserStats(): Promise<{
  success: boolean;
  data?: UsageStats;
  error?: string;
}> {
  try {
    const config = await loadConfig();
    const provider = (config.providers ?? []).find((item) => item.type === "tako");
    if (!provider) {
      return { success: false, error: "未配置 Tako provider" };
    }
    if (!provider.apiKey) {
      return { success: false, error: "Tako provider 缺少 API key，请重新配置" };
    }

    const resolved = await resolveTakoApiId(provider.apiKey);
    if (!resolved.valid) {
      return { success: false, error: resolved.message };
    }
    const apiId = resolved.apiId;

    // 获取基础统计
    const statsResponse = await fetch(
      `${PROXY_BASE_URL}/apiStats/api/user-stats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiId }),
      }
    );

    const statsData: UserStatsResponse = await statsResponse.json();

    // 获取模型统计
    const modelResponse = await fetch(
      `${PROXY_BASE_URL}/apiStats/api/user-model-stats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiId, period: "daily" }),
      }
    );

    const modelData: ModelStatsResponse = await modelResponse.json();

    if (!statsData.success) {
      return { success: false, error: statsData.error || statsData.message || "获取统计失败" };
    }

    // 解析模型统计
    const modelStats = (modelData.data || []).map((item) => ({
      model: item.model,
      requests: item.requests,
      cost: item.formatted?.total || "$0.00",
    }));

    return {
      success: true,
      data: {
        totalRequests: statsData.data?.usage?.total?.requests || 0,
        totalCost: statsData.data?.usage?.total?.formattedCost || "$0.00",
        todayCost: `$${(statsData.data?.limits?.currentDailyCost || 0).toFixed(2)}`,
        modelStats,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "网络请求失败",
    };
  }
}

/**
 * 格式化数字（添加千位分隔符）
 */
export function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

