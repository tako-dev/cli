/** Test client configurations */
export const testClients = {
  claudeCode: {
    id: "claude-code",
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    command: "claude",
    runtime: "bun" as const,
  },
  codex: {
    id: "codex",
    name: "Codex",
    package: "@openai/codex",
    command: "codex",
    runtime: "bun" as const,
  },
  pi: {
    id: "pi",
    name: "Pi",
    package: "@earendil-works/pi-coding-agent",
    command: "pi",
    runtime: "native" as const,
  },
  piWeb: {
    id: "pi-web",
    name: "Pi Web",
    package: "@agegr/pi-web",
    command: "pi-web",
    runtime: "node" as const,
  },
};

/** Core source modules that should exist */
export const coreModules = [
  "index.ts",
  "config.ts",
  "installer.ts",
  "launcher/index.ts",
  "updater.ts",
  "auth.ts",
  "stats.ts",
  "region.ts",
  "ui/index.ts",
];

/** Client modules that should exist */
export const clientModules = [
  "base.ts",
  "index.ts",
  "claude-code.ts",
  "codex.ts",
  "pi.ts",
  "pi-web.ts",
  "pi-settings.ts",
];

/** Required Tako subdirectories */
export const takoSubdirs = [
  "cli",
  "bun",
  "bin",
  "tools",
];

/** Required config fields */
export const requiredConfigFields = [
  "apiKey",
  "apiId",
  "installedClients",
];

/** Required package.json fields */
export const requiredPackageFields = [
  "name",
  "version",
];
