/** Mock package.json data */
export const mockPackageJsons = {
  claudeCode: {
    name: "@anthropic-ai/claude-code",
    version: "2.1.1",
    bin: { claude: "cli.js" }
  },
  pi: {
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
    bin: { pi: "dist/cli.js" }
  },
  piWeb: {
    name: "@agegr/pi-web",
    version: "0.8.0",
    bin: { "pi-web": "bin/pi-web.js" }
  },
  stringBin: {
    name: "some-tool",
    bin: "index.js"
  },
  multiCommand: {
    name: "multi-cli",
    bin: { cmd1: "bin/cmd1.js", cmd2: "bin/cmd2.js" }
  },
  noBin: {
    name: "no-bin"
  },
  wrongCommand: {
    name: "wrong-cmd",
    bin: { foo: "foo.js" }
  }
};

/** Parse bin field from package.json (extracted from source) */
export function parseBinField(bin: any, command: string): string | null {
  if (!bin) {
    return null;
  }

  if (typeof bin === "string") {
    return bin;
  } else if (typeof bin === "object" && bin[command]) {
    return bin[command];
  }

  return null;
}

/** Mock config structure */
export const mockConfig = {
  apiKey: "",
  apiId: "",
  installedClients: [] as string[]
};

/** Mock valid config */
export const mockValidConfig = {
  apiKey: "test-api-key",
  apiId: "test-api-id",
  installedClients: ["claude-code"]
};
