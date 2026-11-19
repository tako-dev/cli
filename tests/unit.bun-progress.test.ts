import { describe, expect, it } from "bun:test";
import {
  formatDownloadProgress,
  renderProgressBar,
  streamBunInstall,
} from "../src/bun-progress";

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

describe("bun install progress", () => {
  it("drains both stderr and stdout so Bun child output cannot fill pipe buffers", async () => {
    const updates: string[] = [];
    const output = await streamBunInstall(
      {
        stderr: streamOf(["Resolving dependencies\n", "Saved lockfile\n"]),
        stdout: streamOf(["Resolved, downloaded and extracted [3]\n", "3 packages installed [100ms]\n"]),
      },
      "正在更新 Claude Code",
      (msg) => updates.push(msg),
    );

    expect(output).toContain("Resolving dependencies");
    expect(output).toContain("Resolved, downloaded and extracted [3]");
    expect(output).toContain("Saved lockfile");
    expect(output).toContain("3 packages installed");
    expect(updates.some((msg) => msg.includes("下载并解压"))).toBe(true);
    expect(updates.some((msg) => msg.includes("完成"))).toBe(true);
  });
});

describe("renderProgressBar and formatDownloadProgress", () => {
  it("renders fixed-width percentage bar clamped to 0..100", () => {
    expect(renderProgressBar(0, 10)).toBe("[░░░░░░░░░░] 0%");
    expect(renderProgressBar(50, 10)).toBe("[█████░░░░░] 50%");
    expect(renderProgressBar(150, 10)).toBe("[██████████] 100%");
    expect(renderProgressBar(-5, 10)).toBe("[░░░░░░░░░░] 0%");
  });

  it("formats known-total and unknown-total download progress cleanly", () => {
    const known = formatDownloadProgress("正在下载 Codex", 5 * 1024 * 1024, 10 * 1024 * 1024, 2);
    expect(known).toContain("[█████████░░░░░░░░░] 50%");
    expect(known).toContain("(5.0/10.0 MB");
    expect(known).toContain("2.5 MB/s");

    const unknown = formatDownloadProgress("正在下载 Codex", 3 * 1024 * 1024, null, 1.5);
    expect(unknown).toBe("正在下载 Codex (3.0 MB · 2.0 MB/s)");
  });

  it("emits progress bar in streamBunInstall phase updates", async () => {
    const enc = new TextEncoder();
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("Resolved, downloaded and extracted [18]\n"));
        c.enqueue(enc.encode("2 packages installed\n"));
        c.close();
      },
    });
    const stdout = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const updates: string[] = [];
    await streamBunInstall({ stdout, stderr }, "正在更新 Codex CLI", (m) => updates.push(m));
    expect(updates.some((m) => /\[█+░*\] \d+%/.test(m) && m.includes("下载并解压"))).toBe(true);
    expect(updates.some((m) => m.includes("[██████████████████] 100%") && m.includes("完成"))).toBe(true);
  });
});
