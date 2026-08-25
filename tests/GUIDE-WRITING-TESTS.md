# Guide: Writing Tests for Tako CLI

This guide provides detailed instructions and templates for writing tests in the Tako CLI project.

## Quick Start Template

### Unit Test Template

```typescript
import { describe, it, expect } from "bun:test";

describe("ModuleName - Feature", () => {
  it("should do something specific", () => {
    // Arrange
    const input = "test input";

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe("expected output");
  });
});
```

### Integration Test Template

```typescript
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { getTakoDir } from "./_helpers/paths";
import { expectFileExists } from "./_helpers/assertions";

describe("Integration - Feature", () => {
  const takoDir = getTakoDir();

  it("should interact with file system", async () => {
    const filePath = join(takoDir, "some-file.json");

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      console.warn("  [SKIP] File not found");
      return;
    }

    await expectFileExists(filePath);
  });
});
```

### Platform Test Template

```typescript
import { describe, it, expect } from "bun:test";
import { isWindows, getBunBin } from "./_helpers/paths";

describe("Platform - Feature", () => {
  it("should handle platform differences", () => {
    const bunBin = getBunBin();

    if (isWindows()) {
      expect(bunBin).toEndWith(".exe");
    } else {
      expect(bunBin).not.toEndWith(".exe");
    }
  });
});
```

---

## Using Helper Functions

### Path Helpers (`_helpers/paths.ts`)

```typescript
import {
  getTakoDir,        // Get ~/.tako
  getTakoCliDir,     // Get ~/.tako/cli
  getTakoToolsDir,   // Get ~/.tako/tools
  getBunBin,         // Get Bun executable path
  getProjectRoot,    // Get project root
  getSrcDir,         // Get src directory
  getDistDir,        // Get dist directory
  isWindows,         // Check if Windows
  getLauncherScriptName, // Get "tako" or "tako.cmd"
} from "./_helpers/paths";
```

### Assertion Helpers (`_helpers/assertions.ts`)

```typescript
import {
  expectFileExists,      // Assert file exists
  expectInTakoDir,       // Assert path is under Tako dir
  expectValidPackageJson, // Assert valid package.json
  expectNoShebang,       // Assert no shebang (Windows compat)
  expectNotContains,     // Assert array doesn't contain element
} from "./_helpers/assertions";
```

### Mock Data (`_helpers/mocks.ts`)

```typescript
import {
  mockPackageJsons,    // Mock package.json data
  parseBinField,       // Parse bin field function
  mockConfig,          // Empty config structure
  mockValidConfig,     // Valid config example
} from "./_helpers/mocks";
```

### Test Fixtures (`_helpers/fixtures.ts`)

```typescript
import {
  testClients,           // Test client configs
  coreModules,           // Core module list
  clientModules,         // Client module list
  takoSubdirs,           // Tako subdirectories
  requiredConfigFields,  // Required config fields
  requiredPackageFields, // Required package.json fields
} from "./_helpers/fixtures";
```

---

## Test Naming Conventions

### File Naming

| Type | Pattern | Example |
|------|---------|---------|
| Unit | `unit.<module>.test.ts` | `unit.entry-resolution.test.ts` |
| Integration | `integration.<feature>.test.ts` | `integration.installer.test.ts` |
| E2E | `e2e.<scenario>.test.ts` | `e2e.install.test.ts` |
| Platform | `platform.<platform>.test.ts` | `platform.windows.test.ts` |

### Describe Block Naming

```typescript
// Format: "Category - Specific Feature"
describe("Entry Resolution - bin field parsing", () => {});
describe("Integration - Claude Code package verification", () => {});
describe("Platform - Windows compatibility", () => {});
```

### Test Case Naming

```typescript
// Format: "should <action> <expected result>"
it("should parse object format bin field", () => {});
it("should return null when command does not exist", () => {});
it("should handle platform differences correctly", () => {});
```

---

## Common Patterns

### Testing Conditional Logic

```typescript
it("should handle both platforms", () => {
  const bunBin = getBunBin();

  // Test is valid regardless of platform
  if (isWindows()) {
    expect(bunBin).toEndWith(".exe");
  } else {
    expect(bunBin).not.toEndWith(".exe");
  }
});
```

### Testing with Optional Dependencies

```typescript
it("should work when package is installed", async () => {
  const file = Bun.file(packagePath);

  // Skip gracefully if dependency not present
  if (!(await file.exists())) {
    console.warn("  [SKIP] Package not installed");
    return;
  }

  // Actual test logic
  const pkg = await file.json();
  expect(pkg.name).toBeDefined();
});
```

### Testing Error Cases

```typescript
it("should return null for invalid input", () => {
  expect(parseBinField(undefined, "cmd")).toBeNull();
  expect(parseBinField(null, "cmd")).toBeNull();
  expect(parseBinField({}, "cmd")).toBeNull();
});
```

### Testing Async Functions

```typescript
it("should handle async operations", async () => {
  const file = Bun.file(path);
  const exists = await file.exists();
  expect(exists).toBe(true);

  const content = await file.json();
  expect(content).toHaveProperty("name");
});
```

---

## Testing Checklist

Before submitting tests, verify:

- [ ] Test file follows naming convention (`unit.*.test.ts`, etc.)
- [ ] Describe blocks have meaningful names
- [ ] Test cases describe expected behavior
- [ ] Helper functions are used where appropriate
- [ ] Tests handle missing dependencies gracefully
- [ ] Tests work on all platforms (or skip appropriately)
- [ ] No hardcoded absolute paths (use helpers)
- [ ] Tests are independent (no shared mutable state)

---

## Examples

### Complete Unit Test Example

```typescript
import { describe, it, expect } from "bun:test";
import { mockPackageJsons, parseBinField } from "./_helpers/mocks";

describe("Entry Resolution - bin field parsing", () => {
  it("should parse object format bin field", () => {
    const result = parseBinField(mockPackageJsons.claudeCode.bin, "claude");
    expect(result).toBe("cli.js");
  });

  it("should parse string format bin field", () => {
    const result = parseBinField(mockPackageJsons.stringBin.bin, "any");
    expect(result).toBe("index.js");
  });

  it("should return null when bin field is undefined", () => {
    const result = parseBinField(undefined, "cmd");
    expect(result).toBeNull();
  });
});
```

### Complete Integration Test Example

```typescript
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { getTakoDir, getTakoToolsDir } from "./_helpers/paths";
import { expectFileExists } from "./_helpers/assertions";

describe("Integration - Claude Code verification", () => {
  const packagePath = join(
    getTakoToolsDir(),
    "claude-code",
    "node_modules",
    "@anthropic-ai/claude-code",
    "package.json"
  );

  it("should have valid package.json (if installed)", async () => {
    const file = Bun.file(packagePath);
    if (!(await file.exists())) {
      console.warn("  [SKIP] Claude Code not installed");
      return;
    }

    await expectFileExists(packagePath);

    const pkg = await file.json();
    expect(pkg.name).toBe("@anthropic-ai/claude-code");
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.claude).toBeDefined();
  });
});
```

---

**Last Updated:** 2026-01-08
