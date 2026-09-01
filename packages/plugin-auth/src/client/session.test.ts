import { describe, expect, test } from "bun:test";
import { decodeAuthSessionProjectionV1 } from "../shared.js";
import { createAuthSessionClient } from "./session.js";

const authenticated = {
  schemaVersion: 1,
  status: "authenticated",
  mode: "better-auth",
  user: {
    id: "alice",
    name: "Alice",
    email: "alice@example.com",
    isAdmin: false,
  },
} as const;

describe("auth session projection", () => {
  test("strictly decodes exact session modes", () => {
    expect(decodeAuthSessionProjectionV1(authenticated)).toEqual(authenticated);
    expect(
      decodeAuthSessionProjectionV1({ schemaVersion: 1, status: "anonymous" }),
    ).toEqual({ schemaVersion: 1, status: "anonymous" });

    for (const invalid of [
      { ...authenticated, extra: true },
      { ...authenticated, user: { ...authenticated.user, extra: true } },
      { ...authenticated, mode: "cookie" },
    ]) {
      expect(() => decodeAuthSessionProjectionV1(invalid)).toThrow();
    }
    const hidden = { ...authenticated } as Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => decodeAuthSessionProjectionV1(hidden)).toThrow();
    expect(() =>
      decodeAuthSessionProjectionV1({
        ...authenticated,
        [Symbol("hidden")]: true,
      }),
    ).toThrow();
  });
});

describe("auth-owned sign-out", () => {
  test("serializes double-click, refreshes authority, and is safely repeatable", async () => {
    let current: unknown = authenticated;
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createAuthSessionClient({
      read: () => Promise.resolve(current),
      signOut: async () => {
        calls += 1;
        await pending;
        current = { schemaVersion: 1, status: "anonymous" };
        return current;
      },
    });
    await session.refresh();

    const first = session.signOut();
    const second = session.signOut();
    expect(session.signingOut.value).toBe(true);
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);

    expect(session.projection.value).toEqual({
      schemaVersion: 1,
      status: "anonymous",
    });
    expect(session.signingOut.value).toBe(false);
    await session.signOut();
    expect(calls).toBe(1);
  });

  test("keeps the authenticated projection when sign-out fails", async () => {
    const session = createAuthSessionClient({
      read: () => Promise.resolve(authenticated),
      signOut: () => Promise.reject(new Error("network unavailable")),
    });
    await session.refresh();

    await expect(session.signOut()).rejects.toThrow("network unavailable");
    expect(session.projection.value).toEqual(authenticated);
    expect(session.signingOut.value).toBe(false);
  });

  test("makes development identity sign-out explicitly unavailable", async () => {
    let calls = 0;
    const session = createAuthSessionClient({
      read: () =>
        Promise.resolve({
          ...authenticated,
          mode: "development",
        }),
      signOut: () => {
        calls += 1;
        return Promise.resolve({ schemaVersion: 1, status: "anonymous" });
      },
    });
    await session.refresh();

    await expect(session.signOut()).rejects.toThrow(
      "Development identity is selected by the local development login",
    );
    expect(calls).toBe(0);
  });

  test("requires authoritative anonymous state after successful sign-out", async () => {
    const session = createAuthSessionClient({
      read: () => Promise.resolve(authenticated),
      signOut: () => Promise.resolve(authenticated),
    });
    await session.refresh();

    await expect(session.signOut()).rejects.toThrow(
      "Sign-out did not clear the authenticated session",
    );
    expect(session.projection.value).toEqual(authenticated);
  });
});
