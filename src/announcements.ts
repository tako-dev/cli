/**
 * 远端公告：从默认 tako provider 拉服务端推送的弹窗公告。
 *
 * 设计目标：admin 在 par 后台推一条 popup → 所有 CLI 启动时自动看见，无需发版。
 *
 * 行为：
 *  1. 启动时调 `fetchAndMaybeShow()` —— 拉 `${baseUrl}/v1/announcements/popup`
 *  2. 服务端返回最新一条 popup=true 的公告（或 null）
 *  3. 若 `popup_once=true` 且本地已记录该 id 为「看过」→ 跳过
 *  4. 否则弹窗展示，关闭后若 `popup_once=true` 把 id 写入 config.seenAnnouncementIds
 *
 * 容错：
 *  - 没默认 provider / 网络失败 / 解析失败 → 全部静默跳过，绝不阻塞 launcher
 *  - 配 2s 超时，避免拖慢启动
 *  - seenAnnouncementIds 在 100 条以上自动裁剪（FIFO），避免 config 无限膨胀
 */
import { loadConfig, saveConfig, IS_DEV } from "./config";
import { getDefaultProvider, getProviders } from "./providers";
import type { Provider } from "./providers/types";
import {
  showAnnouncementPrompt,
  type AnnouncementPayload,
} from "./ui/shared/terminal";

const FETCH_TIMEOUT_MS = 2_000;
const MAX_SEEN_IDS = 100;

// dev 或 TAKO_DEBUG 模式下打到 stderr，方便排查为啥公告没弹
function debug(msg: string): void {
  if (IS_DEV || process.env.TAKO_DEBUG === "1") {
    process.stderr.write(`[announcements] ${msg}\n`);
  }
}

interface PopupResponse {
  announcement?: {
    id?: string;
    title?: string;
    content?: string;
    type?: string;
    popup_once?: boolean;
  } | null;
}

function pickFetchTarget(provider: Provider | undefined): { baseUrl: string; apiKey: string } | null {
  if (!provider) return null;
  if (provider.type !== "tako" && provider.type !== "custom") return null;
  if (!provider.baseUrl || !provider.apiKey) return null;
  return { baseUrl: provider.baseUrl.replace(/\/+$/, ""), apiKey: provider.apiKey };
}

async function fetchPopup(baseUrl: string, apiKey: string): Promise<AnnouncementPayload | null> {
  const url = `${baseUrl}/v1/announcements/popup`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      debug(`HTTP ${res.status} from ${url}（par 可能未部署新路由 /v1/announcements/popup）`);
      return null;
    }
    const json = (await res.json()) as PopupResponse;
    const a = json?.announcement;
    if (!a) {
      debug(`返回 announcement=null（par 后台没有 published+popup=true 的公告）`);
      return null;
    }
    if (typeof a.id !== "string" || typeof a.title !== "string") {
      debug(`payload 缺 id/title，丢弃：${JSON.stringify(a)}`);
      return null;
    }
    debug(`拉到公告 id=${a.id} title=${a.title} popup_once=${!!a.popup_once}`);
    return {
      id: a.id,
      title: a.title,
      content: a.content ?? "",
      type: a.type,
      popup_once: !!a.popup_once,
    };
  } catch (e) {
    debug(`fetch 失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function hasSeen(id: string): Promise<boolean> {
  const config = await loadConfig();
  return (config.seenAnnouncementIds ?? []).includes(id);
}

async function markSeen(id: string): Promise<void> {
  const config = await loadConfig();
  const existing = config.seenAnnouncementIds ?? [];
  if (existing.includes(id)) return;
  const next = [...existing, id];
  if (next.length > MAX_SEEN_IDS) next.splice(0, next.length - MAX_SEEN_IDS);
  config.seenAnnouncementIds = next;
  await saveConfig(config);
}

/**
 * 选拉公告用的 provider：默认 provider 优先（如果是 tako/custom），否则扫所有
 * provider 取第一个能用的 tako/custom。这样默认是 codex-subscription /
 * claude-subscription 时也能从用户配的 tako provider 拉公告。
 */
async function pickAnyTakoTarget(): Promise<{ baseUrl: string; apiKey: string } | null> {
  const def = pickFetchTarget(await getDefaultProvider());
  if (def) return def;
  for (const p of await getProviders()) {
    const t = pickFetchTarget(p);
    if (t) return t;
  }
  return null;
}

/**
 * 启动入口：拉公告 → 决定是否弹 → 若弹了且 popup_once 则记号已看过。
 * 任何一步失败都静默跳过，不影响 launcher。
 */
export async function fetchAndMaybeShowAnnouncement(): Promise<void> {
  const target = await pickAnyTakoTarget();
  if (!target) {
    debug(`跳过：没有可用的 tako/custom provider（apiKey + baseUrl）`);
    return;
  }

  debug(`查询公告：${target.baseUrl}/v1/announcements/popup`);
  const ann = await fetchPopup(target.baseUrl, target.apiKey);
  if (!ann) return;

  if (ann.popup_once && (await hasSeen(ann.id))) {
    debug(`已在 seenAnnouncementIds，跳过：${ann.id}`);
    return;
  }

  debug(`弹窗：${ann.id}`);
  await showAnnouncementPrompt(ann);

  if (ann.popup_once) {
    await markSeen(ann.id);
    debug(`标记已看过：${ann.id}`);
  }
}

// ─── 测试用导出 ────────────────────────────────────────────
export const _internal = { fetchPopup, hasSeen, markSeen, pickFetchTarget };
