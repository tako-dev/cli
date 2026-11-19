import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as agyMod from "../src/clients/agy";
import { agyClient, buildAgyModelOptions, prepareAgyEnv } from "../src/clients/agy";
import { _resetTakoCatalog, _setCachePathForTest, type TakoModelEntry } from "../src/models/tako";
import type { Provider, ProviderContext } from "../src/providers/types";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");

const BASE_URL = "https://agy-effort-qa.example.test";
const CACHE_API_KEY = "cr_qa_effort_cache_key_123456";
const CACHE_KEY_SHA256 = createHash("sha256").update(CACHE_API_KEY).digest("hex");

const MAIN_API_KEY = "cr_qa_main_api_key_primary_0358";
const AGY_ONLY_API_KEY = "cr_qa_agy_only_gateway_key_9999";

// Valid 1x1 RGB PNG fixtures (distinct bytes so input vs output fidelity is verifiable)
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const GREEN_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";

const RED_PNG_BYTES = Buffer.from(RED_PNG_BASE64, "base64");
const BLUE_PNG_BYTES = Buffer.from(BLUE_PNG_BASE64, "base64");
const GREEN_PNG_BYTES = Buffer.from(GREEN_PNG_BASE64, "base64");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const ISOLATED_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  "TAKO_HOME",
  "TAKO_SERVER",
  "PROXY_BASE_URL",
  "TAKO_DEV",
  "TAKO_API_KEY",
  "TAKO_AGY_API_KEY",
  "TAKO_AGY_GATEWAY_URL",
  "AGY_LLM_GATEWAY_API_KEY",
  "AGY_LLM_GATEWAY_URL",
  "AGY_LLM_GATEWAY_MODELS",
  "AGY_LLM_GATEWAY_TIER_PRO",
  "AGY_LLM_GATEWAY_TIER_FLASH",
  "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
  "VERSION",
] as const;

const NUMERIC_SCHEMA_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "multipleOf",
]);

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface CapturedHttpRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: any;
}

const tempDirs: string[] = [];
const activeClients: McpStdioClient[] = [];
const activeServers: Array<ReturnType<typeof Bun.serve>> = [];

function makeTempDir(prefix: string): string {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  let canonical = raw;
  try {
    canonical = realpathSync(raw);
  } catch {
    canonical = resolve(raw);
  }
  tempDirs.push(canonical);
  return canonical;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function cleanChildEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of ISOLATED_ENV_KEYS) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function writeIsolatedTakoHome(
  baseDir: string,
  opts: { withKey: boolean; serverUrl: string },
): { homeDir: string; takoHome: string } {
  const homeDir = join(baseDir, "home");
  const takoHome = join(baseDir, "tako");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(takoHome, { recursive: true });

  const config = opts.withKey
    ? {
        apiKey: MAIN_API_KEY,
        apiId: "qa-api-id-0358",
        agyApiKey: AGY_ONLY_API_KEY,
        installedClients: {},
        defaultProviderId: "prov-tako-qa",
        providers: [
          {
            id: "prov-tako-qa",
            name: "Tako 官方",
            type: "tako",
            apiKey: MAIN_API_KEY,
            agyApiKey: AGY_ONLY_API_KEY,
            baseUrl: opts.serverUrl,
            builtin: true,
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      }
    : {
        apiKey: "",
        apiId: "",
        installedClients: {},
        providers: [],
      };

  writeFileSync(join(takoHome, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return { homeDir, takoHome };
}

function startMockTakoServer(
  handler: (req: CapturedHttpRequest) => Response | Promise<Response>,
): {
  url: string;
  requests: CapturedHttpRequest[];
  server: ReturnType<typeof Bun.serve>;
} {
  const requests: CapturedHttpRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const bodyText = await req.text();
      let bodyJson: any = undefined;
      if (bodyText.trim()) {
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          bodyJson = undefined;
        }
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const captured: CapturedHttpRequest = {
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        headers,
        bodyText,
        bodyJson,
      };
      requests.push(captured);
      return await handler(captured);
    },
  });
  activeServers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    server,
  };
}

class McpStdioClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private queue: JsonRpcResponse[] = [];
  private waiters: Array<{
    resolve: (msg: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private stdoutClosed = false;
  private closed = false;
  private stdoutLoop: Promise<void>;
  private stderrLoop: Promise<void>;
  public rawStdoutLines: string[] = [];
  public nonJsonLines: string[] = [];
  public stderrText = "";

  constructor(env: Record<string, string>) {
    this.proc = Bun.spawn([process.execPath, CLI_ENTRY, "mcp-server"], {
      cwd: REPO_ROOT,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    activeClients.push(this);

    this.stdoutLoop = this.pumpStdout();
    this.stderrLoop = this.pumpStderr();
  }

  private failAllWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private handleStdoutLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) return;
    this.rawStdoutLines.push(line);

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.nonJsonLines.push(line);
      this.failAllWaiters(new Error(`Non-JSON stdout emitted by mcp-server: ${JSON.stringify(line)}`));
      return;
    }

    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(parsed);
    } else {
      this.queue.push(parsed);
    }
  }

  private async pumpStdout(): Promise<void> {
    const stream = this.proc.stdout;
    if (!stream || typeof stream === "number") {
      this.stdoutClosed = true;
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          this.handleStdoutLine(line);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        this.handleStdoutLine(buffer);
      }
    } catch {
      // Stream terminated during shutdown
    } finally {
      this.stdoutClosed = true;
      this.failAllWaiters(
        new Error(
          `mcp-server stdout closed before response (nonJson=${JSON.stringify(this.nonJsonLines)}, stderr=${JSON.stringify(this.stderrText.slice(0, 300))})`,
        ),
      );
    }
  }

  private async pumpStderr(): Promise<void> {
    const stream = this.proc.stderr;
    if (!stream || typeof stream === "number") return;
    try {
      this.stderrText = await new Response(stream).text();
    } catch {
      // Ignore shutdown read error
    }
  }

  send(payload: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error("mcp-server stdin is not writable");
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
    stdin.flush();
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  nextMessage(timeoutMs = 5000): Promise<JsonRpcResponse> {
    if (this.nonJsonLines.length > 0) {
      return Promise.reject(
        new Error(`Non-JSON stdout emitted by mcp-server: ${JSON.stringify(this.nonJsonLines[0])}`),
      );
    }
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (this.stdoutClosed) {
      return Promise.reject(
        new Error(
          `mcp-server stdout closed before response (stderr=${JSON.stringify(this.stderrText.slice(0, 300))})`,
        ),
      );
    }
    return new Promise<JsonRpcResponse>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for mcp-server response (stdoutLines=${this.rawStdoutLines.length}, stderr=${JSON.stringify(this.stderrText.slice(0, 300))})`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ resolve: resolveMsg, reject: rejectMsg, timer });
    });
  }

  async request(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<JsonRpcResponse> {
    this.send({ jsonrpc: "2.0", id, method, params });
    return await this.nextMessage(timeoutMs);
  }

  async close(timeoutMs = 3000): Promise<{
    exitCode: number | null;
    rawStdoutLines: string[];
    nonJsonLines: string[];
    stderrText: string;
    unreadMessages: JsonRpcResponse[];
  }> {
    if (!this.closed) {
      this.closed = true;
      try {
        const stdin = this.proc.stdin;
        if (stdin && typeof stdin !== "number") {
          stdin.end();
        }
      } catch {
        // Already closed
      }
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
      ]);
      if (!exited) {
        try {
          this.proc.kill();
        } catch {
          // Already terminated
        }
        await Promise.race([
          this.proc.exited,
          new Promise<void>((r) => setTimeout(r, 1500)),
        ]);
      }
      await Promise.race([
        Promise.allSettled([this.stdoutLoop, this.stderrLoop]),
        new Promise<void>((r) => setTimeout(r, 1000)),
      ]);
    }
    return {
      exitCode: this.proc.exitCode,
      rawStdoutLines: [...this.rawStdoutLines],
      nonJsonLines: [...this.nonJsonLines],
      stderrText: this.stderrText,
      unreadMessages: [...this.queue],
    };
  }
}

function assertAllSchemaNumericConstraintsAreNumbers(node: unknown, path = "inputSchema"): void {
  if (Array.isArray(node)) {
    node.forEach((item, idx) => assertAllSchemaNumericConstraintsAreNumbers(item, `${path}[${idx}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (NUMERIC_SCHEMA_KEYWORDS.has(key) && value !== undefined) {
      expect(typeof value, `${path}.${key} must be a JS number, got ${typeof value}`).toBe("number");
      expect(Number.isFinite(value as number), `${path}.${key} must be finite`).toBe(true);
    }
    assertAllSchemaNumericConstraintsAreNumbers(value, `${path}.${key}`);
  }
}

function assertValidMcpToolsList(tools: unknown): void {
  expect(Array.isArray(tools)).toBe(true);
  const list = tools as Array<Record<string, unknown>>;
  const byName = new Map(list.map((tool) => [tool.name, tool]));

  expect(byName.has("tako_generate_image")).toBe(true);
  expect(byName.has("tako_web_search")).toBe(true);

  for (const tool of list) {
    expect(typeof tool.name).toBe("string");
    expect((tool.name as string).length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe("string");
    expect((tool.description as string).length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.inputSchema).toBe("object");
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(typeof schema.properties).toBe("object");
    assertAllSchemaNumericConstraintsAreNumbers(schema, `${String(tool.name)}.inputSchema`);
  }

  const imgProps = ((byName.get("tako_generate_image")!.inputSchema as Record<string, unknown>)
    .properties ?? {}) as Record<string, unknown>;
  expect(imgProps.prompt).toBeDefined();
  expect(imgProps.output_path).toBeDefined();
  expect(imgProps.aspect_ratio).toBeDefined();
  expect(imgProps.input_image_path).toBeDefined();

  const searchSchema = byName.get("tako_web_search")!.inputSchema as Record<string, unknown>;
  const searchProps = (searchSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  expect(searchProps.query).toBeDefined();
  expect(searchProps.count).toBeDefined();
  expect(searchProps.provider).toBeDefined();
  if (searchProps.count?.minimum !== undefined) {
    expect(searchProps.count.minimum).toBe(1);
  }
  if (searchProps.count?.maximum !== undefined) {
    expect(searchProps.count.maximum).toBe(20);
  }
}

async function importOptionalModule(absPath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(absPath)) return null;
  return (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
}

async function loadMcpServerExports(): Promise<{
  handleMcpRequest: (req: Record<string, unknown>) => Promise<any> | any;
  runTakoMcpServer: (...args: any[]) => any;
  TAKO_MCP_TOOLS: unknown[];
}> {
  const indexMod = await importOptionalModule(join(REPO_ROOT, "src", "mcp", "index.ts"));
  const serverMod = await importOptionalModule(join(REPO_ROOT, "src", "mcp", "server.ts"));

  expect(
    indexMod !== null || serverMod !== null,
    "Expected src/mcp/index.ts or src/mcp/server.ts to exist",
  ).toBe(true);

  const handleMcpRequest = indexMod?.handleMcpRequest ?? serverMod?.handleMcpRequest;
  const runTakoMcpServer = indexMod?.runTakoMcpServer ?? serverMod?.runTakoMcpServer;
  const TAKO_MCP_TOOLS = indexMod?.TAKO_MCP_TOOLS ?? serverMod?.TAKO_MCP_TOOLS;

  expect(typeof handleMcpRequest).toBe("function");
  expect(typeof runTakoMcpServer).toBe("function");
  expect(Array.isArray(TAKO_MCP_TOOLS)).toBe(true);

  return {
    handleMcpRequest: handleMcpRequest as (req: Record<string, unknown>) => Promise<any> | any,
    runTakoMcpServer: runTakoMcpServer as (...args: any[]) => any,
    TAKO_MCP_TOOLS: TAKO_MCP_TOOLS as unknown[],
  };
}

async function loadMcpConfigExports(): Promise<{
  indexMod: Record<string, unknown>;
  agyConfigMod: Record<string, unknown>;
  getAgyMcpConfigPath: (...args: any[]) => string;
  buildTakoMcpServerConfig: (...args: any[]) => Record<string, any>;
  injectAgyMcpConfig: (opts?: Record<string, any>) => Promise<any> | any;
  removeAgyMcpConfig: (opts?: Record<string, any>) => Promise<any> | any;
}> {
  const indexPath = join(REPO_ROOT, "src", "mcp", "index.ts");
  const agyConfigPath = join(REPO_ROOT, "src", "mcp", "agy-config.ts");

  expect(existsSync(indexPath), "Expected src/mcp/index.ts to exist").toBe(true);
  expect(existsSync(agyConfigPath), "Expected src/mcp/agy-config.ts to exist").toBe(true);

  const indexMod = (await import(pathToFileURL(indexPath).href)) as Record<string, unknown>;
  const agyConfigMod = (await import(pathToFileURL(agyConfigPath).href)) as Record<string, unknown>;

  for (const name of [
    "getAgyMcpConfigPath",
    "buildTakoMcpServerConfig",
    "injectAgyMcpConfig",
    "removeAgyMcpConfig",
  ] as const) {
    expect(typeof indexMod[name], `src/mcp/index.ts must export ${name}`).toBe("function");
    expect(typeof agyConfigMod[name], `src/mcp/agy-config.ts must export ${name}`).toBe("function");
  }

  return {
    indexMod,
    agyConfigMod,
    getAgyMcpConfigPath: agyConfigMod.getAgyMcpConfigPath as (...args: any[]) => string,
    buildTakoMcpServerConfig: agyConfigMod.buildTakoMcpServerConfig as (
      ...args: any[]
    ) => Record<string, any>,
    injectAgyMcpConfig: agyConfigMod.injectAgyMcpConfig as (opts?: Record<string, any>) => any,
    removeAgyMcpConfig: agyConfigMod.removeAgyMcpConfig as (opts?: Record<string, any>) => any,
  };
}

function getExpandAgyGatewayModelsWithEffort(): (models: readonly string[]) => string[] {
  const fn = (agyMod as Record<string, unknown>).expandAgyGatewayModelsWithEffort;
  expect(typeof fn, "src/clients/agy.ts must export expandAgyGatewayModelsWithEffort").toBe(
    "function",
  );
  return fn as (models: readonly string[]) => string[];
}

function cacheEntry(id: string, sortOrder = 0): TakoModelEntry {
  return {
    id,
    displayName: id,
    description: `Cached ${id}`,
    contextWindow: 200_000,
    sortOrder,
    category: "chat",
  };
}

function writeAgyModelCache(cacheFile: string, modelIds: readonly string[]): void {
  writeFileSync(
    cacheFile,
    JSON.stringify({
      version: 2,
      buckets: {
        [`${BASE_URL}#agy-v2#${CACHE_KEY_SHA256}`]: {
          fetchedAt: Date.now(),
          entries: modelIds.map((id, i) => cacheEntry(id, i)),
        },
      },
    }),
    "utf8",
  );
  _setCachePathForTest(cacheFile);
  _resetTakoCatalog();
}

function makeProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: "prov-agy-effort-qa",
    name: "Tako",
    type: "tako",
    baseUrl: `${BASE_URL}/v1`,
    apiKey: CACHE_API_KEY,
    createdAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

function makeProviderContext(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    type: "tako",
    baseUrl: `${BASE_URL}/v1`,
    apiKey: CACHE_API_KEY,
    ...overrides,
  };
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) return 0;
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split(/\r?\n/).length;
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (st.isFile() && entry.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function assertMcpToolError(resp: JsonRpcResponse): void {
  expect(resp.error).toBeUndefined();
  expect(resp.result?.isError).toBe(true);
  expect(Array.isArray(resp.result?.content)).toBe(true);
  expect(resp.result.content.length).toBeGreaterThan(0);
  const textItem = resp.result.content.find(
    (c: any) => c?.type === "text" && typeof c?.text === "string" && c.text.trim().length > 0,
  );
  expect(textItem).toBeDefined();
}

afterEach(async () => {
  // Always terminate child processes before stopping servers or removing temp dirs (Windows lock safety)
  for (const client of activeClients.splice(0)) {
    await client.close(1500);
  }
  for (const server of activeServers.splice(0)) {
    try {
      server.stop(true);
    } catch {
      // Already stopped
    }
  }
  _setCachePathForTest(null);
  _resetTakoCatalog();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// EFFORT-01: Official gemini-3.8-flash Effort Slider Expansion
// ============================================================================
describe("EFFORT-01: gemini-3.8-flash effort slider expansion (src/clients/agy.ts)", () => {
  let savedEnv: Record<string, string | undefined>;
  const trackedKeys = [
    "AGY_LLM_GATEWAY_MODELS",
    "AGY_LLM_GATEWAY_TIER_PRO",
    "AGY_LLM_GATEWAY_TIER_FLASH",
    "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
    "TAKO_AGY_GATEWAY_URL",
    "TAKO_AGY_API_KEY",
  ] as const;

  beforeEach(() => {
    savedEnv = {};
    for (const key of trackedKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of trackedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("TC-EFFORT01-01: expands bare gemini-3.8-flash in-place into high/medium/low without mutating input or altering other models", () => {
    const expand = getExpandAgyGatewayModelsWithEffort();

    const input = Object.freeze([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);

    expect(expand(input)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ]);

    expect(expand(["gemini-3.8-flash"])).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
    ]);
  });

  it("TC-EFFORT01-02: deduplicates entries, avoids duplicating existing suffixed variants, and leaves lists without gemini-3.8-flash untouched", () => {
    const expand = getExpandAgyGatewayModelsWithEffort();

    // Duplicate inputs are deduplicated
    expect(
      expand([
        "claude-opus-4-6",
        "gemini-3.8-flash",
        "claude-opus-4-6",
        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
      ]),
    ).toEqual([
      "claude-opus-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ]);

    // Existing suffixed variants are never duplicated
    const alreadySuffixed = [
      "claude-opus-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ];
    expect(expand(alreadySuffixed)).toEqual(alreadySuffixed);

    // Mixed bare + explicit suffixed variant must never produce duplicate variants
    const mixed = expand([
      "claude-opus-4-6",
      "gemini-3.8-flash",
      "gemini-3.8-flash-medium",
      "gemini-3.5-flash-lite",
    ]);
    expect(new Set(mixed).size).toBe(mixed.length);
    expect(mixed.filter((m) => m === "gemini-3.8-flash-medium")).toHaveLength(1);
    expect(mixed).toContain("claude-opus-4-6");
    expect(mixed).toContain("gemini-3.5-flash-lite");

    // Lists without gemini-3.8-flash remain untouched
    expect(expand(["claude-opus-4-6", "claude-sonnet-4-6", "gemini-3.5-flash-lite"])).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.5-flash-lite",
    ]);
    expect(expand([])).toEqual([]);
  });

  it("TC-EFFORT01-03: prepareAgyEnv & agyClient.getEnvVars emit expanded AGY_LLM_GATEWAY_MODELS while keeping AGY_LLM_GATEWAY_TIER_FLASH bare canonical", () => {
    const dir = makeTempDir("tako-effort-env-");
    const emptyCache = join(dir, "empty-cache.json");
    _setCachePathForTest(emptyCache);
    _resetTakoCatalog();

    // 1) Default fallback (includes claude-sonnet-4-6 + gemini-3.8-flash)
    const providerCtx = makeProviderContext();
    const envVars = agyClient.getEnvVars(providerCtx);
    const prepared = prepareAgyEnv({}, providerCtx);

    for (const env of [envVars, prepared]) {
      expect(env.AGY_LLM_GATEWAY_MODELS).toContain(
        "gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
      );
      const list = env.AGY_LLM_GATEWAY_MODELS.split(",");
      expect(list).toEqual([
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.5-flash-lite",
      ]);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-4-6");
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).not.toMatch(/-(low|medium|high)$/);
    }

    // 2) Cached catalog WITHOUT claude-sonnet-4-6: TIER_FLASH must be bare "gemini-3.8-flash", NEVER suffixed!
    const flashOnlyCache = join(dir, "flash-only-cache.json");
    writeAgyModelCache(flashOnlyCache, [
      "claude-opus-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);

    const flashEnvVars = agyClient.getEnvVars(providerCtx);
    const flashPrepared = prepareAgyEnv({}, providerCtx);
    for (const env of [flashEnvVars, flashPrepared]) {
      expect(env.AGY_LLM_GATEWAY_MODELS).toContain(
        "gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
      );
      expect(env.AGY_LLM_GATEWAY_MODELS.split(",")).toEqual([
        "claude-opus-4-6",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.5-flash-lite",
      ]);
      expect(env.AGY_LLM_GATEWAY_TIER_FLASH).toBe("gemini-3.8-flash");
    }
  });

  it("TC-EFFORT01-04: buildAgyModelOptions still exposes ONE clean model-gemini-3.8-flash option while gateway env expands effort variants", () => {
    const dir = makeTempDir("tako-effort-picker-");
    const emptyCache = join(dir, "empty-cache.json");
    _setCachePathForTest(emptyCache);
    _resetTakoCatalog();

    const provider = makeProvider();

    // Default fallback case
    const defaultEnv = agyClient.getEnvVars(provider);
    expect(defaultEnv.AGY_LLM_GATEWAY_MODELS).toContain(
      "gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
    );
    const defaultOpts = buildAgyModelOptions(provider);
    const defaultFlashOpts = defaultOpts.filter((o) => o.id.includes("gemini-3.8-flash"));
    expect(defaultFlashOpts.map((o) => o.id)).toEqual(["model-gemini-3.8-flash"]);
    expect(defaultFlashOpts[0]?.args).toEqual(["--model", "gemini-3.8-flash"]);

    // Cached catalog case
    const cacheFile = join(dir, "cached-models.json");
    writeAgyModelCache(cacheFile, [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);

    const cachedEnv = agyClient.getEnvVars(provider);
    expect(cachedEnv.AGY_LLM_GATEWAY_MODELS).toContain(
      "gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low",
    );
    const cachedOpts = buildAgyModelOptions(provider);
    const cachedFlashOpts = cachedOpts.filter((o) => o.id.includes("gemini-3.8-flash"));
    expect(cachedFlashOpts.map((o) => o.id)).toEqual(["model-gemini-3.8-flash"]);
    expect(cachedFlashOpts[0]?.args).toEqual(["--model", "gemini-3.8-flash"]);
  });
});

// ============================================================================
// MCP-01: Built-in Tako MCP Server JSON-RPC 2.0 Protocol
// ============================================================================
describe("MCP-01: Built-in Tako MCP server JSON-RPC 2.0 protocol", () => {
  it("TC-MCP01-01: exports handleMcpRequest, runTakoMcpServer, TAKO_MCP_TOOLS with valid numeric JSON schemas", async () => {
    const { TAKO_MCP_TOOLS } = await loadMcpServerExports();
    assertValidMcpToolsList(TAKO_MCP_TOOLS);
  });

  it("TC-MCP01-02: handleMcpRequest handles agy 1.5.12 discovery, notifications, initialize, tools/list, ping, resources/list, prompts/list", async () => {
    const { handleMcpRequest } = await loadMcpServerExports();

    // 1. server/discover -> -32601 error
    const discover = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {},
    });
    expect(discover?.jsonrpc).toBe("2.0");
    expect(discover?.id).toBe(1);
    expect(discover?.result).toBeUndefined();
    expect(discover?.error?.code).toBe(-32601);

    // 2. notifications/roots/list_changed -> null/undefined (no response)
    const notifRoots = await handleMcpRequest({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    expect(notifRoots == null).toBe(true);

    // 3. initialize -> protocolVersion 2025-11-25, capabilities.tools, serverInfo.name === "tako"
    const init = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(init?.jsonrpc).toBe("2.0");
    expect(init?.id).toBe(2);
    expect(init?.error).toBeUndefined();
    expect(init?.result?.protocolVersion).toBe("2025-11-25");
    expect(init?.result?.capabilities?.tools).toBeDefined();
    expect(init?.result?.serverInfo?.name).toBe("tako");

    // 4. notifications/initialized -> null/undefined (no response)
    const notifInit = await handleMcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    expect(notifInit == null).toBe(true);

    // 5. tools/list -> valid schemas with numeric constraints
    const toolsList = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    expect(toolsList?.jsonrpc).toBe("2.0");
    expect(toolsList?.id).toBe(3);
    expect(toolsList?.error).toBeUndefined();
    assertValidMcpToolsList(toolsList?.result?.tools);

    // 6. ping, resources/list, prompts/list
    const ping = await handleMcpRequest({ jsonrpc: "2.0", id: 4, method: "ping", params: {} });
    expect(ping?.jsonrpc).toBe("2.0");
    expect(ping?.id).toBe(4);
    expect(ping?.error).toBeUndefined();
    expect(ping?.result).toBeDefined();

    const resources = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/list",
      params: {},
    });
    expect(resources?.jsonrpc).toBe("2.0");
    expect(resources?.id).toBe(5);
    expect(resources?.error).toBeUndefined();
    expect(Array.isArray(resources?.result?.resources)).toBe(true);

    const prompts = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/list",
      params: {},
    });
    expect(prompts?.jsonrpc).toBe("2.0");
    expect(prompts?.id).toBe(6);
    expect(prompts?.error).toBeUndefined();
    expect(Array.isArray(prompts?.result?.prompts)).toBe(true);
  });

  it("TC-MCP01-03: CLI fast-path `bun src/index.ts mcp-server` completes full agy 1.5.12 stdio handshake with ZERO non-JSON banners or notification output", async () => {
    const dir = makeTempDir("tako-mcp-handshake-");
    const mock = startMockTakoServer(() => new Response("unexpected", { status: 404 }));
    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });

    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    // 1. server/discover -> immediate -32601 with id: 1
    const r1 = await client.request(1, "server/discover", {});
    expect(r1.jsonrpc).toBe("2.0");
    expect(r1.id).toBe(1);
    expect(r1.result).toBeUndefined();
    expect(r1.error?.code).toBe(-32601);

    // 2. notifications/roots/list_changed -> MUST emit ZERO stdout
    client.notify("notifications/roots/list_changed", {});

    // 3. initialize -> MUST be the very next stdout message (id: 2)
    const r2 = await client.request(2, "initialize", { protocolVersion: "2025-11-25" });
    expect(r2.jsonrpc).toBe("2.0");
    expect(r2.id).toBe(2);
    expect(r2.error).toBeUndefined();
    expect(r2.result?.protocolVersion).toBe("2025-11-25");
    expect(r2.result?.capabilities?.tools).toBeDefined();
    expect(r2.result?.serverInfo?.name).toBe("tako");

    // 4. notifications/initialized -> MUST emit ZERO stdout
    client.notify("notifications/initialized", {});

    // 5. tools/list -> MUST be the very next stdout message (id: 3)
    const r3 = await client.request(3, "tools/list", {});
    expect(r3.jsonrpc).toBe("2.0");
    expect(r3.id).toBe(3);
    expect(r3.error).toBeUndefined();
    assertValidMcpToolsList(r3.result?.tools);

    // 6. ping, resources/list, prompts/list
    const r4 = await client.request(4, "ping", {});
    expect(r4.jsonrpc).toBe("2.0");
    expect(r4.id).toBe(4);
    expect(r4.error).toBeUndefined();
    expect(r4.result).toBeDefined();

    const r5 = await client.request(5, "resources/list", {});
    expect(r5.jsonrpc).toBe("2.0");
    expect(r5.id).toBe(5);
    expect(r5.error).toBeUndefined();
    expect(Array.isArray(r5.result?.resources)).toBe(true);

    const r6 = await client.request(6, "prompts/list", {});
    expect(r6.jsonrpc).toBe("2.0");
    expect(r6.id).toBe(6);
    expect(r6.error).toBeUndefined();
    expect(Array.isArray(r6.result?.prompts)).toBe(true);

    // Trailing notification before EOF must also emit ZERO stdout
    client.notify("notifications/roots/list_changed", {});

    const closed = await client.close();
    expect(closed.nonJsonLines).toEqual([]);
    expect(closed.unreadMessages).toEqual([]);
    expect(closed.rawStdoutLines).toHaveLength(6);
    expect(closed.exitCode).toBe(0);
    // Zero spurious update-check HTTP calls during fast-path mcp-server handshake
    expect(mock.requests).toHaveLength(0);
  });
});

// ============================================================================
// MCP-02: tako_generate_image Tool Execution (Mock HTTP E2E)
// ============================================================================
describe("MCP-02: tako_generate_image tool execution (Mock HTTP E2E)", () => {
  it("TC-MCP02-01: sends x-goog-api-key with main apiKey (preferring over agyApiKey), decodes inlineData, creates parent dirs, saves exact PNG bytes, returns text + image", async () => {
    const dir = makeTempDir("tako-mcp-img-camel-");
    const mock = startMockTakoServer((req) => {
      if (
        req.method === "POST" &&
        req.pathname === "/v1beta/models/gemini-3.1-flash-image:generateContent"
      ) {
        return Response.json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Generated image ready." },
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: RED_PNG_BASE64,
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        // Simulate agy runtime env having AGY_LLM_GATEWAY_API_KEY set to agy-only key
        AGY_LLM_GATEWAY_API_KEY: AGY_ONLY_API_KEY,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    const outputPath = join(dir, "nested", "deep", "sunrise.png");
    const resp = await client.request(2, "tools/call", {
      name: "tako_generate_image",
      arguments: {
        prompt: "A serene mountain sunrise",
        output_path: outputPath,
        aspect_ratio: "16:9",
      },
    });

    // Verify HTTP request contract
    expect(mock.requests).toHaveLength(1);
    const httpReq = mock.requests[0]!;
    expect(httpReq.method).toBe("POST");
    expect(httpReq.pathname).toBe("/v1beta/models/gemini-3.1-flash-image:generateContent");
    expect(httpReq.headers["x-goog-api-key"]).toBe(MAIN_API_KEY);
    expect(httpReq.headers["x-goog-api-key"]).not.toBe(AGY_ONLY_API_KEY);

    const genCfg = httpReq.bodyJson?.generationConfig;
    expect(Array.isArray(genCfg?.responseModalities)).toBe(true);
    expect(genCfg.responseModalities).toContain("IMAGE");
    expect(genCfg?.imageConfig?.aspectRatio).toBe("16:9");

    // Verify exact binary image saved & parent dirs created automatically
    expect(existsSync(outputPath)).toBe(true);
    const savedBytes = readFileSync(outputPath);
    expect(Buffer.compare(savedBytes, RED_PNG_BYTES)).toBe(0);

    // Verify MCP response content has BOTH text (referencing absolute path) AND image (matching data + mimeType)
    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    expect(Array.isArray(resp.result?.content)).toBe(true);

    const absOutput = resolve(outputPath);
    const textItem = resp.result.content.find(
      (item: any) => item?.type === "text" && typeof item?.text === "string",
    );
    expect(textItem).toBeDefined();
    const mentionsPath =
      textItem.text.includes(absOutput) ||
      normalizeSlashes(textItem.text).includes(normalizeSlashes(absOutput));
    expect(mentionsPath).toBe(true);

    const imageItem = resp.result.content.find((item: any) => item?.type === "image");
    expect(imageItem).toBeDefined();
    expect(imageItem.data).toBe(RED_PNG_BASE64);
    expect(imageItem.mimeType).toBe("image/png");

    const closed = await client.close();
    expect(closed.nonJsonLines).toEqual([]);
  });

  it("TC-MCP02-02: decodes snake_case inline_data response and saves exact binary PNG bytes", async () => {
    const dir = makeTempDir("tako-mcp-img-snake-");
    const mock = startMockTakoServer((req) => {
      if (
        req.method === "POST" &&
        req.pathname === "/v1beta/models/gemini-3.1-flash-image:generateContent"
      ) {
        return Response.json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    inline_data: {
                      mime_type: "image/png",
                      data: BLUE_PNG_BASE64,
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    const outputPath = join(dir, "snake", "octopus.png");
    const resp = await client.request(2, "tools/call", {
      name: "tako_generate_image",
      arguments: {
        prompt: "A pixel art octopus",
        output_path: outputPath,
      },
    });

    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    expect(existsSync(outputPath)).toBe(true);
    expect(Buffer.compare(readFileSync(outputPath), BLUE_PNG_BYTES)).toBe(0);

    const absOutput = resolve(outputPath);
    const textItem = resp.result.content.find((c: any) => c?.type === "text");
    expect(textItem).toBeDefined();
    expect(
      textItem.text.includes(absOutput) ||
        normalizeSlashes(textItem.text).includes(normalizeSlashes(absOutput)),
    ).toBe(true);

    const imageItem = resp.result.content.find((c: any) => c?.type === "image");
    expect(imageItem?.data).toBe(BLUE_PNG_BASE64);
    expect(imageItem?.mimeType).toBe("image/png");

    await client.close();
  });

  it("TC-MCP02-03: supports input_image_path by sending local image bytes as inlineData part in request contents", async () => {
    const dir = makeTempDir("tako-mcp-img-edit-");
    const inputPath = join(dir, "input-source.png");
    writeFileSync(inputPath, BLUE_PNG_BYTES);

    const mock = startMockTakoServer((req) => {
      if (
        req.method === "POST" &&
        req.pathname === "/v1beta/models/gemini-3.1-flash-image:generateContent"
      ) {
        return Response.json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: GREEN_PNG_BASE64,
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    const outputPath = join(dir, "edited", "green.png");
    const resp = await client.request(2, "tools/call", {
      name: "tako_generate_image",
      arguments: {
        prompt: "Recolor the pixel green",
        input_image_path: inputPath,
        output_path: outputPath,
      },
    });

    expect(mock.requests).toHaveLength(1);
    const contents = mock.requests[0]!.bodyJson?.contents;
    expect(Array.isArray(contents)).toBe(true);

    const allParts = contents.flatMap((c: any) => (Array.isArray(c?.parts) ? c.parts : []));
    const textPart = allParts.find(
      (p: any) => typeof p?.text === "string" && p.text.includes("Recolor the pixel green"),
    );
    expect(textPart).toBeDefined();

    const inlinePart = allParts.find((p: any) => p?.inlineData);
    expect(inlinePart?.inlineData).toBeDefined();
    expect(inlinePart.inlineData.data).toBe(BLUE_PNG_BASE64);
    expect(inlinePart.inlineData.mimeType).toBe("image/png");

    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    expect(Buffer.compare(readFileSync(outputPath), GREEN_PNG_BYTES)).toBe(0);

    await client.close();
  });

  it("TC-MCP02-04: handles HTTP 500, response without image, and missing API key with isError=true without crashing stdio server", async () => {
    const dir = makeTempDir("tako-mcp-img-err-");
    let mode: "http500" | "noImage" = "http500";
    const mock = startMockTakoServer(() => {
      if (mode === "http500") {
        return Response.json({ error: { message: "upstream image outage" } }, { status: 500 });
      }
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Safety policy blocked image generation." }],
            },
          },
        ],
      });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    // 1. HTTP 500
    mode = "http500";
    const err500 = await client.request(2, "tools/call", {
      name: "tako_generate_image",
      arguments: { prompt: "broken", output_path: join(dir, "fail-500.png") },
    });
    assertMcpToolError(err500);
    const pingAfter500 = await client.request(3, "ping", {});
    expect(pingAfter500.error).toBeUndefined();

    // 2. Response without image part
    mode = "noImage";
    const errNoImg = await client.request(4, "tools/call", {
      name: "tako_generate_image",
      arguments: { prompt: "blocked", output_path: join(dir, "fail-noimg.png") },
    });
    assertMcpToolError(errNoImg);
    const pingAfterNoImg = await client.request(5, "ping", {});
    expect(pingAfterNoImg.error).toBeUndefined();

    const closed1 = await client.close();
    expect(closed1.nonJsonLines).toEqual([]);

    // 3. Missing API key
    const noKeyDir = makeTempDir("tako-mcp-img-nokey-");
    const noKeyEnvDirs = writeIsolatedTakoHome(noKeyDir, {
      withKey: false,
      serverUrl: mock.url,
    });
    const noKeyClient = new McpStdioClient(
      cleanChildEnv({
        HOME: noKeyEnvDirs.homeDir,
        USERPROFILE: noKeyEnvDirs.homeDir,
        TAKO_HOME: noKeyEnvDirs.takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await noKeyClient.request(1, "initialize", { protocolVersion: "2025-11-25" });
    noKeyClient.notify("notifications/initialized", {});
    const errNoKey = await noKeyClient.request(2, "tools/call", {
      name: "tako_generate_image",
      arguments: { prompt: "missing key", output_path: join(noKeyDir, "fail-nokey.png") },
    });
    assertMcpToolError(errNoKey);
    const pingAfterNoKey = await noKeyClient.request(3, "ping", {});
    expect(pingAfterNoKey.error).toBeUndefined();

    const closed2 = await noKeyClient.close();
    expect(closed2.nonJsonLines).toEqual([]);
  });
});

// ============================================================================
// MCP-03: tako_web_search Tool Execution (Mock HTTP E2E)
// ============================================================================
describe("MCP-03: tako_web_search tool execution (Mock HTTP E2E)", () => {
  it("TC-MCP03-01: sends POST /v1/search with Bearer <mainApiKey> and { query, count, provider } and formats titles, URLs, and snippets", async () => {
    const dir = makeTempDir("tako-mcp-search-");
    const mock = startMockTakoServer((req) => {
      if (req.method === "POST" && req.pathname === "/v1/search") {
        return Response.json({
          query: req.bodyJson?.query,
          provider: req.bodyJson?.provider ?? "tavily",
          results: [
            {
              title: "Antigravity MCP Protocol Guide",
              url: "https://docs.example.test/agy-mcp",
              snippet: "Connect custom tools over stdio JSON-RPC 2.0.",
            },
            {
              title: "Tako CLI Release 0.3.58",
              url: "https://tako.example.test/releases/0.3.58",
              snippet: "Built-in image generation and web search MCP tools.",
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        AGY_LLM_GATEWAY_API_KEY: AGY_ONLY_API_KEY,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    const resp = await client.request(2, "tools/call", {
      name: "tako_web_search",
      arguments: {
        query: "antigravity mcp server",
        count: 5,
        provider: "tavily",
      },
    });

    expect(mock.requests).toHaveLength(1);
    const httpReq = mock.requests[0]!;
    expect(httpReq.method).toBe("POST");
    expect(httpReq.pathname).toBe("/v1/search");
    expect(httpReq.headers["authorization"]).toBe(`Bearer ${MAIN_API_KEY}`);
    expect(httpReq.headers["authorization"]).not.toBe(`Bearer ${AGY_ONLY_API_KEY}`);
    expect(httpReq.bodyJson?.query).toBe("antigravity mcp server");
    expect(httpReq.bodyJson?.count).toBe(5);
    expect(httpReq.bodyJson?.provider).toBe("tavily");

    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    expect(Array.isArray(resp.result?.content)).toBe(true);
    const combinedText = resp.result.content
      .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
      .map((c: any) => c.text)
      .join("\n");

    expect(combinedText).toContain("Antigravity MCP Protocol Guide");
    expect(combinedText).toContain("https://docs.example.test/agy-mcp");
    expect(combinedText).toContain("Connect custom tools over stdio JSON-RPC 2.0.");
    expect(combinedText).toContain("Tako CLI Release 0.3.58");
    expect(combinedText).toContain("https://tako.example.test/releases/0.3.58");
    expect(combinedText).toContain("Built-in image generation and web search MCP tools.");

    const closed = await client.close();
    expect(closed.nonJsonLines).toEqual([]);
  });

  it("TC-MCP03-02: clamps out-of-range count to [1, 20] before calling /v1/search", async () => {
    const dir = makeTempDir("tako-mcp-search-clamp-");
    const mock = startMockTakoServer((req) => {
      if (req.method === "POST" && req.pathname === "/v1/search") {
        return Response.json({
          results: [
            {
              title: "Clamped Result",
              url: "https://example.test/clamped",
              snippet: "Result snippet.",
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    const rHigh = await client.request(2, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "clamp high", count: 999 },
    });
    expect(rHigh.result?.isError).toBeFalsy();

    const rZero = await client.request(3, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "clamp zero", count: 0 },
    });
    expect(rZero.result?.isError).toBeFalsy();

    const rNeg = await client.request(4, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "clamp negative", count: -5 },
    });
    expect(rNeg.result?.isError).toBeFalsy();

    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[0]!.bodyJson?.count).toBe(20);
    expect(mock.requests[1]!.bodyJson?.count).toBe(1);
    expect(mock.requests[2]!.bodyJson?.count).toBe(1);

    await client.close();
  });

  it("TC-MCP03-03: handles HTTP error, empty/whitespace query, and missing API key with isError=true without crashing stdio server", async () => {
    const dir = makeTempDir("tako-mcp-search-err-");
    let returnError = false;
    const mock = startMockTakoServer(() => {
      if (returnError) {
        return Response.json({ error: { message: "search backend failed" } }, { status: 500 });
      }
      // Return 200 by default so empty-query validation is proven to happen client-side
      return Response.json({ results: [] });
    });

    const { homeDir, takoHome } = writeIsolatedTakoHome(dir, {
      withKey: true,
      serverUrl: mock.url,
    });
    const client = new McpStdioClient(
      cleanChildEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TAKO_HOME: takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await client.request(1, "initialize", { protocolVersion: "2025-11-25" });
    client.notify("notifications/initialized", {});

    // 1. Empty and whitespace-only queries
    const errEmpty = await client.request(2, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "" },
    });
    assertMcpToolError(errEmpty);

    const errWhitespace = await client.request(3, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "   \t\n  " },
    });
    assertMcpToolError(errWhitespace);
    expect(mock.requests).toHaveLength(0);

    // 2. HTTP 500 error
    returnError = true;
    const errHttp = await client.request(4, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "trigger 500" },
    });
    assertMcpToolError(errHttp);

    // Server must still respond to ping
    const ping1 = await client.request(5, "ping", {});
    expect(ping1.error).toBeUndefined();
    const closed1 = await client.close();
    expect(closed1.nonJsonLines).toEqual([]);

    // 3. Missing API key
    const noKeyDir = makeTempDir("tako-mcp-search-nokey-");
    const noKeyEnvDirs = writeIsolatedTakoHome(noKeyDir, {
      withKey: false,
      serverUrl: mock.url,
    });
    const noKeyClient = new McpStdioClient(
      cleanChildEnv({
        HOME: noKeyEnvDirs.homeDir,
        USERPROFILE: noKeyEnvDirs.homeDir,
        TAKO_HOME: noKeyEnvDirs.takoHome,
        PROXY_BASE_URL: mock.url,
        TAKO_SERVER: mock.url,
        VERSION: "0.3.58",
      }),
    );

    await noKeyClient.request(1, "initialize", { protocolVersion: "2025-11-25" });
    noKeyClient.notify("notifications/initialized", {});
    const errNoKey = await noKeyClient.request(2, "tools/call", {
      name: "tako_web_search",
      arguments: { query: "missing api key" },
    });
    assertMcpToolError(errNoKey);

    const ping2 = await noKeyClient.request(3, "ping", {});
    expect(ping2.error).toBeUndefined();
    const closed2 = await noKeyClient.close();
    expect(closed2.nonJsonLines).toEqual([]);
  });
});

// ============================================================================
// MCP-04: agy MCP Config Injection & <= 600 Line Compliance
// ============================================================================
describe("MCP-04: agy MCP config injection (src/mcp/agy-config.ts) & <= 600 line compliance", () => {
  let savedEnv: Record<string, string | undefined>;
  const trackedKeys = [
    "TAKO_API_KEY",
    "TAKO_AGY_API_KEY",
    "AGY_LLM_GATEWAY_API_KEY",
    "VERSION",
  ] as const;

  beforeEach(() => {
    savedEnv = {};
    for (const k of trackedKeys) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of trackedKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("TC-MCP04-01: exports getAgyMcpConfigPath, buildTakoMcpServerConfig, injectAgyMcpConfig, removeAgyMcpConfig from both src/mcp/index.ts and src/mcp/agy-config.ts", async () => {
    const { getAgyMcpConfigPath } = await loadMcpConfigExports();
    const tmpHome = makeTempDir("tako-mcp-path-");
    const expected = normalizeSlashes(join(tmpHome, ".gemini", "config", "mcp_config.json"));

    const defaultPath = getAgyMcpConfigPath();
    expect(typeof defaultPath).toBe("string");
    expect(normalizeSlashes(defaultPath).endsWith("/.gemini/config/mcp_config.json")).toBe(true);

    // Support either getAgyMcpConfigPath({ home }) or getAgyMcpConfigPath(home)
    let resolvedForHome: string | undefined;
    try {
      const candidate = getAgyMcpConfigPath({ home: tmpHome });
      if (typeof candidate === "string" && normalizeSlashes(candidate) === expected) {
        resolvedForHome = candidate;
      }
    } catch {
      // Fallback to string signature
    }
    if (!resolvedForHome) {
      resolvedForHome = getAgyMcpConfigPath(tmpHome);
    }
    expect(normalizeSlashes(resolvedForHome)).toBe(expected);
  });

  it("TC-MCP04-02: injectAgyMcpConfig({ home }) writes <home>/.gemini/config/mcp_config.json with mcpServers.tako and ZERO secrets", async () => {
    const { injectAgyMcpConfig } = await loadMcpConfigExports();
    const tmpHome = makeTempDir("tako-mcp-inject-");

    process.env.TAKO_API_KEY = "cr_sentinel_env_main_111111";
    process.env.TAKO_AGY_API_KEY = "cr_sentinel_env_tako_agy_222222";
    process.env.AGY_LLM_GATEWAY_API_KEY = "cr_sentinel_env_agy_333333";

    await injectAgyMcpConfig({ home: tmpHome });

    const configPath = join(tmpHome, ".gemini", "config", "mcp_config.json");
    expect(existsSync(configPath)).toBe(true);

    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("cr_sentinel_env_main_111111");
    expect(raw).not.toContain("cr_sentinel_env_tako_agy_222222");
    expect(raw).not.toContain("cr_sentinel_env_agy_333333");
    expect(raw).not.toMatch(/cr_[a-zA-Z0-9_-]{8,}/);
    expect(raw).not.toMatch(/api[_-]?key/i);
    expect(raw).not.toMatch(/bearer\s+/i);

    const parsed = JSON.parse(raw) as Record<string, any>;
    const tako = parsed.mcpServers?.tako;
    expect(tako).toBeDefined();
    expect(typeof tako.command).toBe("string");
    expect(tako.command.length).toBeGreaterThan(0);
    expect(Array.isArray(tako.args)).toBe(true);
    expect(tako.args).toContain("mcp-server");
    expect(tako.disabled).toBe(false);

    if (tako.env && typeof tako.env === "object") {
      for (const key of Object.keys(tako.env)) {
        expect(key).not.toMatch(/key|token|secret|auth/i);
      }
    }
  });

  it("TC-MCP04-03: injectAgyMcpConfig strictly preserves existing user MCP servers and unrelated top-level JSON keys", async () => {
    const { injectAgyMcpConfig } = await loadMcpConfigExports();
    const tmpHome = makeTempDir("tako-mcp-preserve-");
    const configPath = join(tmpHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });

    const existingConfig = {
      schemaVersion: 2,
      customTopLevel: { keepMe: true, list: [1, 2, 3] },
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_user_owned_token" },
          disabled: false,
        },
        "local-db": {
          command: "/usr/local/bin/db-mcp",
          args: ["--readonly"],
          disabled: true,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), "utf8");

    await injectAgyMcpConfig({ home: tmpHome });
    await injectAgyMcpConfig({ home: tmpHome }); // idempotent second call

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.customTopLevel).toEqual(existingConfig.customTopLevel);
    expect(parsed.mcpServers.github).toEqual(existingConfig.mcpServers.github);
    expect(parsed.mcpServers["local-db"]).toEqual(existingConfig.mcpServers["local-db"]);

    expect(parsed.mcpServers.tako).toBeDefined();
    expect(typeof parsed.mcpServers.tako.command).toBe("string");
    expect(parsed.mcpServers.tako.args).toContain("mcp-server");
    expect(parsed.mcpServers.tako.disabled).toBe(false);
  });

  it("TC-MCP04-04: injectAgyMcpConfig strictly respects explicit user opt-out (mcpServers.tako.disabled === true)", async () => {
    const { injectAgyMcpConfig } = await loadMcpConfigExports();
    const tmpHome = makeTempDir("tako-mcp-optout-");
    const configPath = join(tmpHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });

    const userDisabledConfig = {
      mcpServers: {
        tako: {
          command: "/custom/user/tako",
          args: ["mcp-server", "--user-custom"],
          disabled: true,
        },
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(userDisabledConfig, null, 2), "utf8");

    await injectAgyMcpConfig({ home: tmpHome });

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(parsed.mcpServers.tako).toEqual(userDisabledConfig.mcpServers.tako);
    expect(parsed.mcpServers.tako.disabled).toBe(true);
    expect(parsed.mcpServers.github).toEqual(userDisabledConfig.mcpServers.github);
  });

  it("TC-MCP04-05: removeAgyMcpConfig({ home }) removes ONLY mcpServers.tako while keeping other servers intact and no-ops when missing", async () => {
    const { injectAgyMcpConfig, removeAgyMcpConfig } = await loadMcpConfigExports();

    // Safe no-op when config does not exist
    const emptyHome = makeTempDir("tako-mcp-remove-empty-");
    await removeAgyMcpConfig({ home: emptyHome });
    expect(existsSync(join(emptyHome, ".gemini", "config", "mcp_config.json"))).toBe(false);

    // Removes only tako while preserving user servers & top-level keys
    const tmpHome = makeTempDir("tako-mcp-remove-");
    const configPath = join(tmpHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          customTop: "keep",
          mcpServers: {
            github: { command: "npx", args: ["github-mcp"], disabled: false },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await injectAgyMcpConfig({ home: tmpHome });
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.tako).toBeDefined();

    await removeAgyMcpConfig({ home: tmpHome });
    const afterRemove = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(afterRemove.customTop).toBe("keep");
    expect(afterRemove.mcpServers.tako).toBeUndefined();
    expect("tako" in afterRemove.mcpServers).toBe(false);
    expect(afterRemove.mcpServers.github).toEqual({
      command: "npx",
      args: ["github-mcp"],
      disabled: false,
    });
  });

  it("TC-MCP04-06: Windows config (platform: 'win32') must NOT use a .cmd/.bat batch file or cmd.exe as command", async () => {
    const { buildTakoMcpServerConfig, injectAgyMcpConfig } = await loadMcpConfigExports();

    for (const version of [undefined, "dev"] as const) {
      if (version === undefined) delete process.env.VERSION;
      else process.env.VERSION = version;

      const cfg = buildTakoMcpServerConfig({ platform: "win32" });
      expect(typeof cfg.command).toBe("string");
      expect(cfg.command.length).toBeGreaterThan(0);
      expect(cfg.command.toLowerCase()).not.toMatch(/\.(cmd|bat)$/);
      expect(cfg.command.toLowerCase()).not.toMatch(/(?:^|[\\/])cmd(?:\.exe)?$/);
      expect(Array.isArray(cfg.args)).toBe(true);
      expect(cfg.args).toContain("mcp-server");
      expect(cfg.disabled).toBe(false);
    }

    delete process.env.VERSION;
    const tmpHome = makeTempDir("tako-mcp-win32-");
    await injectAgyMcpConfig({ home: tmpHome, platform: "win32" });
    const written = JSON.parse(
      readFileSync(join(tmpHome, ".gemini", "config", "mcp_config.json"), "utf8"),
    ) as Record<string, any>;
    expect(written.mcpServers.tako.command.toLowerCase()).not.toMatch(/\.(cmd|bat)$/);
    expect(written.mcpServers.tako.command.toLowerCase()).not.toMatch(/(?:^|[\\/])cmd(?:\.exe)?$/);
    expect(written.mcpServers.tako.args).toContain("mcp-server");
    expect(written.mcpServers.tako.disabled).toBe(false);
  });

  it("TC-MCP04-07: every src/mcp/*.ts file and src/clients/agy.ts is <= 600 lines", () => {
    const mcpDir = join(REPO_ROOT, "src", "mcp");
    expect(existsSync(mcpDir), "Expected src/mcp directory to exist").toBe(true);

    const mcpFiles = collectTsFiles(mcpDir);
    expect(mcpFiles.length, "Expected at least one TypeScript file in src/mcp/").toBeGreaterThan(0);

    const filesToCheck = [...mcpFiles, join(REPO_ROOT, "src", "clients", "agy.ts")];
    for (const file of filesToCheck) {
      const lines = countLines(file);
      expect(lines, `${file} has ${lines} lines (limit <= 600)`).toBeLessThanOrEqual(600);
    }
  });
});
