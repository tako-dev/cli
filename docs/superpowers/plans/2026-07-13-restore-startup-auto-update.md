# Restore Startup Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Tako CLI startup auto-update for production builds while keeping development runs update-free, then publish the next patch release.

**Architecture:** Keep `shouldRunStartupUpdate(isDev)` as the single decision point shared by the interactive and quick-launch paths. Change only its existing feature flag, with a focused regression test proving production and development behavior.

**Tech Stack:** TypeScript, Bun Test, Bun build, GitHub Actions, npm trusted publishing

---

### Task 1: Restore the startup update decision

**Files:**
- Modify: `tests/unit.update-logic.test.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Write the failing production-mode regression test**

Replace the production assertion with:

```ts
it("startup auto update runs in production mode", () => {
  expect(shouldRunStartupUpdate(false)).toBe(true);
});
```

Keep the development assertion and rename it for the permanent behavior:

```ts
it("startup auto update remains disabled in dev mode", () => {
  expect(shouldRunStartupUpdate(true)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test tests/unit.update-logic.test.ts
```

Expected: one failure where production mode expected `true` and received `false`; the development assertion still passes.

- [ ] **Step 3: Enable the existing production switch**

In `src/app.ts`, change:

```ts
const STARTUP_AUTO_UPDATE_ENABLED = false;
```

to:

```ts
const STARTUP_AUTO_UPDATE_ENABLED = true;
```

Update the nearby interactive-entry comment to describe the active startup check instead of a temporary disable.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test tests/unit.update-logic.test.ts
```

Expected: all updater tests pass with zero failures.

- [ ] **Step 5: Commit the behavior change**

```bash
git add src/app.ts tests/unit.update-logic.test.ts
git commit -m "fix: restore startup auto update"
```

### Task 2: Run release gates

**Files:**
- Verify: `src/app.ts`
- Verify: `tests/unit.update-logic.test.ts`
- Verify: generated `dist/index.js`

- [ ] **Step 1: Run all unit tests**

```bash
bun run test:unit
```

Expected: all unit tests pass with zero failures.

- [ ] **Step 2: Build the release bundle**

```bash
bun run build
```

Expected: `dist/index.js` is generated successfully.

- [ ] **Step 3: Run pre-release checks**

```bash
bun run test:pre-release
```

Expected: build artifact, smoke test, source integrity, updater, platform, and client registry checks all pass.

- [ ] **Step 4: Verify repository integrity**

```bash
git diff --check
git status --short --branch
wc -l src/app.ts tests/unit.update-logic.test.ts docs/updater/DESIGN.md docs/updater/TESTPLAN.md
```

Expected: no whitespace errors, only intentional committed changes, and every file remains under 600 lines.

### Task 3: Publish the patch release

**Files:**
- Modify via release script: `package.json`

- [ ] **Step 1: Confirm the remote and registry still point to 0.3.24**

```bash
git fetch origin main --tags
git rev-parse origin/main
npm view tako-cli version dist-tags.latest --json --registry https://registry.npmjs.org
```

Expected: `origin/main` is still the release base and npm `latest` is `0.3.24`.

- [ ] **Step 2: Run the repository patch release script from the isolated branch**

```bash
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=push.default \
GIT_CONFIG_VALUE_0=upstream \
bun run release
```

Expected: version becomes `0.3.25`, a release commit and `v0.3.25` tag are created, and the branch is pushed to its `origin/main` upstream together with the tag.

- [ ] **Step 3: Watch the release workflow**

```bash
RUN_ID=$(gh run list --repo tako-dev/cli --workflow "CLI release" \
  --json databaseId,headBranch,event \
  --jq 'map(select(.headBranch == "v0.3.25" and .event == "push"))[0].databaseId')
gh run watch "$RUN_ID" --repo tako-dev/cli --exit-status
```

Expected: Ubuntu, macOS, and Windows installer e2e jobs pass; build, unit, pre-release, and npm publish jobs pass.

- [ ] **Step 4: Verify the published package**

```bash
git ls-remote --tags origin refs/tags/v0.3.25
npm view tako-cli@0.3.25 version dist-tags.latest dist.attestations --json --registry https://registry.npmjs.org
```

Expected: remote tag `v0.3.25` exists and npm `latest` resolves to `0.3.25` with provenance attestations.
