import { describe, expect, it } from "bun:test";
import { apiErrorText } from "../src/api-error";

describe("apiErrorText", () => {
  it("keeps RS-compat string errors", () => {
    expect(apiErrorText({ success: false, error: "Invalid key" }, "fallback")).toBe("Invalid key");
    expect(apiErrorText("User not found", "fallback")).toBe("User not found");
  });

  it("unwraps OpenAI {message,type,param,code} objects", () => {
    expect(apiErrorText({
      error: {
        message: "Invalid URL (POST /apiStats/api/get-key-id)",
        type: "invalid_request_error",
        param: "",
        code: "",
      },
    }, "fallback")).toBe("Invalid URL (POST /apiStats/api/get-key-id)");
  });

  it("uses fallback when nothing readable is present", () => {
    expect(apiErrorText(null, "fallback")).toBe("fallback");
    expect(apiErrorText({ unexpected: true }, "fallback")).toBe("fallback");
  });
});
