/**
 * `tako models [list] [--refresh] [--json]`
 *
 * 仅覆盖 type === "tako" 的 provider。读 `~/.tako/tako-models-cache.json`
 * 的两条 apiType 桶（openai + claude）。`--refresh` 时先并行调
 * `refreshTakoModels` 拉新缓存（失败静默），再渲染。
 */
import type { TakoConfig } from "../config";
import { loadConfig } from "../config";
import type { Provider } from "../providers/types";
import type { TakoApiType, TakoModelEntry } from "./tako";
import { getTakoModels, refreshTakoModels } from "./tako";

const API_TYPES: TakoApiType[] = ["openai", "claude"];

interface ApiTypeBucket {
  apiType: TakoApiType;
  models: TakoModelEntry[];
}

interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  buckets: ApiTypeBucket[];
  hasAnyCache: boolean;
}

export interface ModelsCommandDeps {
  loadConfig?: () => Promise<TakoConfig>;
  refresh?: (baseUrl: string, apiKey: string, apiType: TakoApiType) => Promise<void>;
  read?: (baseUrl: string, apiType: TakoApiType, apiKey?: string) => TakoModelEntry[] | null;
  now?: () => number;
  columns?: () => number;
}

interface ParsedArgs {
  json: boolean;
  refresh: boolean;
  invalid?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, refresh: false };
  const rest = [...args];
  if (rest[0] === "list") rest.shift();
  for (const a of rest) {
    if (a === "--json") out.json = true;
    else if (a === "--refresh") out.refresh = true;
    else {
      out.invalid = a;
      return out;
    }
  }
  return out;
}

function selectTakoProviders(config: TakoConfig): Provider[] {
  const list = (config.providers ?? []).filter(
    (p) => p.type === "tako" && !!p.baseUrl,
  );
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

function sortModels(entries: TakoModelEntry[]): TakoModelEntry[] {
  return [...entries].sort(
    (a, b) => a.id.localeCompare(b.id) || a.displayName.localeCompare(b.displayName),
  );
}

function collect(
  provider: Provider,
  read: NonNullable<ModelsCommandDeps["read"]>,
): ProviderView {
  const buckets: ApiTypeBucket[] = [];
  let hasAnyCache = false;
  for (const apiType of API_TYPES) {
    const raw = read(provider.baseUrl as string, apiType, provider.apiKey);
    if (raw === null) {
      buckets.push({ apiType, models: [] });
      continue;
    }
    hasAnyCache = true;
    buckets.push({ apiType, models: sortModels(raw) });
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl as string,
    buckets,
    hasAnyCache,
  };
}

async function runRefresh(
  providers: Provider[],
  refresh: NonNullable<ModelsCommandDeps["refresh"]>,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const p of providers) {
    if (!p.apiKey || !p.baseUrl) continue;
    for (const apiType of API_TYPES) {
      jobs.push(refresh(p.baseUrl, p.apiKey, apiType).catch(() => {}));
    }
  }
  await Promise.allSettled(jobs);
}

const MAX_PER_LINE = 5;

function dedupeIds(buckets: ApiTypeBucket[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of buckets) {
    for (const m of b.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m.id);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function groupByPrefix(ids: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let prefix = "";
  for (const id of ids) {
    const p = id.slice(0, 3);
    if (p !== prefix) {
      if (current.length) groups.push(current);
      current = [id];
      prefix = p;
    } else {
      current.push(id);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function layoutGroup(group: string[], columns: number): string[] {
  if (group.length === 0) return [];
  const indent = 4;
  const maxLen = Math.max(...group.map((s) => s.length));
  const colWidth = maxLen + 2;
  const usable = Math.max(colWidth, columns - indent);
  const widthCols = Math.max(1, Math.floor(usable / colWidth));
  const cols = Math.min(widthCols, MAX_PER_LINE);
  const lines: string[] = [];
  for (let i = 0; i < group.length; i += cols) {
    const slice = group.slice(i, i + cols);
    const row = slice
      .map((s, idx) => (idx === slice.length - 1 ? s : s.padEnd(colWidth)))
      .join("");
    lines.push(" ".repeat(indent) + row);
  }
  return lines;
}

function renderText(views: ProviderView[], columns: number): string {
  if (views.length === 0) {
    return "未配置 Tako 渠道\n";
  }
  const out: string[] = [];
  for (const v of views) {
    out.push(`Provider: ${v.id} (${v.baseUrl})`);
    if (!v.hasAnyCache) {
      out.push("  缓存为空，请先运行 `tako models list --refresh`");
      out.push("");
      continue;
    }
    const ids = dedupeIds(v.buckets);
    out.push(`  ${ids.length} models`);
    for (const group of groupByPrefix(ids)) {
      out.push(...layoutGroup(group, columns));
    }
    out.push("");
  }
  return out.join("\n");
}

interface JsonModel {
  apiType: TakoApiType;
  id: string;
  displayName: string;
  description: string;
  contextWindow: number;
  sortOrder: number;
}

interface JsonProvider {
  id: string;
  name: string;
  baseUrl: string;
  hasCache: boolean;
  models: JsonModel[];
}

interface JsonPayload {
  command: "list";
  refreshed: boolean;
  fetchedAt: string;
  providers: JsonProvider[];
}

function renderJson(views: ProviderView[], refreshed: boolean, nowIso: string): string {
  const providers: JsonProvider[] = views.map((v) => ({
    id: v.id,
    name: v.name,
    baseUrl: v.baseUrl,
    hasCache: v.hasAnyCache,
    models: v.buckets.flatMap((b) =>
      b.models.map((m) => ({
        apiType: b.apiType,
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        contextWindow: m.contextWindow,
        sortOrder: m.sortOrder,
      })),
    ),
  }));
  const payload: JsonPayload = {
    command: "list",
    refreshed,
    fetchedAt: nowIso,
    providers,
  };
  return `${JSON.stringify(payload)}\n`;
}

export async function runModelsCommand(
  args: string[] = [],
  deps: ModelsCommandDeps = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.invalid) {
    process.stderr.write(
      `Unknown argument: ${parsed.invalid}\nUsage: tako models [list] [--refresh] [--json]\n`,
    );
    return 1;
  }

  const readConfig = deps.loadConfig ?? loadConfig;
  const refresh = deps.refresh ?? refreshTakoModels;
  const read = deps.read ?? getTakoModels;
  const now = deps.now ?? (() => Date.now());
  const columns = deps.columns ?? (() => process.stdout.columns ?? 80);

  const config = await readConfig();
  const providers = selectTakoProviders(config);

  if (parsed.refresh && providers.length > 0) {
    await runRefresh(providers, refresh);
  }

  const views = providers.map((p) => collect(p, read));
  const nowIso = new Date(now()).toISOString();

  if (parsed.json) {
    process.stdout.write(renderJson(views, parsed.refresh, nowIso));
  } else {
    process.stdout.write(renderText(views, columns()));
  }
  return 0;
}
