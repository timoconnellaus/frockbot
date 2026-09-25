// The User Contribution over an in-memory socket list: what a machine is sent
// when it connects and when work is dispatched, presence, and revocation.
import { describe, expect, test } from "bun:test";
import { MachineUserBackendContribution } from "./user.ts";
import {
  createMemoryMachineSocketsV1,
  createMemoryMachineStorageV1,
  type MemoryMachineSocketsV1,
} from "./testing.ts";
import type { MachineSocketV1 } from "./device.ts";
import {
  MACHINE_LIMITS_V1,
  MACHINE_SOCKET_REVOKED_CODE_V1,
  decodeMachineSocketFrameV1,
  machineTokenDigestV1,
  type MachineTokenClaimsV1,
} from "@frockbot/core/machine-protocol";

const SECRET = "machine-user-secret-0123456789abcdef";
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

let now = T0;
let sockets: MemoryMachineSocketsV1;

function contribution(secret: string | undefined) {
  now = T0;
  sockets = createMemoryMachineSocketsV1();
  return new MachineUserBackendContribution({
    storage: createMemoryMachineStorageV1(),
    readSecret: () => secret,
    sockets,
    now: () => now,
  });
}

/** Connect as the Durable Object does: authorize, then accept and send. */
async function connect(
  authority: MachineUserBackendContribution,
  machine: { machineId: string; claims: MachineTokenClaimsV1; digest: string },
): Promise<MachineSocketV1> {
  const opened = await authority.connect(
    machine.claims,
    machine.digest,
    machine.machineId,
  );
  return sockets.accept(machine.machineId, opened.frame);
}

/** The command ids in the next frame down a socket. */
async function nextFrame(socket: MachineSocketV1): Promise<string[]> {
  const event = await socket.receive();
  if (event.type !== "message") throw new Error(`closed: ${event.code}`);
  const frame = decodeMachineSocketFrameV1(JSON.parse(event.data));
  if (frame.type !== "commands") throw new Error(`a ${frame.type} frame`);
  return frame.commands.map((command) => command.commandId);
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
  test("a connecting machine is sent every command still waiting", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "connect-user");
    await authority.dispatch(command(machine.machineId, "tool:1:1:0"));
    const socket = await connect(authority, machine);
    expect(await nextFrame(socket)).toEqual(["tool:1:1:0"]);
  });

  test("a dispatch is pushed down an open socket at once", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "push-user");
    const socket = await connect(authority, machine);
    expect(await nextFrame(socket)).toEqual([]);
    await authority.dispatch(command(machine.machineId, "tool:1:1:0"));
    expect(await nextFrame(socket)).toEqual(["tool:1:1:0"]);
  });

  test("a connect with a revoked or foreign token is refused", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "refused-user");
    await expect(
      authority.connect(machine.claims, "0".repeat(64), machine.machineId),
    ).rejects.toThrow(/invalid/);
    await authority.revoke(machine.machineId);
    await expect(connect(authority, machine)).rejects.toThrow(/invalid/);
  });

  test("presence is an open socket, and revocation closes it", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "presence-user");
    expect((await authority.list()).machines[0]?.connected).toBe(false);
    const socket = await connect(authority, machine);
    await nextFrame(socket);
    expect((await authority.list()).machines[0]?.connected).toBe(true);
    expect(
      (await authority.describeTarget(machine.machineId)).entry?.connected,
    ).toBe(true);
    socket.close();
    expect((await authority.list()).machines[0]?.connected).toBe(false);
    const again = await connect(authority, machine);
    await nextFrame(again);
    await authority.revoke(machine.machineId);
    expect(await again.receive()).toMatchObject({
      type: "close",
      code: MACHINE_SOCKET_REVOKED_CODE_V1,
    });
    expect((await authority.list()).machines[0]?.connected).toBe(false);
  });

  test("a lease that lapses while the machine stays connected is offered again", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "lease-user");
    const socket = await connect(authority, machine);
    await nextFrame(socket);
    await authority.dispatch(command(machine.machineId, "tool:1:1:0"));
    expect(await nextFrame(socket)).toEqual(["tool:1:1:0"]);
    await authority.claim(
      machine.claims,
      machine.digest,
      machine.machineId,
      "tool:1:1:0",
    );
    // The agent stalled. The next dispatch sweeps the lapsed lease and
    // offers both.
    now = T0 + MACHINE_LIMITS_V1.leaseMs + 1;
    await authority.dispatch(command(machine.machineId, "tool:1:2:0"));
    expect(await nextFrame(socket)).toEqual(["tool:1:2:0"]);
    expect(await nextFrame(socket)).toEqual(["tool:1:1:0"]);
  });

  test("a closed socket records when the machine was last seen", async () => {
    const authority = contribution(SECRET);
    const machine = await enrolled(authority, "seen-user");
    now = T0 + 5_000;
    await authority.disconnected(machine.machineId);
    expect((await authority.readMachine(machine.machineId))?.lastSeenAt).toBe(
      new Date(T0 + 5_000).toISOString(),
    );
    // A machine this User does not hold is nothing to record.
    await authority.disconnected("mac-nobody");
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
    // Registered, but no socket is open.
    expect(target.entry?.connected).toBe(false);
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
