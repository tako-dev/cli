import { join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { claudeCodeClient } from "../../src/clients/claude-code";
import { codexClient } from "../../src/clients/codex";
import { parse } from "smol-toml";
import type { ProviderContext } from "../../src/providers/types";

const home = process.env.HOME!;
const tako = process.env.TAKO_HOME!;
const provider: ProviderContext = { type: "custom", baseUrl: "https://fixture.example.test", apiKey: "fixture-menu-key" };
for (const [id, pkg, version] of [["claude-code", "@anthropic-ai/claude-code", "2.1.316"], ["codex", "@openai/codex", "0.166.0"]]) {
  const directory = join(tako, "tools", id!, "node_modules", pkg!);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ version }));
}
const fingerprint = createHash("sha256").update(provider.apiKey!).digest("hex");
await writeFile(join(tako, "tako-models-cache.json"), JSON.stringify({ version: 2, buckets: {
  [`${provider.baseUrl}#claude#${fingerprint}`]: { fetchedAt: Date.now(), entries: [
    { id: "fixture-model", displayName: "Fixture model", contextWindow: 200000, category: "chat", description: "Fixture only" },
  ] },
} }));
await mkdir(join(home, ".claude"), { recursive: true });
await mkdir(join(home, ".codex"), { recursive: true });
const claudeUser = JSON.stringify({ model: "personal-model", permissions: { allow: ["Read"] } });
await writeFile(join(home, ".claude", "settings.json"), claudeUser);
await writeFile(join(home, ".codex", "config.toml"), 'model = "personal-model"\n[features]\napi_key_model_discovery = true\n');
const claude = await claudeCodeClient.setupConfigFiles!(provider, [], { forLaunch: true, launchEnvVars: {} });
if (!claude?.cleanupFiles?.[0]) throw new Error("Missing Claude overlay");
const overlay = JSON.parse(await readFile(claude.cleanupFiles[0], "utf8"));
const codex = await codexClient.setupConfigFiles!(provider, [], { forLaunch: true, launchArgs: [] });
const codexConfig = parse(await readFile(join(home, ".codex", "config.toml"), "utf8"));
const profile = await codexClient.setupConfigFiles!(provider, [], { forLaunch: true, launchArgs: ["--profile", "mine"] });
const result = {
  claudeModelPicker: overlay.modelPicker,
  claudeUserUnchanged: await readFile(join(home, ".claude", "settings.json"), "utf8") === claudeUser,
  codexArgs: codex?.args,
  codexCatalogNotPersisted: !codexConfig.model_providers?.tako?.model_catalog_url,
  codexModelPreserved: codexConfig.model === "personal-model",
  profileOverrideAbsent: !profile?.args,
};
await Promise.all(claude.cleanupFiles.map((path) => rm(path)));
console.log(JSON.stringify(result));
