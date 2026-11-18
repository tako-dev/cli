import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
  computeFileSha512,
  ensureClientReady,
  getGeminiRetiredMessage,
  installAgy,
  installAgyFromManifest,
  installClient,
  isDirOnPath,
  resolveAgyInstallTarget,
  resolveAgyManifestUrl,
  resolveAgyPlatform,
} from "../src/installer";
import { clearLocaleOverride, setLocale } from "../src/i18n";
import { migrateSupportedClients } from "../src/providers";
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

    // 1. AGY_PATH wins over PATH and ~/.local/bin
    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: explicitBin, PATH: pathDir },
      }),
    ).toBe(explicitBin);

    // 2. Invalid AGY_PATH falls through to PATH
    expect(
      await findAgyBinary({
        platform: "darwin",
        home: homeDir,
        env: { AGY_PATH: join(tmp, "missing-agy"), PATH: pathDir },
      }),
    ).toBe(pathBin);

    // 3. Empty PATH falls through to ~/.local/bin/agy
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

    // Original parentEnv untouched
    expect(parentEnv.GEMINI_API_KEY).toBe("conflict-gemini-key");

    // Conflicting keys completely deleted (not empty strings)
    for (const conflictKey of AGY_CONFLICTING_ENV_KEYS) {
      expect(Object.hasOwn(childEnv, conflictKey)).toBe(false);
    }

    expect(childEnv.PATH).toBe("/usr/bin:/bin");
    expect(childEnv.AGY_LLM_GATEWAY_URL).toBe("https://tako.shiroha.tech");
    expect(childEnv.AGY_LLM_GATEWAY_API_KEY).toBe("cr_dedicated_agy_key");
    expect(childEnv.AGY_LLM_GATEWAY_MODELS).toBe(DEFAULT_AGY_GATEWAY_MODELS.join(","));
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
      "gemini-3.1-pro-preview",
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
    expect(env.AGY_LLM_GATEWAY_MODELS).toBe("claude-opus-4-6,gemini-3.8-flash,gpt-oss-120b");
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

    // Stale v0.3.54 #gemini# bucket + #agy-v2# with only non-agy models
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
              { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro", description: "", contextWindow: 1000000, sortOrder: 1, category: "chat" },
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

describe("Antigravity cross-platform one-click installer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-agy-install-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps platform and arch to official manifest keys including linux musl", () => {
    expect(resolveAgyPlatform("darwin", "arm64")).toBe("darwin_arm64");
    expect(resolveAgyPlatform("darwin", "x64")).toBe("darwin_amd64");
    expect(resolveAgyPlatform("linux", "x64", { isMusl: false })).toBe("linux_amd64");
    expect(resolveAgyPlatform("linux", "arm64", { isMusl: false })).toBe("linux_arm64");
    expect(resolveAgyPlatform("linux", "x64", { isMusl: true })).toBe("linux_amd64_musl");
    expect(resolveAgyPlatform("linux", "arm64", { isMusl: true })).toBe("linux_arm64_musl");
    expect(resolveAgyPlatform("win32", "x64")).toBe("windows_amd64");
    expect(resolveAgyPlatform("win32", "arm64")).toBe("windows_arm64");
    expect(() => resolveAgyPlatform("freebsd" as NodeJS.Platform, "x64")).toThrow();
    expect(() => resolveAgyPlatform("darwin", "ia32")).toThrow();
  });

  it("resolves manifest URL and target path across Unix and Windows", () => {
    expect(
      resolveAgyManifestUrl({
        platform: "darwin",
        arch: "arm64",
        env: { AGY_INSTALL_MANIFEST_BASE: "http://127.0.0.1:19999/manifests/" },
      }),
    ).toBe("http://127.0.0.1:19999/manifests/darwin_arm64.json");

    expect(
      resolveAgyInstallTarget({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
      }),
    ).toEqual({
      binDir: "/Users/alice/.local/bin",
      binPath: "/Users/alice/.local/bin/agy",
    });

    expect(
      resolveAgyInstallTarget({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      }),
    ).toEqual({
      binDir: "C:\\Users\\Alice\\AppData\\Local\\agy\\bin",
      binPath: "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe",
    });

    expect(isDirOnPath("/Users/alice/.local/bin", "/usr/bin:/Users/alice/.local/bin/", "darwin")).toBe(true);
    expect(isDirOnPath("/Users/alice/.local/bin", "/usr/bin:/bin", "darwin")).toBe(false);
  });

  it("installs Unix .tar.gz and Windows .exe from local mock HTTP server and rejects sha512 mismatch", async () => {
    // Build a real .tar.gz containing an `antigravity` executable
    const pkgSrc = join(tmp, "pkg-src");
    mkdirSync(pkgSrc, { recursive: true });
    const mockBinaryBody = "#!/bin/sh\necho '1.5.11'\n";
    writeFileSync(join(pkgSrc, "antigravity"), mockBinaryBody, { mode: 0o755 });

    const tarballPath = join(tmp, "cli_mac_arm64.tar.gz");
    const tarRes = Bun.spawnSync(["tar", "-czf", "../cli_mac_arm64.tar.gz", "antigravity"], {
      cwd: pkgSrc,
    });
    expect(tarRes.exitCode).toBe(0);
    const tarballSha512 = await computeFileSha512(tarballPath);

    const winExePath = join(tmp, "cli_windows_x64.exe");
    writeFileSync(winExePath, "MZ-mock-antigravity-exe");
    const winSha512 = await computeFileSha512(winExePath);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/manifests/darwin_arm64.json") {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: tarballSha512,
          });
        }
        if (url.pathname === "/manifests/bad_sha.json") {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: "0".repeat(128),
          });
        }
        if (url.pathname === "/files/cli_mac_arm64.tar.gz") {
          return new Response(Bun.file(tarballPath));
        }
        if (url.pathname === "/files/cli_windows_x64.exe") {
          return new Response(Bun.file(winExePath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const base = `http://127.0.0.1:${server.port}/manifests`;

      // 1. Successful Unix install via installAgy + AGY_INSTALL_MANIFEST_BASE
      const unixTarget = join(tmp, "unix-target");
      const res = await installAgy({
        platform: "darwin",
        arch: "arm64",
        targetDir: unixTarget,
        env: { AGY_INSTALL_MANIFEST_BASE: base, PATH: "/usr/bin:/bin" },
        quiet: true,
      });
      expect(res.success).toBe(true);
      expect(res.version).toBe("1.5.11");
      expect(res.binPath).toBe(join(unixTarget, "agy"));
      expect(readFileSync(join(unixTarget, "agy"), "utf-8")).toBe(mockBinaryBody);
      if (process.platform !== "win32") {
        expect(statSync(join(unixTarget, "agy")).mode & 0o111).toBeGreaterThan(0);
      }

      // 2. Successful Windows .exe install via installAgyFromManifest
      const winTarget = join(tmp, "win-target");
      const winRes = await installAgyFromManifest(
        {
          version: "1.5.11",
          url: `http://127.0.0.1:${server.port}/files/cli_windows_x64.exe`,
          sha512: winSha512,
        },
        {
          platform: "win32",
          targetDir: winTarget,
          env: { PATH: "" },
          quiet: true,
        },
      );
      expect(winRes.binPath).toBe(join(winTarget, "agy.exe"));
      expect(readFileSync(join(winTarget, "agy.exe"), "utf-8")).toBe("MZ-mock-antigravity-exe");

      // 3. SHA-512 mismatch aborts cleanly without writing target binary
      const badTarget = join(tmp, "bad-target");
      await expect(
        installAgyFromManifest(
          {
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}/files/cli_mac_arm64.tar.gz`,
            sha512: "f".repeat(128),
          },
          {
            platform: "darwin",
            targetDir: badTarget,
            env: { PATH: "/usr/bin" },
            quiet: true,
          },
        ),
      ).rejects.toThrow(/sha512/i);
      expect(existsSync(join(badTarget, "agy"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("runs end-to-end CLI `tako install agy` and `tako --agy` with isolated env and config", async () => {
    const isWin = process.platform === "win32";
    const fakeHome = join(tmp, "e2e-home");
    const fakeLocalAppData = join(tmp, "e2e-localappdata");
    const takoHome = join(tmp, "e2e-tako");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeLocalAppData, { recursive: true });
    mkdirSync(takoHome, { recursive: true });

    const pkgSrc = join(tmp, "e2e-pkg");
    mkdirSync(pkgSrc, { recursive: true });
    const dumpFile = join(tmp, "agy-dump.json");
    const platformKey = resolveAgyPlatform();

    let payloadPath: string;
    let payloadRoute: string;
    if (isWin) {
      payloadPath = join(tmp, "e2e_agy.exe");
      payloadRoute = "/e2e_agy.exe";
      writeFileSync(payloadPath, "MZ-mock-antigravity-exe");
    } else {
      const mockScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("1.5.11");
  process.exit(0);
}
writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  AGY_LLM_GATEWAY_URL: process.env.AGY_LLM_GATEWAY_URL ?? null,
  AGY_LLM_GATEWAY_API_KEY: process.env.AGY_LLM_GATEWAY_API_KEY ?? null,
  AGY_LLM_GATEWAY_MODELS: process.env.AGY_LLM_GATEWAY_MODELS ?? null,
  AGY_LLM_GATEWAY_TIER_PRO: process.env.AGY_LLM_GATEWAY_TIER_PRO ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH: process.env.AGY_LLM_GATEWAY_TIER_FLASH ?? null,
  AGY_LLM_GATEWAY_TIER_FLASH_LITE: process.env.AGY_LLM_GATEWAY_TIER_FLASH_LITE ?? null,
  hasGeminiBase: Object.hasOwn(process.env, "GOOGLE_GEMINI_BASE_URL"),
  hasGeminiKey: Object.hasOwn(process.env, "GEMINI_API_KEY"),
  hasGoogleKey: Object.hasOwn(process.env, "GOOGLE_API_KEY"),
  hasAicodeUrl: Object.hasOwn(process.env, "AICODE_ENDPOINT_URL"),
}));
`;
      writeFileSync(join(pkgSrc, "antigravity"), mockScript, { mode: 0o755 });
      payloadPath = join(tmp, "e2e_agy.tar.gz");
      payloadRoute = "/e2e_agy.tar.gz";
      expect(
        Bun.spawnSync(["tar", "-czf", "../e2e_agy.tar.gz", "antigravity"], { cwd: pkgSrc }).exitCode,
      ).toBe(0);
    }
    const sha512 = await computeFileSha512(payloadPath);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/manifests/${platformKey}.json`) {
          return Response.json({
            version: "1.5.11",
            url: `http://127.0.0.1:${server.port}${payloadRoute}`,
            sha512,
          });
        }
        if (url.pathname === payloadRoute) {
          return new Response(Bun.file(payloadPath));
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
      let isolatedPath: string;
      if (isWin) {
        const sysRoot = process.env.SystemRoot || "C:\\Windows";
        isolatedPath = `${sysRoot}\\System32;${sysRoot}`;
      } else {
        const shimBin = join(tmp, "shim-bin");
        mkdirSync(shimBin, { recursive: true });
        symlinkSync(process.execPath, join(shimBin, "bun"));
        isolatedPath = `${shimBin}:/usr/bin:/bin`;
      }

      const expectedBin = isWin
        ? join(fakeLocalAppData, "agy", "bin", "agy.exe")
        : join(fakeHome, ".local", "bin", "agy");

      const cleanParentEnv: Record<string, string | undefined> = { ...process.env };
      delete cleanParentEnv.Path;
      delete cleanParentEnv.AGY_PATH;
      delete cleanParentEnv.AGY_INSTALL_DIR;
      delete cleanParentEnv.TAKO_AGY_API_KEY;
      delete cleanParentEnv.TAKO_AGY_GATEWAY_URL;
      delete cleanParentEnv.AGY_LLM_GATEWAY_URL;
      delete cleanParentEnv.AGY_LLM_GATEWAY_API_KEY;
      delete cleanParentEnv.AGY_LLM_GATEWAY_MODELS;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_PRO;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_FLASH;
      delete cleanParentEnv.AGY_LLM_GATEWAY_TIER_FLASH_LITE;
      for (const proxyKey of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        delete cleanParentEnv[proxyKey];
      }

      // Seed telemetryEnabled: false before `tako install agy` so `track("client_installed")`
      // never opens an outbound OpenPanel HTTP connection during hermetic unit tests.
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "",
          apiId: "",
          telemetryEnabled: false,
          installedClients: {},
        }),
      );

      // Step 1: `tako install agy` installs into platform target location
      const installProc = Bun.spawn([process.execPath, cliEntry, "install", "agy"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...cleanParentEnv,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          LOCALAPPDATA: fakeLocalAppData,
          TAKO_HOME: takoHome,
          TAKO_DEV: "1",
          AGY_INSTALL_MANIFEST_BASE: `http://127.0.0.1:${server.port}/manifests`,
          PATH: isolatedPath,
        },
      });
      const installOut = `${await new Response(installProc.stdout).text()}\n${await new Response(installProc.stderr).text()}`;
      expect(await installProc.exited).toBe(0);
      expect(existsSync(expectedBin)).toBe(true);
      expect(installOut).toContain("tako --agy");

      // Step 2: Write Tako config with both apiKey and dedicated agyApiKey + /v1 baseUrl
      writeFileSync(
        join(takoHome, "config.json"),
        JSON.stringify({
          apiKey: "cr_claude_main",
          agyApiKey: "cr_agy_dedicated",
          apiId: "uuid-e2e",
          telemetryEnabled: false,
          installedClients: {},
          providers: [
            {
              id: "prov-1",
              name: "Tako",
              type: "tako",
              apiKey: "cr_claude_main",
              baseUrl: "https://tako.shiroha.tech/v1",
              createdAt: "2026-11-18T00:00:00.000Z",
              builtin: true,
            },
          ],
          defaultProviderId: "prov-1",
        }),
      );

      // Step 3: `tako --agy --model models/gemini-2.5-pro -p hi`
      const handoffFile = join(tmp, "win-handoff.ps1");
      const launchProc = Bun.spawn(
        [process.execPath, cliEntry, "--agy", "--model", "models/gemini-2.5-pro", "-p", "hi"],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...cleanParentEnv,
            HOME: fakeHome,
            USERPROFILE: fakeHome,
            LOCALAPPDATA: fakeLocalAppData,
            TAKO_HOME: takoHome,
            TAKO_DEV: "1",
            ...(isWin ? { TAKO_WINDOWS_HANDOFF_FILE: handoffFile } : {}),
            GOOGLE_GEMINI_BASE_URL: "https://polluted.example",
            GEMINI_API_KEY: "polluted-gemini",
            GOOGLE_API_KEY: "polluted-google",
            AICODE_ENDPOINT_URL: "https://polluted.aicode",
            PATH: isolatedPath,
          },
        },
      );
      expect(await launchProc.exited).toBe(0);

      if (isWin) {
        const handoffText = readFileSync(handoffFile, "utf-8");
        expect(handoffText).toContain(expectedBin.replace(/'/g, "''"));
        expect(handoffText).toContain("'--dangerously-skip-permissions', '--model', 'gemini-2.5-pro', '-p', 'hi'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_URL = 'https://tako.shiroha.tech'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_API_KEY = 'cr_agy_dedicated'");
        expect(handoffText).toContain(`$env:AGY_LLM_GATEWAY_MODELS = '${DEFAULT_AGY_GATEWAY_MODELS.join(",")}'`);
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_PRO = 'claude-opus-4-6'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_FLASH = 'claude-sonnet-4-6'");
        expect(handoffText).toContain("$env:AGY_LLM_GATEWAY_TIER_FLASH_LITE = 'gemini-3.5-flash-lite'");
        for (const conflictKey of AGY_CONFLICTING_ENV_KEYS) {
          expect(handoffText).toContain(`Remove-Item -Path Env:${conflictKey} -ErrorAction SilentlyContinue`);
        }
      } else {
        const dumped = JSON.parse(readFileSync(dumpFile, "utf-8"));
        expect(dumped).toEqual({
          argv: ["--dangerously-skip-permissions", "--model", "gemini-2.5-pro", "-p", "hi"],
          AGY_LLM_GATEWAY_URL: "https://tako.shiroha.tech",
          AGY_LLM_GATEWAY_API_KEY: "cr_agy_dedicated",
          AGY_LLM_GATEWAY_MODELS: DEFAULT_AGY_GATEWAY_MODELS.join(","),
          AGY_LLM_GATEWAY_TIER_PRO: "claude-opus-4-6",
          AGY_LLM_GATEWAY_TIER_FLASH: "claude-sonnet-4-6",
          AGY_LLM_GATEWAY_TIER_FLASH_LITE: "gemini-3.5-flash-lite",
          hasGeminiBase: false,
          hasGeminiKey: false,
          hasGoogleKey: false,
          hasAicodeUrl: false,
        });
      }
    } finally {
      server.stop(true);
    }
  }, 15000);

  it("cold-starts launchClient(agyClient) in milliseconds without probing Tako bun or node binaries", async () => {
    const isWin = process.platform === "win32";
    const takoHome = join(tmp, "cold-launch-tako");
    const bunMarker = join(tmp, "bun-probed");
    const nodeMarker = join(tmp, "node-probed");
    const mockAgy = join(tmp, isWin ? "agy.exe" : "agy");

    if (isWin) {
      mkdirSync(join(takoHome, "bun", "bin"), { recursive: true });
      mkdirSync(join(takoHome, "node"), { recursive: true });
      writeFileSync(join(takoHome, "bun", "bin", "bun.exe"), "not-a-valid-exe");
      writeFileSync(join(takoHome, "node", "node.exe"), "not-a-valid-exe");
      writeFileSync(mockAgy, "MZ-mock-agy");
    } else {
      mkdirSync(join(takoHome, "bun", "bin"), { recursive: true });
      mkdirSync(join(takoHome, "node", "bin"), { recursive: true });
      writeFileSync(
        join(takoHome, "bun", "bin", "bun"),
        `#!/bin/sh\necho 1 > ${JSON.stringify(bunMarker)}\nsleep 5\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(takoHome, "node", "bin", "node"),
        `#!/bin/sh\necho 1 > ${JSON.stringify(nodeMarker)}\nsleep 5\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(mockAgy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      Bun.spawnSync([mockAgy]);
    }

    const launcherUrl = new URL("../src/launcher-legacy.ts", import.meta.url).href;
    const agyUrl = new URL("../src/clients/agy.ts", import.meta.url).href;
    const handoffFile = join(tmp, "cold-handoff.ps1");
    const script = `
      const { launchClient } = await import(${JSON.stringify(launcherUrl)});
      const { agyClient } = await import(${JSON.stringify(agyUrl)});
      const t0 = performance.now();
      const res = await launchClient(agyClient, {
        projectPath: ${JSON.stringify(tmp)},
        args: ["--version"],
        handoffOnWindows: true,
        providerContext: {
          type: "tako",
          baseUrl: "https://tako.shiroha.tech/v1",
          apiKey: "cr_main",
          agyApiKey: "cr_agy",
        },
      });
      const elapsedMs = performance.now() - t0;
      console.log(JSON.stringify({ res, elapsedMs }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: mockAgy,
        ...(isWin ? { TAKO_WINDOWS_HANDOFF_FILE: handoffFile } : {}),
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const { res, elapsedMs } = JSON.parse(stdout.trim());
    expect(res.success).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
    expect(existsSync(bunMarker)).toBe(false);
    expect(existsSync(nodeMarker)).toBe(false);
  });
});

describe("Gemini CLI retirement and config migration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-gemini-retire-"));
  });

  afterEach(() => {
    clearLocaleOverride();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("migrates legacy supportedClients entries from gemini to agy without duplicates", () => {
    expect(migrateSupportedClients(["claude-code", "gemini"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "gemini", "agy"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "agy", "gemini"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "codex"])).toEqual(["claude-code", "codex"]);
  });

  it("rejects programmatic install/ensure of retired gemini client with bilingual/localized guidance", async () => {
    const legacyGemini = {
      id: "gemini",
      name: "Gemini CLI",
      package: "@google/gemini-cli",
      command: "gemini",
      runtime: "bun" as const,
      getEnvVars: () => ({}),
    };

    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const msg = getGeminiRetiredMessage();
      expect(msg).toContain("Gemini CLI");
      expect(msg).toContain("Antigravity CLI (agy)");
      expect(msg).toContain("tako install agy");
      expect(msg).toContain("tako --agy");

      const installRes = await installClient(legacyGemini);
      expect(installRes.success).toBe(false);
      expect(installRes.error).toContain("tako install agy");

      const readyRes = await ensureClientReady(legacyGemini);
      expect(readyRes.success).toBe(false);
      expect(readyRes.error).toContain("tako --agy");
    }
  });

  it("migrates saved ~/.tako/config.json supportedClients and clientProviderMap cleanly to agy", async () => {
    const takoHome = join(tmp, "tako-home");
    mkdirSync(takoHome, { recursive: true });
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "",
        apiId: "",
        installedClients: {},
        providers: [
          {
            id: "prov-legacy",
            name: "Legacy Custom",
            type: "custom",
            apiKey: "sk-legacy",
            baseUrl: "https://legacy.example/v1",
            supportedClients: ["claude-code", "gemini"],
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "prov-both",
            name: "Both",
            type: "custom",
            apiKey: "sk-both",
            baseUrl: "https://both.example/v1",
            supportedClients: ["claude-code", "grok", "gemini", "agy"],
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        defaultProviderId: "prov-legacy",
        clientProviderMap: {
          gemini: "prov-legacy",
        },
      }),
    );

    const providersModuleUrl = new URL("../src/providers/index.ts", import.meta.url).href;
    const script = `
      const { getProviders, getProvidersForClient, getClientProvider, fixupProviders } = await import(${JSON.stringify(providersModuleUrl)});
      const preProviders = await getProviders();
      const preAgyCompatible = await getProvidersForClient("agy");
      const preGeminiCompatible = await getProvidersForClient("gemini");
      const preBound = await getClientProvider("agy");
      await fixupProviders();
      console.log(JSON.stringify({
        preSupported: preProviders.map((p) => p.supportedClients),
        preAgyIds: preAgyCompatible.map((p) => p.id),
        preGeminiIds: preGeminiCompatible.map((p) => p.id),
        preBoundId: preBound?.id ?? null,
      }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
      },
    });
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");

    const pre = JSON.parse(stdout);
    expect(pre.preSupported).toEqual([
      ["claude-code", "agy"],
      ["claude-code", "grok", "agy"],
    ]);
    expect(pre.preAgyIds.sort()).toEqual(["prov-both", "prov-legacy"]);
    expect(pre.preGeminiIds).toEqual([]);
    expect(pre.preBoundId).toBe("prov-legacy");

    const persisted = JSON.parse(readFileSync(join(takoHome, "config.json"), "utf-8"));
    expect(persisted.providers[0].supportedClients).toContain("agy");
    expect(persisted.providers[0].supportedClients).not.toContain("gemini");
    expect(persisted.providers[0].supportedClients).toEqual(["claude-code", "grok", "agy"]);
    expect(persisted.providers[1].supportedClients).toEqual(["claude-code", "grok", "agy"]);
    expect(persisted.clientProviderMap).toEqual({ agy: "prov-legacy" });
  });

  it("exits 1 with agy replacement guidance on `tako --gemini` and `tako install gemini` and omits --gemini from --help", async () => {
    const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
    const takoHome = join(tmp, "cli-tako-home");
    mkdirSync(takoHome, { recursive: true });
    const env = {
      ...process.env,
      TAKO_HOME: takoHome,
      TAKO_DEV: "1",
    };

    // 1. `tako --help` omits --gemini and lists --agy
    const helpProc = Bun.spawn([process.execPath, cliEntry, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const helpOut = await new Response(helpProc.stdout).text();
    expect(await helpProc.exited).toBe(0);
    expect(helpOut).toContain("--agy");
    expect(helpOut).not.toContain("--gemini");

    // 2. `tako --gemini` and `tako install gemini` exit 1 with guidance
    for (const argv of [
      ["--gemini"],
      ["--gemini", "-p", "hello"],
      ["install", "gemini"],
      ["install", "gemini", "latest"],
    ]) {
      const proc = Bun.spawn([process.execPath, cliEntry, ...argv], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const out = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
      expect(await proc.exited).toBe(1);
      expect(out).toContain("Gemini CLI");
      expect(out).toContain("Antigravity CLI (agy)");
      expect(out).toContain("tako install agy");
      expect(out).toContain("tako --agy");
    }
  });
});
