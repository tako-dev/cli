import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/clients";
import { getAllClients, getClient, getClientLaunchOptions } from "../src/clients/base";
import {
  AGY_CONFLICTING_ENV_KEYS,
  AgyClient,
  agyClient,
  agyStandardCandidates,
  buildAgyArgs,
  buildAgyModelOptions,
  DEFAULT_AGY_GATEWAY_MODELS,
  expandAgyGatewayModelsWithEffort,
  findAgyBinary,
  isAgySupportedModelId,
  normalizeAgyGatewayUrl,
  normalizeAgyModelId,
  parseAgyVersion,
  prepareAgyEnv,
  resolveAgyApiKey,
  resolveAgyGatewayModels,
  resolveAgyGatewayUrl,
  resolveAgyTierModels,
  splitAgyPathEnv,
} from "../src/clients/agy";
import { buildPassthroughArgs } from "../src/quick-launch-args";
import { buildWindowsHandoffScript } from "../src/windows-handoff";
import { _resetTakoCatalog, _setCachePathForTest } from "../src/models/tako";
import type { Provider } from "../src/providers/types";

describe("Antigravity (agy) client registration", () => {
  it("registers AgyClient cleanly in the visible launcher list and retires gemini", () => {
    const ids = getAllClients().map((c) => c.id);
    expect(ids).toEqual(["codex", "claude-code", "pi", "grok", "agy"]);
    expect(ids).not.toContain("gemini");
    expect(getClient("gemini")).toBeUndefined();
    expect(AgyClient).toBe(agyClient);
    expect(getClient("agy")?.name).toBe("Antigravity (agy)");
    expect(getClient("agy")?.install).toBe("system");
    expect(getClient("agy")?.runtime).toBe("native");
    expect(getClient("agy")?.oneClickInstall).toBe(true);
    expect(getClient("agy")?.unsetEnvVars).toEqual(AGY_CONFLICTING_ENV_KEYS);
  });

  it("parses agy --version output", () => {
    expect(parseAgyVersion("1.5.11\n")).toBe("1.5.11");
    expect(parseAgyVersion("agy version 1.5.11-beta.1")).toBe("1.5.11-beta.1");
    expect(parseAgyVersion("unknown")).toBeNull();
  });
});

describe("Antigravity binary resolution", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-bin-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists expected standard locations on macOS/Linux and Windows", () => {
    expect(agyStandardCandidates("/Users/alice", "darwin", {})).toEqual([
      "/Users/alice/.local/bin/agy",
      "/Users/alice/.gemini/bin/agy",
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ]);

    expect(
      agyStandardCandidates("C:\\Users\\Alice", "win32", {
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      }),
    ).toEqual([
      "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe",
      "C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe",
      "C:\\Users\\Alice\\.local\\bin\\agy.exe",
    ]);
  });

  it("resolves AGY_PATH first, then PATH, then standard install paths", async () => {
    const explicitBin = join(tmp, "custom", "agy");
    const pathDir = join(tmp, "path-bin");
    const pathBin = join(pathDir, "agy");
    const homeDir = join(tmp, "home");
    const localBin = join(homeDir, ".local", "bin", "agy");

    mkdirSync(join(tmp, "custom"), { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });

    for (const p of [explicitBin, pathBin, localBin]) {
      writeFileSync(p, "#!/bin/sh\necho 1.5.11\n");
      if (process.platform !== "win32") chmodSync(p, 0o755);
    }

    expect(splitAgyPathEnv("C:\\Users\\runner\\path-bin", "darwin")).toEqual([
      "C:\\Users\\runner\\path-bin",
    ]);
    expect(splitAgyPathEnv("/usr/local/bin:/usr/bin", "darwin")).toEqual([
      "/usr/local/bin",
      "/usr/bin",
    ]);

    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: explicitBin, PATH: pathDir },
      }),
    ).toBe(explicitBin);

    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: join(tmp, "missing-agy"), PATH: pathDir },
      }),
    ).toBe(pathBin);

    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { PATH: join(tmp, "empty-dir") },
      }),
    ).toBe(localBin);
  });

  it("resolves Windows %LOCALAPPDATA%\\agy\\bin\\agy.exe when not on PATH", async () => {
    const localAppData = join(tmp, "LocalAppData");
    const winBin = join(localAppData, "agy", "bin", "agy.exe");
    mkdirSync(join(localAppData, "agy", "bin"), { recursive: true });
    writeFileSync(winBin, "MZ-mock");

    expect(
      await findAgyBinary({
        platform: "win32",
        home: join(tmp, "win-home"),
        env: { LOCALAPPDATA: localAppData, PATH: "" },
      }),
    ).toBe(winBin);
  });
});

describe("Antigravity environment & gateway URL preparation", () => {
  it("strips trailing slashes and /v1 or /v1beta suffixes from gateway URL", () => {
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1/")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1beta")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech/v1beta/")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("https://tako.shiroha.tech///")).toBe("https://tako.shiroha.tech");
    expect(normalizeAgyGatewayUrl("http://127.0.0.1:9000/gw/v1")).toBe("http://127.0.0.1:9000/gw");
    expect(normalizeAgyGatewayUrl("http://127.0.0.1:9000/v10")).toBe("http://127.0.0.1:9000/v10");

    expect(
      resolveAgyGatewayUrl("https://tako.shiroha.tech/v1", {
        TAKO_AGY_GATEWAY_URL: "https://override.example.test/v1beta/",
      }),
    ).toBe("https://override.example.test");
  });

  it("computes gateway API key with TAKO_AGY_API_KEY > agyApiKey > apiKey precedence", () => {
    expect(
      resolveAgyApiKey({ agyApiKey: "cr_agy_cfg", apiKey: "cr_main" }, "cr_fallback", {
        TAKO_AGY_API_KEY: "cr_env_override",
      }),
    ).toBe("cr_env_override");

    expect(
      resolveAgyApiKey({ agyApiKey: "cr_agy_cfg", apiKey: "cr_main" }, "cr_fallback", {}),
    ).toBe("cr_agy_cfg");

    expect(
      resolveAgyApiKey({ apiKey: "cr_main" }, "cr_fallback", {}),
    ).toBe("cr_main");

    expect(resolveAgyApiKey({}, "cr_fallback", {})).toBe("cr_fallback");
  });

  it("clones baseEnv, deletes all conflicting Gemini/Google/AICode vars, and sets AGY_LLM_GATEWAY_*", () => {
    const parentEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/dev",
      GOOGLE_GEMINI_BASE_URL: "https://conflict.gemini.example",
      GEMINI_API_KEY: "conflict-gemini-key",
      GOOGLE_API_KEY: "conflict-google-key",
      AICODE_ENDPOINT_URL: "https://conflict.aicode.example",
    };

    const childEnv = prepareAgyEnv(parentEnv, {
      baseUrl: "https://tako.shiroha.tech/v1/",
      apiKey: "cr_main_key",
      agyApiKey: "cr_dedicated_agy_key",
    });

    expect(parentEnv.GEMINI_API_KEY).toBe("conflict-gemini-key");

    for (const conflictKey of AGY_CONFLICTING_ENV_KEYS) {
      expect(Object.hasOwn(childEnv, conflictKey)).toBe(false);
    }

    expect(childEnv.PATH).toBe("/usr/bin:/bin");
    expect(childEnv.AGY_LLM_GATEWAY_URL).toBe("https://tako.shiroha.tech");
    expect(childEnv.AGY_LLM_GATEWAY_API_KEY).toBe("cr_dedicated_agy_key");
    expect(childEnv.AGY_LLM_GATEWAY_MODELS).toBe(
      expandAgyGatewayModelsWithEffort(DEFAULT_AGY_GATEWAY_MODELS).join(","),
    );
    expect(childEnv.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-4-6");
    expect(childEnv.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-4-6");
    expect(childEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gemini-3.5-flash-lite");
  });

  it("preserves non-empty user overrides for AGY_LLM_GATEWAY_MODELS and TIER_* in prepareAgyEnv and getEnvVars", () => {
    const childEnv = prepareAgyEnv(
      {
        AGY_LLM_GATEWAY_MODELS: "  claude-opus-5-5,gemini-3.8-flash  ",
        AGY_LLM_GATEWAY_TIER_PRO: "claude-opus-5-5",
        AGY_LLM_GATEWAY_TIER_FLASH: "   ",
        AGY_LLM_GATEWAY_TIER_FLASH_LITE: "gpt-oss-120b",
      },
      {
        baseUrl: "https://tako.shiroha.tech/v1",
        apiKey: "cr_main",
      },
    );

    expect(childEnv.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-5-5,gemini-3.8-flash");
    expect(childEnv.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-5-5");
    expect(childEnv.AGY_LLM_GATEWAY_TIER_FLASH).toBe("claude-sonnet-4-6");
    expect(childEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gpt-oss-120b");

    const saved: Record<string, string | undefined> = {};
    const keys = [
      "AGY_LLM_GATEWAY_MODELS",
      "AGY_LLM_GATEWAY_TIER_PRO",
      "AGY_LLM_GATEWAY_TIER_FLASH",
      "AGY_LLM_GATEWAY_TIER_FLASH_LITE",
      "TAKO_AGY_GATEWAY_URL",
      "TAKO_AGY_API_KEY",
    ];
    for (const k of keys) saved[k] = process.env[k];
    try {
      for (const k of keys) delete process.env[k];
      process.env.AGY_LLM_GATEWAY_MODELS = "claude-sonnet-5-5,gemini-3.5-flash-lite";
      process.env.AGY_LLM_GATEWAY_TIER_PRO = "gemini-4-pro";

      const envVars = agyClient.getEnvVars({
        type: "tako",
        baseUrl: "https://tako.shiroha.tech/v1",
        apiKey: "cr_main",
        agyApiKey: "cr_agy_key",
      });
      expect(envVars).toEqual({
        AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
        AGY_LLM_GATEWAY_API_KEY: "cr_agy_key",
        AGY_LLM_GATEWAY_MODELS: "claude-sonnet-5-5,gemini-3.5-flash-lite",
        AGY_LLM_GATEWAY_TIER_PRO: "gemini-4-pro",
        AGY_LLM_GATEWAY_TIER_FLASH: "claude-sonnet-4-6",
        AGY_LLM_GATEWAY_TIER_FLASH_LITE: "gemini-3.5-flash-lite",
      });
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("emits Remove-Item for conflicting env vars in Windows PowerShell handoff scripts", () => {
    const script = buildWindowsHandoffScript({
      command: ["C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe"],
      cwd: "C:\\work",
      unsetEnv: agyClient.unsetEnvVars,
      env: {
        AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
        AGY_LLM_GATEWAY_API_KEY: "cr_test",
      },
    });
    for (const key of AGY_CONFLICTING_ENV_KEYS) {
      expect(script).toContain(`Remove-Item -Path Env:${key} -ErrorAction SilentlyContinue`);
    }
    expect(script).toContain("$env:AGY_LLM_GATEWAY_URL = 'https://tako.shiroha.tech'");
  });
});

describe("Antigravity models, filtering, tier resolution & quick-launch args", () => {
  let tmpDir: string;
  const BASE = "https://agy-models.example.test";
  const KEY = "cr_agy_models";
  const FP = createHash("sha256").update(KEY).digest("hex");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tako-agy-models-"));
    _setCachePathForTest(join(tmpDir, "models-cache.json"));
    _resetTakoCatalog();
    writeFileSync(
      join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE}#agy-v2#${FP}`]: {
            fetchedAt: Date.now(),
            entries: [
              {
                id: "models/claude-opus-4-6",
                displayName: "Claude Opus 4.6",
                description: "Flagship reasoning model",
                contextWindow: 1000000,
                sortOrder: 0,
                category: "chat",
              },
              {
                id: "claude-opus-4-6",
                displayName: "Duplicate Claude Opus 4.6",
                description: "Duplicate",
                contextWindow: 1000000,
                sortOrder: 1,
                category: "chat",
              },
              {
                id: "gemini-3.8-flash",
                displayName: "Gemini 3.8 Flash",
                description: "Fast multimodal model",
                contextWindow: 1048576,
                sortOrder: 2,
                category: "chat",
              },
              {
                id: "gpt-oss-120b",
                displayName: "GPT OSS 120B",
                description: "Open-weight fast model",
                contextWindow: 128000,
                sortOrder: 3,
                category: "chat",
              },
              {
                id: "deepseek-v4-flash",
                displayName: "DeepSeek V4 Flash",
                description: "Non-agy chat model",
                contextWindow: 128000,
                sortOrder: 4,
                category: "chat",
              },
              {
                id: "gemini-3-pro-image",
                displayName: "Gemini 3 Pro Image",
                description: "Image generation",
                contextWindow: 32000,
                sortOrder: 5,
                category: "chat",
              },
              {
                id: "claude-sonnet-4-6",
                displayName: "Claude Sonnet Image Category",
                description: "Marked non-chat",
                contextWindow: 200000,
                sortOrder: 6,
                category: "image",
              },
            ],
          },
        },
      }),
    );
  });

  afterEach(() => {
    _setCachePathForTest(null);
    _resetTakoCatalog();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches only Antigravity-supported model families in isAgySupportedModelId", () => {
    expect(DEFAULT_AGY_GATEWAY_MODELS).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);

    const supported = [
      "claude-opus-4-6",
      "models/claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6-high",
      "claude-haiku-4-5-20251001",
      "gemini-3.8-flash",
      "gemini-3.8-flash-high",
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash-lite-low",
      "gemini-4-pro",
      "gemini-4-flash-preview",
      "gpt-oss-120b",
      "gpt-oss-20b-medium",
    ];
    for (const id of supported) {
      expect(isAgySupportedModelId(id)).toBe(true);
    }

    const rejected = [
      "",
      "   ",
      "models/",
      "anthropic/claude-opus-4-6",
      "claude-opus-4.6",
      "claude-opus-4-6[1m]",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.1-pro-image",
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-4-image",
      "gemini-4-pro-video",
      "gemini-4-tts",
      "gemini-4-embedding",
      "veo-3",
      "lyria-2",
      "aqa",
      "gemma-4-31b-it",
      "glm-5.3",
      "deepseek-v4-flash",
      "kimi-k3",
      "gpt-6-sol",
      "gpt-5.6",
      "grok-4.6",
      "mimo-v2.6-pro",
      "minimax-m3",
      "swe-2-flash",
      "tako-auto",
      "composer-2.5",
    ];
    for (const id of rejected) {
      expect(isAgySupportedModelId(id)).toBe(false);
    }
  });

  it("resolves tier models with expected fallbacks in resolveAgyTierModels", () => {
    expect(resolveAgyTierModels(DEFAULT_AGY_GATEWAY_MODELS)).toEqual({
      pro: "claude-opus-4-6",
      flash: "claude-sonnet-4-6",
      flashLite: "gemini-3.5-flash-lite",
    });

    expect(resolveAgyTierModels([])).toEqual({
      pro: "claude-opus-4-6",
      flash: "claude-sonnet-4-6",
      flashLite: "gemini-3.5-flash-lite",
    });

    expect(resolveAgyTierModels(["gemini-4-pro", "gemini-3.8-flash", "gpt-oss-120b"])).toEqual({
      pro: "gemini-4-pro",
      flash: "gemini-3.8-flash",
      flashLite: "gpt-oss-120b",
    });

    expect(resolveAgyTierModels(["claude-haiku-4-5", "claude-sonnet-4-6"])).toEqual({
      pro: "claude-haiku-4-5",
      flash: "claude-sonnet-4-6",
      flashLite: "claude-sonnet-4-6",
    });
  });

  it("resolves filtered Agy gateway models from #agy-v2# cache and injects into prepareAgyEnv / getEnvVars", () => {
    const models = resolveAgyGatewayModels(
      { baseUrl: `${BASE}/v1`, apiKey: "cr_unused", agyApiKey: KEY },
      undefined,
      {},
    );
    expect(models).toEqual(["claude-opus-4-6", "gemini-3.8-flash", "gpt-oss-120b"]);

    const env = prepareAgyEnv({}, { baseUrl: `${BASE}/v1`, apiKey: "cr_unused", agyApiKey: KEY });
    expect(env.AGY_LLM_GATEWAY_URL).toBe(BASE);
    expect(env.AGY_LLM_GATEWAY_API_KEY).toBe(KEY);
    expect(env.AGY_LLM_GATEWAY_MODELS).toBe(
      "claude-opus-4-6,gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low,gpt-oss-120b",
    );
    expect(env.AGY_LLM_GATEWAY_TIER_PRO).toBe("claude-opus-4-6");
    expect(env.AGY_LLM_GATEWAY_TIER_FLASH).toBe("gemini-3.8-flash");
    expect(env.AGY_LLM_GATEWAY_TIER_FLASH_LITE).toBe("gpt-oss-120b");
  });

  it("falls back to DEFAULT_AGY_GATEWAY_MODELS on cold cache, stale #gemini# cache, or non-agy-only cache", () => {
    const coldProv: Provider = {
      id: "p-cold",
      name: "Cold",
      type: "tako",
      baseUrl: "https://cold.example.test/v1",
      apiKey: "cr_cold",
      createdAt: "2026-11-18T00:00:00.000Z",
    };
    expect(resolveAgyGatewayModels(coldProv, undefined, {})).toEqual([...DEFAULT_AGY_GATEWAY_MODELS]);
    expect(buildAgyModelOptions(coldProv).map((o) => o.id)).toEqual(
      DEFAULT_AGY_GATEWAY_MODELS.map((id) => `model-${id}`),
    );

    const staleKey = "cr_stale_v0354";
    const staleFp = createHash("sha256").update(staleKey).digest("hex");
    const nonAgyKey = "cr_non_agy_only";
    const nonAgyFp = createHash("sha256").update(nonAgyKey).digest("hex");
    writeFileSync(
      join(tmpDir, "models-cache.json"),
      JSON.stringify({
        version: 2,
        buckets: {
          [`${BASE}#gemini#${staleFp}`]: {
            fetchedAt: Date.now(),
            entries: [
              { id: "deepseek-v4-flash", displayName: "DeepSeek", description: "", contextWindow: 128000, sortOrder: 0, category: "chat" },
              { id: "glm-5.3", displayName: "GLM 5.3", description: "", contextWindow: 128000, sortOrder: 1, category: "chat" },
            ],
          },
          [`${BASE}#agy-v2#${nonAgyFp}`]: {
            fetchedAt: Date.now(),
            entries: [
              { id: "deepseek-v4-flash", displayName: "DeepSeek", description: "", contextWindow: 128000, sortOrder: 0, category: "chat" },
              { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", description: "", contextWindow: 1000000, sortOrder: 1, category: "chat" },
            ],
          },
        },
      }),
    );
    _resetTakoCatalog();

    for (const apiKey of [staleKey, nonAgyKey]) {
      const prov: Provider = {
        id: "p-fallback",
        name: "Tako",
        type: "tako",
        baseUrl: `${BASE}/v1`,
        apiKey,
        createdAt: "2026-11-18T00:00:00.000Z",
      };
      expect(resolveAgyGatewayModels(prov, undefined, {})).toEqual([...DEFAULT_AGY_GATEWAY_MODELS]);
      expect(buildAgyModelOptions(prov).map((o) => o.id)).toEqual(
        DEFAULT_AGY_GATEWAY_MODELS.map((id) => `model-${id}`),
      );
    }
  });

  it("strips models/ prefix in normalizeAgyModelId and buildAgyArgs", () => {
    expect(normalizeAgyModelId("models/claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeAgyModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(
      buildAgyArgs({ model: "models/claude-opus-4-6", skipPermissions: true, extraArgs: ["-c"] }),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-6", "-c"]);
  });

  it("exposes skip-permissions and filtered Agy model options even when provider baseUrl has /v1", () => {
    const prov: Provider = {
      id: "p-agy",
      name: "Tako",
      type: "tako",
      baseUrl: `${BASE}/v1`,
      apiKey: "cr_unused_main",
      agyApiKey: KEY,
      createdAt: "2026-11-18T00:00:00.000Z",
    };

    const options = getClientLaunchOptions(agyClient, prov);
    expect(options[0]?.id).toBe("skip-permissions");
    expect(options[0]?.args).toEqual(["--dangerously-skip-permissions"]);
    expect(options[0]?.defaultOn).toBe(true);

    const modelOpts = options.filter((o) => o.group === "model");
    expect(modelOpts.map((o) => o.id)).toEqual([
      "model-claude-opus-4-6",
      "model-gemini-3.8-flash",
      "model-gpt-oss-120b",
    ]);
    expect(modelOpts[0]?.args).toEqual(["--model", "claude-opus-4-6"]);
    expect(modelOpts[0]?.shortLabel).toBe("Claude Opus 4.6");
  });

  it("wires --agy passthrough args with inherited --dangerously-skip-permissions and model normalization", async () => {
    expect(
      await buildPassthroughArgs("agy", ["--agy", "--model", "models/claude-opus-4-6"], "--agy", {
        getLastSelectedOptionIds: async () => [],
      }),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-6"]);

    expect(
      await buildPassthroughArgs("agy", ["--agy", "--model=models/gemini-3.8-flash"], "--agy", {
        getLastSelectedOptionIds: async () => ["model-gemini-3.8-flash"],
      }),
    ).toEqual(["--model=gemini-3.8-flash"]);

    expect(
      await buildPassthroughArgs("agy", ["--agy", "--dangerously-skip-permissions"], "--agy", {
        getLastSelectedOptionIds: async () => ["skip-permissions"],
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });
});
