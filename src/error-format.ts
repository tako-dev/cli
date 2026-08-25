const MAX_ERROR_LEN = 800;

function compactWhitespace(text: string): string {
  return text.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function firstMatchingLine(text: string, patterns: RegExp[]): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (patterns.some((p) => p.test(trimmed))) return trimmed;
  }
  return null;
}

export function summarizeInstallError(raw: string | undefined, fallback = "未知错误"): string {
  const text = compactWhitespace(raw ?? "");
  if (!text) return fallback;

  const httpLine = firstMatchingLine(text, [
    /HTTP error!?\s*status:\s*\d+/i,
    /registry http\s+\d+/i,
    /models\.dev http\s+\d+/i,
  ]);
  if (httpLine) {
    const status = httpLine.match(/\b(?:status:|http)\s*(\d{3})\b/i)?.[1];
    if (status === "524") {
      return "网络请求超时（HTTP 524），registry 或代理上游未及时响应。请稍后重试，或切换 TAKO_REGION/global 后重试。";
    }
    return `网络请求失败：${httpLine}`;
  }

  const bunLine = firstMatchingLine(text, [
    /\b(error|failed|timeout|timed out|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i,
  ]);
  if (bunLine) return bunLine.slice(0, MAX_ERROR_LEN);

  return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}...` : text;
}
