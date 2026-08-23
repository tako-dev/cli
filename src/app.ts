// 导入客户端（自动注册）
import "./clients";

// 导入模块
import { checkAndUpdate, runUpdateCommand } from "./updater";
import { getClient } from "./clients/base";
import { launchClientUnified } from "./launcher";
import { t } from "./i18n";
import { track, identify, shutdown } from "./analytics";
import { statusLineCommand, injectStatusLineConfig } from "./statusline";
import { selectProviderForClient } from "./ui/providers";
import { buildPassthroughArgs } from "./quick-launch-args";
import { loadCatalog, refreshCatalog } from "./models";
import { listAvailableVersions, installAtVersion, getInstalledVersion } from "./installer-versions";
import { IS_DEV } from "./config";

const VERSION = process.env.VERSION || "dev";
const STARTUP_AUTO_UPDATE_ENABLED = true;

type UiMain = () => Promise<void>;

export function shouldRunStartupUpdate(isDev: boolean): boolean {
  return STARTUP_AUTO_UPDATE_ENABLED && !isDev;
}

function showHelp() {
  console.log(`
${t("cli.version", { version: VERSION })}

${t("cli.usage")}

${t("cli.options")}
${t("cli.optionVersion")}
${t("cli.optionHelp")}

${t("cli.shortcuts")}
${t("cli.shortcutClaude")}
${t("cli.shortcutCodex")}
${t("cli.shortcutPi")}
${t("cli.shortcutPiWeb")}
${t("cli.shortcutGemini")}

Commands:
  tako update                Update Tako CLI to the latest version
  tako install <client>     Install AI coding tool
  tako quota                Print Tako quota as JSON
  tako agent [--model X]    Start agent mode
  tako sessions [search]    Search and resume native sessions
  tako skill list           List available skills
  tako skill install <name> Install skill to current project
  tako models [--refresh]   List models exposed by Tako providers

${t("cli.examples")}
${t("cli.exampleInteractive")}
${t("cli.exampleClaude")}
${t("cli.exampleClaudeModel")}
${t("cli.exampleCodex")}
${t("cli.examplePi")}
${t("cli.examplePiWeb")}
${t("cli.exampleGemini")}
`);
}

/**
 * tako install <client> [version]
 *  - 仅 client：列出该 client 对应 npm 包的所有版本（标记当前安装版本）
 *  - client+version：安装指定版本到 TOOLS_DIR/<client>
 */
async function runInstallCommand(rest: string[]): Promise<void> {
  const [clientId, version] = rest;
  if (!clientId) {
    console.error("用法: tako install <client> [version]");
    console.error("  tako install claude-code              # 列出所有可用版本");
    console.error("  tako install claude-code 1.0.5        # 安装指定版本");
    process.exit(1);
  }
  const client = getClient(clientId);
  if (!client) {
    console.error(`未知 client: ${clientId}`);
    process.exit(1);
  }

  if (!version) {
    try {
      const versions = await listAvailableVersions(client.package);
      const current = await getInstalledVersion(client);
      const top = versions.slice(0, 30);
      console.log(`${client.name} (${client.package}) 最近 ${top.length} 个版本：`);
      for (const v of top) {
        const marker = v.version === current ? " ← 当前" : "";
        const publishedAt = v.publishedAt ? `  ${v.publishedAt.slice(0, 10)}` : "";
        console.log(`  ${v.version}${publishedAt}${marker}`);
      }
      console.log(`\n安装：tako install ${clientId} <version>`);
    } catch (e) {
      console.error("获取版本列表失败:", (e as Error).message);
      process.exit(1);
    }
    return;
  }

  console.log(`正在安装 ${client.package}@${version} 到 ${client.id}...`);
  try {
    await installAtVersion(client, version);
    console.log(`✓ ${client.name} 已切换到 ${version}`);
  } catch (e) {
    console.error("安装失败:", (e as Error).message);
    process.exit(1);
  }
}

/**
 * 快捷启动（--claude, --codex, --pi, --pi-web, --gemini）
 * 自动选 Provider，不弹交互式菜单
 */
async function quickLaunch(
  clientId: string,
  clientName: string,
  passthroughArgs: string[],
): Promise<void> {
  const client = getClient(clientId);
  if (!client) {
    console.error(t("cli.clientNotFound", { client: clientName }));
    process.exit(1);
  }

  const providerContext = await selectProviderForClient(clientId);
  if (!providerContext) {
    console.error("未配置可用的服务商");
    process.exit(1);
  }

  const result = await launchClientUnified(client, {
    providerContext,
    args: passthroughArgs,
    handoffOnWindows: true,
  });
  if (!result.success) {
    console.error(result.error);
    process.exit(1);
  }

  // Windows quick-launch writes a handoff script for the outer wrapper to run.
  // Exit explicitly so background analytics/stdin handles cannot keep Bun alive
  // and block the wrapper from starting Claude Code.
  process.exit(result.exitCode ?? 0);
}

export async function runCli(main: UiMain): Promise<void> {
  const args = process.argv.slice(2);

  // statusline 命令（被 Claude Code 调用，需要快速响应）
  if (args[0] === "statusline") {
    loadCatalog(); // 同步加载模型目录（统计窗口大小用）
    await statusLineCommand();
    return;
  }

  // install 命令：tako install <client> [version]
  // - 不带 version：列出 npm registry 上的所有版本
  // - 带 version：安装该版本到 TOOLS_DIR/<client>
  if (args[0] === "install") {
    await runInstallCommand(args.slice(1));
    return;
  }

  // quota 命令：tako quota
  // 脚本接口，stdout 固定输出 JSON；失败时 runQuotaCommand 返回非 0 code。
  if (args[0] === "quota") {
    const { runQuotaCommand } = await import("./quota/command");
    const code = await runQuotaCommand(args.slice(1));
    if (code !== 0) process.exit(code);
    return;
  }

  // update 命令：tako update
  if (args[0] === "update") {
    await runUpdateCommand();
    return;
  }

  // agent 命令：tako agent <subcmd> [...]
  if (args[0] === "agent") {
    loadCatalog();
    const { runAgentCommand } = await import("./agent/cmd");
    await runAgentCommand(args.slice(1));
    return;
  }

  if (args[0] === "sessions") {
    const { runSessionsCommand } = await import("./sessions/cmd");
    await runSessionsCommand(args.slice(1));
    return;
  }

  // skill 命令：tako skill list | tako skill install <name|--all>
  if (args[0] === "skill") {
    const { runSkillCommand } = await import("./skills/command");
    await runSkillCommand(args.slice(1));
    return;
  }

  // models 命令：tako models [list] [--refresh] [--json]
  if (args[0] === "models") {
    const { runModelsCommand } = await import("./models/command");
    const code = await runModelsCommand(args.slice(1));
    if (code !== 0) process.exit(code);
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    console.log(`Tako CLI v${VERSION}`);
    return;
  }

  if (args.includes("-h") || args.includes("--help")) {
    showHelp();
    return;
  }

  // dev 模式不自动更新：源码直跑（VERSION=dev）/ 显式 TAKO_DEV / localhost server
  const isDev = VERSION === "dev" || IS_DEV;

  // 初始化埋点
  identify();
  track("cli_started");

  // 快捷启动命令
  if (args.includes("--claude")) {
    if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();
    await quickLaunch("claude-code", "Claude Code", await buildPassthroughArgs("claude-code", args, "--claude"));
    return;
  }
  if (args.includes("--codex")) {
    if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();
    await quickLaunch("codex", "Codex", await buildPassthroughArgs("codex", args, "--codex"));
    return;
  }
  if (args.includes("--gemini")) {
    if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();
    await quickLaunch("gemini", "Gemini CLI", await buildPassthroughArgs("gemini", args, "--gemini"));
    return;
  }
  if (args.includes("--pi")) {
    if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();
    await quickLaunch("pi", "Pi", await buildPassthroughArgs("pi", args, "--pi"));
    return;
  }
  if (args.includes("--pi-web")) {
    if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();
    await quickLaunch("pi-web", "Pi Web", await buildPassthroughArgs("pi-web", args, "--pi-web"));
    return;
  }

  // 检查自动更新
  if (shouldRunStartupUpdate(isDev)) await checkAndUpdate();

  // 注入 statusline 配置到 Claude Code
  injectStatusLineConfig().catch(() => {});

  // 模型目录：先同步加载本地缓存，再后台刷新最新（不阻塞主程序）
  loadCatalog();
  refreshCatalog().catch(() => {});

  // 交互式 TUI 需要 TTY（stdin raw mode）。pipe / 非终端环境无法运行。
  if (!process.stdin.isTTY) {
    console.log("Tako CLI v" + VERSION);
    console.log("\n安装成功！请在终端中直接运行 tako 启动交互界面。");
    console.log("  tako          — 交互式启动器");
    console.log("  tako --help   — 查看所有命令");
    return;
  }

  await main();
}

export async function runCliWithHandlers(main: UiMain): Promise<void> {
  process.on("beforeExit", async () => { await shutdown(); });
  process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
  process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });

  try {
    await runCli(main);
  } catch (error) {
    console.error(t("cli.cliError"), error);
    await shutdown();
    process.exit(1);
  }
}
