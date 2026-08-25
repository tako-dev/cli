# Native Session Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sea-data-ai-coding:subagent-driven-development (recommended) or sea-data-ai-coding:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local cross-client session search, preview, and native resume for Claude Code, Codex, and Gemini, with an inline Launcher search entry.

**Architecture:** Introduce an independent `src/sessions/` domain with source adapters, a Bun SQLite/FTS index, search and resume services, then expose the same APIs through CLI commands and reusable Ink components. The Launcher embeds a compact single-column search panel while `tako sessions` reuses it in a larger standalone view.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, FTS5, React 19, Ink 6, Bun test.

**Testing authorization:** The user asked to begin development; implementation will use TDD and run focused tests immediately without an additional pause.

**Commit policy:** Do not create commits unless the user explicitly requests them.

---

### Task 1: Unified Types and Source Adapters

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/parser-utils.ts`
- Create: `src/sessions/adapters/claude.ts`
- Create: `src/sessions/adapters/codex.ts`
- Create: `src/sessions/adapters/gemini.ts`
- Create: `src/sessions/registry.ts`
- Create: `tests/fixtures/sessions/claude-basic.jsonl`
- Create: `tests/fixtures/sessions/codex-basic.jsonl`
- Create: `tests/fixtures/sessions/gemini-basic.jsonl`
- Create: `tests/unit.session-adapters.test.ts`

- [ ] Write failing tests for native ID, cwd, title, timestamps, message roles, and searchability flags.
- [ ] Run `bun test tests/unit.session-adapters.test.ts` and verify failures are caused by missing adapters.
- [ ] Implement shared types, safe JSONL parsing, content extraction, and the three adapters.
- [ ] Add malformed-line, truncated-tail, missing-metadata, and system/developer exclusion tests.
- [ ] Run the focused adapter test until green.

### Task 2: SQLite Schema and Incremental Indexer

**Files:**
- Create: `src/sessions/database.ts`
- Create: `src/sessions/migrations/001-initial.ts`
- Create: `src/sessions/discovery.ts`
- Create: `src/sessions/indexer.ts`
- Create: `tests/unit.session-indexer.test.ts`

- [ ] Write failing tests for schema creation, atomic replacement, unchanged-file skipping, parser-version invalidation, and stale cleanup.
- [ ] Run `bun test tests/unit.session-indexer.test.ts` and verify RED.
- [ ] Implement database initialization under an injectable root path for tests.
- [ ] Implement finite-concurrency discovery and file-level incremental indexing.
- [ ] Ensure one corrupt source file records diagnostics without aborting the scan.
- [ ] Run indexer and adapter tests until green.

### Task 3: Default and Deep Search

**Files:**
- Create: `src/sessions/search.ts`
- Create: `tests/unit.session-search.test.ts`

- [ ] Write failing tests for title, user message, assistant message, cwd, Chinese text, paths, and error-code search.
- [ ] Add tests proving default search excludes reasoning/tool output while deep search includes it.
- [ ] Add filter and ranking tests for source, cwd, project, recency, and current-cwd boost.
- [ ] Run `bun test tests/unit.session-search.test.ts` and verify RED.
- [ ] Implement bound-parameter FTS queries, safe query normalization, snippets, and stable ranking.
- [ ] Run all session-domain tests until green.

### Task 4: Resume Capability and Launcher Handoff

**Files:**
- Create: `src/sessions/resume.ts`
- Modify: `src/launcher/index.ts`
- Modify: `src/ui/shared/launch.ts`
- Create: `tests/unit.session-resume.test.ts`

- [ ] Write failing command-construction tests for Claude and Codex.
- [ ] Write Gemini capability-detection and fallback tests.
- [ ] Add cwd-missing, client-missing, and provider-setup failure tests.
- [ ] Run `bun test tests/unit.session-resume.test.ts` and verify RED.
- [ ] Implement resume preparation by reusing existing provider/config/terminal handoff logic.
- [ ] Keep original model informational unless the user chooses advanced resume.
- [ ] Run resume and launcher regression tests until green.

### Task 5: CLI Commands

**Files:**
- Create: `src/sessions/cmd.ts`
- Create: `src/sessions/index.ts`
- Modify: `src/app.ts`
- Create: `tests/unit.sessions-command.test.ts`

- [ ] Write failing parser and JSON-output tests for `search`, `show`, `resume`, and `index`.
- [ ] Run `bun test tests/unit.sessions-command.test.ts` and verify RED.
- [ ] Implement human and JSON output without exposing message content unless explicitly requested.
- [ ] Add source, cwd, project, time, deep-search, and limit flags.
- [ ] Run CLI and existing app argument tests until green.

### Task 6: Reusable Ink Search Panel

**Files:**
- Create: `src/ui/ink/views/SessionSearchPanel.tsx`
- Create: `src/ui/ink/views/SessionsView.tsx`
- Create: `src/ui/ink/views/SessionDetailView.tsx`
- Create: `src/ui/ink/views/SessionFilterView.tsx`
- Modify: `src/ui/ink/views/LauncherView.tsx`
- Modify: `src/ui/ink/App.tsx`
- Modify: `src/ui/shared/types.ts`
- Create: `tests/unit.session-search-view.test.tsx`

- [ ] Write failing navigation tests for moving from the first project to Search with `↑` and returning with `↓` or `Esc`.
- [ ] Write tests for input debounce, result selection by stable key, Enter resume, right-arrow details, and empty/indexing states.
- [ ] Run `bun test tests/unit.session-search-view.test.tsx` and verify RED.
- [ ] Implement the compact homepage style from the design spec without new letter shortcuts.
- [ ] Implement responsive standalone layout and details action menu.
- [ ] Verify 79-, 100-, and 140-column render snapshots or deterministic text models.
- [ ] Run focused TUI tests and existing launcher/model-grid tests until green.

### Task 7: Documentation, Performance, and Release Validation

**Files:**
- Modify: `README.md`
- Create: `docs/sessions/DESIGN.md`
- Create: `docs/sessions/TESTPLAN.md`
- Modify: `docs/superpowers/specs/2026-07-15-native-session-search-design.md`
- Create: `scripts/benchmark-session-search.ts`

- [ ] Document the homepage navigation, CLI commands, privacy behavior, and Gemini fallback.
- [ ] Add a local benchmark using generated, non-sensitive fixtures.
- [ ] Verify indexed opening and query targets at representative scale.
- [ ] Run `bun run build`.
- [ ] Run all new focused tests.
- [ ] Run `bun test tests/pre-release.test.ts` and relevant launcher regression tests.
- [ ] Review final diff for accidental generated `.js`, `.d.ts`, or `.map` files.

## Case Coverage Summary

- Functional: source discovery, parsing, incremental indexing, default/deep search, filtering, preview, Claude/Codex resume, Gemini fallback, CLI output.
- UI: homepage upward navigation, focused search style, loading/empty/results states, minimal-key interaction, responsive standalone layout.
- Regression: existing project/client navigation, provider setup, terminal handoff, Agent Sessions, updater, and pre-release packaging.
- Not covered in v1: semantic search, cloud sync, cross-machine resume, rewriting Gemini native files.
