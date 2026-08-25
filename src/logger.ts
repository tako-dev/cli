/**
 * Tako Logger — 统一日志抽象
 *
 * 默认用 console 输出。TUI 运行时可通过 setLogHandler 替换为
 * 消息回调，由界面统一渲染，避免 console.log 打断 TUI。
 */

export interface SpinHandle {
  stop(msg?: string): void;
  update(msg: string): void;
}

export interface LogHandler {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  /** 开始进度，返回 stop/update 句柄 */
  spin(msg: string): SpinHandle;
}

function consoleSpin(msg: string): SpinHandle {
  const isTTY = !!process.stderr.isTTY;
  const write = (s: string) => process.stderr.write(s);
  let last = msg;
  if (isTTY) write(`⏳ ${msg}`);
  else write(`⏳ ${msg}\n`);
  return {
    update(m: string) {
      if (m === last) return;
      last = m;
      if (isTTY) write(`\r\x1b[2K⏳ ${m}`);
      else write(`⏳ ${m}\n`);
    },
    stop(m?: string) {
      if (isTTY) write("\r\x1b[2K");
      if (m) write(`✓ ${m}\n`);
    },
  };
}

const consoleHandler: LogHandler = {
  info: (msg) => console.log(`ℹ ${msg}`),
  warn: (msg) => console.log(`⚠ ${msg}`),
  error: (msg) => console.error(`✗ ${msg}`),
  success: (msg) => console.log(`✓ ${msg}`),
  spin: consoleSpin,
};

let handler: LogHandler = consoleHandler;

/** TUI 调用此函数替换日志处理器 */
export function setLogHandler(h: LogHandler): void {
  handler = h;
}

/** 恢复为 console 输出 */
export function resetLogHandler(): void {
  handler = consoleHandler;
}

export const log = {
  info: (msg: string) => handler.info(msg),
  warn: (msg: string) => handler.warn(msg),
  error: (msg: string) => handler.error(msg),
  success: (msg: string) => handler.success(msg),
  message: (msg: string) => handler.info(msg),
  debug: (msg: string) => {
    if (process.env.TAKO_DEV) process.stderr.write(`[debug] ${msg}\n`);
  },
};

export function spinner() {
  return {
    start(msg: string): SpinHandle { return handler.spin(msg); },
  };
}

/** 创建带 start/stop/update 的 spinner（兼容旧 API） */
export function createSpinner() {
  let h: SpinHandle | null = null;
  return {
    start(msg: string) { h = handler.spin(msg); },
    stop(msg?: string) { h?.stop(msg); h = null; },
    update(msg: string) { h?.update(msg); },
  };
}
