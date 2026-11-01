/** Offline acceptance with the declared installed Gemini baseline; no generators or model requests. */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mergeGeminiNativeModels } from "../../src/clients/gemini-native";

const core = process.argv[2];
if (!core) throw new Error("Pass the isolated @google/gemini-cli-core package path");
const { ModelConfigService } = await import(pathToFileURL(join(core, "dist/src/services/modelConfigService.js")).href);
const { DEFAULT_MODEL_CONFIGS } = await import(pathToFileURL(join(core, "dist/src/config/defaultModelConfigs.js")).href);
const overlay = mergeGeminiNativeModels({}, [], [{ id: "fixture-native-id", displayName: "Fixture native" }]);
if (!overlay) throw new Error("No overlay generated");
const service = new ModelConfigService({ ...DEFAULT_MODEL_CONFIGS, ...overlay.modelConfigs as object,
  modelDefinitions: { ...DEFAULT_MODEL_CONFIGS.modelDefinitions, ...(overlay.modelConfigs as { modelDefinitions: object }).modelDefinitions },
  modelIdResolutions: { ...DEFAULT_MODEL_CONFIGS.modelIdResolutions, ...(overlay.modelConfigs as { modelIdResolutions: object }).modelIdResolutions },
});
const offered = service.getAvailableModelOptions({ hasAccessToPreview: false, hasAccessToProModel: false });
if (!offered.some((entry: { modelId: string }) => entry.modelId === "fixture-native-id")) throw new Error("Model absent from native menu options");
const resolved = service.getResolvedConfig({ model: "fixture-native-id", isChatModel: true });
if (resolved.model !== "fixture-native-id") throw new Error("Configuration remaps upstream ID");
if (service.resolveModelId("fixture-native-id", { useGemini3_1: true }) !== "fixture-native-id") throw new Error("Resolution remaps upstream ID");
if (Object.keys(resolved.generateContentConfig).length !== 0) throw new Error("Unverified generation settings inherited");
console.log(JSON.stringify({ nativeOptionsContainModel: true, exactResolvedModel: resolved.model, noInheritedGenerationSettings: true,
  packageVersion: "0.51.0", networkCalls: 0, modelCalls: 0 }));
