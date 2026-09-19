import { describe, expect, test } from "bun:test";
import { stageFlyWorkspaceBytesV1 } from "./staging.ts";

describe("Fly workspace chunk staging", () => {
  test("skips staging for one bounded chunk", async () => {
    const scripts: string[] = [];
    await expect(
      stageFlyWorkspaceBytesV1({
        mount: "/home/box",
        stagingRoot: ".frockbot-sync/staging",
        name: "one.write",
        bytes: new TextEncoder().encode("small"),
        chunkBytes: 10,
        invalidResponse: "invalid",
        run: async (script) => {
          scripts.push(script);
          return "__STAGED__";
        },
      }),
    ).resolves.toBeUndefined();
    expect(scripts).toEqual([]);
  });

  test("resets once, appends each chunk, and returns the marker path", async () => {
    const scripts: string[] = [];
    const staged = await stageFlyWorkspaceBytesV1({
      mount: "/home/box",
      stagingRoot: ".frockbot-sync/staging",
      name: "many.write",
      bytes: new TextEncoder().encode("abcdef"),
      chunkBytes: 2,
      invalidResponse: "invalid",
      run: async (script) => {
        scripts.push(script);
        return "__STAGED__";
      },
    });
    expect(staged).toBe("/home/box/.frockbot-sync/staging/many.write");
    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toContain('rm -f "$STAGE"');
    expect(scripts[1]).not.toContain('rm -f "$STAGE"');
    expect(scripts.every((script) => script.includes("echo __STAGED__"))).toBe(
      true,
    );
  });

  test("keeps the caller's invalid-response wording", async () => {
    const result = await stageFlyWorkspaceBytesV1({
      mount: "/home/box",
      stagingRoot: ".frockbot-sync/staging",
      name: "many.write",
      bytes: new TextEncoder().encode("abcdef"),
      chunkBytes: 2,
      invalidResponse: "Invalid Fly Workspace sync response",
      run: async () => "other",
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "Invalid Fly Workspace sync response",
    });
  });
});
