export interface AnnouncementPayload {
  id: string;
  title: string;
  content: string;
  type?: string;
  popup_once?: boolean;
}

type KeyDecision<T> = T | undefined;

type PromptStdinLike = {
  isTTY?: boolean;
  isRaw?: boolean;
  ref?: () => unknown;
  removeAllListeners?: () => unknown;
  setRawMode?: (enabled: boolean) => void;
  pause?: () => unknown;
};

function restoreRawMode(previousRaw: boolean) {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
  } catch {
    // ignore
  }
}

export async function settleStdinForTerminalPrompt(
  stdin: PromptStdinLike = process.stdin,
  delayMs = 30,
): Promise<void> {
  const release = () => {
    try {
      stdin.ref?.();
      stdin.removeAllListeners?.();
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
      stdin.pause?.();
    } catch {
      // Best-effort cleanup before a prompt reads directly from stdin.
    }
  };

  release();
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  release();
}

async function readTerminalKey<T>(
  onChunk: (chunk: string) => KeyDecision<T>,
  fallback: T,
): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;

  const previousRaw = Boolean((process.stdin as { isRaw?: boolean }).isRaw);
  await settleStdinForTerminalPrompt();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off("data", onData);
      restoreRawMode(previousRaw);
    };

    const onData = (buffer: Buffer) => {
      const chunk = buffer.toString("utf8");

      if (chunk === "\u0003") {
        cleanup();
        process.kill(process.pid, "SIGINT");
        resolve(fallback);
        return;
      }

      const decision = onChunk(chunk);
      if (decision !== undefined) {
        cleanup();
        resolve(decision);
      }
    };

    process.stdin.on("data", onData);
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  });
}

export async function confirmPrompt(options: {
  message: string;
  defaultValue?: boolean;
}): Promise<boolean> {
  const defaultValue = options.defaultValue ?? true;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";

  process.stdout.write(`\n? ${options.message} ${suffix} `);

  const result = await readTerminalKey<boolean>((chunk) => {
    if (chunk === "\r" || chunk === "\n") return defaultValue;
    if (chunk === "\u001b") return false;
    if (chunk === "y" || chunk === "Y") return true;
    if (chunk === "n" || chunk === "N") return false;
    return undefined;
  }, defaultValue);

  process.stdout.write(result ? "Yes\n" : "No\n");
  return result;
}

export async function pausePrompt(message: string): Promise<void> {
  process.stdout.write(`\n${message}\n`);
  process.stdout.write("Press Enter to continue...");

  await readTerminalKey<boolean>((chunk) => {
    if (chunk === "\r" || chunk === "\n") return true;
    if (chunk === "\u001b" || chunk === "q" || chunk === "Q") return true;
    return undefined;
  }, true);

  process.stdout.write("\n");
}

export async function showAnnouncementPrompt(ann: AnnouncementPayload): Promise<void> {
  const lines = ann.content
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  process.stdout.write(`\n=== Announcement: ${ann.title} ===\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    ann.popup_once
      ? "\nPress Enter, Esc, or q to close. This announcement is shown once.\n"
      : "\nPress Enter, Esc, or q to close.\n",
  );

  await readTerminalKey<boolean>((chunk) => {
    if (chunk === "\r" || chunk === "\n") return true;
    if (chunk === "\u001b" || chunk === "q" || chunk === "Q") return true;
    return undefined;
  }, true);

  process.stdout.write("\n");
}
