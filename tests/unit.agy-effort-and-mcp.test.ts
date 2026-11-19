import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  DEFAULT_AGY_GATEWAY_MODELS,
  GEMINI_38_FLASH_EFFORT_VARIANTS,
  buildAgyModelOptions,
  expandAgyGatewayModelsWithEffort,
  prepareAgyEnv,
  resolveAgyGatewayModels,
  resolveAgyTierModels,
} from "../src/clients/agy";
import {
  MIN_MCP_VERSION,
  TAKO_MCP_SERVER_NAME,
  TAKO_MCP_TOOLS,
  buildTakoMcpServerConfig,
  executeTakoGenerateImage,
  executeTakoWebSearch,
  getAgyMcpConfigPath,
  handleMcpRequest,
  injectAgyMcpConfig,
  removeAgyMcpConfig,
  resolveTakoMcpCredentials,
  runTakoMcpServer,
} from "../src/mcp";
import type { Provider } from "../src/providers/types";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_1X1_BYTES = Buffer.from(PNG_1X1_BASE64, "base64");

describe("Feature 1: Official Effort Slider expansion for gemini-3.8-flash", () => {
  it("expands bare gemini-3.8-flash in-place into high/medium/low variants and deduplicates preserving order", () => {
    expect(expandAgyGatewayModelsWithEffort(DEFAULT_AGY_GATEWAY_MODELS)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-lite",
    ]);

    expect(
      expandAgyGatewayModelsWithEffort([
        "claude-opus-4-6",
        "Gemini-3.8-Flash",
        "models/gemini-3.8-flash",
        "claude-opus-4-6",
      ]),
    ).toEqual([
      "claude-opus-4-6",
      ...GEMINI_38_FLASH_EFFORT_VARIANTS,
    ]);
  });

  it("does not expand gemini-3.8-flash when an explicit effort variant already exists", () => {
    expect(
      expandAgyGatewayModelsWithEffort(["claude-opus-4-6", "gemini-3.8-flash", "gemini-3.8-flash-medium"]),
    ).toEqual(["claude-opus-4-6", "gemini-3.8-flash", "gemini-3.8-flash-medium"]);

    expect(
      expandAgyGatewayModelsWithEffort(["gemini-3.8-flash-high", "gemini-3.8-flash-low"]),
    ).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
  });

  it("leaves lists without gemini-3.8-flash unchanged and keeps UI / tier models canonical", () => {
    expect(expandAgyGatewayModelsWithEffort(["claude-opus-4-6", "gemini-3.5-flash-lite"])).toEqual([
      "claude-opus-4-6",
      "gemini-3.5-flash-lite",
    ]);
    expect(expandAgyGatewayModelsWithEffort([])).toEqual([]);

    const provider: Provider = {
      id: "prov-tako",
      name: "Tako",
      type: "tako",
      baseUrl: "https://effort-test.example/v1",
      apiKey: "cr_test",
      createdAt: "2026-11-19T00:00:00.000Z",
    };

    const canonical = resolveAgyGatewayModels(provider, undefined, {});
    expect(canonical).toEqual([...DEFAULT_AGY_GATEWAY_MODELS]);
    expect(resolveAgyTierModels(["gemini-3.8-flash", "gemini-3.5-flash-lite"])).toEqual({
      pro: "gemini-3.8-flash",
      flash: "gemini-3.8-flash",
      flashLite: "gemini-3.5-flash-lite",
    });

    const pickerIds = buildAgyModelOptions(provider).map((o) => o.id);
    expect(pickerIds).toEqual([
      "model-claude-opus-4-6",
      "model-claude-sonnet-4-6",
      "model-gemini-3.8-flash",
      "model-gemini-3.5-flash-lite",
    ]);

    // Explicit user override is preserved verbatim
    const overridden = prepareAgyEnv(
      { AGY_LLM_GATEWAY_MODELS: "claude-opus-4-6,gemini-3.8-flash" },
      provider,
    );
    expect(overridden.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-4-6,gemini-3.8-flash");
  });
});

describe("Feature 2a: Tako MCP tool schemas, credential priority & API executors", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-mcp-tools-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes valid JSON schemas with real JSON integers (never stringified ints)", () => {
    expect(TAKO_MCP_TOOLS.map((t) => t.name)).toEqual(["tako_generate_image", "tako_web_search"]);

    const imgSchema = TAKO_MCP_TOOLS[0].inputSchema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(imgSchema.required).toEqual(["prompt"]);
    expect(imgSchema.properties.aspect_ratio.enum).toEqual(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

    const searchSchema = TAKO_MCP_TOOLS[1].inputSchema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(searchSchema.required).toEqual(["query"]);
    expect(searchSchema.properties.count.type).toBe("integer");
    expect(searchSchema.properties.count.minimum).toBe(1);
    expect(searchSchema.properties.count.maximum).toBe(20);
    expect(typeof searchSchema.properties.count.minimum).toBe("number");
    expect(typeof searchSchema.properties.count.maximum).toBe("number");
  });

  it("resolves credentials with main apiKey prioritized over agyApiKey and strips /v1 or /v1beta", async () => {
    const takoHome = join(tmp, ".tako");
    mkdirSync(takoHome, { recursive: true });
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_config_main",
        agyApiKey: "cr_config_agy",
        defaultProviderId: "p-default",
        clientProviderMap: { agy: "p-agy" },
        providers: [
          {
            id: "p-default",
            name: "Default Tako",
            type: "tako",
            baseUrl: "https://default.tako.test/v1/",
            apiKey: "cr_default_main",
            agyApiKey: "cr_default_agy",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
          {
            id: "p-agy",
            name: "Agy Tako",
            type: "tako",
            baseUrl: "https://agy.tako.test/v1beta/",
            apiKey: "cr_provider_main",
            agyApiKey: "cr_provider_agy",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      }),
    );

    // 1. Active Tako provider main apiKey wins over agyApiKey
    const fromProvider = await resolveTakoMcpCredentials({ takoHome, env: {} });
    expect(fromProvider).toEqual({
      baseUrl: "https://agy.tako.test",
      apiKey: "cr_provider_main",
    });

    // 2. Explicit TAKO_MCP_* overrides beat config
    const fromOverride = await resolveTakoMcpCredentials({
      takoHome,
      env: {
        TAKO_MCP_BASE_URL: "http://127.0.0.1:9999/v1/",
        TAKO_MCP_API_KEY: "cr_mcp_override",
        TAKO_API_KEY: "cr_env_tako",
      },
    });
    expect(fromOverride).toEqual({
      baseUrl: "http://127.0.0.1:9999",
      apiKey: "cr_mcp_override",
    });

    // 3. Fallback chain: config.apiKey > env.TAKO_API_KEY > provider.agyApiKey > config.agyApiKey
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "",
        agyApiKey: "cr_config_agy",
        providers: [
          {
            id: "p1",
            name: "Tako",
            type: "tako",
            baseUrl: "https://only-agy.test/v1",
            agyApiKey: "cr_provider_agy",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(await resolveTakoMcpCredentials({ takoHome, env: { TAKO_API_KEY: "cr_env_main" } })).toEqual({
      baseUrl: "https://only-agy.test",
      apiKey: "cr_env_main",
    });
    expect(await resolveTakoMcpCredentials({ takoHome, env: {} })).toEqual({
      baseUrl: "https://only-agy.test",
      apiKey: "cr_provider_agy",
    });

    writeFileSync(join(takoHome, "config.json"), JSON.stringify({ agyApiKey: "cr_config_agy" }));
    expect(await resolveTakoMcpCredentials({ takoHome, env: {} })).toEqual({
      baseUrl: "https://tako.shiroha.tech",
      apiKey: "cr_config_agy",
    });
  });

  it("executes tako_generate_image (generation + editing + errors) against a mock HTTP server", async () => {
    const requests: Array<{ path: string; apiKey: string | null; body: Record<string, unknown> }> = [];
    let mode: "ok-camel" | "ok-snake" | "no-image" | "http-500" = "ok-camel";

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        requests.push({ path: url.pathname, apiKey: req.headers.get("x-goog-api-key"), body });

        if (mode === "http-500") {
          return new Response("upstream image failed", { status: 500 });
        }
        if (mode === "no-image") {
          return Response.json({
            candidates: [{ content: { parts: [{ text: "Safety refusal" }] } }],
          });
        }
        if (mode === "ok-snake") {
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    { inline_data: { mime_type: "image/webp", data: PNG_1X1_BASE64 } },
                  ],
                },
              },
            ],
          });
        }
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: "A tiny pixel icon" },
                  { inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } },
                ],
              },
            },
          ],
        });
      },
    });

    try {
      const baseEnv = {
        TAKO_MCP_BASE_URL: `http://127.0.0.1:${server.port}/v1beta/`,
        TAKO_MCP_API_KEY: "cr_img_key",
      };
      const outDir = join(tmp, "work");
      mkdirSync(outDir, { recursive: true });

      // 1. Text-to-image with nested custom output_path & aspect_ratio
      const res1 = await executeTakoGenerateImage(
        { prompt: "a blue octopus", output_path: "nested/out.png", aspect_ratio: "16:9" },
        { env: baseEnv, cwd: outDir },
      );
      expect(res1.isError).toBeUndefined();
      expect(res1.content).toHaveLength(2);
      const savedPath = resolve(outDir, "nested/out.png");
      expect(existsSync(savedPath)).toBe(true);
      expect(readFileSync(savedPath)).toEqual(PNG_1X1_BYTES);
      expect(res1.content[0]).toMatchObject({ type: "text" });
      expect((res1.content[0] as { text: string }).text).toContain(savedPath);
      expect((res1.content[0] as { text: string }).text).toContain("A tiny pixel icon");
      expect(res1.content[1]).toEqual({ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" });

      expect(requests[0]?.path).toBe("/v1beta/models/gemini-3.1-flash-image:generateContent");
      expect(requests[0]?.apiKey).toBe("cr_img_key");
      expect(requests[0]?.body).toEqual({
        contents: [{ role: "user", parts: [{ text: "a blue octopus" }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9" },
        },
      });

      // 2. Image editing with input_image_path + snake_case inline_data + default timestamped output path
      mode = "ok-snake";
      const res2 = await executeTakoGenerateImage(
        { prompt: "make it brighter", input_image_path: "nested/out.png", model: "gemini-3-pro-image" },
        { env: baseEnv, cwd: outDir, now: () => new Date(2026, 10, 19, 8, 9, 10) },
      );
      expect(res2.isError).toBeUndefined();
      const defaultPath = join(outDir, "tako-image-20261119-080910.webp");
      expect(existsSync(defaultPath)).toBe(true);
      expect(requests[1]?.path).toBe("/v1beta/models/gemini-3-pro-image:generateContent");
      const editParts = ((requests[1]?.body.contents as Array<{ parts: unknown[] }>)[0]?.parts) ?? [];
      expect(editParts).toEqual([
        { inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } },
        { text: "make it brighter" },
      ]);

      // 3. Error cases never throw
      expect((await executeTakoGenerateImage({ prompt: "   " }, { env: baseEnv })).isError).toBe(true);
      expect(
        (await executeTakoGenerateImage({ prompt: "ok", aspect_ratio: "21:9" }, { env: baseEnv })).isError,
      ).toBe(true);
      expect(
        (await executeTakoGenerateImage({ prompt: "ok" }, { env: {}, takoHome: join(tmp, "empty") })).isError,
      ).toBe(true);
      expect(
        (await executeTakoGenerateImage({ prompt: "ok", input_image_path: "missing.png" }, { env: baseEnv, cwd: outDir })).isError,
      ).toBe(true);

      mode = "no-image";
      const noImg = await executeTakoGenerateImage({ prompt: "ok" }, { env: baseEnv, cwd: outDir });
      expect(noImg.isError).toBe(true);
      expect((noImg.content[0] as { text: string }).text).toContain("Safety refusal");

      mode = "http-500";
      const err500 = await executeTakoGenerateImage({ prompt: "ok" }, { env: baseEnv, cwd: outDir });
      expect(err500.isError).toBe(true);
      expect((err500.content[0] as { text: string }).text).toContain("HTTP 500");
    } finally {
      server.stop(true);
    }
  });

  it("executes tako_web_search (clamping, formatting, empty results, errors) against a mock HTTP server", async () => {
    const requests: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
    let mode: "ok" | "empty" | "http-401" | "bad-json" = "ok";

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        requests.push({ path: url.pathname, auth: req.headers.get("authorization"), body });

        if (mode === "http-401") return new Response("unauthorized", { status: 401 });
        if (mode === "bad-json") return new Response("not-json", { status: 200 });
        if (mode === "empty") return Response.json({ query: body.query, provider: "tavily", results: [] });

        return Response.json({
          query: body.query,
          provider: "brave",
          results: [
            { title: "Tako CLI", url: "https://tako.shiroha.tech", snippet: "Unified AI coding launcher." },
            { title: "MCP Spec", url: "https://modelcontextprotocol.io", snippet: "Model Context Protocol." },
          ],
        });
      },
    });

    try {
      const baseEnv = {
        TAKO_MCP_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        TAKO_MCP_API_KEY: "cr_search_key",
      };

      const res = await executeTakoWebSearch(
        { query: "tako cli", count: 50, provider: "brave" },
        { env: baseEnv },
      );
      expect(res.isError).toBeUndefined();
      expect(requests[0]).toEqual({
        path: "/v1/search",
        auth: "Bearer cr_search_key",
        body: { query: "tako cli", count: 20, provider: "brave" },
      });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("1. Tako CLI");
      expect(text).toContain("https://tako.shiroha.tech");
      expect(text).toContain("2. MCP Spec");

      // Clamp count < 1 to 1
      await executeTakoWebSearch({ query: "min clamp", count: 0 }, { env: baseEnv });
      expect(requests[1]?.body).toEqual({ query: "min clamp", count: 1 });

      // Empty results cleanly reported without isError
      mode = "empty";
      const emptyRes = await executeTakoWebSearch({ query: "nothing" }, { env: baseEnv });
      expect(emptyRes.isError).toBeUndefined();
      expect((emptyRes.content[0] as { text: string }).text).toContain("No web search results");

      // Error handling
      expect((await executeTakoWebSearch({ query: "" }, { env: baseEnv })).isError).toBe(true);
      expect(
        (await executeTakoWebSearch({ query: "x" }, { env: {}, takoHome: join(tmp, "empty") })).isError,
      ).toBe(true);

      mode = "http-401";
      expect((await executeTakoWebSearch({ query: "x" }, { env: baseEnv })).isError).toBe(true);

      mode = "bad-json";
      expect((await executeTakoWebSearch({ query: "x" }, { env: baseEnv })).isError).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("Feature 2b: Tako MCP stdio JSON-RPC 2.0 server", () => {
  it("handles initialize, ping, notifications, tools/list, resources/list, prompts/list, and server/discover", async () => {
    expect(
      await handleMcpRequest(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { version: "0.3.58" },
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tako", version: "0.3.58" },
      },
    });

    // Notifications produce null (no stdout write)
    expect(await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/roots/list_changed" })).toBeNull();
    expect(await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();

    // Critical for agy 1.5.12: server/discover MUST return -32601 immediately
    expect(await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "server/discover" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Method not found: server/discover" },
    });

    expect(await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });

    expect(await handleMcpRequest({ jsonrpc: "2.0", id: 4, method: "tools/list" })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { tools: TAKO_MCP_TOOLS },
    });

    expect(await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "resources/list" })).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { resources: [] },
    });

    expect(await handleMcpRequest({ jsonrpc: "2.0", id: 6, method: "prompts/list" })).toEqual({
      jsonrpc: "2.0",
      id: 6,
      result: { prompts: [] },
    });

    // Unknown tool returns MCP tool isError result
    expect(
      await handleMcpRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        isError: true,
        content: [{ type: "text", text: "Unknown tool: nonexistent_tool" }],
      },
    });
  });

  it("handles chunk splits, CRLF, blank lines, and malformed JSON over stdio streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (c) => chunks.push(c.toString("utf8")));

    const serverPromise = runTakoMcpServer({ stdin, stdout, deps: { version: "0.3.58" } });

    // Split a single JSON message across two chunks
    stdin.write('{"jsonrpc":"2.0","id":1,');
    stdin.write('"method":"initialize"}\r\n\n');
    // Notification (should emit nothing) + server/discover + malformed JSON + ping without trailing newline
    stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"server/discover"}\n' +
      '{not-json\n' +
      '{"jsonrpc":"2.0","id":3,"method":"ping"}',
    );
    stdin.end();

    await serverPromise;

    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const responses = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(responses[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25" } });
    expect(responses[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Method not found: server/discover" },
    });
    expect(responses[2]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(responses[3]).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("runs `tako mcp-server` end-to-end via CLI entrypoint with zero non-JSON stdout noise", async () => {
    const entry = resolve(import.meta.dir, "../src/index.ts");
    const proc = Bun.spawn([process.execPath, entry, "mcp-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAKO_DEV: "1" },
    });

    proc.stdin.write(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
        "",
      ].join("\n"),
    );
    proc.stdin.end();

    const [stdoutText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);

    const lines = stdoutText.trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "tako" } } });
    expect(parsed[1]).toMatchObject({ id: 2, error: { code: -32601 } });
    expect((parsed[2].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([
      "tako_generate_image",
      "tako_web_search",
    ]);
  });
});

describe("Feature 2c: Antigravity mcp_config.json injection & opt-out preservation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-mcp-cfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("builds cross-platform server configs without writing any secrets or Windows .cmd wrappers", () => {
    expect(getAgyMcpConfigPath({ configDir: "/custom/dir" })).toBe(join("/custom/dir", "mcp_config.json"));
    expect(getAgyMcpConfigPath({ home: "/Users/alice" })).toBe(join("/Users/alice", ".gemini", "config", "mcp_config.json"));

    const devCfg = buildTakoMcpServerConfig({
      version: "dev",
      argv1: "/repo/src/index.ts",
      execPath: "/usr/local/bin/bun",
    });
    expect(devCfg).toEqual({
      command: "/usr/local/bin/bun",
      args: ["/repo/src/index.ts", "mcp-server"],
      disabled: false,
    });

    const unixCfg = buildTakoMcpServerConfig({
      takoHome: "/Users/alice/.tako",
      platform: "darwin",
      version: "0.3.58",
    });
    expect(unixCfg).toEqual({
      command: "/Users/alice/.tako/bin/tako",
      args: ["mcp-server"],
      disabled: false,
    });

    const winCfg = buildTakoMcpServerConfig({
      takoHome: "C:\\Users\\Alice\\.tako",
      platform: "win32",
      version: "0.3.58",
      execPath: "C:\\Users\\Alice\\.tako\\bun\\bin\\bun.exe",
    });
    expect(winCfg.command.toLowerCase().endsWith(".exe")).toBe(true);
    expect(winCfg.command.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(winCfg).toEqual({
      command: "C:\\Users\\Alice\\.tako\\bun\\bin\\bun.exe",
      args: ["C:\\Users\\Alice\\.tako\\cli\\node_modules\\tako-cli\\dist\\index.js", "mcp-server"],
      disabled: false,
    });
    expect(Object.keys(winCfg)).toEqual(["command", "args", "disabled"]);

    const winFallbackCfg = buildTakoMcpServerConfig({
      takoHome: "C:\\Users\\Alice\\.tako",
      platform: "win32",
      version: "0.3.58",
      execPath: "C:\\Users\\runneradmin\\.bun\\bin\\bun.exe",
    });
    expect(winFallbackCfg.command.toLowerCase().endsWith(".exe")).toBe(true);
    expect(winFallbackCfg.command.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(winFallbackCfg).toEqual({
      command:
        process.platform === "win32"
          ? "C:\\Users\\runneradmin\\.bun\\bin\\bun.exe"
          : "C:\\Users\\Alice\\.tako\\bun\\bin\\bun.exe",
      args: ["C:\\Users\\Alice\\.tako\\cli\\node_modules\\tako-cli\\dist\\index.js", "mcp-server"],
      disabled: false,
    });
    expect(Object.keys(winFallbackCfg)).toEqual(["command", "args", "disabled"]);

    const fakeWinTakoHome = join(tmp, "win-tako");
    const fakeWinBunExe = join(fakeWinTakoHome, "bun", "bin", "bun.exe");
    mkdirSync(join(fakeWinTakoHome, "bun", "bin"), { recursive: true });
    writeFileSync(fakeWinBunExe, "");
    const winExistingCfg = buildTakoMcpServerConfig({
      takoHome: fakeWinTakoHome,
      platform: "win32",
      version: "0.3.58",
      execPath: join(tmp, "fallback-bun.exe"),
    });
    expect(winExistingCfg.command.toLowerCase().endsWith(".exe")).toBe(true);
    expect(winExistingCfg.command.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(winExistingCfg).toEqual({
      command: fakeWinBunExe,
      args: [join(fakeWinTakoHome, "cli", "node_modules", "tako-cli", "dist", "index.js"), "mcp-server"],
      disabled: false,
    });
    expect(Object.keys(winExistingCfg)).toEqual(["command", "args", "disabled"]);
  });

  it("injects idempotently, preserves other keys/servers, respects disabled:true opt-out, and removes cleanly", async () => {
    const fakeHome = join(tmp, "home");
    const takoHome = join(tmp, ".tako");
    const cfgPath = getAgyMcpConfigPath({ home: fakeHome });

    // 1. Fresh inject creates parent directory and writes mcpServers.tako
    await injectAgyMcpConfig({ home: fakeHome, takoHome, platform: "darwin", version: "0.3.58" });
    expect(existsSync(cfgPath)).toBe(true);
    const created = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    expect(created).toEqual({
      mcpServers: {
        [TAKO_MCP_SERVER_NAME]: {
          command: join(takoHome, "bin", "tako"),
          args: ["mcp-server"],
          disabled: false,
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain("apiKey");

    // 2. Idempotent second call does not rewrite unchanged file
    const mtimeBefore = statSync(cfgPath).mtimeMs;
    await Bun.sleep(15);
    await injectAgyMcpConfig({ home: fakeHome, takoHome, platform: "darwin", version: "0.3.58" });
    expect(statSync(cfgPath).mtimeMs).toBe(mtimeBefore);

    // 3. Preserves all other top-level keys and other mcpServers entries
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          customTopLevel: { enabled: true },
          mcpServers: {
            github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], disabled: false },
          },
        },
        null,
        2,
      ),
    );
    await injectAgyMcpConfig({ home: fakeHome, takoHome, platform: "darwin", version: "0.3.58" });
    const merged = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    expect(merged).toEqual({
      customTopLevel: { enabled: true },
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], disabled: false },
        tako: {
          command: join(takoHome, "bin", "tako"),
          args: ["mcp-server"],
          disabled: false,
        },
      },
    });

    // 4. Respects user opt-out (disabled: true) and never re-enables or overwrites
    const optedOut = {
      customTopLevel: { enabled: true },
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], disabled: false },
        tako: { command: "/old/tako", args: ["mcp-server"], disabled: true },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(optedOut, null, 2));
    await injectAgyMcpConfig({ home: fakeHome, takoHome, platform: "darwin", version: "0.3.58" });
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual(optedOut);

    // 5. removeAgyMcpConfig deletes ONLY mcpServers.tako
    await removeAgyMcpConfig({ home: fakeHome });
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual({
      customTopLevel: { enabled: true },
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], disabled: false },
      },
    });
  });

  it("checks installed CLI version >= MIN_MCP_VERSION when auto-injecting without explicit home/configDir", async () => {
    const fakeHome = join(tmp, "auto-home");
    const takoHome = join(tmp, "auto-tako");
    const pkgDir = join(takoHome, "cli", "node_modules", "tako-cli");
    mkdirSync(pkgDir, { recursive: true });
    const cfgPath = getAgyMcpConfigPath({ env: { HOME: fakeHome } });

    // Older installed version (< 0.3.58) -> skips auto-injection
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.3.57" }));
    await injectAgyMcpConfig({ env: { HOME: fakeHome, TAKO_HOME: takoHome }, version: "0.3.57" });
    expect(existsSync(cfgPath)).toBe(false);

    // Supported version (>= MIN_MCP_VERSION) -> injects
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: MIN_MCP_VERSION }));
    await injectAgyMcpConfig({ env: { HOME: fakeHome, TAKO_HOME: takoHome }, version: MIN_MCP_VERSION });
    expect(existsSync(cfgPath)).toBe(true);
  });
});
