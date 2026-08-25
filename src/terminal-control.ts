type StdinLike = {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  removeAllListeners?: () => unknown;
  pause?: () => unknown;
};

type StdoutLike = {
  isTTY?: boolean;
  write?: (chunk: string) => unknown;
};

const TERMINAL_MODE_RESET =
  "\x1b[?1000l" +
  "\x1b[?1002l" +
  "\x1b[?1003l" +
  "\x1b[?1005l" +
  "\x1b[?1006l" +
  "\x1b[?1015l" +
  "\x1b[?1049l" +
  "\x1b[?2004l" +
  "\x1b[0m" +
  "\x1b[?25h";

export function releaseStdinForExternalChild(stdin: StdinLike = process.stdin): void {
  try {
    stdin.removeAllListeners?.();
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause?.();
  } catch {
    // Best-effort cleanup before handing the terminal to another process.
  }
}

export function resetTerminalModes(stdout: StdoutLike = process.stdout): void {
  if (!stdout.isTTY || typeof stdout.write !== "function") return;
  try {
    stdout.write(TERMINAL_MODE_RESET);
  } catch {
    // Best-effort cleanup; failing to reset modes should not block launch.
  }
}

export async function settleTerminalForExternalChild(options: {
  stdin?: StdinLike;
  stdout?: StdoutLike;
  delayMs?: number;
} = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const delayMs = options.delayMs ?? 30;

  releaseStdinForExternalChild(stdin);
  resetTerminalModes(stdout);

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

  // Some prompt/TUI libraries re-arm stdin during cleanup. Run the release
  // twice so the following child gets an uncontested console.
  releaseStdinForExternalChild(stdin);
  resetTerminalModes(stdout);
}
