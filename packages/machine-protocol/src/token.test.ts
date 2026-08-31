import { describe, expect, test } from "bun:test";
import {
  MACHINE_AUTHORIZATION_SCHEME,
  MachineTokenError,
  constantTimeEqualsV1,
  machineBearerTokenV1,
  machineTokenClaimsV1,
  machineTokenDigestV1,
  machineTokenMatchesRecordV1,
  mintMachineTokenV1,
  verifyMachineTokenV1,
} from "./token.ts";

const SECRET = "machine-token-secret-value-32-bytes";
const MACHINE_ID = "994dc2ee-3f42-4a4d-9f2a-0a3f6f0d1b77";
const CLAIMS = { u: "user-1", m: MACHINE_ID, v: 1 } as const;

describe("machine token", () => {
  test("round-trips its claims and is deterministic", async () => {
    const token = await mintMachineTokenV1(SECRET, CLAIMS);
    expect(await mintMachineTokenV1(SECRET, CLAIMS)).toBe(token);
    expect(await verifyMachineTokenV1(SECRET, token)).toEqual({ ...CLAIMS });
  });

  test("a tampered payload, signature or secret never verifies", async () => {
    const token = await mintMachineTokenV1(SECRET, CLAIMS);
    const [payload, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ u: "user-2", m: MACHINE_ID, v: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.${signature!.slice(0, -1)}A`,
      payload!,
      "",
      "x".repeat(4_096),
    ]) {
      await expect(verifyMachineTokenV1(SECRET, bad)).rejects.toThrow(
        MachineTokenError,
      );
    }
    await expect(
      verifyMachineTokenV1("another-secret-of-sufficient-length", token),
    ).rejects.toThrow(/machine token is invalid/);
  });

  test("a secret too short to be a secret fails loudly, not silently", async () => {
    await expect(mintMachineTokenV1("short", CLAIMS)).rejects.toThrow(
      /MACHINE_TOKEN_SECRET/,
    );
  });

  test("claims are exact-key and bounded", () => {
    expect(machineTokenClaimsV1({ ...CLAIMS })).toEqual({ ...CLAIMS });
    for (const bad of [
      { ...CLAIMS, extra: 1 },
      { u: "", m: MACHINE_ID, v: 1 },
      { u: "user-1", m: "not a machine id", v: 1 },
      { u: "user-1", m: MACHINE_ID, v: 0 },
      { u: "user-1", m: MACHINE_ID, v: 1.5 },
      { u: "user-1", m: MACHINE_ID },
      [CLAIMS],
      null,
    ]) {
      expect(() => machineTokenClaimsV1(bad)).toThrow(MachineTokenError);
    }
  });

  test("verification says nothing about which half failed", async () => {
    const token = await mintMachineTokenV1(SECRET, CLAIMS);
    const failure = await verifyMachineTokenV1(SECRET, `${token}x`).catch(
      (error: MachineTokenError) => error,
    );
    expect((failure as MachineTokenError).status).toBe(401);
    expect((failure as MachineTokenError).message).toBe(
      "machine token is invalid",
    );
  });
});

describe("digest-only storage", () => {
  test("the digest is a hex SHA-256 and the token is not recoverable from it", async () => {
    const token = await mintMachineTokenV1(SECRET, CLAIMS);
    const digest = await machineTokenDigestV1(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token.slice(0, 8));
    expect(await machineTokenDigestV1(token)).toBe(digest);
    expect(await machineTokenDigestV1(`${token} `)).not.toBe(digest);
  });

  test("the record check refuses a wrong key version, a wrong digest and a revocation", async () => {
    const token = await mintMachineTokenV1(SECRET, CLAIMS);
    const digest = await machineTokenDigestV1(token);
    const record = { keyVersion: 1, tokenDigest: digest };
    expect(machineTokenMatchesRecordV1(record, CLAIMS, digest)).toBe(true);
    // Revocation bumps the key version: a token minted at v1 verifies at the
    // edge and is still refused by the record, which is the second check.
    const rotated = await mintMachineTokenV1(SECRET, { ...CLAIMS, v: 2 });
    expect(
      machineTokenMatchesRecordV1(
        record,
        { ...CLAIMS, v: 2 },
        await machineTokenDigestV1(rotated),
      ),
    ).toBe(false);
    expect(machineTokenMatchesRecordV1(record, CLAIMS, "b".repeat(64))).toBe(
      false,
    );
    expect(
      machineTokenMatchesRecordV1(
        { ...record, revokedAt: "2026-09-01T00:00:00.000Z" },
        CLAIMS,
        digest,
      ),
    ).toBe(false);
  });
});

describe("constant-time compare", () => {
  test("answers on content, not on where the first difference is", () => {
    expect(constantTimeEqualsV1("abc", "abc")).toBe(true);
    expect(constantTimeEqualsV1("abc", "abd")).toBe(false);
    expect(constantTimeEqualsV1("abc", "zbc")).toBe(false);
    expect(constantTimeEqualsV1("abc", "abcd")).toBe(false);
    expect(constantTimeEqualsV1("", "")).toBe(true);
    expect(constantTimeEqualsV1("abc", "")).toBe(false);
  });
});

describe("bearer presentation", () => {
  test("reads a token only under the declared scheme", () => {
    expect(
      machineBearerTokenV1(`${MACHINE_AUTHORIZATION_SCHEME} abc.def`),
    ).toBe("abc.def");
    expect(machineBearerTokenV1("Bearer   abc.def  ")).toBe("abc.def");
    for (const bad of [
      "bearer abc.def",
      "Basic abc.def",
      "abc.def",
      "Bearer ",
      "Bearer",
      null,
      undefined,
    ]) {
      expect(machineBearerTokenV1(bad)).toBeUndefined();
    }
  });
});
