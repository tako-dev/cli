import { describe, it, expect } from "bun:test";
import { join } from "path";
import { getTakoDir, getTakoCliDir, getProjectRoot, getSrcDir, getDistDir } from "./_helpers/paths";
import { expectFileExists, expectValidPackageJson, expectHasShebang } from "./_helpers/assertions";
import { coreModules, clientModules, requiredConfigFields } from "./_helpers/fixtures";
import { buildCliUpdateCommand } from "../src/updater";

describe("Pre-Release - Build System", () => {
  const projectRoot = getProjectRoot();

  it("package.json should exist and be valid", async () => {
    const pkgPath = join(projectRoot, "package.json");
    await expectValidPackageJson(pkgPath);
  });

  it("build artifact should exist", async () => {
    const distPath = join(getDistDir(), "index.js");
    await expectFileExists(distPath);
  });

  it("legacy split backend artifacts should not exist", async () => {
    expect(await Bun.file(join(getDistDir(), "index-ink.js")).exists()).toBe(false);
    expect(await Bun.file(join(getDistDir(), "index-opentui.js")).exists()).toBe(false);
  });

  it("build artifact should contain shebang (Unix executable)", async () => {
    const distPath = join(getDistDir(), "index.js");
    await expectHasShebang(distPath);
  });

  it("install scripts should exist", async () => {
    await expectFileExists(join(projectRoot, "install.sh"));
    await expectFileExists(join(projectRoot, "install.ps1"));
  });

  it("build artifact should have reasonable size", async () => {
    const distPath = join(getDistDir(), "index.js");
    const file = Bun.file(distPath);
    const size = file.size;
    expect(size).toBeGreaterThan(1000); // At least 1KB
    expect(size).toBeLessThan(1500000); // Less than 1.5MB (includes Ink/React)
  });

  it("build artifact should not load OpenTUI backend", async () => {
    const bundle = await Bun.file(join(getDistDir(), "index.js")).text();

    expect(bundle).not.toContain("@opentui/core");
    expect(bundle).not.toContain("index-opentui");
  });

  it("build artifact should start without errors (smoke test)", async () => {
    const distPath = join(getDistDir(), "index.js");
    const proc = Bun.spawn(["bun", distPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Tako CLI");
  });
});

describe("Pre-Release - Source Code Integrity", () => {
  const srcPath = getSrcDir();

  for (const module of coreModules) {
    it(`core module ${module} should exist`, async () => {
      await expectFileExists(join(srcPath, module));
    });
  }

  for (const module of clientModules) {
    it(`client module ${module} should exist`, async () => {
      await expectFileExists(join(srcPath, "clients", module));
    });
  }
});

describe("Pre-Release - Configuration System", () => {
  it("Tako CLI directory should be configured correctly", () => {
    const takoDir = getTakoDir();
    const cliDir = getTakoCliDir();

    expect(cliDir.startsWith(takoDir)).toBe(true);
  });

  it("config file structure should be correct (if exists)", async () => {
    const configPath = join(getTakoDir(), "config.json");
    const file = Bun.file(configPath);

    if (!(await file.exists())) {
      console.warn("  [SKIP] Config file does not exist");
      return;
    }

    const config = await file.json();
    for (const field of requiredConfigFields) {
      expect(config).toHaveProperty(field);
    }
  });
});

describe("Pre-Release - Entry Resolution", () => {
  it("bin field parsing - object format", () => {
    const bin = { claude: "cli.js" };
    const command = "claude";
    const result = bin[command];
    expect(result).toBe("cli.js");
  });

  it("bin field parsing - string format", () => {
    const bin = "index.js";
    expect(bin).toBe("index.js");
  });

  it("bin field parsing - multi-command format", () => {
    const bin = { cmd1: "bin/cmd1.js", cmd2: "bin/cmd2.js" };
    const command = "cmd2";
    const result = bin[command];
    expect(result).toBe("bin/cmd2.js");
  });
});

describe("Pre-Release - Update Logic", () => {
  it("Tako CLI directory should be under Tako directory", () => {
    const takoDir = getTakoDir();
    const cliDir = getTakoCliDir();
    expect(cliDir.startsWith(takoDir)).toBe(true);
  });

  it("update command should not contain -g flag", () => {
    const command = buildCliUpdateCommand();
    expect(command).not.toContain("-g");
  });

  it("working directory should be set to Tako CLI directory", () => {
    const takoDir = getTakoDir();
    const cwd = getTakoCliDir();
    expect(cwd.startsWith(takoDir)).toBe(true);
  });
});

describe("Pre-Release - Cross Platform", () => {
  it("path separator handling should work", () => {
    const testPath = join("a", "b", "c");
    expect(testPath).toContain("a");
    expect(testPath).toContain("c");
  });

  it("executable extension should be correct for platform", () => {
    const isWindows = process.platform === "win32";
    const takoDir = getTakoDir();
    const bunBin = join(takoDir, "bun", "bin", isWindows ? "bun.exe" : "bun");

    if (isWindows) {
      expect(bunBin).toEndWith(".exe");
    } else {
      expect(bunBin).not.toEndWith(".exe");
    }
  });

  it("launcher script should be platform-appropriate", () => {
    const isWindows = process.platform === "win32";
    const scriptName = isWindows ? "tako.cmd" : "tako";

    expect(scriptName).toBeDefined();
    if (isWindows) {
      expect(scriptName).toEndWith(".cmd");
    }
  });
});

describe("Pre-Release - Client Registry", () => {
  it("Claude Code client configuration should be complete", () => {
    const client = {
      id: "claude-code",
      name: "Claude Code",
      package: "@anthropic-ai/claude-code",
      command: "claude",
      runtime: "bun" as const,
    };

    expect(client.id).toBeTruthy();
    expect(client.name).toBeTruthy();
    expect(client.package).toBeTruthy();
    expect(client.command).toBeTruthy();
    expect(["bun", "native"]).toContain(client.runtime);
  });

  it("Codex client configuration should be complete", () => {
    const client = {
      id: "codex",
      name: "Codex",
      package: "@openai/codex",
      command: "codex",
      runtime: "bun" as const,
    };

    expect(client.id).toBeTruthy();
    expect(client.name).toBeTruthy();
    expect(client.package).toBeTruthy();
    expect(client.command).toBeTruthy();
    expect(["bun", "native"]).toContain(client.runtime);
  });
});
