/**
 * Provider 选择和检测逻辑（非 UI，被 index.ts 和 ui/index.ts 引用）
 */

import {
  getDefaultProvider,
  getClientProvider,
  getProvidersForClient,
  resolveProviderContext,
  detectProviders,
  mergeDetectedProviders,
  migrateIfNeeded,
} from "../providers";
import { loadConfig } from "../config";
import type { ProviderContext } from "../providers/types";
import { track, identify, reset as resetAnalytics } from "../analytics";

/**
 * 为客户端自动选择 ProviderContext（快捷启动用，不弹 UI）
 *
 * 优先级：客户端绑定 → 默认 Provider → 第一个兼容的
 */
export async function selectProviderForClient(
  clientId: string,
): Promise<ProviderContext | null> {
  let compatible = await getProvidersForClient(clientId);
  if (compatible.length === 0) {
    if (await migrateIfNeeded()) {
      compatible = await getProvidersForClient(clientId);
    }
  }
  if (compatible.length === 0) return null;

  const config = await loadConfig();
  const fallbackAgyKey = config.agyApiKey;

  // 1. 客户端绑定
  const bound = await getClientProvider(clientId);
  if (bound) return resolveProviderContext(bound, fallbackAgyKey);

  // 2. 默认 Provider
  if (compatible.length === 1) return resolveProviderContext(compatible[0], fallbackAgyKey);
  const defaultProv = await getDefaultProvider();
  if (defaultProv && compatible.some((p) => p.id === defaultProv.id)) {
    return resolveProviderContext(defaultProv, fallbackAgyKey);
  }

  // 3. 第一个兼容的
  return resolveProviderContext(compatible[0], fallbackAgyKey);
}

/**
 * 首次启动时自动检测订阅
 */
export async function runProviderDetection(): Promise<void> {
  const detected = await detectProviders();
  const added = await mergeDetectedProviders(detected);
  if (added > 0) {
    for (const prov of detected) {
      track("provider_added", { provider_type: prov.type, method: "auto_detect" });
    }
    resetAnalytics();
    identify();
  }
}
