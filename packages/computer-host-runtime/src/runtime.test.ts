import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  BOTS_ROOT,
  COMPUTER_RUNTIME_FILES,
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
  CONTROL_SCRIPT,
  DATA_ROOT,
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
  provisionScript,
  RUNTIME_ROOT,
  base64,
  installFile,
  shellQuote,
  WORKSPACES_ROOT,
} from "./runtime.ts";

function spriteName(userId: string, base = "frockbot"): string {
  return computerSpriteNameV1(
    userId,
    createHash("sha256")
      .update(computerSpriteNameSourceV1(userId))
      .digest("hex"),
    base,
  );
}

describe("layout", () => {
  test("the Computer is laid out under the GrokBot home", () => {
    expect(HOME_ROOT).toBe("/home/box");
    expect(DATA_ROOT).toBe("/home/box/agent-data");
    expect(RUNTIME_ROOT).toBe("/home/box/.frockbot");
    expect(BOTS_ROOT).toBe("/home/box/.frockbot/bots");
    expect(WORKSPACES_ROOT).toBe("/workspaces");
  });
});

describe("runtime files", () => {
  test("every declared file is the one the provisioning script installs", () => {
    for (const file of COMPUTER_RUNTIME_FILES) {
      expect(provisionScript).toContain(installFile(file.path, file.content));
    }
  });

  test("the inventory covers every file the provisioning script installs", () => {
    const installs = provisionScript
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("printf %s '") && line.includes("base64 -d >"),
      );
    expect(installs).toHaveLength(COMPUTER_RUNTIME_FILES.length);
  });

  test("the control and ensure scripts are installed where the provider calls them", () => {
    const paths = COMPUTER_RUNTIME_FILES.map((file) => file.path);
    expect(paths).toContain(CONTROL_SCRIPT);
    expect(paths).toContain(ENSURE_AGENT_SCRIPT);
  });
});

describe("provisioning script", () => {
  test("is far larger than the argv budget that produced the measured 431", () => {
    // ADR 0004: Fly answered a ~2.5 KB `cmd=` query with 431. The script must
    // reach the Sprite on stdin, and this asserts the size that makes argv
    // delivery impossible rather than merely unwise.
    expect(provisionScript.length).toBeGreaterThan(3_000);
  });

  test("installs the desktop, sync, and gateway runtime", () => {
    expect(provisionScript).toContain("apt-get install -y chromium xvfb");
    expect(provisionScript).toContain("playwright-core@1.55.0");
    expect(provisionScript).toContain(`chmod 600 ${RUNTIME_ROOT}/tokens`);
  });
});

describe("shell helpers", () => {
  test("quotes a value that would otherwise break out of its argument", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  test("round-trips content through the base64 installer", () => {
    const line = installFile("/tmp/x", "hello");
    expect(line).toBe(`printf %s '${base64("hello")}' | base64 -d > /tmp/x`);
  });
});

describe("Sprite naming", () => {
  test("one Computer per User: the name derives from the User alone", () => {
    expect(spriteName("user-1")).toBe(spriteName("user-1"));
    expect(spriteName("user-1")).not.toBe(spriteName("user-2"));
  });

  test("the digest source is keyed so another owner kind cannot collide", () => {
    expect(computerSpriteNameSourceV1("user-1")).toBe('["user","user-1"]');
  });

  test("the name is a legal Sprite name with a twelve-character digest", () => {
    const name = spriteName("user-1");
    expect(name).toMatch(/^frockbot-[0-9a-f]{12}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("a long base name is trimmed so the result still fits", () => {
    const name = spriteName("user-1", `a${"b".repeat(60)}`);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("refuses a base name that is not a legal Sprite name", () => {
    expect(() => spriteName("user-1", "Frockbot")).toThrow(/base name/);
    expect(() => spriteName("user-1", "-leading")).toThrow(/base name/);
  });

  test("refuses an empty User", () => {
    expect(() => spriteName("   ")).toThrow(/non-empty userId/);
  });
});
