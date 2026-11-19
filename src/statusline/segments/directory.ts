import { homedir } from "os";
import type { Segment, StatusLineInput } from "../types";
import { theme, style, getIcon } from "../colors";

/**
 * 目录 Segment：显示当前工作目录
 *
 * 显示格式：~/path/to/dir 或 /path/to/dir
 * 如果路径在用户 home 目录下，用 ~ 替换
 */
export class DirectorySegment implements Segment {
  id = "directory";

  render(input: StatusLineInput): string | null {
    const rawDir = input.workspace?.current_dir || input.cwd;
    if (!rawDir) return null;
    const dir = this.formatPath(rawDir);
    const icon = getIcon("directory");

    return `${theme.directory.icon}${icon}${style.reset} ${theme.directory.text}${dir}${style.reset}`;
  }

  /**
   * 格式化路径，用 ~ 替换 home 目录
   */
  private formatPath(path: string): string {
    const home = homedir();

    if (path === home) {
      return "~";
    }

    if (path.startsWith(home + "/")) {
      return "~" + path.slice(home.length);
    }

    return path;
  }
}
