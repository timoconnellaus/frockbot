import { describe, expect, test } from "bun:test";
import { MACHINE_LIMITS_V1 } from "@frockbot/machine-protocol";
import {
  machinePairingCodeDigestV1,
  machinePairingNonceV1,
  mintMachinePairingCodeV1,
  verifyMachinePairingCodeV1,
} from "./pairing.ts";

const SECRET = "machine-pairing-secret-0123456789abcdef";

describe("the pairing code", () => {
  test("round-trips the User and machine it was minted for", async () => {
    const claims = {
      userId: "user-with-a-fairly-long-identifier-0123",
      machineId: crypto.randomUUID(),
      nonce: machinePairingNonceV1(),
    };
    const code = await mintMachinePairingCodeV1(SECRET, claims);
    expect(code.length).toBeLessThanOrEqual(MACHINE_LIMITS_V1.pairingCode);
    expect(await verifyMachinePairingCodeV1(SECRET, code)).toEqual(claims);
  });

  test("a tampered payload, a wrong secret and a truncated code are all refused", async () => {
    const claims = {
      userId: "pairing-user",
      machineId: crypto.randomUUID(),
      nonce: machinePairingNonceV1(),
    };
    const code = await mintMachinePairingCodeV1(SECRET, claims);
    const [payload, tag] = [
      code.slice(0, code.lastIndexOf(".")),
      code.slice(code.lastIndexOf(".") + 1),
    ];
    const otherMachine = await mintMachinePairingCodeV1(SECRET, {
      ...claims,
      machineId: crypto.randomUUID(),
    });
    // The tag of one code on the payload of another: the pairing that would
    // let a caller redirect an offer at a machine it names itself.
    const spliced = `${payload}.${otherMachine.slice(otherMachine.lastIndexOf(".") + 1)}`;
    for (const forged of [
      spliced,
      `${payload}x.${tag}`,
      payload,
      code.slice(0, -1),
      "",
    ]) {
      await expect(verifyMachinePairingCodeV1(SECRET, forged)).rejects.toThrow(
        /invalid/,
      );
    }
    await expect(
      verifyMachinePairingCodeV1(`${SECRET}-other`, code),
    ).rejects.toThrow(/invalid/);
  });

  test("no two mints are the same code, and the digest is not the code", async () => {
    const machineId = crypto.randomUUID();
    const first = await mintMachinePairingCodeV1(SECRET, {
      userId: "u",
      machineId,
      nonce: machinePairingNonceV1(),
    });
    const second = await mintMachinePairingCodeV1(SECRET, {
      userId: "u",
      machineId,
      nonce: machinePairingNonceV1(),
    });
    expect(first).not.toBe(second);
    const digest = await machinePairingCodeDigestV1(first);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(first);
  });

  test("a secret that is missing or too weak refuses to mint", async () => {
    await expect(
      mintMachinePairingCodeV1("short", {
        userId: "u",
        machineId: crypto.randomUUID(),
        nonce: machinePairingNonceV1(),
      }),
    ).rejects.toThrow(/MACHINE_TOKEN_SECRET/);
  });
});
