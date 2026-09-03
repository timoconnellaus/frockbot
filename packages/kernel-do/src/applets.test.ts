import { describe, expect, test } from "bun:test";
import {
  appletBindingDigestV1,
  appletDirectoryEntryKey,
  appletFailureKey,
  appletGenerationIdV1,
  appletGenerationKey,
  appletIdV1,
  appletLoaderIdV1,
  appletStateNameV1,
  AppletViewerTokenError,
  APPLET_CURRENT_KEY,
  APPLET_DIRECTORY_REVISION_KEY,
  APPLET_LAST_KNOWN_GOOD_KEY,
  APPLET_MOUNT_INPUT_KEY,
  APPLET_VIEWER_TOKEN_TTL_MS,
  decodeAppletFailureV1,
  decodeAppletHealthV1,
  decodeAppletMountInputV1,
  decodeAppletPointerV1,
  decodeFocusedAppletV1,
  mintAppletViewerTokenV1,
  newAppletIdV1,
  verifyAppletViewerTokenV1,
} from "./applets.js";

const SECRET = "applet-viewer-secret-0123456789abcdef";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const APPLET = `user-42.${"c".repeat(32)}`;

describe("Applet durable keys", () => {
  test("the keys are exactly the ones the plan names", () => {
    expect(appletDirectoryEntryKey(APPLET)).toBe(`applets:entry:${APPLET}`);
    expect(APPLET_DIRECTORY_REVISION_KEY).toBe("applets:directory-revision");
    expect(APPLET_CURRENT_KEY).toBe("applet:current");
    expect(APPLET_LAST_KNOWN_GOOD_KEY).toBe("applet:last-known-good");
    expect(APPLET_MOUNT_INPUT_KEY).toBe("applet:mount-input");
    expect(appletGenerationKey("g1")).toBe("applet:generation:g1");
  });

  test("failure keys are attempt-ordered under one generation", () => {
    expect(appletFailureKey("g1", 1)).toBe("applet:failure:g1:0001");
    expect(
      [appletFailureKey("g1", 10), appletFailureKey("g1", 2)].sort(),
    ).toEqual([appletFailureKey("g1", 2), appletFailureKey("g1", 10)]);
  });

  test("the Durable Object name is `<userId>:<appletId>`", () => {
    expect(appletStateNameV1("user-42", APPLET)).toBe(`user-42:${APPLET}`);
    expect(() => appletStateNameV1("user:42", APPLET)).toThrow();
    expect(() => appletStateNameV1("user-42", "not-an-applet")).toThrow();
  });
});

describe("Applet ids", () => {
  test("an id is the ADR 0015 share shape", () => {
    expect(appletIdV1("user-42", "d".repeat(32))).toBe(
      `user-42.${"d".repeat(32)}`,
    );
    expect(() => appletIdV1("User-42", "d".repeat(32))).toThrow();
    expect(() => appletIdV1("user-42", "nope")).toThrow();
  });

  test("a minted id parses and is not guessable from the owner", () => {
    const first = newAppletIdV1("user-42");
    const second = newAppletIdV1("user-42");
    expect(first.startsWith("user-42.")).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("Applet loader identity", () => {
  test("the applet id is an input, so identical code never shares an env", async () => {
    const bindingDigest = await appletBindingDigestV1({
      userId: "user-42",
      capabilities: ["scheduleAlarm", "invokeModel"],
      contract: 1,
    });
    const first = await appletLoaderIdV1({
      contract: 1,
      appletId: `user-42.${"1".repeat(32)}`,
      serverHash: HASH_A,
      bindingDigest,
    });
    const second = await appletLoaderIdV1({
      contract: 1,
      appletId: `user-42.${"2".repeat(32)}`,
      serverHash: HASH_A,
      bindingDigest,
    });
    expect(first).not.toBe(second);
  });

  test("a changed server artifact or binding digest is a new loader id", async () => {
    const base = {
      contract: 1,
      appletId: APPLET,
      serverHash: HASH_A,
      bindingDigest: HASH_A,
    };
    const id = await appletLoaderIdV1(base);
    expect(await appletLoaderIdV1(base)).toBe(id);
    expect(await appletLoaderIdV1({ ...base, serverHash: HASH_B })).not.toBe(
      id,
    );
    expect(await appletLoaderIdV1({ ...base, bindingDigest: HASH_B })).not.toBe(
      id,
    );
  });

  test("the binding digest ignores capability order and follows the User", async () => {
    const one = await appletBindingDigestV1({
      userId: "user-42",
      capabilities: ["invokeModel", "scheduleAlarm"],
      contract: 1,
    });
    const two = await appletBindingDigestV1({
      userId: "user-42",
      capabilities: ["scheduleAlarm", "invokeModel"],
      contract: 1,
    });
    const other = await appletBindingDigestV1({
      userId: "user-43",
      capabilities: ["scheduleAlarm", "invokeModel"],
      contract: 1,
    });
    expect(one).toBe(two);
    expect(one).not.toBe(other);
  });

  test("generation ids sort by their creation instant", () => {
    const early = appletGenerationIdV1("2026-09-03T00:00:00.000Z", HASH_A);
    const late = appletGenerationIdV1("2026-09-03T00:00:01.000Z", HASH_A);
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe("Applet durable records", () => {
  test("a pointer decodes exactly", () => {
    const pointer = {
      schemaVersion: 1 as const,
      generationId: "g1",
      changedAt: "2026-09-03T00:00:00.000Z",
    };
    expect(decodeAppletPointerV1(pointer)).toEqual(pointer);
    expect(() => decodeAppletPointerV1({ ...pointer, extra: 1 })).toThrow();
    expect(() =>
      decodeAppletPointerV1({ ...pointer, schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
  });

  test("a failure record carries its phase, attempt, and diagnostics", () => {
    const failure = {
      schemaVersion: 1 as const,
      appletId: APPLET,
      generationId: "g1",
      attempt: 2,
      phase: "health",
      message: "tools do not match",
      diagnostics: ["declared:add_todo", "reported:"],
      recordedAt: "2026-09-03T00:00:00.000Z",
    };
    expect(decodeAppletFailureV1(failure)).toEqual(failure as never);
    expect(() =>
      decodeAppletFailureV1({ ...failure, phase: "boom" }),
    ).toThrow();
    expect(() => decodeAppletFailureV1({ ...failure, attempt: 0 })).toThrow();
  });

  test("the mount input is everything the alarm handler needs", () => {
    const input = {
      schemaVersion: 1 as const,
      userId: "user-42",
      appletId: APPLET,
      generationId: "g1",
      loaderId: HASH_A,
      serverHash: HASH_B,
      contract: 1,
    };
    expect(decodeAppletMountInputV1(input)).toEqual(input as never);
    expect(() =>
      decodeAppletMountInputV1({ ...input, loaderId: "no" }),
    ).toThrow();
  });

  test("a focused Applet may be null", () => {
    const focused = {
      schemaVersion: 1 as const,
      appletId: null,
      changedAt: "2026-09-03T00:00:00.000Z",
    };
    expect(decodeFocusedAppletV1(focused)).toEqual(focused);
    expect(
      decodeFocusedAppletV1({ ...focused, appletId: APPLET }).appletId,
    ).toBe(APPLET);
    expect(() =>
      decodeFocusedAppletV1({ ...focused, appletId: "nope" }),
    ).toThrow();
  });

  test("health is the contract, the tools, and the schema revision", () => {
    expect(
      decodeAppletHealthV1({ contract: 1, tools: ["a"], schemaRevision: 3 }),
    ).toEqual({ contract: 1, tools: ["a"], schemaRevision: 3 });
    expect(() =>
      decodeAppletHealthV1({ contract: 2, tools: [], schemaRevision: 0 }),
    ).toThrow(/contract/);
    expect(() =>
      decodeAppletHealthV1({
        contract: 1,
        tools: ["a", "a"],
        schemaRevision: 0,
      }),
    ).toThrow(/duplicate/);
  });
});

describe("Applet viewer tokens", () => {
  const claims = {
    u: "user-42",
    a: APPLET,
    g: "g1",
    exp: Math.floor((Date.now() + APPLET_VIEWER_TOKEN_TTL_MS) / 1_000),
  };

  test("a minted token verifies and answers with its claims", async () => {
    const token = await mintAppletViewerTokenV1(SECRET, claims);
    expect(await verifyAppletViewerTokenV1(SECRET, token)).toEqual(claims);
  });

  test("a token minted under another secret is refused", async () => {
    const token = await mintAppletViewerTokenV1(SECRET, claims);
    await expect(
      verifyAppletViewerTokenV1(`${SECRET}-other`, token),
    ).rejects.toThrow(AppletViewerTokenError);
  });

  test("an expired token is refused", async () => {
    const token = await mintAppletViewerTokenV1(SECRET, {
      ...claims,
      exp: Math.floor(Date.now() / 1_000) - 1,
    });
    await expect(verifyAppletViewerTokenV1(SECRET, token)).rejects.toThrow(
      /invalid/,
    );
  });

  test("a tampered payload is refused rather than re-signed", async () => {
    const token = await mintAppletViewerTokenV1(SECRET, claims);
    const [, signature] = token.split(".");
    const forged = `${btoa(
      JSON.stringify({ ...claims, a: `user-42.${"9".repeat(32)}` }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${signature}`;
    await expect(verifyAppletViewerTokenV1(SECRET, forged)).rejects.toThrow(
      /invalid/,
    );
  });

  test("the token is scoped: the claims name the User, Applet, and generation", async () => {
    const token = await mintAppletViewerTokenV1(SECRET, claims);
    const verified = await verifyAppletViewerTokenV1(SECRET, token);
    expect(verified.u).toBe("user-42");
    expect(verified.a).toBe(APPLET);
    expect(verified.g).toBe("g1");
  });

  test("a short secret is a deployment fault, not a 401", async () => {
    await expect(mintAppletViewerTokenV1("short", claims)).rejects.toThrow(
      /secret/,
    );
  });

  test("garbage is refused without a signature check crash", async () => {
    await expect(verifyAppletViewerTokenV1(SECRET, "nope")).rejects.toThrow(
      /invalid/,
    );
    await expect(verifyAppletViewerTokenV1(SECRET, 7)).rejects.toThrow(
      /invalid/,
    );
  });
});
