# Agent Instructions

## Release And Publishing

`tako-cli` must be published through GitHub Actions. Never run `npm publish`
manually from a local machine.

Normal release flow:

1. Start from a clean, current `main`.
2. Run validation before releasing:

   ```bash
   bun run build
   bun test tests/pre-release.test.ts
   ```

   Also run focused tests for the code path being released.

3. Run the repository release script:

   ```bash
   bun run release
   ```

   This is only the CI trigger. It bumps `package.json`, commits
   `chore: release vX.Y.Z`, creates tag `vX.Y.Z`, pushes `main`, and pushes
   tags.

4. Watch the GitHub Actions workflow `CLI release` triggered by the `v*` tag:

   ```bash
   gh run list --repo tako-dev/cli --workflow "CLI release" --limit 5
   gh run watch <run-id> --repo tako-dev/cli --exit-status
   ```

5. Only call the release complete after both checks pass:

   ```bash
   gh run view <run-id> --repo tako-dev/cli --json status,conclusion
   npm view tako-cli version dist-tags.latest --registry=https://registry.npmjs.org/ --json
   ```

The actual npm publish happens in GitHub Actions with OIDC trusted publishing.
See `docs/release/RUNBOOK.md` for the full runbook and recovery steps.
