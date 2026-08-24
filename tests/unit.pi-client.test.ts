import { describe, expect, it } from "bun:test";
import "../src/clients";
import { getAllClients, getClient, getClientLaunchOptions } from "../src/clients/base";
import { piClient } from "../src/clients/pi";
import {
  PI_CC_HEADER_PACKAGE,
  PI_CLAUDE_CODE_UI_PACKAGE,
  PI_PACKAGE,
  applyPiSettings,
  hasLocalTakoPi,
  hasPackageSource,
  hasTakoPi,
  missingPiStylePackages,
  patchPiCcHeaderSource,
  planTakoPiAction,
  withDefaultPiPackages,
} from "../src/clients/pi-settings";
import { resolveLaunchTarget, stripPiOnlyArgs, wantsPiWeb } from "../src/launcher";
import { resolveDefaultClientIndex } from "../src/ui/shared/launcher-data";

describe("Pi launcher placement", () => {
  it("keeps Pi visible and hides Pi Web from tabs", () => {
    const ids = getAllClients().map((c) => c.id);
    expect(ids).toContain("pi");
    expect(ids).not.toContain("pi-web");
    expect(getClient("pi-web")?.hidden).toBe(true);
  });

  it("defaults to Pi when this directory has no last client", () => {
    expect(resolveDefaultClientIndex(["codex", "claude-code", "pi", "gemini"], null)).toBe(2);
  });

  it("stays on the last client used in this directory", () => {
    expect(resolveDefaultClientIndex(["codex", "claude-code", "pi", "gemini"], "claude-code")).toBe(1);
  });

  it("treats leftover pi-web history as Pi", () => {
    expect(resolveDefaultClientIndex(["codex", "claude-code", "pi", "gemini"], "pi-web")).toBe(2);
  });

  it("exposes Web UI as a Pi option, not a separate tab", () => {
    const ids = getClientLaunchOptions(piClient).map((o) => o.id);
    expect(ids[0]).toBe("web");
    expect(ids).toContain("no-session");
  });
});

describe("Pi Web routing", () => {
  it("routes Pi launches with the Web option to pi-web", () => {
    expect(wantsPiWeb(piClient, { selectedOptionIds: ["web"] })).toBe(true);
    expect(wantsPiWeb(piClient, { args: ["--web"] })).toBe(true);
    expect(wantsPiWeb(piClient, { selectedOptionIds: ["no-session"] })).toBe(false);
    expect(wantsPiWeb(getClient("pi-web")!, {})).toBe(true);
    expect(resolveLaunchTarget(piClient, { selectedOptionIds: ["web"] }).web).toBe(true);
  });

  it("strips terminal-only Pi flags before starting the browser UI", () => {
    expect(stripPiOnlyArgs([
      "--provider", "tako",
      "--model", "grok-4.6",
      "--no-session",
      "--web",
      "--no-open",
    ])).toEqual(["--no-open"]);
  });
});

describe("tako-pi package detection", () => {
  it("treats local and git sources as already installed", () => {
    expect(hasTakoPi(["local/tako-pi"])).toBe(true);
    expect(hasLocalTakoPi(["local/tako-pi"])).toBe(true);
    expect(hasTakoPi(["git:github.com/Barrierml/tako-pi"])).toBe(true);
    expect(hasLocalTakoPi(["git:github.com/Barrierml/tako-pi"])).toBe(false);
    expect(hasTakoPi(["npm:pi-cc-header"])).toBe(false);
  });

  it("installs the public git package on first launch", () => {
    expect(planTakoPiAction({
      packages: [PI_CC_HEADER_PACKAGE],
      installed: false,
      update: true,
      updatedToday: false,
      hasBin: true,
    })).toEqual({
      packages: [PI_CC_HEADER_PACKAGE, PI_PACKAGE, PI_CLAUDE_CODE_UI_PACKAGE],
      action: "install",
    });
  });

  it("adds Claude tool UI without replacing local/tako-pi", () => {
    expect(withDefaultPiPackages(["local/tako-pi", PI_CC_HEADER_PACKAGE])).toEqual([
      "local/tako-pi",
      PI_CC_HEADER_PACKAGE,
      PI_CLAUDE_CODE_UI_PACKAGE,
    ]);
    expect(hasPackageSource([PI_CLAUDE_CODE_UI_PACKAGE], PI_CLAUDE_CODE_UI_PACKAGE)).toBe(true);
    expect(missingPiStylePackages(["pi-cc-header"])).toEqual([PI_CLAUDE_CODE_UI_PACKAGE]);
    expect(missingPiStylePackages(["pi-cc-header", "pi-claude-code-ui"])).toEqual([]);
    expect(planTakoPiAction({
      packages: ["local/tako-pi"],
      installed: false,
      update: true,
      updatedToday: false,
      hasBin: true,
    })).toEqual({
      packages: ["local/tako-pi", PI_CC_HEADER_PACKAGE, PI_CLAUDE_CODE_UI_PACKAGE],
      action: "none",
    });
  });

  it("updates the git package at most once a day", () => {
    const git = [PI_PACKAGE];
    expect(planTakoPiAction({
      packages: git,
      installed: true,
      update: true,
      updatedToday: false,
      hasBin: true,
    }).action).toBe("update");
    expect(planTakoPiAction({
      packages: git,
      installed: true,
      update: true,
      updatedToday: true,
      hasBin: true,
    }).action).toBe("none");
  });

  it("never updates a local/tako-pi checkout", () => {
    expect(planTakoPiAction({
      packages: ["local/tako-pi", PI_CC_HEADER_PACKAGE, PI_CLAUDE_CODE_UI_PACKAGE],
      installed: false,
      update: true,
      updatedToday: false,
      hasBin: true,
    })).toEqual({
      packages: ["local/tako-pi", PI_CC_HEADER_PACKAGE, PI_CLAUDE_CODE_UI_PACKAGE],
      action: "none",
    });
  });
});

describe("Pi settings merge", () => {
  it("writes Tako defaults without wiping other settings", () => {
    const { next, args } = applyPiSettings(
      { theme: "dark", packages: ["local/plan-mode"] },
      { type: "tako", model: "grok-4.6" },
      ["model-mimo-v2.5"],
    );
    expect(next.theme).toBe("dark");
    expect(next.packages).toEqual(["local/plan-mode"]);
    expect(next.defaultProvider).toBe("tako");
    expect(next.defaultModel).toBe("mimo-v2.5");
    expect(next.compaction).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
    expect(args).toEqual(["--provider", "tako", "--model", "mimo-v2.5"]);
  });

  it("keeps an existing compaction block", () => {
    const { next } = applyPiSettings(
      { compaction: { enabled: false } },
      { type: "tako" },
    );
    expect(next.compaction).toEqual({ enabled: false });
    expect(next.defaultModel).toBe("grok-4.6");
  });

  it("defaults Pi to grok-4.6 when no model is selected", () => {
    const { next, args } = applyPiSettings({}, { type: "tako" });
    expect(next.defaultModel).toBe("grok-4.6");
    expect(args).toEqual(["--provider", "tako", "--model", "grok-4.6"]);
  });
});

describe("pi-cc-header stale ctx patch", () => {
  it("wraps ctx.mode so a delayed header apply cannot crash Pi 0.84", () => {
    const source = [
      "function apply(pi: ExtensionAPI, ctx: ExtensionContext) {",
      "\tif (ctx.mode !== \"tui\") return;",
      "\tctx.ui.setHeader(() => undefined);",
      "}",
    ].join("\n");
    const first = patchPiCcHeaderSource(source);
    expect(first.changed).toBe(true);
    expect(first.next).toContain("catch {");
    expect(patchPiCcHeaderSource(first.next).changed).toBe(false);
  });
});
