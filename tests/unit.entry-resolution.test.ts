import { describe, it, expect } from "bun:test";
import { mockPackageJsons, parseBinField } from "./_helpers/mocks";

describe("Entry Resolution - bin field parsing", () => {
  it("should parse object format bin field", () => {
    const result = parseBinField(mockPackageJsons.claudeCode.bin, "claude");
    expect(result).toBe("cli.js");
  });

  it("should parse Pi and Pi Web JS entries", () => {
    expect(parseBinField(mockPackageJsons.pi.bin, "pi")).toBe("dist/cli.js");
    expect(parseBinField(mockPackageJsons.piWeb.bin, "pi-web")).toBe("bin/pi-web.js");
  });

  it("should parse string format bin field", () => {
    const result = parseBinField(mockPackageJsons.stringBin.bin, "any");
    expect(result).toBe("index.js");
  });

  it("should parse multi-command bin field", () => {
    const result = parseBinField(mockPackageJsons.multiCommand.bin, "cmd2");
    expect(result).toBe("bin/cmd2.js");
  });

  it("should return null when command does not exist", () => {
    const result = parseBinField({ foo: "bar.js" }, "baz");
    expect(result).toBeNull();
  });

  it("should return null when bin field is undefined", () => {
    const result = parseBinField(undefined, "cmd");
    expect(result).toBeNull();
  });

  it("should return null when bin field is null", () => {
    const result = parseBinField(null, "cmd");
    expect(result).toBeNull();
  });

  it("should handle empty object bin field", () => {
    const result = parseBinField({}, "cmd");
    expect(result).toBeNull();
  });
});
