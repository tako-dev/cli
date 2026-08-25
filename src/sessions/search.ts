import type { SessionDatabase } from "./database";
import type { NativeSessionSource, UnifiedSession } from "./types";

export interface SessionSearchOptions { deep?: boolean; sources?: NativeSessionSource[]; cwd?: string; project?: string; after?: number; limit?: number; currentCwd?: string }
export interface SessionSearchResult { session: UnifiedSession; snippet: string; score: number }

function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function searchSessions(db: SessionDatabase, query: string, options: SessionSearchOptions = {}): SessionSearchResult[] {
  const terms = searchTerms(query);
  const results: SessionSearchResult[] = [];
  const requestedLimit = options.limit ?? 50;
  for (const candidate of db.searchCandidates(terms, !!options.deep, requestedLimit, { sources: options.sources, cwd: options.cwd, project: options.project, after: options.after, currentCwd: options.currentCwd })) {
    const session = candidate.session;
    const body = candidate.text;
    let score = 0;
    for (const term of terms) {
      if (session.title?.toLocaleLowerCase().includes(term)) score += 8;
      if (session.projectName?.toLocaleLowerCase().includes(term)) score += 5;
      if (body.toLocaleLowerCase().includes(term)) score += 2;
    }
    if (terms.length > 0 && options.currentCwd && session.cwd === options.currentCwd) score += 4;
    const hit = terms.length ? body.split("\n").find((line) => terms.some((term) => line.includes(term))) : undefined;
    results.push({ session, snippet: hit ?? session.preview, score });
  }
  return results.sort((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt).slice(0, requestedLimit);
}
