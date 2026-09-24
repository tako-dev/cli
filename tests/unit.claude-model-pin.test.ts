/**
 * 模型全家桶（model pin）测试
 *
 * 背景：Claude Code 的 subagent、内置别名（opus/sonnet/haiku/fable）、
 * 标题/压缩等 utility 调用各自走独立的模型解析路径。只设 ANTHROPIC_MODEL
 * 时，没钉的路径会漏回 CC 内置默认模型（生产实锤：用户选 mimo/glm，
 * subagent 请求走成 claude-opus-5 / claude-opus-4-6 计费）。
 *
 * 架构（0.3.44 起）：钉不在 getEnvVars/选项 envVars 里静态下发——env 合并
 * 只增不删，「CC 默认」启动选项无法撤掉已注入的钉。钉收敛到两处：
 *  - 交互启动：setupConfigFiles 在 env 合并后单点计算（resolveLaunchPinEnv），
 *    模式 = 启动选项组选中 > provider.subagentModel 默认；
 *  - tako agent 后台会话（绕过 setupConfigFiles）：agent/manager 用
 *    claudeCodeSessionPinEnv 按 provider 三态补钉。
 * 刻意不开 CLAUDE_CODE_SUBAGENT_MODEL_FORCE。
 */
import { describe, it, expect } from "bun:test";
import {
  CLAUDE_SUBAGENT_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY,
  CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY,
  SUBAGENT_OPTION_GROUP,
  SUBAGENT_OPTION_FOLLOW_ID,
  SUBAGENT_OPTION_CC_DEFAULT_ID,
  SUBAGENT_OPTION_CUSTOM_ID,
  buildTakoClaudeSettingsOverlay,
  claudeCodeClient,
  claudeCodeSessionPinEnv,
  claudeModelPinEnv,
  resolveLaunchPinEnv,
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

function pinEnvOf(model: string): Record<string, string> {
  return {
    [CLAUDE_SUBAGENT_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_OPUS_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_SONNET_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_HAIKU_MODEL_ENV_KEY]: model,
    [CLAUDE_DEFAULT_FABLE_MODEL_ENV_KEY]: model,
  };
}

describe("claudeModelPinEnv", () => {
  it("六个解析路径全部钉到同一模型", () => {
    expect(claudeModelPinEnv("mimo-v2.6-pro[1m]")).toEqual({
      ANTHROPIC_MODEL: "mimo-v2.6-pro[1m]",
      ...pinEnvOf("mimo-v2.6-pro[1m]"),
    });
  });
});

describe("getEnvVars 只下发主模型（钉子不在此处）", () => {
  const cases: Array<{
    name: string;
    ctx: Parameters<typeof claudeCodeClient.getEnvVars>[0];
    tagged?: string;
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

  for (const { name, ctx, tagged } of cases) {
    it(`${name} 分支：ANTHROPIC_MODEL=tagged，五条子代理路径一律不钉`, () => {
      const env = claudeCodeClient.getEnvVars(ctx);
      expect(env.ANTHROPIC_MODEL).toBe(tagged);
      for (const key of SUBAGENT_PIN_KEYS) {
        expect(env[key]).toBeUndefined();
      }
    });
  }

  it("provider 配了 cc-default/指定模型时 getEnvVars 同样不钉（钉在合并后单点）", () => {
    for (const subagentModel of [SUBAGENT_MODEL_CC_DEFAULT, "glm-5.3"]) {
      const env = claudeCodeClient.getEnvVars({
        type: "tako", apiKey: "sk", baseUrl: "https://x",
        model: "mimo-v2.5-pro", subagentModel,
      });
      expect(env.ANTHROPIC_MODEL).toBe("mimo-v2.5-pro[1m]");
      for (const key of SUBAGENT_PIN_KEYS) {
        expect(env[key]).toBeUndefined();
      }
    }
  });

  it("claude-subscription 不下发任何 pin（走 OAuth + CC 自己的默认）", () => {
    const env = claudeCodeClient.getEnvVars({ type: "claude-subscription" });
    for (const key of PIN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("provider 没设 model → ANTHROPIC_MODEL 也不下发", () => {
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

describe("resolveLaunchPinEnv：合并后单点钉（provider 三态默认）", () => {
  const launchEnv = { ANTHROPIC_MODEL: "mimo-v2.5-pro[1m]" };

  it("跟随主模型（默认）：五条路径钉到合并后的最终主模型（含选项覆盖的值）", () => {
    // 模型选项覆盖过 ANTHROPIC_MODEL 时，钉必须跟随最终值而非 provider.model
    expect(resolveLaunchPinEnv({}, undefined, launchEnv)).toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
    expect(resolveLaunchPinEnv({}, ["model-glm-5.3"], { ANTHROPIC_MODEL: "glm-5.3" }))
      .toEqual(pinEnvOf("glm-5.3"));
  });

  it("跟随但主模型未设：无可钉返回 {}", () => {
    expect(resolveLaunchPinEnv({}, undefined, {})).toEqual({});
  });

  it("provider cc-default：不钉（用户 settings.json / shell env 可接管）", () => {
    expect(resolveLaunchPinEnv({ subagentModel: SUBAGENT_MODEL_CC_DEFAULT }, undefined, launchEnv))
      .toEqual({});
  });

  it("provider 指定模型：钉到指定模型（自动补 [1m] 逻辑同主模型）", () => {
    expect(resolveLaunchPinEnv({ subagentModel: "claude-opus-4-7" }, undefined, launchEnv))
      .toEqual(pinEnvOf("claude-opus-4-7[1m]"));
    expect(resolveLaunchPinEnv({ subagentModel: "glm-5.3" }, undefined, launchEnv))
      .toEqual(pinEnvOf("glm-5.3"));
  });
});

describe("resolveLaunchPinEnv：启动选项组单次覆盖 provider 默认", () => {
  const launchEnv = { ANTHROPIC_MODEL: "mimo-v2.5-pro[1m]" };

  it("选「CC 默认」压过 provider 跟随/指定 → 不钉", () => {
    expect(resolveLaunchPinEnv({}, [SUBAGENT_OPTION_CC_DEFAULT_ID], launchEnv)).toEqual({});
    expect(resolveLaunchPinEnv(
      { subagentModel: "glm-5.3" }, [SUBAGENT_OPTION_CC_DEFAULT_ID], launchEnv,
    )).toEqual({});
  });

  it("选「跟随主模型」压过 provider cc-default/指定 → 钉最终主模型", () => {
    expect(resolveLaunchPinEnv(
      { subagentModel: SUBAGENT_MODEL_CC_DEFAULT }, [SUBAGENT_OPTION_FOLLOW_ID], launchEnv,
    )).toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
    expect(resolveLaunchPinEnv(
      { subagentModel: "glm-5.3" }, [SUBAGENT_OPTION_FOLLOW_ID], launchEnv,
    )).toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
  });

  it("选「指定」且 provider 配有指定模型 → 钉指定模型", () => {
    expect(resolveLaunchPinEnv(
      { subagentModel: "glm-5.3" }, [SUBAGENT_OPTION_CUSTOM_ID], launchEnv,
    )).toEqual(pinEnvOf("glm-5.3"));
  });

  it("选「指定」但 provider 配置已被清掉 → 回退跟随（钉比漏安全）", () => {
    expect(resolveLaunchPinEnv({}, [SUBAGENT_OPTION_CUSTOM_ID], launchEnv))
      .toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
    expect(resolveLaunchPinEnv(
      { subagentModel: SUBAGENT_MODEL_CC_DEFAULT }, [SUBAGENT_OPTION_CUSTOM_ID], launchEnv,
    )).toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
  });
});

describe("claudeCodeSessionPinEnv：tako agent 后台会话补钉", () => {
  const base = { type: "tako", apiKey: "sk", baseUrl: "https://x" } as const;

  it("默认跟随：钉到 ctx.model（内部补 [1m]）", () => {
    expect(claudeCodeSessionPinEnv({ ...base, model: "mimo-v2.5-pro" }))
      .toEqual(pinEnvOf("mimo-v2.5-pro[1m]"));
  });

  it("cc-default：不钉", () => {
    expect(claudeCodeSessionPinEnv({ ...base, model: "mimo-v2.5-pro", subagentModel: SUBAGENT_MODEL_CC_DEFAULT }))
      .toEqual({});
  });

  it("指定模型：钉指定（[1m] 逻辑同主模型）", () => {
    expect(claudeCodeSessionPinEnv({ ...base, model: "mimo-v2.5-pro", subagentModel: "claude-opus-4-7" }))
      .toEqual(pinEnvOf("claude-opus-4-7[1m]"));
  });

  it("主模型未设且未指定：无可钉返回 {}", () => {
    expect(claudeCodeSessionPinEnv({ ...base })).toEqual({});
  });
});

describe("「子代理模型」启动选项组", () => {
  const mkProvider = (subagentModel?: string) => ({
    id: "p",
    name: "P",
    type: "anthropic",
    apiKey: "sk",
    ...(subagentModel ? { subagentModel } : {}),
    createdAt: new Date().toISOString(),
  });

  it("默认 provider：组内两项，「跟随主模型」defaultOn，选项只是标记不带 envVars", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, mkProvider());
    const group = opts.filter((o) => o.group === SUBAGENT_OPTION_GROUP);
    expect(group.map((o) => o.id)).toEqual([SUBAGENT_OPTION_FOLLOW_ID, SUBAGENT_OPTION_CC_DEFAULT_ID]);
    expect(group.find((o) => o.id === SUBAGENT_OPTION_FOLLOW_ID)?.defaultOn).toBe(true);
    expect(group.find((o) => o.id === SUBAGENT_OPTION_CC_DEFAULT_ID)?.defaultOn).toBeUndefined();
    for (const o of group) {
      expect(o.envVars).toBeUndefined();
      expect(o.args).toEqual([]);
    }
  });

  it("provider cc-default：「CC 默认」defaultOn", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, mkProvider(SUBAGENT_MODEL_CC_DEFAULT));
    const group = opts.filter((o) => o.group === SUBAGENT_OPTION_GROUP);
    expect(group.map((o) => o.id)).toEqual([SUBAGENT_OPTION_FOLLOW_ID, SUBAGENT_OPTION_CC_DEFAULT_ID]);
    expect(group.find((o) => o.id === SUBAGENT_OPTION_CC_DEFAULT_ID)?.defaultOn).toBe(true);
  });

  it("provider 指定模型：多出「指定：<id>」项且 defaultOn", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, mkProvider("glm-5.3"));
    const group = opts.filter((o) => o.group === SUBAGENT_OPTION_GROUP);
    expect(group.map((o) => o.id)).toEqual([
      SUBAGENT_OPTION_FOLLOW_ID, SUBAGENT_OPTION_CC_DEFAULT_ID, SUBAGENT_OPTION_CUSTOM_ID,
    ]);
    expect(group.find((o) => o.id === SUBAGENT_OPTION_CUSTOM_ID)?.defaultOn).toBe(true);
  });

  it("订阅 provider：不提供该组（不钉，走 OAuth + CC 自己的解析）", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, {
      id: "p", name: "P", type: "claude-subscription", createdAt: new Date().toISOString(),
    });
    expect(opts.some((o) => o.group === SUBAGENT_OPTION_GROUP)).toBe(false);
  });

  it("模型选项 envVars 不再携带钉（钉在合并后单点计算）", () => {
    const opts = getClientLaunchOptions(claudeCodeClient, mkProvider());
    const opus = opts.find((o) => o.id === "model-claude-opus-4-7");
    expect(opus?.envVars?.ANTHROPIC_MODEL).toBe("claude-opus-4-7[1m]");
    for (const key of SUBAGENT_PIN_KEYS) {
      expect(opus?.envVars?.[key]).toBeUndefined();
    }
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
