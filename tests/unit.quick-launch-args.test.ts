/**
 * tako --claude / --codex / --gemini 参数透传
 *
 * 设计：buildPassthroughArgs 是 quickLaunch 用的纯函数，
 * 负责剥掉 shortcut 标志本身，并对 claude-code 的 --model 自动补 [1m]
 * （与交互菜单选模型行为一致；底层用 appendOneMTagIfNeeded 决定是否补）。
 *
 * 危险跳过开关默认全放行：无记忆（首次）自动补全放行 flag
 * （claude-code: --dangerously-skip-permissions; codex:
 * --dangerously-bypass-approvals-and-sandbox）；有记忆则尊重上次选择，
 * 仅当勾过对应开关才补。注入式 reader 让单测不依赖磁盘 config。
 */
import { describe, it, expect } from "bun:test";
import { buildPassthroughArgs } from "../src/quick-launch-args";

import "../src/clients";

const noInherit = { getLastSelectedOptionIds: async () => [] };

describe("buildPassthroughArgs", () => {
  it("claude-code: 无额外参数、无记忆 → 默认补跳过权限", async () => {
    expect(await buildPassthroughArgs("claude-code", ["--claude"], "--claude", noInherit)).toEqual(["--dangerously-skip-permissions"]);
  });

  it("claude-code: --model <id> → 自动补 [1m]（catalog 1M 模型）", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--claude", "--model", "claude-opus-4-7"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-7[1m]"]);
  });

  it("claude-code: --model=<id> 形式同样自动补 [1m]", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--claude", "--model=claude-opus-4-7"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--model=claude-opus-4-7[1m]"]);
  });

  it("claude-code: 200k 模型不补后缀", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--claude", "--model", "claude-sonnet-4-5"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-sonnet-4-5"]);
  });

  it("claude-code: 已带 [1m] 不重复加", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--claude", "--model", "claude-opus-4-7[1m]"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-7[1m]"]);
  });

  it("claude-code: 非 --model 参数原样透传", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--claude", "--resume", "abc", "--continue"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--resume", "abc", "--continue"]);
  });

  it("claude-code: shortcut 标志可在中间，仍能正确剥除", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        ["--model", "claude-opus-4-7", "--claude"],
        "--claude",
        noInherit,
      ),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-7[1m]"]);
  });

  it("claude-code: --model 末尾孤立（缺值）→ 原样透传，交给 claude 自己报错", async () => {
    expect(
      await buildPassthroughArgs("claude-code", ["--claude", "--model"], "--claude", noInherit),
    ).toEqual(["--dangerously-skip-permissions", "--model"]);
  });

  it("codex: --model 不补 [1m]（无 1M 概念）；无记忆默认补 bypass", async () => {
    expect(
      await buildPassthroughArgs(
        "codex",
        ["--codex", "--model", "claude-opus-4-7"],
        "--codex",
        noInherit,
      ),
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--model", "claude-opus-4-7"]);
  });

  it("gemini: --model 不补 [1m]，且不在危险白名单内不补任何 flag", async () => {
    expect(
      await buildPassthroughArgs(
        "gemini",
        ["--gemini", "--model", "claude-opus-4-7"],
        "--gemini",
        noInherit,
      ),
    ).toEqual(["--model", "claude-opus-4-7"]);
  });

  it("claude-code: 多个 --model 全部处理（最后一个生效由 claude 决定）", async () => {
    expect(
      await buildPassthroughArgs(
        "claude-code",
        [
          "--claude",
          "--model",
          "claude-opus-4-7",
          "--resume",
          "x",
          "--model=claude-sonnet-4-6",
        ],
        "--claude",
        noInherit,
      ),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "claude-opus-4-7[1m]",
      "--resume",
      "x",
      "--model=claude-sonnet-4-6[1m]",
    ]);
  });

  describe("继承 panel 的危险跳过开关", () => {
    it("claude-code: 无记忆 → 默认补 --dangerously-skip-permissions", async () => {
      expect(
        await buildPassthroughArgs("claude-code", ["--claude"], "--claude", {
          getLastSelectedOptionIds: async () => [],
        }),
      ).toEqual(["--dangerously-skip-permissions"]);
    });

    it("codex: 无记忆 → 默认补 --dangerously-bypass-approvals-and-sandbox", async () => {
      expect(
        await buildPassthroughArgs("codex", ["--codex"], "--codex", {
          getLastSelectedOptionIds: async () => [],
        }),
      ).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });

    it("claude-code: 上次勾了 skip-permissions → 自动补 --dangerously-skip-permissions", async () => {
      expect(
        await buildPassthroughArgs("claude-code", ["--claude"], "--claude", {
          getLastSelectedOptionIds: async () => ["skip-permissions"],
        }),
      ).toEqual(["--dangerously-skip-permissions"]);
    });

    it("claude-code: 继承的 flag 与 --model 共存", async () => {
      expect(
        await buildPassthroughArgs(
          "claude-code",
          ["--claude", "--model", "claude-opus-4-7"],
          "--claude",
          { getLastSelectedOptionIds: async () => ["skip-permissions"] },
        ),
      ).toEqual(["--dangerously-skip-permissions", "--model", "claude-opus-4-7[1m]"]);
    });

    it("claude-code: 用户已显式传 --dangerously-skip-permissions → 不重复补", async () => {
      expect(
        await buildPassthroughArgs(
          "claude-code",
          ["--claude", "--dangerously-skip-permissions"],
          "--claude",
          { getLastSelectedOptionIds: async () => ["skip-permissions"] },
        ),
      ).toEqual(["--dangerously-skip-permissions"]);
    });

    it("claude-code: 有记忆但没勾 skip-permissions → 尊重记忆，不补", async () => {
      expect(
        await buildPassthroughArgs("claude-code", ["--claude"], "--claude", {
          getLastSelectedOptionIds: async () => ["worktree", "model-claude-opus-4-7"],
        }),
      ).toEqual([]);
    });

    it("codex: 上次勾了 bypass-sandbox → 自动补 --dangerously-bypass-approvals-and-sandbox", async () => {
      expect(
        await buildPassthroughArgs("codex", ["--codex"], "--codex", {
          getLastSelectedOptionIds: async () => ["bypass-sandbox"],
        }),
      ).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });

    it("codex: 用户已显式传 bypass flag → 不重复补", async () => {
      expect(
        await buildPassthroughArgs(
          "codex",
          ["--codex", "--dangerously-bypass-approvals-and-sandbox"],
          "--codex",
          { getLastSelectedOptionIds: async () => ["bypass-sandbox"] },
        ),
      ).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });

    it("codex: 有记忆但没勾 bypass-sandbox → 尊重记忆，不补", async () => {
      expect(
        await buildPassthroughArgs("codex", ["--codex"], "--codex", {
          getLastSelectedOptionIds: async () => ["search"],
        }),
      ).toEqual([]);
    });

    it("gemini: 不在白名单内 → 不继承任何 flag", async () => {
      expect(
        await buildPassthroughArgs("gemini", ["--gemini"], "--gemini", {
          getLastSelectedOptionIds: async () => ["skip-permissions", "bypass-sandbox"],
        }),
      ).toEqual([]);
    });
  });

  describe("grok model remapping", () => {
    it("grok: --model grok-4.6 → 只带一次 -m tako-grok-4.6", async () => {
      expect(
        await buildPassthroughArgs(
          "grok",
          ["--grok", "--model", "grok-4.6"],
          "--grok",
          noInherit,
        ),
      ).toEqual(["-m", "tako-grok-4.6"]);
    });

    it("grok: -m composer-2.5 → tako-composer-2.5", async () => {
      expect(
        await buildPassthroughArgs(
          "grok",
          ["--grok", "-m", "composer-2.5"],
          "--grok",
          noInherit,
        ),
      ).toEqual(["-m", "tako-composer-2.5"]);
    });

    it("grok: 没传模型 → 默认 -m tako-grok-4.6", async () => {
      expect(
        await buildPassthroughArgs("grok", ["--grok"], "--grok", noInherit),
      ).toEqual(["-m", "tako-grok-4.6"]);
    });

    it("grok: --model 和 -m 同时出现 → 只保留第一次", async () => {
      expect(
        await buildPassthroughArgs(
          "grok",
          ["--grok", "--model", "grok-4.6", "-m", "composer-2.5"],
          "--grok",
          noInherit,
        ),
      ).toEqual(["-m", "tako-grok-4.6"]);
    });
  });
});
