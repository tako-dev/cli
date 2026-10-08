/**
 * Flatten mixed API error payloads into a string Ink can render.
 *
 * RS-compat endpoints return `{ error: "Invalid key" }`. OpenAI-shaped 404s
 * return `{ error: { message, type, param, code } }`. Passing the object into
 * `<Text>` crashes Ink/React 19 with "Symbols are not valid as a React child".
 */
export function apiErrorText(payload: unknown, fallback: string): string {
  const direct = messageFrom(payload);
  if (direct) return direct;
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    const fromError = messageFrom(rec.error);
    if (fromError) return fromError;
    const fromMessage = messageFrom(rec.message);
    if (fromMessage) return fromMessage;
  }
  return fallback;
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    const trimmed = (value as { message: string }).message.trim();
    return trimmed || undefined;
  }
  return undefined;
}
