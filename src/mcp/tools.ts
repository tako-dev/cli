import {
  TAKO_DEFAULT_AUDIO_MODEL,
  TAKO_DEFAULT_CONSULT_MODEL,
  TAKO_DEFAULT_IMAGE_MODEL,
  TAKO_DEFAULT_VIDEO_MODEL,
  TAKO_IMAGE_ASPECT_RATIOS,
  TAKO_MCP_INITIALIZE_INSTRUCTIONS,
  TAKO_MCP_TOOLS,
  type McpToolDeps,
  type McpToolResult,
} from "./schemas";
import {
  errorResult,
  fetchApiNoRedirect,
  normalizeTakoMcpBaseUrl,
  resolveTakoMcpCredentials,
  truncateText,
} from "./shared";
import { executeTakoGenerateImage } from "./image-tool";
import {
  executeTakoGenerateAudio,
  executeTakoGenerateVideo,
} from "./media-tools";

export {
  TAKO_DEFAULT_AUDIO_MODEL,
  TAKO_DEFAULT_CONSULT_MODEL,
  TAKO_DEFAULT_IMAGE_MODEL,
  TAKO_DEFAULT_VIDEO_MODEL,
  TAKO_IMAGE_ASPECT_RATIOS,
  TAKO_MCP_INITIALIZE_INSTRUCTIONS,
  TAKO_MCP_TOOLS,
  executeTakoGenerateAudio,
  executeTakoGenerateImage,
  executeTakoGenerateVideo,
  normalizeTakoMcpBaseUrl,
  resolveTakoMcpCredentials,
};
export type {
  McpContentItem,
  McpToolDefinition,
  McpToolDeps,
  McpToolResult,
  TakoMcpCredentials,
} from "./schemas";

export async function executeTakoWebSearch(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorResult("'query' is required and must be a non-empty string.");
  }

  let count = 5;
  if (typeof args?.count === "number" && Number.isFinite(args.count)) {
    count = Math.max(1, Math.min(20, Math.floor(args.count)));
  }

  const provider = typeof args?.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined;

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) {
    return errorResult("Tako API key is not configured. Set TAKO_MCP_API_KEY or configure ~/.tako/config.json.");
  }
  if (!creds.baseUrl) {
    return errorResult("Tako base URL is not configured.");
  }

  const url = `${creds.baseUrl}/v1/search`;
  const fetchFn = deps?.fetch ?? globalThis.fetch;

  let res: Response;
  try {
    res = await fetchApiNoRedirect(fetchFn, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        query,
        count,
        ...(provider ? { provider } : {}),
      }),
    });
  } catch (err) {
    return errorResult(`Request to Tako search API failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return errorResult(
      `Tako search API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return errorResult(`Failed to parse Tako search API JSON response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResult("Tako search API returned an unexpected response payload.");
  }

  const data = payload as {
    query?: unknown;
    provider?: unknown;
    answer?: unknown;
    results?: unknown;
  };

  const resultQuery = typeof data.query === "string" && data.query.trim() ? data.query.trim() : query;
  const resultProvider = typeof data.provider === "string" && data.provider.trim() ? data.provider.trim() : undefined;
  const answer = typeof data.answer === "string" && data.answer.trim() ? data.answer.trim() : undefined;
  const results = Array.isArray(data.results) ? data.results : [];

  if (results.length === 0 && !answer) {
    return {
      content: [{ type: "text", text: `No web search results found for "${resultQuery}".` }],
    };
  }

  const header = resultProvider
    ? `Web search results for "${resultQuery}" (provider: ${resultProvider}):`
    : `Web search results for "${resultQuery}":`;

  const blocks: string[] = [header];
  if (answer) blocks.push(`Summary:\n${answer}`);
  if (results.length > 0) {
    const formatted = results.map((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "(untitled)";
      const itemUrl = typeof item.url === "string" ? item.url.trim() : "";
      const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
      const lines = [`${index + 1}. ${title}`];
      if (itemUrl) lines.push(`   URL: ${itemUrl}`);
      if (snippet) lines.push(`   ${snippet}`);
      return lines.join("\n");
    });
    blocks.push(formatted.join("\n\n"));
  }

  return {
    content: [{ type: "text", text: blocks.join("\n\n") }],
  };
}

export async function executeTakoConsult(
  args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const question = typeof args?.question === "string" ? args.question.trim() : "";
  if (!question) return errorResult("'question' is required and must be a non-empty string.");

  const model = typeof args?.model === "string" && args.model.trim() ? args.model.trim() : TAKO_DEFAULT_CONSULT_MODEL;
  const systemPrompt =
    typeof args?.system_prompt === "string" && args.system_prompt.trim()
      ? args.system_prompt.trim()
      : "You are a rigorous technical & strategic second-opinion advisor. Give concise, candid analysis pointing out blind spots, edge cases, and better alternatives.";
  const context = typeof args?.context === "string" && args.context.trim() ? args.context.trim() : "";
  const userMsg = context ? `${question}\n\n<context>\n${context}\n</context>` : question;

  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) return errorResult("Tako API key is not configured.");
  if (!creds.baseUrl) return errorResult("Tako base URL is not configured.");

  const fetchFn = deps?.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
      }),
    });
  } catch (err) {
    return errorResult(`Consult request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return errorResult(`Tako consult API returned HTTP ${res.status}${bodyText ? `: ${truncateText(bodyText)}` : ""}`);
  }

  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  } catch (err) {
    return errorResult(`Failed to parse consult response: ${err instanceof Error ? err.message : String(err)}`);
  }

  const reply = body?.choices?.[0]?.message?.content;
  if (typeof reply !== "string") {
    return errorResult(`Consult response missing choices[0].message.content: ${truncateText(JSON.stringify(body))}`);
  }
  return { content: [{ type: "text", text: `[${model}]\n${reply}` }] };
}

export async function executeTakoAccountStatus(
  _args: Record<string, unknown>,
  deps?: McpToolDeps,
): Promise<McpToolResult> {
  const creds = await resolveTakoMcpCredentials({ env: deps?.env, takoHome: deps?.takoHome });
  if (!creds.apiKey) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          logged_in: false,
          base_url: creds.baseUrl || null,
          error: "Tako API key is not configured.",
        }, null, 2),
      }],
    };
  }

  const fetchFn = deps?.fetch ?? globalThis.fetch;
  let userName: string | null = null;
  let planName: string | null = null;
  let walletRemainUsd: number | null = null;
  let walletUsedUsd: number | null = null;
  let apiId: string | null = null;
  let errMsg: string | null = null;

  try {
    const meRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/api/desktop/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (meRes.ok) {
      const val = (await meRes.json()) as Record<string, unknown>;
      const data = val?.data as Record<string, unknown> | undefined;
      if (val?.success === true && data) {
        const user = data.user as Record<string, unknown> | undefined;
        const plan = data.plan as Record<string, unknown> | undefined;
        const quota = data.quota as Record<string, unknown> | undefined;
        if (typeof user?.name === "string" && user.name.trim()) userName = user.name.trim();
        if (typeof user?.id === "string" && user.id.trim()) apiId = user.id.trim();
        if (typeof plan?.name === "string" && plan.name.trim()) planName = plan.name.trim();
        if (typeof quota?.remain === "number") walletRemainUsd = quota.remain / 500_000;
        if (typeof quota?.used === "number") walletUsedUsd = quota.used / 500_000;
      }
    } else {
      const verifyRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/apiStats/api/verify-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: creds.apiKey }),
      }).catch(() => null);
      if (verifyRes?.ok) {
        const val = (await verifyRes.json()) as Record<string, unknown>;
        const user = val?.user as Record<string, unknown> | undefined;
        const plan = user?.plan as Record<string, unknown> | undefined;
        if (val?.success === true) {
          if (typeof user?.name === "string" && user.name.trim()) userName = user.name.trim();
          if (typeof plan?.name === "string" && plan.name.trim()) planName = plan.name.trim();
        } else {
          errMsg = `API key verification failed (HTTP ${meRes.status})`;
        }
      } else {
        errMsg = `Failed to fetch user profile (HTTP ${meRes.status})`;
      }
    }
  } catch (err) {
    errMsg = `Gateway request failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!apiId) {
    try {
      const idRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/apiStats/api/get-key-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: creds.apiKey }),
      });
      if (idRes.ok) {
        const idJson = (await idRes.json()) as { success?: boolean; data?: { id?: unknown } };
        if (idJson?.success && idJson.data?.id !== undefined) apiId = String(idJson.data.id);
      }
    } catch {
      // Optional apiId lookup failure does not discard user/wallet info.
    }
  }

  let quota: Record<string, unknown> | null = null;
  if (apiId) {
    try {
      const qRes = await fetchApiNoRedirect(fetchFn, `${creds.baseUrl}/apiStats/api/user-quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiId }),
      });
      if (qRes.ok) {
        const qJson = (await qRes.json()) as { plan?: Record<string, unknown>; usage?: Record<string, unknown> };
        if (qJson?.plan && typeof qJson.plan === "object") {
          quota = {
            window_cost_limit: qJson.plan.window_cost_limit ?? 0,
            window_used: qJson.usage?.windowCost ?? 0,
            window_minutes: qJson.plan.window_minutes ?? 300,
            daily_cost_limit: qJson.plan.daily_cost_limit ?? 0,
            daily_used: qJson.usage?.dailyCost ?? 0,
            weekly_cost_limit: qJson.plan.weekly_cost_limit ?? 0,
            weekly_used: qJson.usage?.weeklyCost ?? 0,
          };
        }
      }
    } catch {
      // Quota endpoint is optional.
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        logged_in: userName !== null || errMsg === null,
        user: userName,
        plan: planName,
        wallet_remain_usd: walletRemainUsd,
        wallet_used_usd: walletUsedUsd,
        wallet_remain_display: walletRemainUsd !== null ? `$${walletRemainUsd.toFixed(2)}` : null,
        wallet_used_display: walletUsedUsd !== null ? `$${walletUsedUsd.toFixed(2)}` : null,
        quota,
        base_url: creds.baseUrl,
        error: errMsg,
      }, null, 2),
    }],
  };
}
