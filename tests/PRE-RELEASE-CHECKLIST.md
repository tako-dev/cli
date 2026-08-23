# Pre-Release Testing Checklist

Before executing `bun run release`, verify the following items:

## Automated Tests

- [ ] `bun test:unit` - All unit tests pass
- [ ] `bun test:integration` - All integration tests pass
- [ ] `bun test:platform` - Cross-platform tests pass
- [ ] `bun test:pre-release` - Pre-release tests pass
- [ ] GitHub `CLI CI` green on the PR (Ubuntu / macOS / Windows)


## Manual Verification

- [ ] Run `bun run build` successfully
- [ ] Check `dist/index.js` has reasonable size (~50KB)
- [ ] Run `git status` to confirm no uncommitted changes
- [ ] Update RELEASE-NOTES.md if applicable

## Optional Verification (Recommended)

- [ ] Test installation in local Docker container
- [ ] Test on Windows VM (if available)
- [ ] Review `bun test:coverage` coverage report

---

## Quick Test Commands

```bash
# Run all automated tests at once
bun test

# Run pre-release tests specifically
bun test:pre-release

# Run with coverage report
bun test:coverage
```

---

## Release Commands

```bash
# Automatic: Run all tests and publish
bun run release

# Manual: Step by step
bun run test:pre-release
bun run bump patch
npm publish
```

---

## Test Categories Explained

### Unit Tests (`bun test:unit`)

- Test pure functions and logic
- Fast execution (< 1 second total)
- No external dependencies

### Integration Tests (`bun test:integration`)

- Test module interactions
- May access file system
- May require installed packages

### Platform Tests (`bun test:platform`)

- Test Windows/Unix compatibility
- Verify path handling
- Check executable extensions

### Pre-Release Tests (`bun test:pre-release`)

- Comprehensive verification
- Build artifact checks
- Source code integrity
- Configuration validation
- All critical paths tested

---

## What to Do If Tests Fail

### Unit Test Failure

1. Check the specific failing test
2. Review the function being tested
3. Fix the logic error
4. Re-run: `bun test:unit`

### Integration Test Failure

1. Check if required files exist
2. Verify file permissions
3. Ensure dependencies are installed
4. Re-run: `bun test:integration`

### Platform Test Failure

1. Check platform-specific logic
2. Verify path handling
3. Test on target platform
4. Re-run: `bun test:platform`

### Pre-Release Test Failure

1. Run individual test categories to isolate issue
2. Check build artifacts exist
3. Verify source files are present
4. Re-run after fixes: `bun test:pre-release`

---

## Emergency Release

If you must release with failing tests (NOT recommended):

1. Document which tests are failing and why
2. Create issue to track the problem
3. Get approval from project maintainer
4. Release with explicit warning in release notes

---

## Post-Release Verification

After publishing:

- [ ] Install via `npm install -g tako-cli` and test
- [ ] Run basic commands: `tako --version`, `tako --help`
- [ ] Test on fresh system if possible

---

**Last Updated:** 2026-01-08
