import { describe, expect, test } from "bun:test";
import {
  claimEmailUsernameV1,
  readEmailUsernameV1,
  releaseEmailUsernameV1,
  resolveEmailUsernameV1,
  type EmailUsernameDirectoryKvV1,
} from "./directory.ts";

function memoryKv(): EmailUsernameDirectoryKvV1 & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => void map.set(key, structuredClone(value)),
    delete: (key) => map.delete(key),
    keys: () => [...map.keys()].sort(),
  };
}

describe("the email username directory", () => {
  test("keeps a username to one account", () => {
    const kv = memoryKv();
    expect(
      claimEmailUsernameV1(kv, { userId: "user-1", username: "tim" }),
    ).toEqual({ status: "claimed" });
    expect(
      claimEmailUsernameV1(kv, { userId: "user-2", username: "tim" }),
    ).toEqual({ status: "taken" });
    expect(resolveEmailUsernameV1(kv, "tim")).toBe("user-1");
    expect(readEmailUsernameV1(kv, "user-2")).toBeUndefined();
    // Claiming the one already held changes nothing.
    expect(
      claimEmailUsernameV1(kv, { userId: "user-1", username: "tim" }),
    ).toEqual({ status: "claimed" });
    expect(readEmailUsernameV1(kv, "user-1")).toBe("tim");
  });

  test("a change releases the old username in the same write", () => {
    const kv = memoryKv();
    claimEmailUsernameV1(kv, { userId: "user-1", username: "tim" });
    claimEmailUsernameV1(kv, { userId: "user-1", username: "timo" });
    expect(resolveEmailUsernameV1(kv, "tim")).toBeUndefined();
    expect(resolveEmailUsernameV1(kv, "timo")).toBe("user-1");
    expect(
      claimEmailUsernameV1(kv, { userId: "user-2", username: "tim" }),
    ).toEqual({ status: "claimed" });
    expect(kv.keys()).toEqual([
      "email:user:v1:user-1",
      "email:user:v1:user-2",
      "email:username:v1:tim",
      "email:username:v1:timo",
    ]);
  });

  test("releasing leaves nothing behind, and a taken claim leaves the old one", () => {
    const kv = memoryKv();
    claimEmailUsernameV1(kv, { userId: "user-1", username: "tim" });
    claimEmailUsernameV1(kv, { userId: "user-2", username: "ada" });
    expect(
      claimEmailUsernameV1(kv, { userId: "user-2", username: "tim" }),
    ).toEqual({ status: "taken" });
    expect(readEmailUsernameV1(kv, "user-2")).toBe("ada");
    releaseEmailUsernameV1(kv, "user-1");
    releaseEmailUsernameV1(kv, "user-2");
    releaseEmailUsernameV1(kv, "user-3");
    expect(kv.keys()).toEqual([]);
  });

  test("refuses to store a username out of shape", () => {
    const kv = memoryKv();
    for (const username of ["ti", "Tim", "fox.tim", "tim-", "abuse"]) {
      expect(() =>
        claimEmailUsernameV1(kv, { userId: "user-1", username }),
      ).toThrow();
    }
    expect(kv.keys()).toEqual([]);
  });
});
