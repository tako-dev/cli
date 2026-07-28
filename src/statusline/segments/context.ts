import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon, fg } from "../colors";
import { getModelEntry } from "../../models";

const DEFAULT_CONTEXT_LIMIT = 200000;
const DEFAULT_OUTPUT_RESERVE = 8192;
const AUTO_COMPACT_BUFFER_PERCENT = 20;
const MIN_COMPACT_BUFFER = 13000;
export const TAKO_CONTEXT_WINDOW_ENV_KEY = "TAKO_MODEL_CONTEXT_WINDOW";

export function resolveContextLimit(modelId: string, envValue = process.env[TAKO_CONTEXT_WINDOW_ENV_KEY]): number {
  if (envValue) {
    const instanceLimit = Number(envValue);
    if (Number.isSafeInteger(instanceLimit) && instanceLimit > 0) return instanceLimit;
  }
  return getModelEntry(modelId)?.contextWindow ?? DEFAULT_CONTEXT_LIMIT;
}

export function statusLineUsageTokens(input: StatusLineInput): number | null {
  const usage = input.context_window?.current_usage;
  if (!usage) return null;
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
}

export function resolveAutoCompactThreshold(contextLimit: number): number {
  const usable = Math.max(0, contextLimit - Math.min(DEFAULT_OUTPUT_RESERVE, 20000));
  return Math.max(0, Math.min(
    usable - Math.round(usable * AUTO_COMPACT_BUFFER_PERCENT / 100),
    usable - MIN_COMPACT_BUFFER,
  ));
}

/**
 * Context Segment：行内显示自动压缩前的剩余百分比
 * 格式：⚡73%
 *
 * 0% 对齐 Claude Code 的自动压缩触发点，而不是模型的物理上下文上限。
 * 上下文窗口优先使用 tako 启动环境传入的实例值；未传入或无效时才查询
 * models 模块（覆盖全网主流模型 + [1m] 变体），最后回落到 200K。
 */
export class ContextSegment implements Segment {
  id = "context";

  private static cache: { path: string; tokens: number | null; timestamp: number } | null = null;
  private static readonly CACHE_TTL = 5000;

  async render(input: StatusLineInput): Promise<string | null> {
    const statusLineTokens = statusLineUsageTokens(input);
    const tokens = statusLineTokens ?? await this.getTokensWithCache(input.transcript_path);
    const limit = resolveContextLimit(input.model.id);
    const threshold = resolveAutoCompactThreshold(limit);
    const remainingPercent = Math.min(100, Math.max(
      0,
      Math.ceil((((threshold - (tokens ?? 0)) / threshold) * 100)),
    ));

    const icon = getIcon("context");
    const color = remainingPercent <= 20 ? fg.brightRed
      : remainingPercent <= 50 ? fg.brightYellow
      : fg.brightGreen;

    return `${theme.context.icon}${icon}${style.reset} ${color}${remainingPercent}%${style.reset}`;
  }

  private async getTokensWithCache(transcriptPath: string): Promise<number | null> {
    const now = Date.now();
    if (
      ContextSegment.cache &&
      ContextSegment.cache.path === transcriptPath &&
      now - ContextSegment.cache.timestamp < ContextSegment.CACHE_TTL
    ) {
      return ContextSegment.cache.tokens;
    }
    const tokens = await this.parseTranscriptTokens(transcriptPath);
    ContextSegment.cache = { path: transcriptPath, tokens, timestamp: now };
    return tokens;
  }

  private async parseTranscriptTokens(transcriptPath: string): Promise<number | null> {
    try {
      const file = Bun.file(transcriptPath);
      if (!(await file.exists())) return null;
      const content = await file.text();
      if (!content.trim()) return null;

      const lines = content.split("\n").filter((line) => line.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "assistant" && entry.message?.usage) {
            const u = entry.message.usage;
            return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0);
          }
        } catch { continue; }
      }
      return null;
    } catch { return null; }
  }
}
