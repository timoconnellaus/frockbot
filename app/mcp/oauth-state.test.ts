import { describe, expect, test } from "bun:test";
import { signMcpOAuthStateV1, verifyMcpOAuthStateV1 } from "./oauth-state.js";

function keyring(keys: Record<string, number>, currentKeyId: string): string {
  const encode = (seed: number) =>
    btoa(
      String.fromCharCode(
        ...Uint8Array.from({ length: 32 }, (_, index) => index + seed),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId,
    keys: Object.fromEntries(
      Object.entries(keys).map(([id, seed]) => [id, encode(seed)]),
    ),
  });
}

const now = Date.parse("2026-09-24T00:00:00.000Z");
const state = {
  userId: "tim",
  connectionId: "connection-1",
  attemptId: "cx-1",
  expiresAt: now + 60_000,
};

describe("an MCP sign-in's state", () => {
  test("verifies what this deployment signed, until it expires", async () => {
    const ring = keyring({ primary: 3 }, "primary");
    const signed = await signMcpOAuthStateV1(ring, state);
    expect(await verifyMcpOAuthStateV1(ring, signed, now)).toEqual(state);
    expect(
      await verifyMcpOAuthStateV1(ring, signed, state.expiresAt),
    ).toBeUndefined();
  });

  test("refuses anything altered, or signed under another keyring", async () => {
    const ring = keyring({ primary: 3 }, "primary");
    const signed = await signMcpOAuthStateV1(ring, state);
    const [body, signature] = signed.split(".");
    const other = await signMcpOAuthStateV1(ring, {
      ...state,
      userId: "someone-else",
    });
    for (const forged of [
      `${other.split(".")[0]}.${signature}`,
      `${body}.${signature}x`,
      `${body}`,
      `${signed}.extra`,
      "",
      "x".repeat(2_000),
      undefined,
    ]) {
      expect(await verifyMcpOAuthStateV1(ring, forged, now)).toBeUndefined();
    }
    expect(
      await verifyMcpOAuthStateV1(
        keyring({ primary: 9 }, "primary"),
        signed,
        now,
      ),
    ).toBeUndefined();
  });

  test("still verifies across a keyring rotation", async () => {
    const before = keyring({ old: 3 }, "old");
    const signed = await signMcpOAuthStateV1(before, state);
    const after = keyring({ old: 3, next: 5 }, "next");
    expect(await verifyMcpOAuthStateV1(after, signed, now)).toEqual(state);
  });

  test("signs only identifiers", async () => {
    const ring = keyring({ primary: 3 }, "primary");
    await expect(
      signMcpOAuthStateV1(ring, { ...state, userId: "tim\u0000x" }),
    ).rejects.toThrow("invalid");
  });
});
