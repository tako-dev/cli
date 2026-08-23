import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildClientLaunchCommand,
  getClient,
  getClientDir,
  parsePathLookup,
  pathLookupCommand,
} from "../src/clients/base";
import { claudeCodeClient } from "../src/clients/claude-code";
import { codexClient } from "../src/clients/codex";
import { geminiClient } from "../src/clients/gemini";
import { piClient } from "../src/clients/pi";
import { piWebClient } from "../src/clients/pi-web";
import {
  pickPiLookupPath,
  resolvePiLookupCommand,
} from "../src/clients/pi-settings";
import { isPackageInstalledAt } from "../src/installer";
import { resolveLaunchTarget } from "../src/launcher";
import { TAKO_DIR } from "../src/config";
import { nodeDownloadSpec, nodeDownloadUrls, nodeVersionMeets, pickNestedNodeDir } from "../src/installer";
import { parseBinField } from "./_helpers/mocks";

const PLATFORMS = ["darwin", "linux", "win32"] as const;

describe("Pi / Pi Web install contracts", () => {
  it("keeps Pi and Pi Web on the isolated Tako tools dir", () => {
    for (const client of [piClient, piWebClient]) {
      const dir = getClientDir(client.id);
      expect(dir.startsWith(TAKO_DIR)).toBe(true);
      expect(dir).toContain(join("tools", client.id));
    }
  });

  it("treats a placeholder package.json as not installed on any OS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tako-pi-install-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "tako-pi", private: true, dependencies: { [piClient.package]: "latest" } }),
      );
      expect(await isPackageInstalledAt(dir, piClient.package)).toBe(false);
      expect(await isPackageInstalledAt(dir, piWebClient.package)).toBe(false);

      const piPkg = join(dir, "node_modules", piClient.package);
      await mkdir(piPkg, { recursive: true });
      await writeFile(join(piPkg, "package.json"), JSON.stringify({ name: piClient.package, version: "0.84.2" }));
      expect(await isPackageInstalledAt(dir, piClient.package)).toBe(true);
      expect(await isPackageInstalledAt(dir, piWebClient.package)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves JS bin entries from package.json without depending on .bin shims", () => {
    expect(parseBinField({ pi: "dist/cli.js" }, "pi")).toBe("dist/cli.js");
    expect(parseBinField({ "pi-web": "bin/pi-web.js" }, "pi-web")).toBe("bin/pi-web.js");
    expect(join(getClientDir("pi"), "node_modules", piClient.package, "dist/cli.js"))
      .toBe(join(TAKO_DIR, "tools", "pi", "node_modules", piClient.package, "dist/cli.js"));
    expect(join(getClientDir("pi-web"), "node_modules", piWebClient.package, "bin/pi-web.js"))
      .toBe(join(TAKO_DIR, "tools", "pi-web", "node_modules", piWebClient.package, "bin/pi-web.js"));
  });
});

describe("Tako Node runtime contracts", () => {
  it("pins Node 22.22.0 zip/tarball names per OS and region", () => {
    expect(nodeDownloadSpec("22.22.0", "darwin", "arm64", "cn")).toEqual({
      file: "node-v22.22.0-darwin-arm64.tar.gz",
      url: "https://cdn.npmmirror.com/binaries/node/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz",
      isZip: false,
    });
    expect(nodeDownloadSpec("22.22.0", "linux", "x64", "cn")).toEqual({
      file: "node-v22.22.0-linux-x64.tar.gz",
      url: "https://cdn.npmmirror.com/binaries/node/v22.22.0/node-v22.22.0-linux-x64.tar.gz",
      isZip: false,
    });
    expect(nodeDownloadSpec("22.22.0", "win32", "x64", "cn")).toEqual({
      file: "node-v22.22.0-win-x64.zip",
      url: "https://cdn.npmmirror.com/binaries/node/v22.22.0/node-v22.22.0-win-x64.zip",
      isZip: true,
    });
    expect(nodeDownloadSpec("22.22.0", "darwin", "arm64", "global")).toEqual({
      file: "node-v22.22.0-darwin-arm64.tar.gz",
      url: "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz",
      isZip: false,
    });
  });

  it("falls back to the other region if the primary Node mirror fails", () => {
    expect(nodeDownloadUrls("22.22.0", "darwin", "arm64", "cn")).toEqual([
      "https://cdn.npmmirror.com/binaries/node/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz",
      "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz",
    ]);
    expect(nodeDownloadUrls("22.22.0", "win32", "x64", "global")).toEqual([
      "https://nodejs.org/dist/v22.22.0/node-v22.22.0-win-x64.zip",
      "https://cdn.npmmirror.com/binaries/node/v22.22.0/node-v22.22.0-win-x64.zip",
    ]);
  });

  it("rejects system Node older than 22.19", () => {
    expect(nodeVersionMeets("21.7.1")).toBe(false);
    expect(nodeVersionMeets("22.18.0")).toBe(false);
    expect(nodeVersionMeets("v22.19.0")).toBe(true);
    expect(nodeVersionMeets("22.22.0")).toBe(true);
  });

  it("flattens the extracted Node directory, not the archive file", () => {
    expect(pickNestedNodeDir([
      "node-v22.22.0-darwin-arm64.tar.gz",
      "node-v22.22.0-darwin-arm64",
    ])).toBe("node-v22.22.0-darwin-arm64");
    expect(pickNestedNodeDir([
      "node-v22.22.0-win-x64.zip",
      "node-v22.22.0-win-x64",
    ])).toBe("node-v22.22.0-win-x64");
  });
});

describe("Pi / Pi Web launch command across OS", () => {
  const bun = {
    darwin: "/Users/hashiro/.tako/bun/bin/bun",
    linux: "/home/hashiro/.tako/bun/bin/bun",
    win32: "C:\\Users\\hashiro\\.tako\\bun\\bin\\bun.exe",
  } as const;
  const piJs = {
    darwin: "/Users/hashiro/.tako/tools/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    linux: "/home/hashiro/.tako/tools/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    win32: "C:\\Users\\hashiro\\.tako\\tools\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
  } as const;
  const webJs = {
    darwin: "/Users/hashiro/.tako/tools/pi-web/node_modules/@agegr/pi-web/bin/pi-web.js",
    linux: "/home/hashiro/.tako/tools/pi-web/node_modules/@agegr/pi-web/bin/pi-web.js",
    win32: "C:\\Users\\hashiro\\.tako\\tools\\pi-web\\node_modules\\@agegr\\pi-web\\bin\\pi-web.js",
  } as const;
  const node = {
    darwin: "/Users/hashiro/.nvm/versions/node/v22.22.0/bin/node",
    linux: "/usr/bin/node",
    win32: "C:\\Program Files\\nodejs\\node.exe",
  } as const;

  for (const os of PLATFORMS) {
    it(`always launches Pi with Tako Node on ${os}`, () => {
      const command = buildClientLaunchCommand(piClient, piJs[os], bun[os], ["--provider", "tako"], os, node[os]);
      expect(command).toEqual([node[os], piJs[os], "--provider", "tako"]);
    });

    it(`always launches Pi Web with Tako Node on ${os}`, () => {
      const command = buildClientLaunchCommand(piWebClient, webJs[os], bun[os], ["--no-open"], os, node[os]);
      expect(command).toEqual([node[os], webJs[os], "--no-open"]);
    });

    it(`always launches bun-runtime clients with bun on ${os}`, () => {
      for (const client of [codexClient, geminiClient]) {
        const bin = os === "win32"
          ? `C:\\tako\\tools\\${client.id}\\cli.js`
          : `/tako/tools/${client.id}/cli.js`;
        expect(buildClientLaunchCommand(client, bin, bun[os], [], os)).toEqual([bun[os], bin]);
      }
    });

    it(`runs native clients directly on ${os === "win32" ? "Windows unless the entry is .js" : os}`, () => {
      const nativeBin = os === "win32"
        ? `C:\\tako\\tools\\${claudeCodeClient.id}\\${claudeCodeClient.command}.exe`
        : `/tako/tools/${claudeCodeClient.id}/${claudeCodeClient.command}`;
      expect(buildClientLaunchCommand(claudeCodeClient, nativeBin, bun[os], [], os)).toEqual([nativeBin]);
    });
  }

  it("looks up a missing binary with which on Unix and where on Windows", () => {
    expect(pathLookupCommand("pi", "darwin")).toBe("which pi");
    expect(pathLookupCommand("pi", "linux")).toBe("which pi");
    expect(pathLookupCommand("pi", "win32")).toBe("where pi.exe 2>nul || where pi.cmd 2>nul || where pi");
    expect(resolvePiLookupCommand("darwin")).toBe("which pi");
    expect(resolvePiLookupCommand("linux")).toBe("which pi");
    expect(resolvePiLookupCommand("win32")).toBe("where pi");
  });

  it("prefers Windows .exe/.cmd over a bare npm shim", () => {
    const win = "C:\\nvm\\pi\r\nC:\\nvm\\pi.cmd\r\nC:\\nvm\\pi.exe\r\n";
    expect(parsePathLookup(win, "win32")).toBe("C:\\nvm\\pi.exe");
    expect(pickPiLookupPath(win, "win32")).toBe("C:\\nvm\\pi.cmd");
    expect(parsePathLookup("/usr/local/bin/pi\n", "linux")).toBe("/usr/local/bin/pi");
    expect(parsePathLookup("/opt/homebrew/bin/pi\n", "darwin")).toBe("/opt/homebrew/bin/pi");
  });
});

describe("Pi Web install is routed through the Pi tab", () => {
  it("installs Pi first, then Pi Web, and records history as Pi", () => {
    expect(resolveLaunchTarget(piClient, { selectedOptionIds: ["web"] })).toEqual({
      installId: "pi",
      recordId: "pi",
      web: true,
    });
    expect(resolveLaunchTarget(getClient("pi-web")!, {})).toEqual({
      installId: "pi",
      recordId: "pi",
      web: true,
    });
    expect(resolveLaunchTarget(piClient, {})).toEqual({
      installId: "pi",
      recordId: "pi",
      web: false,
    });
  });
});
