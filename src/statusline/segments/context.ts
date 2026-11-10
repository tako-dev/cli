import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon, fg } from "../colors";
import { getModelEntry } from "../../models";

const DEFAULT_CONTEXT_LIMIT = 200000;
const OUTPUT_RESERVE_CAP = 20000;
const MIN_COMPACT_BUFFER = 13000;
export const TAKO_CONTEXT_WINDOW_ENV_KEY = "TAKO_MODEL_CONTEXT_WINDOW";
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

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

/**
 * Claude Code 的 statusline input 已经带当前模型的实际 context_window_size。
 * 优先用它，避免 tako 的 env / models.dev 兜底和 Claude Code 自己不一致。
 * 老版本 Claude Code 没有这个字段时才回落到 env / catalog。
 */
export function resolveStatusLineContextLimit(input: StatusLineInput): number {
  const fromInput = input.context_window?.context_window_size;
  if (typeof fromInput === "number" && Number.isSafeInteger(fromInput) && fromInput > 0) {
    return fromInput;
  }
  return resolveContextLimit(input.model.id);
}

/**
 * Claude Code 的自动压缩窗口可能被 CLAUDE_CODE_AUTO_COMPACT_WINDOW 调低。
 * tako 启动时会设置它；如果用户自己调低，statusline 也跟着用。
 */
export function resolveAutoCompactWindow(
  contextLimit: number,
  envValue = process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY],
): number {
  if (envValue) {
    const configured = Number(envValue);
    if (Number.isSafeInteger(configured) && configured > 0) return Math.min(contextLimit, configured);
  }
  return contextLimit;
}

/**
 * 对齐 Claude Code 的自动压缩阈值：
 *   window - min(maxOutputTokens, 20000) - 13000
 *
 * statusline input 不带 maxOutputTokens，默认按 Claude Code 的 20000 上限算。
 * 不要用 20% precompute buffer——那是 Claude Code 提前预计算摘要的阈值，
 * 不是真正触发 compaction 的阈值（旧实现抄错了，导致 1M 窗口提前约 17 万
 * token 归零）。
 */
export function resolveAutoCompactThreshold(
  contextLimit: number,
  maxOutputTokens = OUTPUT_RESERVE_CAP,
): number {
  const reserve = Math.min(Math.max(0, maxOutputTokens), OUTPUT_RESERVE_CAP);
  const usable = Math.max(0, contextLimit - reserve);
  return Math.max(0, usable - MIN_COMPACT_BUFFER);
}

/**
 * Context Segment：行内显示自动压缩前的剩余百分比
 * 格式：⚡73%
 *
 * 0% 对齐 Claude Code 的自动压缩触发点，而不是模型的物理上下文上限。
 * 窗口优先用 statusline input 的 context_window_size；老版本没有时才回落到
 * tako 启动环境传入的实例值，再查 models 模块，最后回落到 200K。
 */
export class ContextSegment implements Segment {
  id = "context";

  private static cache: { path: string; tokens: number | null; timestamp: number } | null = null;
  private static readonly CACHE_TTL = 5000;

  async render(input: StatusLineInput): Promise<string | null> {
    const statusLineTokens = statusLineUsageTokens(input);
    const tokens = statusLineTokens ?? await this.getTokensWithCache(input.transcript_path);
    const limit = resolveStatusLineContextLimit(input);
    const compactWindow = resolveAutoCompactWindow(limit);
    const threshold = resolveAutoCompactThreshold(compactWindow);
    if (threshold <= 0) return null;
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
