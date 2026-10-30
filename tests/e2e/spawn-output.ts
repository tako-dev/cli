export function looksLikeVersion(text: string, clientId: string): boolean {
  const lower = text.toLowerCase();
  if (clientId === "codex") return lower.includes("codex");
  if (clientId === "pi") {
    return lower.split(/\r?\n/).some((line) =>
      /^(?:pi(?:\s+version)?\s+)?v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/.test(line.trim()),
    );
  }
  return /ready|started|listening|localhost|127\.0\.0\.1|pi[ -]?web/.test(lower);
}
