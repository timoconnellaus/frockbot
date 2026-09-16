/**
 * The bounded workerd boot: which failures are the boot's and are tried
 * again, and which belong to the code being built and are answered.
 */

import { describe, expect, it } from "bun:test";

import {
  bootedWithin,
  RuntimeDidNotStart,
  withOneMoreBoot,
} from "../src/build/boot.js";

/** What a workerd spawn that never left the ground rejects `ready` with. */
function spawnRace(): Error {
  return Object.assign(new Error("Failed to connect"), {
    syscall: "connect",
    code: "ENOENT",
  });
}

describe("a boot that never happened", () => {
  it("is a RuntimeDidNotStart, so the build tries once more", async () => {
    let boots = 0;
    const description = await withOneMoreBoot(() => {
      boots += 1;
      return bootedWithin(
        boots === 1 ? Promise.reject(spawnRace()) : Promise.resolve("ready"),
      );
    });
    expect(boots).toBe(2);
    expect(description).toBe("ready");
  });

  it("keeps the spawn failure as the reason when both boots fail", async () => {
    const outcome = await withOneMoreBoot(() =>
      bootedWithin(Promise.reject(spawnRace())),
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(RuntimeDidNotStart);
    expect((outcome as Error).message).toContain("Failed to connect");
  });
});

describe("a boot that did happen", () => {
  it("hands a failure from the code being built back untouched", async () => {
    const refusal = new Error('the module must export a "tools" array');
    const outcome = await withOneMoreBoot(() =>
      bootedWithin(Promise.reject(refusal)),
    ).catch((error: unknown) => error);
    expect(outcome).toBe(refusal);
  });
});
