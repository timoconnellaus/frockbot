import { describe, expect, test } from "bun:test";
import {
  decodeAuthorizationState,
  encodeAuthorizationState,
  isStrongAuthorizationStateSecretV1,
  type AuthorizationState,
} from "./authorization-state.js";

const SECRET = "an-independent-random-secret-0123456789";

function state(
  overrides: Partial<AuthorizationState> = {},
): AuthorizationState {
  return {
    schemaVersion: 1,
    authorizationStateId: "state-1",
    userId: "user-1",
    connectionId: "mcp-1",
    returnTarget: "browser",
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

describe("the signed callback state", () => {
  test("round-trips, and the payload is the identity a callback acts as", async () => {
    const encoded = await encodeAuthorizationState(state(), SECRET);
    expect(await decodeAuthorizationState(encoded, SECRET)).toMatchObject({
      userId: "user-1",
      connectionId: "mcp-1",
      authorizationStateId: "state-1",
    });
  });

  test("keeps the wire format it had inside plugin-composio", async () => {
    // Two base64url segments joined by a dot: a state minted before the move
    // to `connection-core` must still verify after it.
    const encoded = await encodeAuthorizationState(state(), SECRET);
    const [payload, signature, extra] = encoded.split(".");
    expect(extra).toBeUndefined();
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      JSON.parse(atob(payload!.replaceAll("-", "+").replaceAll("_", "/"))),
    ).toMatchObject({ schemaVersion: 1, userId: "user-1" });
  });

  test("refuses a tampered payload", async () => {
    const encoded = await encodeAuthorizationState(state(), SECRET);
    const [payload, signature] = encoded.split(".");
    const forged = JSON.stringify({ ...state(), userId: "user-2" });
    const swapped = btoa(forged)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(swapped).not.toBe(payload);
    await expect(
      decodeAuthorizationState(`${swapped}.${signature}`, SECRET),
    ).rejects.toThrow(/invalid/);
  });

  test("refuses a state signed with another secret", async () => {
    const encoded = await encodeAuthorizationState(state(), SECRET);
    await expect(
      decodeAuthorizationState(encoded, `${SECRET}-other`),
    ).rejects.toThrow(/invalid/);
  });

  test("refuses an expired state", async () => {
    const encoded = await encodeAuthorizationState(
      state({ expiresAt: Date.now() - 1 }),
      SECRET,
    );
    await expect(decodeAuthorizationState(encoded, SECRET)).rejects.toThrow(
      /expired/,
    );
  });

  test("refuses a malformed token rather than reading half of one", async () => {
    for (const value of ["", "a", "a.b.c", "..", "not-base64url!.x"]) {
      await expect(decodeAuthorizationState(value, SECRET)).rejects.toThrow();
    }
  });
});

describe("the secret strength check", () => {
  test("refuses short, repeated, and placeholder secrets", () => {
    expect(isStrongAuthorizationStateSecretV1("short")).toBe(false);
    expect(isStrongAuthorizationStateSecretV1("ab".repeat(32))).toBe(false);
    expect(isStrongAuthorizationStateSecretV1("a".repeat(64))).toBe(false);
    expect(
      isStrongAuthorizationStateSecretV1(
        "replace-with-an-independent-random-secret",
      ),
    ).toBe(false);
  });

  test("accepts an independent random secret", () => {
    expect(isStrongAuthorizationStateSecretV1(SECRET)).toBe(true);
  });
});
