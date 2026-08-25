import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { TAKO_DIR, ensureTakoDir } from "./config";

export interface ModelUsage {
  counts: Record<string, number>;
  updatedAt: string;
}

export const USAGE_DECAY = 0.95;
export const PRUNE_THRESHOLD = 0.05;

let pathForTest: string | null = null;

function usagePath(): string {
  return pathForTest ?? join(TAKO_DIR, "model-usage.json");
}

function emptyUsage(): ModelUsage {
  return { counts: {}, updatedAt: new Date(0).toISOString() };
}

async function readUsage(): Promise<ModelUsage> {
  try {
    const file = Bun.file(usagePath());
    if (!(await file.exists())) return emptyUsage();
    const json = await file.json();
    const rawCounts = json?.counts;
    if (!rawCounts || typeof rawCounts !== "object") return emptyUsage();

    const counts: Record<string, number> = {};
    for (const [id, value] of Object.entries(rawCounts)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[id] = value;
    }
    return {
      counts,
      updatedAt: typeof json?.updatedAt === "string" ? json.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptyUsage();
  }
}

async function writeUsage(usage: ModelUsage): Promise<void> {
  if (pathForTest) {
    await mkdir(dirname(pathForTest), { recursive: true });
  } else {
    await ensureTakoDir();
  }
  await Bun.write(usagePath(), JSON.stringify(usage, null, 2));
}

export async function getModelPickCounts(): Promise<Record<string, number>> {
  const usage = await readUsage();
  return { ...usage.counts };
}

export async function recordModelPicks(pickedModelOptionIds: string[]): Promise<void> {
  const usage = await readUsage();
  const counts: Record<string, number> = {};

  for (const [id, value] of Object.entries(usage.counts)) {
    const decayed = value * USAGE_DECAY;
    if (decayed >= PRUNE_THRESHOLD) counts[id] = decayed;
  }

  for (const id of pickedModelOptionIds) {
    if (!id.startsWith("model-")) continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }

  await writeUsage({ counts, updatedAt: new Date().toISOString() });
}

export function _setPathForTest(path: string | null): void {
  pathForTest = path;
}
