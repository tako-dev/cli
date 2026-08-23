import { ClientConfig, registerClient } from "./base";
import type { ProviderContext } from "../providers/types";
import { setupPiConfigFiles, takoPiEnv } from "./pi-settings";

/**
 * Browser UI for the same local Pi agent data (~/.pi/agent).
 * Sessions, tako-pi plugins, and models are shared with the terminal client.
 */
export const piWebClient: ClientConfig = {
  id: "pi-web",
  name: "Pi Web",
  package: "@agegr/pi-web",
  command: "pi-web",
  runtime: "node",
  brandColor: "magenta",
  hidden: true,

  getEnvVars(provider: ProviderContext) {
    return takoPiEnv(provider);
  },

  async setupConfigFiles(provider, selectedOptionIds, context) {
    const result = await setupPiConfigFiles(provider, selectedOptionIds, context);
    // pi-web has its own CLI flags; do not forward `pi --provider/--model`.
    void result;
  },

  launchOptions: [
    {
      id: "no-open",
      label: { en: "Don't open browser", zh: "不自动打开浏览器" },
      shortLabel: "No Open",
      description: {
        en: "Start the server without opening a browser tab",
        zh: "只起服务，不自动开浏览器",
      },
      flag: "--no-open",
      args: ["--no-open"],
    },
  ],
};

registerClient(piWebClient);
