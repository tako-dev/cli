import { describe, expect, it } from "bun:test";
import { streamBunInstall } from "../src/bun-progress";

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
