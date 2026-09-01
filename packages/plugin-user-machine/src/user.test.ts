// The User Contribution's own two facts: a hold that ends early, and a door
// that stays shut without the deployment secret.
import { describe, expect, test } from "bun:test";
import { MachineUserBackendContribution } from "./user.ts";
import { createMemoryMachineStorageV1 } from "./testing.ts";
import { machineTokenDigestV1 } from "@frockbot/machine-protocol";

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

/** Pair, enroll, and hand back what a machine needs to speak. */
async function enrolled(
  authority: MachineUserBackendContribution,
  userId: string,
) {
  const offer = await authority.createPairing(userId, {});
  const receipt = await authority.enroll(
    { userId, machineId: offer.machineId, nonce: "n" },
    {
      schemaVersion: 1,
      code: offer.code,
      label: "held.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec"],
    },
  );
  return {
    machineId: offer.machineId,
    claims: { u: userId, m: offer.machineId, v: receipt.keyVersion },
    digest: await machineTokenDigestV1(receipt.token),
  };
}

function command(machineId: string, commandId: string) {
  return {
    schemaVersion: 1 as const,
    commandId,
    machineId,
    botId: "bot-1",
    runId: "run-1",
    turn: 1,
    approvalId: commandId,
    op: {
      kind: "exec" as const,
      command: "uname -a",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    issuedAt: new Date(T0).toISOString(),
    status: "queued" as const,
  };
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

  test("one read answers the five questions a control tool has to ask", async () => {
    const authority = contribution(SECRET);
    const { machineId } = await enrolled(authority, "target-user");
    const target = await authority.describeTarget(machineId);
    expect(target.entry?.machineId).toBe(machineId);
    expect(target.entry?.connected).toBe(true);
    expect(target.entry?.capabilities).toEqual(["exec"]);
    expect(target.queuedCommands).toBe(0);
    expect(target.commandsToday).toBe(0);
    await authority.dispatch(command(machineId, "tool:1:1:0"));
    const after = await authority.describeTarget(machineId);
    expect(after.queuedCommands).toBe(1);
    expect(after.commandsToday).toBe(1);
    // A machine this User does not hold is a view with no row, never a throw:
    // the tool has to be able to say so in words.
    const missing = await authority.describeTarget("mac-nobody");
    expect(missing.entry).toBeUndefined();
  });

  test("a recorded result is delivered once, and a replay tells nobody", async () => {
    const authority = contribution(SECRET);
    const { machineId, claims, digest } = await enrolled(
      authority,
      "deliver-user",
    );
    await authority.dispatch(command(machineId, "tool:1:1:0"));
    await authority.claim(claims, digest, machineId, "tool:1:1:0");
    const answer = {
      schemaVersion: 1,
      commandId: "tool:1:1:0",
      finishedAt: new Date(T0).toISOString(),
      outcome: "ok",
      truncated: false,
      exitCode: 0,
      stdout: "Darwin",
    };
    const first = await authority.recordResult(
      claims,
      digest,
      machineId,
      "tool:1:1:0",
      answer,
    );
    expect(first.status).toBe("recorded");
    const deliveries = await authority.takeDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      botId: "bot-1",
      commandId: "tool:1:1:0",
      machineId,
      outcome: "ok",
    });
    // The agent retried. "Recovery never silently duplicates" applies to the
    // telling as much as to the running.
    const replay = await authority.recordResult(
      claims,
      digest,
      machineId,
      "tool:1:1:0",
      answer,
    );
    expect(replay.status).toBe("replayed");
    // Taking is removing, and a replay writes nothing to take.
    expect(await authority.takeDeliveries()).toEqual([]);
  });
});
