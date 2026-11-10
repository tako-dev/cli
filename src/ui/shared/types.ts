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
      /** 从原生会话恢复：launchClientUnified 会补危险跳过 flag 和上下文窗口 env。 */
      resume?: boolean;
      /** 被恢复会话的模型 id。 */
      resumeModelId?: string;
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
