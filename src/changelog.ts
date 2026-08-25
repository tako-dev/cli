/**
 * 更新日志
 *
 * 记录每个版本的变更内容，供主页展示。
 * 新版本请在 CHANGELOG 数组顶部添加条目。
 */

import { loadConfig, updateConfig } from "./config";
import { CURRENT_VERSION } from "./updater";
import { log } from "./logger";
import { pausePrompt } from "./ui/shared/terminal";

export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  changes: string[];
}

/**
 * 更新日志数据 — 最新版本放最前面
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.2.21",
    date: "2026-04-20",
    changes: [
      "客户端更新改为用户确认，不再自动更新",
      "禁止 Claude Code / Codex 自身的自动更新，由 Tako 统一管理",
      "修复已安装用户原生二进制未就位导致 ENOEXEC 的问题",
    ],
  },
  {
    version: "0.2.20",
    date: "2026-04-19",
    changes: [
      "修复 Claude Code v2 原生二进制启动失败的问题",
      "安装时自动运行 postinstall 确保原生二进制就位",
      "新增更新日志功能，可在主页查看版本变更",
    ],
  },
  {
    version: "0.2.18",
    date: "2026-04-15",
    changes: [
      "新增 Gemini CLI 支持",
      "Codex 配置简化，无需手动编辑配置文件",
      "Claude Code settings.json 冲突检测与自动清理",
      "安装流程优化",
    ],
  },
  {
    version: "0.2.14",
    date: "2026-04-10",
    changes: [
      "Codex 启动选项支持（跳过权限、详细日志等）",
      "配置注入机制优化",
    ],
  },
  {
    version: "0.2.12",
    date: "2026-04-06",
    changes: [
      "国内镜像源安装修复",
      "Windows install.ps1 安装脚本修复",
    ],
  },
  {
    version: "0.2.9",
    date: "2026-03-30",
    changes: [
      "statusline 状态栏功能迁移",
      "Codex 配置增量更新，修复启动失败问题",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-03-15",
    changes: [
      "全新 Ink TUI 主菜单",
      "客户端 Tab 切换 + 可折叠启动选项",
      "最近项目快速启动",
      "埋点分析系统",
    ],
  },
];

/**
 * 检查是否有用户未看过的新版本更新
 */
export async function hasUnseenChangelog(): Promise<boolean> {
  const config = await loadConfig();
  const lastSeen = config.lastSeenVersion;
  if (!lastSeen) return true;
  return lastSeen !== CURRENT_VERSION;
}

/**
 * 标记当前版本的更新日志已查看
 */
export async function markChangelogSeen(): Promise<void> {
  await updateConfig({ lastSeenVersion: CURRENT_VERSION });
}

/**
 * 在 banner 下方显示最新版本的简要更新提示
 */
export async function showChangelogHint(): Promise<void> {
  if (!(await hasUnseenChangelog())) return;

  const entry = CHANGELOG.find((e) => e.version === CURRENT_VERSION);
  if (!entry) {
    // 当前版本没有 changelog 条目，静默标记已读
    await markChangelogSeen();
    return;
  }

  log.info(`📋 v${entry.version} 更新内容：`);
  for (const change of entry.changes) {
    log.info(`  • ${change}`);
  }

  await markChangelogSeen();
}

/**
 * 显示完整更新日志（菜单调用）
 */
export async function showFullChangelog(): Promise<void> {
  log.info("📋 更新日志");
  for (const entry of CHANGELOG) {
    const isCurrent = entry.version === CURRENT_VERSION;
    const tag = isCurrent ? `v${entry.version} (当前)` : `v${entry.version}`;
    log.info(`${tag}  ${entry.date}`);
    for (const change of entry.changes) {
      log.info(`  • ${change}`);
    }
  }

  // 等用户按回车返回
  await pausePrompt("返回主菜单");
}
