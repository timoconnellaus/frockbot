import { describe, expect, test } from "bun:test";
import { resolveUserDisplayName } from "./user-display-name.js";

describe("resolveUserDisplayName", () => {
  test("prefers a saved name over the authenticated session", () => {
    expect(
      resolveUserDisplayName({
        savedName: "Tim",
        sessionName: "Local developer",
        sessionEmail: "developer@example.com",
      }),
    ).toBe("Tim");
  });

  test("uses the session name when the saved name is the placeholder", () => {
    expect(
      resolveUserDisplayName({
        savedName: "FrockBot user",
        sessionName: "Local developer",
        sessionEmail: "developer@example.com",
      }),
    ).toBe("Local developer");
  });

  test("uses the session email when its name is the placeholder", () => {
    expect(
      resolveUserDisplayName({
        savedName: "FrockBot user",
        sessionName: "FrockBot user",
        sessionEmail: "  developer@example.com  ",
      }),
    ).toBe("developer@example.com");
  });

  test("uses the placeholder when every candidate is blank", () => {
    expect(
      resolveUserDisplayName({
        savedName: "  ",
        sessionName: "",
        sessionEmail: "  ",
      }),
    ).toBe("FrockBot user");
  });
});
