import { homedir } from "os";
import { loadConfig, saveConfig, type ProjectRecord } from "./config";

/** 最多存储的项目数量 */
const MAX_PROJECTS = 50;

/** 每个客户端显示的最近项目数 */
export const DISPLAY_PER_CLIENT = 3;

/**
 * 检查目录是否存在
 */
export async function isValidDirectory(path: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 记录项目启动
 * @param selectedOptionIds 本次启动勾选的 launchOption id 列表，会写入 clientUsage
 *                          供下次启动时恢复默认勾选状态
 */
export async function recordProjectLaunch(
  projectPath: string,
  clientId: string,
  selectedOptionIds?: string[]
): Promise<void> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];
  const now = new Date().toISOString();

  // 查找是否已存在该项目
  const existingIndex = projects.findIndex((p) => p.path === projectPath);

  if (existingIndex >= 0) {
    const existing = projects[existingIndex];
    const clientUsage = existing.clientUsage || {};
    const currentUsage = clientUsage[clientId] || { count: 0, lastAt: now };

    // 更新现有记录
    projects[existingIndex] = {
      ...existing,
      launchCount: existing.launchCount + 1,
      lastLaunchedAt: now,
      lastClientId: clientId,
      clientUsage: {
        ...clientUsage,
        [clientId]: {
          count: currentUsage.count + 1,
          lastAt: now,
          lastSelectedOptionIds: selectedOptionIds ?? currentUsage.lastSelectedOptionIds,
        },
      },
    };
  } else {
    // 添加新记录
    projects.push({
      path: projectPath,
      launchCount: 1,
      lastLaunchedAt: now,
      lastClientId: clientId,
      clientUsage: {
        [clientId]: {
          count: 1,
          lastAt: now,
          lastSelectedOptionIds: selectedOptionIds,
        },
      },
    });
  }

  // 按最后启动时间排序并限制数量
  const sortedProjects = projects
    .sort((a, b) => new Date(b.lastLaunchedAt).getTime() - new Date(a.lastLaunchedAt).getTime())
    .slice(0, MAX_PROJECTS);

  config.recentProjects = sortedProjects;
  await saveConfig(config);
}

/**
 * 获取当前目录下某客户端最近一次启动时勾选的 launchOption id 列表
 * 优先级：当前目录记录 → 该客户端其他项目中最近的一次 → []
 */
export async function getLastSelectedOptionsForClient(
  clientId: string
): Promise<string[]> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];
  const cwd = process.cwd();

  const cwdProject = projects.find((p) => p.path === cwd);
  const cwdIds = cwdProject?.clientUsage?.[clientId]?.lastSelectedOptionIds;
  if (cwdIds) return cwdIds;

  // 回退：该客户端其他项目中最近一次的选择
  const others = projects
    .filter((p) => p.path !== cwd && p.clientUsage?.[clientId]?.lastSelectedOptionIds)
    .sort((a, b) => {
      const at = new Date(a.clientUsage![clientId].lastAt).getTime();
      const bt = new Date(b.clientUsage![clientId].lastAt).getTime();
      return bt - at;
    });

  return others[0]?.clientUsage?.[clientId]?.lastSelectedOptionIds ?? [];
}

/**
 * 获取项目在某客户端下的最后使用时间
 */
function getClientLastUsedTime(
  project: ProjectRecord,
  clientId: string
): number {
  const usage = project.clientUsage?.[clientId];

  // 如果有 clientUsage，使用它的时间
  if (usage) {
    return new Date(usage.lastAt).getTime();
  }

  // 兼容旧数据：如果 lastClientId 匹配，使用项目的最后启动时间
  if (project.lastClientId === clientId) {
    return new Date(project.lastLaunchedAt).getTime();
  }

  return 0;
}

/**
 * 获取某个客户端的最近项目列表
 * 按综合评分排序，过滤无效目录，排除当前目录
 */
export async function getRecentProjectsForClient(
  clientId: string,
  limit: number = DISPLAY_PER_CLIENT,
  excludeCwd: boolean = true
): Promise<ProjectRecord[]> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];
  const cwd = process.cwd();

  // 筛选该客户端使用过的项目（排除当前目录）
  const clientProjects = projects.filter((p) => {
    if (excludeCwd && p.path === cwd) return false;
    // 有 clientUsage 记录，或者兼容旧数据的 lastClientId
    return p.clientUsage?.[clientId] || p.lastClientId === clientId;
  });

  // 按该客户端的最后使用时间排序
  const sorted = clientProjects
    .map((p) => ({ ...p, lastUsedTime: getClientLastUsedTime(p, clientId) }))
    .sort((a, b) => b.lastUsedTime - a.lastUsedTime);

  // 过滤无效目录并限制数量
  const validProjects: ProjectRecord[] = [];
  for (const { lastUsedTime, ...project } of sorted) {
    if (validProjects.length >= limit) break;
    if (await isValidDirectory(project.path)) {
      validProjects.push(project);
    }
  }

  return validProjects;
}

/**
 * 获取当前目录最后使用的客户端 ID
 */
export async function getLastClientForCwd(): Promise<string | null> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];
  const cwd = process.cwd();

  const project = projects.find((p) => p.path === cwd);
  return project?.lastClientId || null;
}

/**
 * 获取所有最近项目（不分客户端）
 */
export async function getAllRecentProjects(
  limit: number = 10
): Promise<ProjectRecord[]> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];

  // 按最后启动时间排序
  const sorted = [...projects].sort(
    (a, b) => new Date(b.lastLaunchedAt).getTime() - new Date(a.lastLaunchedAt).getTime()
  );

  const validProjects: ProjectRecord[] = [];
  for (const project of sorted) {
    if (validProjects.length >= limit) break;
    if (await isValidDirectory(project.path)) {
      validProjects.push(project);
    }
  }

  return validProjects;
}

/**
 * 移除项目记录
 */
export async function removeProject(projectPath: string): Promise<void> {
  const config = await loadConfig();
  const projects = config.recentProjects || [];

  config.recentProjects = projects.filter((p) => p.path !== projectPath);
  await saveConfig(config);
}

/**
 * 格式化路径显示
 * 将 home 目录替换为 ~，长路径截断
 */
export function formatProjectPath(
  fullPath: string,
  maxLength: number = 25
): string {
  const home = homedir();

  // 替换 home 目录为 ~，并把 Windows 反斜杠收成显示用的 /
  let displayPath = fullPath.startsWith(home)
    ? "~" + fullPath.slice(home.length)
    : fullPath;
  displayPath = displayPath.replaceAll("\\", "/");

  // 如果太长，只保留项目名
  if (displayPath.length > maxLength) {
    const parts = displayPath.split("/");
    const projectName = parts.pop() || "";

    // 项目名本身就很长，直接截断
    if (projectName.length > maxLength - 4) {
      displayPath = "..." + projectName.slice(-maxLength + 3);
    } else {
      displayPath = `.../${projectName}`;
    }
  }

  return displayPath;
}

/**
 * 格式化最后使用时间
 * 返回友好的相对时间描述
 */
export function formatLastUsed(isoTime: string): string {
  const { t } = require("./i18n");

  const now = Date.now();
  const then = new Date(isoTime).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.daysAgo", { n: days });
  if (days < 30) return t("time.weeksAgo", { n: weeks });
  return t("time.monthsAgo", { n: months });
}
