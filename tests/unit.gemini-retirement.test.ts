import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/clients";
import { ensureClientReady, getGeminiRetiredMessage, installClient } from "../src/installer";
import { clearLocaleOverride, setLocale } from "../src/i18n";
import { migrateSupportedClients } from "../src/providers";

describe("Gemini CLI retirement and config migration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tako-gemini-retire-"));
  });

  afterEach(() => {
    clearLocaleOverride();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("migrates legacy supportedClients entries from gemini to agy without duplicates", () => {
    expect(migrateSupportedClients(["claude-code", "gemini"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "gemini", "agy"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "agy", "gemini"])).toEqual(["claude-code", "agy"]);
    expect(migrateSupportedClients(["claude-code", "codex"])).toEqual(["claude-code", "codex"]);
  });

  it("rejects programmatic install/ensure of retired gemini client with bilingual/localized guidance", async () => {
    const legacyGemini = {
      id: "gemini",
      name: "Gemini CLI",
      package: "@google/gemini-cli",
      command: "gemini",
      runtime: "bun" as const,
      getEnvVars: () => ({}),
    };

    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const msg = getGeminiRetiredMessage();
      expect(msg).toContain("Gemini CLI");
      expect(msg).toContain("Antigravity CLI (agy)");
      expect(msg).toContain("tako install agy");
      expect(msg).toContain("tako --agy");

      const installRes = await installClient(legacyGemini);
      expect(installRes.success).toBe(false);
      expect(installRes.error).toContain("tako install agy");

      const readyRes = await ensureClientReady(legacyGemini);
      expect(readyRes.success).toBe(false);
      expect(readyRes.error).toContain("tako --agy");
    }
  });

  it("migrates saved ~/.tako/config.json supportedClients and clientProviderMap cleanly to agy", async () => {
    const takoHome = join(tmp, "tako-home");
    mkdirSync(takoHome, { recursive: true });
    writeFileSync(
      join(takoHome, "config.json"),
      JSON.stringify({
        apiKey: "",
        apiId: "",
        installedClients: {},
        providers: [
          {
            id: "prov-legacy",
            name: "Legacy Custom",
            type: "custom",
            apiKey: "sk-legacy",
            baseUrl: "https://legacy.example/v1",
            supportedClients: ["claude-code", "gemini"],
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "prov-both",
            name: "Both",
            type: "custom",
            apiKey: "sk-both",
            baseUrl: "https://both.example/v1",
            supportedClients: ["claude-code", "grok", "gemini", "agy"],
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        defaultProviderId: "prov-legacy",
        clientProviderMap: {
          gemini: "prov-legacy",
        },
      }),
    );

    const providersModuleUrl = new URL("../src/providers/index.ts", import.meta.url).href;
    const script = `
      const { getProviders, getProvidersForClient, getClientProvider, fixupProviders } = await import(${JSON.stringify(providersModuleUrl)});
      const preProviders = await getProviders();
      const preAgyCompatible = await getProvidersForClient("agy");
      const preGeminiCompatible = await getProvidersForClient("gemini");
      const preBound = await getClientProvider("agy");
      await fixupProviders();
      console.log(JSON.stringify({
        preSupported: preProviders.map((p) => p.supportedClients),
        preAgyIds: preAgyCompatible.map((p) => p.id),
        preGeminiIds: preGeminiCompatible.map((p) => p.id),
        preBoundId: preBound?.id ?? null,
      }));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAKO_HOME: takoHome,
        TAKO_DEV: "1",
      },
    });
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");

    const pre = JSON.parse(stdout);
    expect(pre.preSupported).toEqual([
      ["claude-code", "agy"],
      ["claude-code", "grok", "agy"],
    ]);
    expect(pre.preAgyIds.sort()).toEqual(["prov-both", "prov-legacy"]);
    expect(pre.preGeminiIds).toEqual([]);
    expect(pre.preBoundId).toBe("prov-legacy");

    const persisted = JSON.parse(readFileSync(join(takoHome, "config.json"), "utf-8"));
    expect(persisted.providers[0].supportedClients).toContain("agy");
    expect(persisted.providers[0].supportedClients).not.toContain("gemini");
    expect(persisted.providers[0].supportedClients).toEqual(["claude-code", "grok", "agy"]);
    expect(persisted.providers[1].supportedClients).toEqual(["claude-code", "grok", "agy"]);
    expect(persisted.clientProviderMap).toEqual({ agy: "prov-legacy" });
  });

  it("exits 1 with agy replacement guidance on `tako --gemini` and `tako install gemini` and omits --gemini from --help", async () => {
    const cliEntry = join(import.meta.dir, "..", "src", "index.ts");
    const takoHome = join(tmp, "cli-tako-home");
    mkdirSync(takoHome, { recursive: true });
    const env = {
      ...process.env,
      TAKO_HOME: takoHome,
      TAKO_DEV: "1",
    };

    const helpProc = Bun.spawn([process.execPath, cliEntry, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const helpOut = await new Response(helpProc.stdout).text();
    expect(await helpProc.exited).toBe(0);
    expect(helpOut).toContain("--agy");
    expect(helpOut).not.toContain("--gemini");

    for (const argv of [
      ["--gemini"],
      ["--gemini", "-p", "hello"],
      ["install", "gemini"],
      ["install", "gemini", "latest"],
    ]) {
      const proc = Bun.spawn([process.execPath, cliEntry, ...argv], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const out = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
      expect(await proc.exited).toBe(1);
      expect(out).toContain("Gemini CLI");
      expect(out).toContain("Antigravity CLI (agy)");
      expect(out).toContain("tako install agy");
      expect(out).toContain("tako --agy");
    }
  });
});
