import { describe, it, expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildTakoClaudeSettingsOverlay,
  findClaudeSettingsConflicts,
  prepareTakoClaudeSettingsForLaunch,
} from "../src/clients/claude-code";

describe("Claude Code launch settings overlay", () => {
  it("contains only provider-owned env keys", () => {
    const overlay = buildTakoClaudeSettingsOverlay({
      ANTHROPIC_AUTH_TOKEN: "new-token",
      ANTHROPIC_BASE_URL: "https://new.example.com",
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
      API_TIMEOUT_MS: "90000",
      KEEP_ME: "yes",
    });

    expect(overlay).toEqual({
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "new-token",
        ANTHROPIC_BASE_URL: "https://new.example.com",
        ANTHROPIC_MODEL: "claude-sonnet-4-6",
      },
    });
  });

  it("reports only provider-owned values that will actually change", () => {
    const settings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: "old-token",
        ANTHROPIC_BASE_URL: "https://new.example.com",
        ANTHROPIC_CUSTOM_HEADERS: "x-trace: keep",
        API_TIMEOUT_MS: "1000",
        KEEP_ME: "yes",
      },
    };
    const overlay = buildTakoClaudeSettingsOverlay({
      ANTHROPIC_AUTH_TOKEN: "new-token",
      ANTHROPIC_BASE_URL: "https://new.example.com",
    });

    expect(findClaudeSettingsConflicts(settings, overlay)).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("writes a minimal overlay without disabling the user settings source", async () => {
    const dir = join(tmpdir(), `tako-claude-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourcePath = join(dir, "source-settings.json");
    const targetPath = join(dir, "tako", "launch-settings.json");

    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        sourcePath,
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: "old-token",
            NORMAL_ENV: "keep",
          },
          permissions: { allow: ["Bash(git *)"] },
          enabledPlugins: { "review@personal": true },
        }),
      );

      const result = await prepareTakoClaudeSettingsForLaunch({
        launchEnvVars: {
          ANTHROPIC_AUTH_TOKEN: "new-token",
          ANTHROPIC_BASE_URL: "https://new.example.com",
        },
        sourcePath,
        targetPath,
        logConflicts: false,
      });

      expect(result.args).toEqual(["--settings", targetPath]);
      expect(result.args).not.toContain("--setting-sources");
      expect(result.conflictingFields).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
      expect(result.cleanupFiles).toEqual([targetPath]);

      const source = JSON.parse(await readFile(sourcePath, "utf-8"));
      const target = JSON.parse(await readFile(targetPath, "utf-8"));
      expect(source.permissions).toEqual({ allow: ["Bash(git *)"] });
      expect(source.enabledPlugins).toEqual({ "review@personal": true });
      expect(target).toEqual({
        env: {
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "new-token",
          ANTHROPIC_BASE_URL: "https://new.example.com",
        },
      });
      expect(target.permissions).toBeUndefined();
      expect(target.enabledPlugins).toBeUndefined();
      expect(target.env.NORMAL_ENV).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the overlay even when user settings are absent", async () => {
    const dir = join(tmpdir(), `tako-claude-settings-clean-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourcePath = join(dir, "missing-settings.json");
    const targetPath = join(dir, "launch-settings.json");

    await mkdir(dir, { recursive: true });
    try {
      const result = await prepareTakoClaudeSettingsForLaunch({
        launchEnvVars: { ANTHROPIC_API_KEY: "selected-key" },
        sourcePath,
        targetPath,
        logConflicts: false,
      });

      expect(result.conflictingFields).toEqual([]);
      expect(JSON.parse(await readFile(targetPath, "utf-8"))).toEqual({
        env: {
          ANTHROPIC_API_KEY: "selected-key",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: "",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
