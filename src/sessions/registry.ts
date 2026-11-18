import { parseAgySessionText } from "./adapters/agy";
import { parseClaudeSessionText } from "./adapters/claude";
import { parseCodexSessionText } from "./adapters/codex";
import { parseGeminiSessionText } from "./adapters/gemini";
import { parseGrokSessionText } from "./adapters/grok";
import { parsePiSessionText } from "./adapters/pi";
import type { NativeSessionSource, ParsedNativeSession } from "./types";

export type SessionTextParser = ((
  text: string,
  sourcePath: string,
  cwd?: string,
  meta?: { title?: string },
) => ParsedNativeSession | null) & { parserVersion: number };

export const SESSION_PARSERS: Record<NativeSessionSource, SessionTextParser> = {
  claude: Object.assign(parseClaudeSessionText, { parserVersion: 2 }),
  codex: Object.assign(parseCodexSessionText, { parserVersion: 2 }),
  gemini: Object.assign(parseGeminiSessionText, { parserVersion: 2 }),
  grok: Object.assign(parseGrokSessionText as unknown as SessionTextParser, { parserVersion: 1 }),
  pi: Object.assign(parsePiSessionText, { parserVersion: 1 }),
  agy: Object.assign(parseAgySessionText, { parserVersion: 1 }),
};
