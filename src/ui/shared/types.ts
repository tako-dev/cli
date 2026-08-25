import type { ClientConfig, LaunchOption } from "../../clients";
import type { Provider } from "../../providers/types";

export interface ProjectItem {
  label: string;
  hint: string;
  path?: string;
}

export interface LauncherClientData {
  client: ClientConfig;
  projects: ProjectItem[];
  providers: Provider[];
  activeProvider?: Provider;
  activeProvIdx: number;
  launchOptions: LaunchOption[];
  lastSelectedOptionIds: string[];
}

export type LauncherResult =
  | {
      type: "launch";
      clientId: string;
      projectPath?: string;
      args: string[];
      envVars: Record<string, string>;
      selectedOptionIds: string[];
    }
  | { type: "agent" }
  | { type: "stats" }
  | { type: "config" }
  | { type: "language" }
  | { type: "providers" }
  | { type: "provider-login"; tool: "claude" | "codex" }
  | { type: "exit" };

export type OptionRow =
  | { kind: "flag"; opt: LaunchOption }
  | { kind: "group"; group: string; title: string }
  | { kind: "provider"; title: string };

export interface LauncherLoadResult {
  clients: LauncherClientData[];
  defaultIdx: number;
  hasProviders: boolean;
  pickCounts: Record<string, number>;
  zh: boolean;
}
