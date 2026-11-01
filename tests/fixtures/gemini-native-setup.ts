import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { geminiClient } from "../../src/clients/gemini";
import { _resetTakoCatalog } from "../../src/models/tako";
import type { ProviderContext } from "../../src/providers/types";

const home = process.env.HOME!;
const tako = process.env.TAKO_HOME!;
const pkg = join(tako, "tools/gemini/node_modules/@google/gemini-cli");
await mkdir(pkg, { recursive: true });
await mkdir(join(home, ".gemini"), { recursive: true });
const provider: ProviderContext = { type: "custom", baseUrl: "https://fixture.example.test", apiKey: "fixture-a" };
const user = join(home, ".gemini/settings.json");
const workspace = await mkdtemp(join(home, "workspace-"));
const defaults = join(workspace, "defaults.json"), system = join(workspace, "system.json");
process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = "defaults.json";
process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = "system.json";
// The launcher may target another project without changing its own cwd.
process.chdir(home);
await mkdir(join(workspace, ".gemini"));
const workspaceSettings = join(workspace, ".gemini/settings.json");
await writeFile(defaults, JSON.stringify({ ui: { theme: "existing" }, modelConfigs: { modelDefinitions: { existing: { isVisible: false } } } }));
await writeFile(system, "{}");
const userText = JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } }, model: { name: "personal" },
  modelConfigs: { customAliases: { "user-owned": { modelConfig: { model: "mine" } } } } });
await writeFile(user, userText);
await writeFile(workspaceSettings, "{}");
const cache = join(tako, "tako-models-cache.json");
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
async function seed(age = 0) {
  _resetTakoCatalog();
  await writeFile(cache, JSON.stringify({ version: 2, buckets: {
    [`${provider.baseUrl}#gemini#${fingerprint("fixture-a")}`]: { fetchedAt: Date.now() - age, entries: [
      ...["model-a", "user-owned", "existing", "auto"].map(id => ({ id, displayName: id, category: "chat" })),
    ] },
    [`${provider.baseUrl}#gemini#${fingerprint("fixture-b")}`]: { fetchedAt: Date.now(), entries: [
      { id: "model-b", displayName: "Model B", category: "chat" },
    ] },
  } }));
}
const context = { forLaunch: true, workingDir: workspace, launchEnvVars: {
  GOOGLE_GEMINI_BASE_URL: provider.baseUrl!, GEMINI_API_KEY: "fixture-a",
} };
async function launch() {
  const setup = await geminiClient.setupConfigFiles!(provider, [], context);
  const file = setup?.cleanupFiles?.[0];
  const overlay = file ? JSON.parse(await readFile(file, "utf8")) : null;
  if (file) await rm(file);
  return { setup: Boolean(file), overlay };
}
await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "0.66.0" }));
await seed();
const first = await launch();
const explicitDefaults = await geminiClient.setupConfigFiles!(provider, [], {
  ...context, launchEnvVars: { ...context.launchEnvVars, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults },
});
context.launchEnvVars.GEMINI_API_KEY = "fixture-b";
const second = await launch();
context.launchEnvVars.GEMINI_API_KEY = "fixture-a";
await writeFile(workspaceSettings, JSON.stringify({ experimental: { dynamicModelConfiguration: false } }));
const disabled = await launch();
await writeFile(workspaceSettings, "{}");
await seed(3_600_001);
const stale = await launch();
await seed();
await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "0.50.0" }));
const old = await launch();
await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "0.66.0" }));
await writeFile(defaults, "{ // valid JSONC, not safe for this writer\n}");
const jsoncDefaults = await launch();
await writeFile(user, "{ malformed");
const malformed = await launch();
const malformedPreserved = await readFile(user, "utf8") === "{ malformed";
await writeFile(user, userText);
console.log(JSON.stringify({
  first, second, explicitDefaultsSkipped: !explicitDefaults?.cleanupFiles, disabled: disabled.setup, stale: stale.setup, old: old.setup,
  jsoncDefaults: jsoncDefaults.setup, malformed: malformed.setup, malformedPreserved,
  userUnchanged: await readFile(user, "utf8") === userText,
  systemUnchanged: await readFile(system, "utf8") === "{}",
}));
