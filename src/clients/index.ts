// 导入所有客户端（顺序 = tab 顺序：Codex / Claude / Pi / Gemini）
import "./codex";
import "./claude-code";
import "./pi";
import "./pi-web"; // hidden: launched from Pi's Web UI option
import "./gemini";

// 导出基础模块
export * from "./base";
