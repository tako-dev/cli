/**
 * OpenPanel Client Wrapper
 */

import { OpenPanel } from "@openpanel/sdk";

const OPENPANEL_CLIENT_ID = "d65a6d4b-f702-4af6-98e7-bdb999e01d5f";
const OPENPANEL_CLIENT_SECRET = "sec_1e0ea34016bc3a5f8ef5";
const OPENPANEL_API_URL = "https://op.shiroha.tech/api";

let client: OpenPanel | null = null;

function getClient(): OpenPanel {
  if (!client) {
    client = new OpenPanel({
      clientId: OPENPANEL_CLIENT_ID,
      clientSecret: OPENPANEL_CLIENT_SECRET,
      apiUrl: OPENPANEL_API_URL,
    });
  }
  return client;
}

const pending: Promise<unknown>[] = [];

/**
 * Track 事件
 */
export function trackEvent(
  name: string,
  profileId: string,
  properties: Record<string, unknown>,
): void {
  const p = getClient().track(name, { profileId, ...properties }).catch(() => {});
  pending.push(p);
}

/**
 * Identify 用户
 *
 * OpenPanel identify payload 格式：
 * { profileId, firstName?, lastName?, email?, avatar?, properties? }
 * 必须有 profileId 以外的字段才会真正发 HTTP 请求
 */
export function identifyUser(
  profileId: string,
  properties: Record<string, unknown>,
): void {
  const { email, ...rest } = properties;

  const p = Promise.resolve(getClient().identify({
    profileId,
    // 顶层字段让 OpenPanel profile 面板能显示
    ...(typeof email === "string" ? { email } : {}),
    firstName: String(rest.platform || ""),
    // 其余放 properties
    properties: rest,
  })).catch(() => {});
  pending.push(p);
}

/**
 * Shutdown
 */
export async function shutdown(): Promise<void> {
  await Promise.allSettled(pending);
  pending.length = 0;
  if (client) {
    try { client.flush(); } catch { /* ignore */ }
    client = null;
  }
}
