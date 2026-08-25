# Release Runbook

This runbook is the operational checklist for publishing `tako-cli` to npm.

## Normal Release

1. Start from a clean, current `main`.

   ```bash
   git checkout main
   git pull --ff-only origin main
   git fetch origin --tags
   git status -sb
   ```

2. Run focused validation for the change being released, then build.

   ```bash
   bun run build
   bun test tests/pre-release.test.ts
   ```

   For quota changes, also run:

   ```bash
   bun test tests/unit.quota-command.test.ts tests/unit.quota.test.ts
   ```

3. Check the current published version and latest tag.

   ```bash
   npm view tako-cli version dist-tags.latest --json
   git tag --sort=-v:refname | head
   git ls-remote --tags origin 'refs/tags/v*'
   ```

4. Publish with the repo script.

   ```bash
   bun run release
   ```

   The script bumps `package.json`, commits `chore: release vX.Y.Z`, creates tag
   `vX.Y.Z`, pushes `main`, and pushes tags.

5. Watch the release workflow until completion.

   ```bash
   gh run list --repo tako-dev/cli --workflow "CLI release" --limit 5
   gh run watch <run-id> --repo tako-dev/cli --exit-status
   ```

6. Verify the npm dist-tag after the workflow succeeds.

   ```bash
   npm view tako-cli version dist-tags.latest --json
   ```

## Release Workflow Gates

Tag pushes matching `v*` trigger `.github/workflows/release.yml`.

The workflow must pass:

- installer e2e on Ubuntu, macOS, and Windows
- `bun run build`
- bundle smoke test: `bun dist/index.js --version`
- `bun run test:pre-release`
- `npx -y npm@11.5.1 publish --provenance --access public`

The workflow intentionally uses a pinned npm CLI through `npx`; do not replace
it with `npm install -g npm@latest`, because npm CLI dependency drift can break
provenance publishing before the package reaches the registry.

## Bad Tag Cleanup

If a malformed tag is pushed, clean it up before publishing the real tag.

1. Cancel the wrong release workflow.

   ```bash
   gh run cancel <run-id> --repo tako-dev/cli
   gh run view <run-id> --repo tako-dev/cli --json status,conclusion,url
   ```

2. Delete the wrong tag locally and remotely.

   ```bash
   git tag -d <bad-tag>
   git push origin :refs/tags/<bad-tag>
   git ls-remote --tags origin 'refs/tags/v*'
   ```

3. Fix the release script or release commit if needed, push `main`, then create
   the correct tag on the final commit.

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   gh run watch <new-run-id> --repo tako-dev/cli --exit-status
   ```

4. Verify npm and remote tags after the successful run.

   ```bash
   npm view tako-cli version dist-tags.latest --json
   git ls-remote --tags origin 'refs/tags/v*'
   ```

## 2026-06-19 v0.3.6 Notes

The first `bun run release` attempt exposed a quoting bug in the release script:
the command passed `require(\"./package.json\")` to `node -p`, so version
expansion failed and created tag `v` plus commit message `chore: release v`.

Recovery steps used:

- canceled the `v` release workflow
- deleted remote tag `v`
- fixed the release script quoting
- pushed the script fix to `main`
- tagged the final commit as `v0.3.6`
- confirmed the release workflow succeeded and npm `latest` became `0.3.6`

## 2026-07-09 v0.3.22 Notes

The `v0.3.22` release workflow passed e2e, build, smoke, unit, and pre-release
checks, then failed in `npm publish --provenance --access public` with
`Cannot find module 'sigstore'`.

Recovery used:

- left the failed `v0.3.22` tag in place because it was a valid commit but not
  published to npm
- changed release.yml to use `npx -y npm@11.5.1 publish --provenance --access public`
  instead of globally installing `npm@latest`
- published the rollback as the next patch version
