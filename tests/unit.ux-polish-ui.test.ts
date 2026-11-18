import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import "../src/clients";
import type { ClientConfig, LaunchOption } from "../src/clients/base";
import { ClientVersionView } from "../src/ui/ink/views/ClientVersionView";
import { GroupPicker, ProviderPicker } from "../src/ui/ink/views/LauncherPickers";
import { ProviderMenuView } from "../src/ui/ink/views/ProviderMenuView";
import { isClientInstalledFast } from "../src/ui/shared/launcher-data";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function createInkHarness(element: React.ReactElement) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 35;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  const app = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  return {
    getOutput: () => output,
    send: (data: string) => {
      stdin.write(data);
    },
    unmount: () => app.unmount(),
  };
}

describe("isClientInstalledFast & UX Polish UI / CLI contracts", () => {
  it("detects system clients via resolveBin without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tako-fast-inst-"));
    tempDirs.push(dir);
    const binPath = join(dir, "mock-agy");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const installedClient: ClientConfig = {
      id: "agy",
      name: "Antigravity (agy)",
      package: "system:agy",
      command: "agy",
      install: "system",
      resolveBin: async () => binPath,
      getEnvVars: () => ({}),
    };
    const missingClient: ClientConfig = {
      ...installedClient,
      resolveBin: async () => null,
    };

    expect(await isClientInstalledFast(installedClient)).toBe(true);
    expect(await isClientInstalledFast(missingClient)).toBe(false);
  });

  it("renders GroupPicker model default item 0 and ProviderPicker k/m shortcut hints", () => {
    const modelOptions: LaunchOption[] = [
      {
        id: "model-claude-opus-4-6",
        label: { en: "Claude Opus 4.6", zh: "Claude Opus 4.6" },
        shortLabel: "Opus 4.6",
        description: { en: "Opus", zh: "Opus" },
        flag: "--model claude-opus-4-6",
        args: ["--model", "claude-opus-4-6"],
        group: "model",
      },
    ];

    const h1 = createInkHarness(
      React.createElement(GroupPicker, {
        group: "model",
        options: modelOptions,
        enabled: new Set<string>(),
        pickerIdx: 0,
        color: "green",
        zh: true,
        query: "",
      }),
    );
    expect(h1.getOutput()).toContain("默认（跟随客户端，不传 --model）");
    expect(h1.getOutput()).toContain("★");
    h1.unmount();

    const h2 = createInkHarness(
      React.createElement(GroupPicker, {
        group: "model",
        options: modelOptions,
        enabled: new Set<string>(),
        pickerIdx: 0,
        color: "green",
        zh: false,
        query: "opus",
      }),
    );
    expect(h2.getOutput()).not.toContain("Default (client built-in, no --model)");
    expect(h2.getOutput()).toContain("Claude Opus 4.6");
    h2.unmount();

    const h3 = createInkHarness(
      React.createElement(ProviderPicker, {
        provs: [
          {
            id: "tako-builtin",
            name: "Tako",
            type: "tako",
            apiKey: "cr_test",
            supportedClients: ["agy"],
            builtin: true,
          },
        ],
        provIdx: 0,
        pickerIdx: 0,
        color: "green",
        zh: true,
      }),
    );
    expect(h3.getOutput()).toContain("改Key");
    expect(h3.getOutput()).toContain("管理");
    h3.unmount();
  });

  it("renders ClientVersionView focused on initialClientId='agy' with one-click 'latest' entry", async () => {
    const h = createInkHarness(
      React.createElement(ClientVersionView, {
        initialClientId: "agy",
        onDone: () => {},
      }),
    );
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !h.getOutput().includes("latest")) {
        await Bun.sleep(40);
      }
      const out = h.getOutput();
      expect(out).toContain("latest");
      expect(out).toMatch(/官方最新（安装\/更新）|official latest/);
    } finally {
      h.unmount();
    }
  });

  it("forwards `tako agy --help` directly to agy instead of intercepting with Tako showHelp()", async () => {
    if (process.platform === "win32") return;
    const tmp = mkdtempSync(join(tmpdir(), "tako-subcmd-agy-"));
    tempDirs.push(tmp);
    const takoHome = join(tmp, "tako-home");
    const mockAgy = join(tmp, "mock-agy");
    const argsFile = join(tmp, "agy-args.json");
    writeFileSync(
      mockAgy,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\necho "AGY_NATIVE_HELP"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tmp, "setup.json"),
      JSON.stringify({
        apiKey: "cr_test",
        apiId: "id1",
        installedClients: {},
        providers: [
          {
            id: "tako-default",
            name: "Tako",
            type: "tako",
            apiKey: "cr_test",
            baseUrl: "https://tako.shiroha.tech",
            supportedClients: ["agy"],
            builtin: true,
          },
        ],
        defaultProviderId: "tako-default",
      }),
    );

    const fs = await import("node:fs/promises");
    await fs.mkdir(takoHome, { recursive: true });
    await fs.copyFile(join(tmp, "setup.json"), join(takoHome, "config.json"));

    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const proc = Bun.spawn([process.execPath, indexPath, "agy", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
        AGY_PATH: mockAgy,
      },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AGY_NATIVE_HELP");
    expect(stdout).not.toContain("tako skill list");
    const receivedArgs = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
    expect(receivedArgs).toContain("--help");
  });

  it("supports initialRekeyProviderId in ProviderMenuView for custom (non-builtin) providers", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tako-rekey-"));
    tempDirs.push(tmp);
    const script = `
      import React from "react";
      import { render } from "ink";
      import { PassThrough } from "node:stream";
      import "./src/clients";
      import { addProvider, getProviders } from "./src/providers";
      import { ProviderMenuView } from "./src/ui/ink/views/ProviderMenuView";

      const created = await addProvider({
        name: "My Custom Gateway",
        type: "custom",
        apiKey: "sk-old-key",
        baseUrl: "https://example.com/v1",
        model: "claude-opus-4-6",
        supportedClients: ["claude-code", "agy"],
      });

      let doneCalled = false;
      const stdout = new PassThrough();
      stdout.columns = 120;
      stdout.rows = 35;
      const stdin = new PassThrough();
      stdin.isTTY = true;
      stdin.setRawMode = () => stdin;
      stdin.ref = () => stdin;
      stdin.unref = () => stdin;

      const app = render(
        React.createElement(ProviderMenuView, {
          initialClientId: "agy",
          initialRekeyProviderId: created.id,
          onDone: () => { doneCalled = true; },
        }),
        { stdout, stdin, debug: true, exitOnCtrlC: false },
      );

      await Bun.sleep(80);
      stdin.write("sk-brand-new-key");
      await Bun.sleep(40);
      stdin.write("\\r");
      await Bun.sleep(80);
      app.unmount();

      const after = await getProviders();
      const updated = after.find((p) => p.id === created.id);
      console.log(JSON.stringify({ doneCalled, apiKey: updated?.apiKey, baseUrl: updated?.baseUrl }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAKO_HOME: tmp, TAKO_DEV: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(parsed).toEqual({
      doneCalled: true,
      apiKey: "sk-brand-new-key",
      baseUrl: "https://example.com/v1",
    });
  });
});
