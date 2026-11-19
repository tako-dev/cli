import type { StatusLineInput, Segment } from "./types";
import {
  DirectorySegment,
  GitSegment,
  ModelSegment,
  ContextSegment,
  QuotaSegment,
} from "./segments";
import { StatusLineRenderer } from "./renderer";

export {
  buildStatusLineCommand,
  buildAgyStatusLineConfig,
  injectStatusLineConfig,
  removeStatusLineConfig,
  injectAgyStatusLineConfig,
  removeAgyStatusLineConfig,
} from "./inject";
export type { StatusLineInput } from "./types";

const SEGMENTS: Segment[] = [
  new DirectorySegment(),
  new GitSegment(),
  new ModelSegment(),
  new ContextSegment(),
  new QuotaSegment(),
];

/**
 * 渲染状态栏（单行紧凑）
 */
export async function renderStatusLine(input: StatusLineInput): Promise<string> {
  const results = await Promise.all(
    SEGMENTS.map(async (segment) => {
      try {
        const content = await segment.render(input);
        return { id: segment.id, content };
      } catch {
        return { id: segment.id, content: null };
      }
    })
  );

  const segmentMap = new Map<string, string | null>();
  for (const { id, content } of results) {
    segmentMap.set(id, content);
  }

  const renderer = new StatusLineRenderer();
  return renderer.render(segmentMap);
}

/**
 * 状态栏命令入口
 */
export async function statusLineCommand(): Promise<void> {
  try {
    const input: StatusLineInput = await Bun.stdin.json();
    const output = await renderStatusLine(input);
    console.log(output);
  } catch {
    process.exit(0);
  }
}
