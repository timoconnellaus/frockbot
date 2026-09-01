// The User Contribution's own two facts: a hold that ends early, and a door
// that stays shut without the deployment secret.
import { describe, expect, test } from "bun:test";
import { MachineUserBackendContribution } from "./user.ts";
import { createMemoryMachineStorageV1 } from "./testing.ts";

const SECRET = "machine-user-secret-0123456789abcdef";
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

function contribution(secret: string | undefined) {
  return new MachineUserBackendContribution({
    storage: createMemoryMachineStorageV1(),
    readSecret: () => secret,
    now: () => T0,
    // A hold that never ends on its own, so only a dispatch can end it.
    sleep: () => new Promise<void>(() => {}),
  });
}

describe("the User Contribution", () => {
  test("a long poll ends the moment a command is queued", async () => {
    const authority = contribution(SECRET);
    const offer = await authority.createPairing("hold-user", {});
    const receipt = await authority.enroll(
      { userId: "hold-user", machineId: offer.machineId, nonce: "n" },
      {
        schemaVersion: 1,
        code: offer.code,
        label: "held.local",
        platform: "macos",
        agentVersion: "0.0.1",
        capabilities: ["exec"],
      },
    );
    const { machineTokenDigestV1 } = await import("@frockbot/machine-protocol");
    const held = authority.poll(
      { u: "hold-user", m: offer.machineId, v: receipt.keyVersion },
      await machineTokenDigestV1(receipt.token),
      offer.machineId,
      25,
    );
    // The `sleep` above never resolves, so this only returns because the
    // dispatch woke it — which is the whole claim.
    await authority.dispatch({
      schemaVersion: 1,
      commandId: "tool:1:1:0",
      machineId: offer.machineId,
      botId: "bot",
      runId: "run",
      turn: 1,
      approvalId: "tool:1:1:0",
      op: {
        kind: "exec",
        command: "uname -a",
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      },
      issuedAt: new Date(T0).toISOString(),
      status: "queued",
    });
    const answered = await held;
    expect(answered.commands.map((command) => command.commandId)).toEqual([
      "tool:1:1:0",
    ]);
  });

  test("without a secret nothing can be paired", async () => {
    await expect(
      contribution(undefined).createPairing("u", {}),
    ).rejects.toThrow(/not configured/);
  });
});
