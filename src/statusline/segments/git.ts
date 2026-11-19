import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon, icons } from "../colors";

/**
 * Git Segment：显示分支名和状态
 */
export class GitSegment implements Segment {
  id = "git";

  async render(input: StatusLineInput): Promise<string | null> {
    const cwd = input.workspace?.current_dir || input.cwd;
    if (!cwd) return null;

    // 检查是否是 git 仓库
    const isGitRepo = await this.isGitRepository(cwd);
    if (!isGitRepo) return null;

    // 获取分支名
    const branch = await this.getBranch(cwd);
    if (!branch) return null;

    // 获取状态
    const { status, statusColor } = await this.getStatus(cwd);

    // 获取 ahead/behind
    const { ahead, behind } = await this.getAheadBehind(cwd);

    // 构建状态字符串
    const icon = getIcon("git");
    let result = `${theme.git.icon}${icon}${style.reset} ${theme.git.text}${branch}${style.reset}`;

    // 添加状态指示符
    result += ` ${statusColor}${status}${style.reset}`;

    // 添加 ahead/behind
    if (ahead > 0) result += ` ${theme.git.clean}${icons.gitAhead}${ahead}${style.reset}`;
    if (behind > 0) result += ` ${theme.git.dirty}${icons.gitBehind}${behind}${style.reset}`;

    return result;
  }

  private async isGitRepository(cwd: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private async getBranch(cwd: string): Promise<string | null> {
    try {
      const proc = Bun.spawn(["git", "branch", "--show-current"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0 && output.trim()) {
        return output.trim();
      }

      // 尝试备用方法（detached HEAD 等情况）
      const proc2 = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output2 = await new Response(proc2.stdout).text();
      const exitCode2 = await proc2.exited;

      if (exitCode2 === 0 && output2.trim()) {
        return `detached:${output2.trim()}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async getStatus(cwd: string): Promise<{ status: string; statusColor: string }> {
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return { status: icons.gitClean, statusColor: theme.git.clean };
      }

      const trimmed = output.trim();
      if (!trimmed) {
        return { status: icons.gitClean, statusColor: theme.git.clean };
      }

      // 检查是否有冲突
      if (trimmed.includes("UU") || trimmed.includes("AA") || trimmed.includes("DD")) {
        return { status: icons.gitConflict, statusColor: theme.git.conflict };
      }

      return { status: icons.gitDirty, statusColor: theme.git.dirty };
    } catch {
      return { status: icons.gitClean, statusColor: theme.git.clean };
    }
  }

  private async getAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
    try {
      // Ahead
      const procAhead = Bun.spawn(["git", "rev-list", "--count", "@{u}..HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const aheadOutput = await new Response(procAhead.stdout).text();
      const aheadCode = await procAhead.exited;
      const ahead = aheadCode === 0 ? parseInt(aheadOutput.trim(), 10) || 0 : 0;

      // Behind
      const procBehind = Bun.spawn(["git", "rev-list", "--count", "HEAD..@{u}"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const behindOutput = await new Response(procBehind.stdout).text();
      const behindCode = await procBehind.exited;
      const behind = behindCode === 0 ? parseInt(behindOutput.trim(), 10) || 0 : 0;

      return { ahead, behind };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }
}
