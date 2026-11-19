import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgyStatusLineConfig,
  buildStatusLineCommand,
  injectAgyStatusLineConfig,
  removeAgyStatusLineConfig,
  renderStatusLine,
  type StatusLineInput,
} from "../src/statusline";
import {
  ContextSegment,
  parseTranscriptTokens,
  statusLineUsageTokens,
} from "../src/statusline/segments/context";
import { MODEL_DISPLAY_NAMES, ModelSegment } from "../src/statusline/segments/model";

describe("Antigravity (agy) statusLine segments, transcript parsing & config injection", () => {
  let tmp: string;
  let savedAgyHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-statusline-"));
    savedAgyHome = process.env.AGY_HOME;
  });

  afterEach(() => {
    if (savedAgyHome === undefined) delete process.env.AGY_HOME;
    else process.env.AGY_HOME = savedAgyHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("computes statusLineUsageTokens for Claude current_usage, agy total_input_tokens, and used_percentage", () => {
    const base = {
      product: "antigravity",
      cwd: "/tmp/proj",
      model: { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
      workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj" },
      transcript_path: "/tmp/missing.jsonl",
    };

    // 1. Prefers current_usage when present
    expect(
      statusLineUsageTokens({
        ...base,
        context_window: {
          context_window_size: 1_000_000,
          total_input_tokens: 999_999,
          total_output_tokens: 500,
          current_usage: {
            input_tokens: 10_000,
            output_tokens: 200,
            cache_creation_input_tokens: 1_000,
            cache_read_input_tokens: 4_000,
          },
          used_percentage: 50,
          remaining_percentage: 50,
        },
      }),
    ).toBe(15_000);

    // 2. Falls back to total_input_tokens > 0 when current_usage is null (agy 1.5.12)
    expect(
      statusLineUsageTokens({
        ...base,
        context_window: {
          context_window_size: 1_000_000,
          total_input_tokens: 120_000,
          total_output_tokens: 3_500,
          current_usage: null,
          used_percentage: 25,
          remaining_percentage: 75,
        },
      }),
    ).toBe(120_000);

    // 3. Falls back to used_percentage > 0 when total_input_tokens is 0 / absent
    expect(
      statusLineUsageTokens({
        ...base,
        context_window: {
          context_window_size: 1_000_000,
          total_input_tokens: 0,
          current_usage: null,
          used_percentage: 12.5,
          remaining_percentage: 87.5,
        },
      }),
    ).toBe(125_000);

    // 4. Returns null when all usage fields are empty / 0
    expect(
      statusLineUsageTokens({
        ...base,
        context_window: {
          context_window_size: 1_000_000,
          total_input_tokens: 0,
          current_usage: null,
          used_percentage: 0,
          remaining_percentage: 100,
        },
      }),
    ).toBeNull();
  });

  it("parses both Claude assistant usage and agy PLANNER_RESPONSE tokens in parseTranscriptTokens", async () => {
    const agyTranscript = join(tmp, "agy-transcript.jsonl");
    writeFileSync(
      agyTranscript,
      [
        JSON.stringify({ type: "USER_INPUT", content: "hi" }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          input_tokens: 14_500,
          cache_read_tokens: 85_500,
          output_tokens: 800,
        }),
        JSON.stringify({ type: "GENERIC", content: "tool output" }),
      ].join("\n"),
      "utf8",
    );
    expect(await parseTranscriptTokens(agyTranscript)).toBe(100_000);

    const cacheOnlyTranscript = join(tmp, "agy-cache-only.jsonl");
    writeFileSync(
      cacheOnlyTranscript,
      JSON.stringify({ type: "PLANNER_RESPONSE", cache_read_tokens: 42_000 }),
      "utf8",
    );
    expect(await parseTranscriptTokens(cacheOnlyTranscript)).toBe(42_000);

    const claudeTranscript = join(tmp, "claude-transcript.jsonl");
    writeFileSync(
      claudeTranscript,
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 3000,
          },
        },
      }),
      "utf8",
    );
    expect(await parseTranscriptTokens(claudeTranscript)).toBe(6_000);

    const rendered = await new ContextSegment().render({
      product: "antigravity",
      model: { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
      workspace: { current_dir: tmp },
      transcript_path: agyTranscript,
      context_window: {
        context_window_size: 1_000_000,
        total_input_tokens: 0,
        current_usage: null,
        used_percentage: 0,
        remaining_percentage: 100,
      },
    });
    expect(rendered).toContain("90%");
  });

  it("maps Antigravity model IDs cleanly in MODEL_DISPLAY_NAMES and ModelSegment", () => {
    const expected: Record<string, string> = {
      "claude-opus-4-6": "Opus 4.6",
      "claude-opus-4-6-thinking": "Opus 4.6",
      "claude-sonnet-4-6": "Sonnet 4.6",
      "gemini-3.8-flash": "Gemini 3.8 Flash",
      "gemini-3.5-flash-lite": "Flash 3.5 Lite",
      "gpt-oss-120b-medium": "GPT-OSS 120B",
    };
    const seg = new ModelSegment();
    for (const [id, label] of Object.entries(expected)) {
      expect(MODEL_DISPLAY_NAMES[id]).toBe(label);
      const out = seg.render({
        product: "antigravity",
        model: { id, display_name: id },
        workspace: { current_dir: tmp },
        transcript_path: "",
      });
      expect(out).toContain(label);
    }
  });

  it("queries agy-bound provider in QuotaSegment when input.product === 'antigravity'", async () => {
    const takoHome = join(tmp, ".tako");
    mkdirSync(takoHome, { recursive: true });
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "cr_claude",
        apiId: "1",
        installedClients: {},
        defaultProviderId: "prov-claude",
        clientProviderMap: {
          "claude-code": "prov-claude",
          agy: "prov-agy",
        },
        providers: [
          {
            id: "prov-claude",
            name: "Claude Prov",
            type: "tako",
            apiKey: "cr_claude_key",
            baseUrl: "https://tako.example.test/v1",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
          {
            id: "prov-agy",
            name: "Agy Prov",
            type: "tako",
            apiKey: "cr_agy_bound_key",
            baseUrl: "https://tako.example.test/v1",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      }),
    );

    const quotaCachePath = join(takoHome, "quota-cache.json");
    const statuslineUrl = new URL("../src/statusline/index.ts", import.meta.url).href;
    const quotaModUrl = new URL("../src/quota/index.ts", import.meta.url).href;
    const crypto = await import("node:crypto");
    const agyFp = crypto.createHash("sha256").update("cr_agy_bound_key").digest("hex").slice(0, 12);
    const claudeFp = crypto.createHash("sha256").update("cr_claude_key").digest("hex").slice(0, 12);
    writeFileSync(
      quotaCachePath,
      JSON.stringify({
        [`tako:prov-agy:${agyFp}`]: {
          provider: "tako",
          status: "ok",
          daily: { usedPct: 0, costUsed: 7.77 },
          fetchedAt: Date.now(),
        },
        [`tako:prov-claude:${claudeFp}`]: {
          provider: "tako",
          status: "ok",
          daily: { usedPct: 0, costUsed: 1.11 },
          fetchedAt: Date.now(),
        },
      }),
    );

    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const q = await import(${JSON.stringify(quotaModUrl)});
         q._setQuotaDiskCachePathForTest(${JSON.stringify(quotaCachePath)});
         const { renderStatusLine } = await import(${JSON.stringify(statuslineUrl)});
         const agyLine = await renderStatusLine({
           product: "antigravity",
           cwd: ${JSON.stringify(tmp)},
           model: { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
           workspace: { current_dir: ${JSON.stringify(tmp)}, project_dir: ${JSON.stringify(tmp)} },
           transcript_path: "",
           context_window: {
             context_window_size: 1000000,
             total_input_tokens: 50000,
             total_output_tokens: 1000,
             current_usage: null,
             used_percentage: 5,
             remaining_percentage: 95,
           },
         });
         const claudeLine = await renderStatusLine({
           model: { id: "claude-opus-4-5", display_name: "Claude Opus 4.5" },
           workspace: { current_dir: ${JSON.stringify(tmp)} },
           transcript_path: "",
         });
         console.log(JSON.stringify({ agyLine, claudeLine }));`,
      ],
      {
        env: { ...process.env, TAKO_HOME: takoHome, TAKO_DEV: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const { agyLine, claudeLine } = JSON.parse(out.trim()) as { agyLine: string; claudeLine: string };
    expect(agyLine).toContain("Opus 4.6");
    expect(agyLine).toContain("Day:$7.77");
    expect(claudeLine).toContain("Day:$1.11");
  });

  it("injects and removes Tako statusLine in agy settings.json while preserving custom non-Tako statusLine", async () => {
    const cmd = buildStatusLineCommand();
    expect(cmd).toContain("statusline");
    expect(buildAgyStatusLineConfig()).toEqual({
      type: "command",
      command: cmd,
      stack_with_default: true,
    });

    const agyHome = join(tmp, "agy-cfg");
    const settingsPath = join(agyHome, "settings.json");

    // 1. Fresh inject creates settings.json with stack_with_default: true
    await injectAgyStatusLineConfig(agyHome);
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      statusLine: buildAgyStatusLineConfig(),
    });

    // 2. Preserves other fields on update & removes cleanly via removeAgyStatusLineConfig
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "solarized",
        trustedWorkspaces: ["/a"],
        statusLine: { type: "command", command: "old-tako statusline", stack_with_default: true },
      }),
      "utf8",
    );
    await injectAgyStatusLineConfig(agyHome);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "solarized",
      trustedWorkspaces: ["/a"],
      statusLine: buildAgyStatusLineConfig(),
    });

    await removeAgyStatusLineConfig(agyHome);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "solarized",
      trustedWorkspaces: ["/a"],
    });

    // 3. Never overwrites or removes user's custom non-Tako statusLine
    const customSettings = {
      theme: "monokai",
      statusLine: { type: "command", command: "/usr/local/bin/my-custom-bar" },
    };
    writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2), "utf8");

    await injectAgyStatusLineConfig(agyHome);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(customSettings);

    await removeAgyStatusLineConfig(agyHome);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(customSettings);
  });
});
