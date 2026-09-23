/**
 * 模型全家桶（model pin）测试
 *
 * 背景：Claude Code 的 subagent、内置别名（opus/sonnet/haiku/fable）、
 * 标题/压缩等 utility 调用各自走独立的模型解析路径。只设 ANTHROPIC_MODEL
 * 时，没钉的路径会漏回 CC 内置默认模型（生产实锤：用户选 mimo/glm，
 * subagent 请求走成 claude-opus-5 / claude-opus-4-6 计费）。
 *
 * 修复（Kimi/DeepSeek 官方接入文档同款）：凡下发 ANTHROPIC_MODEL 的地方，
 * 同步把 CLAUDE_CODE_SUBAGENT_MODEL 与 ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL
 * 钉成同一个模型值（含 [1m] 后缀逻辑）。刻意不开 CLAUDE_CODE_SUBAGENT_MODEL_FORCE。
 */
import { describe, it, expect } from "bun:test";
import {
  CLAUDE_SUBAGENT_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY,
  buildTakoClaudeSettingsOverlay,
  claudeCodeClient,
  claudeModelPinEnv,
  claudeSubagentPinEnv,
} from "../src/clients/claude-code";
import { SUBAGENT_MODEL_CC_DEFAULT } from "../src/providers/types";
import { getClientLaunchOptions } from "../src/clients/base";

import "../src/clients";

const PIN_KEYS = [
  "ANTHROPIC_MODEL",
  CLAUDE_SUBAGENT_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY,
] as const;

/** 五条子代理/别名/utility 路径（不含 ANTHROPIC_MODEL 本身） */
const SUBAGENT_PIN_KEYS = PIN_KEYS.slice(1);

describe("claudeModelPinEnv", () => {
  it("六个解析路径全部钉到同一模型", () => {
    expect(claudeModelPinEnv("mimo-v2.6-pro[1m]")).toEqual({
      ANTHROPIC_MODEL: "mimo-v2.6-pro[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "mimo-v2.6-pro[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.6-pro[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2.6-pro[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2.6-pro[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "mimo-v2.6-pro[1m]",
    });
  });
});

describe("getEnvVars 模型全家桶", () => {
  const pinCases: Array<{
    name: string;
    ctx: Parameters<typeof claudeCodeClient.getEnvVars>[0];
    tagged: string;
  }> = [
    {
      name: "tako",
      ctx: { type: "tako", apiKey: "sk", baseUrl: "https://x", model: "mimo-v2.5-pro" },
      tagged: "mimo-v2.5-pro[1m]",
    },
    {
      name: "anthropic",
      ctx: { type: "anthropic", apiKey: "sk", model: "claude-opus-4-7" },
      tagged: "claude-opus-4-7[1m]",
    },
    {
      name: "deepseek",
      ctx: { type: "deepseek", apiKey: "sk", model: "deepseek-v4-flash" },
      tagged: "deepseek-v4-flash[1m]",
    },
    {
      name: "xiaomi",
      ctx: { type: "xiaomi", apiKey: "sk-abc", model: "mimo-v2.5-pro" },
      tagged: "mimo-v2.5-pro[1m]",
    },
    {
      name: "custom",
      ctx: { type: "custom", apiKey: "sk", baseUrl: "https://proxy", model: "glm-5.3" },
      tagged: "glm-5.3",
    },
  ];

  for (const { name, ctx, tagged } of pinCases) {
    it(`${name} 分支：六键全钉成 tagged 值（含 [1m] 逻辑）`, () => {
      const env = claudeCodeClient.getEnvVars(ctx);
      for (const key of PIN_KEYS) {
        expect(env[key]).toBe(tagged);
      }
    });
  }

  it("非 claude 系模型（glm-5.3 不加 [1m]）pins 原样跟随", () => {
    const env = claudeCodeClient.getEnvVars({
      type: "custom",
      apiKey: "sk",
      baseUrl: "https://proxy",
      model: "glm-5.3",
    });
    expect(env[CLAUDE_SUBAGENT_MODEL_ENV_KEY]).toBe("glm-5.3");
    expect(env[CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY]).toBe("glm-5.3");
  });

  it("claude-subscription 不下发任何 pin（走 OAuth + CC 自己的默认）", () => {
    const env = claudeCodeClient.getEnvVars({ type: "claude-subscription" });
    for (const key of PIN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("provider 没设 model → 六个键都不下发", () => {
    const env = claudeCodeClient.getEnvVars({
      type: "tako",
      apiKey: "sk",
      baseUrl: "https://x",
    });
    for (const key of PIN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("不主动下发 FORCE（留作后手，默认尊重 frontmatter 显式选择）", () => {
    const env = claudeCodeClient.getEnvVars({
      type: "tako",
      apiKey: "sk",
      baseUrl: "https://x",
      model: "mimo-v2.6-pro",
    });
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
  });
});

describe("子代理模型三态（provider.subagentModel）", () => {
  const takoCtx = {
    type: "tako",
    apiKey: "sk",
    baseUrl: "https://x",
    model: "mimo-v2.5-pro",
  } as const;

  it("cc-default：主模型照发，五条子代理路径全不钉", () => {
    const env = claudeCodeClient.getEnvVars({ ...takoCtx, subagentModel: SUBAGENT_MODEL_CC_DEFAULT });
    expect(env.ANTHROPIC_MODEL).toBe("mimo-v2.5-pro[1m]");
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("指定模型：主模型不变，五条路径钉到指定模型（[1m] 逻辑同主模型）", () => {
    const env = claudeCodeClient.getEnvVars({ ...takoCtx, subagentModel: "claude-opus-4-7" });
    expect(env.ANTHROPIC_MODEL).toBe("mimo-v2.5-pro[1m]");
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(env[key]).toBe("claude-opus-4-7[1m]");
    }
  });

  it("指定非 claude 系模型：pins 原样跟随不加 [1m]", () => {
    const env = claudeCodeClient.getEnvVars({ ...takoCtx, subagentModel: "glm-5.3" });
    expect(env[CLAUDE_SUBAGENT_MODEL_ENV_KEY]).toBe("glm-5.3");
    expect(env[CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY]).toBe("glm-5.3");
  });

  it("指定模型 + 主模型未设：只发五条 pins，不发 ANTHROPIC_MODEL", () => {
    const env = claudeCodeClient.getEnvVars({
      type: "tako",
      apiKey: "sk",
      baseUrl: "https://x",
      subagentModel: "glm-5.3",
    });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(env[key]).toBe("glm-5.3");
    }
  });

  it("claudeSubagentPinEnv：cc-default → {}；空白字符串 → 按跟随主模型处理", () => {
    expect(claudeSubagentPinEnv({ subagentModel: SUBAGENT_MODEL_CC_DEFAULT }, "m[1m]")).toEqual({});
    expect(claudeSubagentPinEnv({ subagentModel: "  " }, "m[1m]")).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "m[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "m[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "m[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "m[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "m[1m]",
    });
    expect(claudeSubagentPinEnv({}, undefined)).toEqual({});
  });

  it("静态模型选项：cc-default 时选项 envVars 也不钉", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, {
      id: "p",
      name: "P",
      type: "anthropic",
      apiKey: "sk",
      subagentModel: SUBAGENT_MODEL_CC_DEFAULT,
      createdAt: new Date().toISOString(),
    });
    const opus = opts.find((o) => o.id === "model-claude-opus-4-7");
    expect(opus?.envVars?.ANTHROPIC_MODEL).toBe("claude-opus-4-7[1m]");
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(opus?.envVars?.[key]).toBeUndefined();
    }
  });

  it("静态模型选项：指定模型时选项 envVars 钉到指定模型", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, {
      id: "p",
      name: "P",
      type: "anthropic",
      apiKey: "sk",
      subagentModel: "glm-5.3",
      createdAt: new Date().toISOString(),
    });
    const opus = opts.find((o) => o.id === "model-claude-opus-4-7");
    expect(opus?.envVars?.ANTHROPIC_MODEL).toBe("claude-opus-4-7[1m]");
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(opus?.envVars?.[key]).toBe("glm-5.3");
    }
  });
});

describe("静态模型选项 envVars 同步钉全家桶", () => {
  it("内置 whitelist 选项（anthropic provider）六键 = modelArg", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, {
      id: "p",
      name: "P",
      type: "anthropic",
      apiKey: "sk",
      createdAt: new Date().toISOString(),
    });
    const opus = opts.find((o) => o.id === "model-claude-opus-4-7");
    expect(opus?.envVars).toMatchObject(claudeModelPinEnv("claude-opus-4-7[1m]"));
  });
});

describe("launch settings overlay 转发 pin 键", () => {
  it("pin 键属于 launch-owned，会被拷进隔离 overlay（压过用户 settings.json 冲突）", () => {
    const overlay = buildTakoClaudeSettingsOverlay({
      ...claudeModelPinEnv("mimo-v2.6-pro[1m]"),
      ANTHROPIC_BASE_URL: "https://x/api",
      ANTHROPIC_AUTH_TOKEN: "sk",
    });
    const env = overlay.env as Record<string, string>;
    for (const key of PIN_KEYS) {
      expect(env[key]).toBe("mimo-v2.6-pro[1m]");
    }
  });

  it("launch 没带 pin 键时 overlay 不凭空造（与 ANTHROPIC_MODEL 同语义）", () => {
    const overlay = buildTakoClaudeSettingsOverlay({
      ANTHROPIC_BASE_URL: "https://x/api",
      ANTHROPIC_AUTH_TOKEN: "sk",
    });
    const env = overlay.env as Record<string, string>;
    for (const key of PIN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });
});
