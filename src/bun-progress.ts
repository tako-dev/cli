/**
 * 解析 bun add / bun update 的 stderr/stdout，把关键阶段喂给 spinner。
 *
 * bun 在 pipe 模式下不会输出 ANSI 进度条，只输出固定格式的阶段日志，
 * 跨平台一致（macOS / Linux / Windows）。我们抓 4 个关键阶段：
 *   - "Resolving dependencies"           → 解析依赖
 *   - "Resolved, downloaded and extracted [N]" → 下载并解压（N 是真实包数）
 *   - "Saved lockfile"                   → 写入 lockfile
 *   - "N packages? installed [Xms]"      → 安装完成
 *
 * 同时叠一个心跳定时器，每秒刷新 elapsed 时间，让用户视觉上知道进程没卡死。
 */

export function renderProgressBar(percent: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${clamped}%`;
}

export function formatDownloadProgress(
  prefix: string,
  downloaded: number,
  total: number | null,
  elapsedSec?: number,
): string {
  const dlMb = (downloaded / 1024 / 1024).toFixed(1);
  const speed =
    elapsedSec && elapsedSec > 0
      ? ` · ${(downloaded / 1024 / 1024 / elapsedSec).toFixed(1)} MB/s`
      : "";
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    const totalMb = (total / 1024 / 1024).toFixed(1);
    return `${prefix} ${renderProgressBar(pct)} (${dlMb}/${totalMb} MB${speed})`;
  }
  return `${prefix} (${dlMb} MB${speed})`;
}

export interface PhaseState {
  phase: string;
  pkgCount: number;
  elapsedSec: number;
}

const RE_RESOLVING = /^Resolving dependencies/;
const RE_RESOLVED = /^Resolved, downloaded and extracted \[(\d+)\]/;
const RE_LOCKFILE = /^Saved lockfile/;
const RE_INSTALLED = /^(\d+) packages? installed/;

function phasePercent(s: PhaseState): number {
  switch (s.phase) {
    case "完成":
      return 100;
    case "写入 lockfile":
      return 92;
    case "下载并解压":
      return Math.min(85, 48 + s.elapsedSec * 2);
    case "解析依赖":
      return Math.min(38, 20 + s.elapsedSec * 2);
    default:
      return Math.min(15, 8 + s.elapsedSec);
  }
}

function formatPhase(prefix: string, s: PhaseState): string {
  const parts: string[] = [];
  if (s.phase) parts.push(s.phase);
  else parts.push("准备中");
  if (s.pkgCount > 0) parts.push(`已处理 ${s.pkgCount} 个包`);
  parts.push(`${s.elapsedSec}s`);
  return `${prefix} ${renderProgressBar(phasePercent(s))} · ${parts.join(" · ")}`;
}

/**
 * 流式读取 bun add/update 的输出并按阶段更新 spinner 文案。
 * 返回完整的 stderr 文本（用于失败时展示给用户）。
 */
export async function streamBunInstall(
  proc: { stderr: ReadableStream<Uint8Array> | null; stdout: ReadableStream<Uint8Array> | null },
  prefix: string,
  onUpdate: (msg: string) => void,
): Promise<string> {
  const start = Date.now();
  const state: PhaseState = { phase: "正在准备", pkgCount: 0, elapsedSec: 0 };
  const allLines: string[] = [];

  const tick = () => {
    state.elapsedSec = Math.floor((Date.now() - start) / 1000);
    onUpdate(formatPhase(prefix, state));
  };
  tick();
  const heartbeat = setInterval(tick, 1000);

  const handleLine = (line: string) => {
    if (!line) return;
    allLines.push(line);
    if (RE_RESOLVING.test(line)) state.phase = "解析依赖";
    else if (RE_RESOLVED.test(line)) {
      state.phase = "下载并解压";
      const m = line.match(RE_RESOLVED);
      if (m) state.pkgCount = parseInt(m[1], 10);
    } else if (RE_LOCKFILE.test(line)) state.phase = "写入 lockfile";
    else if (RE_INSTALLED.test(line)) state.phase = "完成";
    tick();
  };

  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Windows 行分隔符 \r\n → 去掉 \r 再 split
        buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      if (buf) handleLine(buf);
    } finally {
      reader.releaseLock();
    }
  };

  try {
    await Promise.all([drain(proc.stderr), drain(proc.stdout)]);
  } finally {
    clearInterval(heartbeat);
  }
  return allLines.join("\n");
}
