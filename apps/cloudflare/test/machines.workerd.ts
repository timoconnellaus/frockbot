// The registered-machine registry against a real User Durable Object.
//
// The claim this file makes is the one the plan makes: a machine's registry
// row, its command queue, its lease and its results are durable User state,
// and none of it depends on the object staying resident. So every step runs
// through the production RPCs — the same ones the gateway's routes call — and
// the object is evicted in the middle of the one sequence where losing state
// would matter: between a claim and the result that answers it. The machine's
// socket is opened on the object's own `fetch`, exactly as the gateway
// forwards a verified upgrade.
//
// The routes themselves are exercised in `plugin-user-machine`'s own unit
// suite (which drives the real `publicRoute` seam) and end to end in
// `test/integration/machines-registration.integration.ts`; what is proved here
// is the authority underneath them.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  MACHINE_SOCKET_REVOKED_CODE_V1,
  machineTokenDigestV1,
  mintMachineTokenV1,
  type MachineCommandV1,
  type MachineEnrollmentReceiptV1,
  type MachineListViewV1,
  type MachinePairingOfferV1,
} from "@frockbot/core/machine-protocol";
import {
  nextMachineFrame as nextFrame,
  nextMachineFrameOf,
  openMachineSocket as connect,
  upgradeMachineSocket as upgrade,
} from "./machine-socket.ts";

interface MachineRpc {
  createMachinePairing(input: unknown): Promise<MachinePairingOfferV1>;
  enrollMachine(input: unknown): Promise<MachineEnrollmentReceiptV1>;
  claimMachineCommand(input: unknown): Promise<{
    status: string;
    leaseExpiresAt: string;
  }>;
  recordMachineResult(input: unknown): Promise<{ status: string }>;
  dispatchMachineCommand(input: unknown): Promise<{ status: string }>;
  readMachineResult(input: unknown): Promise<unknown>;
  listMachines(input: unknown): Promise<MachineListViewV1>;
  revokeMachine(input: unknown): Promise<MachineListViewV1>;
}

function machines(userId: string): MachineRpc {
  // SAFETY: USER_CONFIGURATIONS is bound to UserConfiguration; the generated
  // stub type is too deep to instantiate here, so this names only the methods
  // this file calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as MachineRpc;
}

/**
 * The message one refused RPC answered with.
 *
 * `expect(...).rejects` would leave the stub's own rejected promise unhandled
 * — a cross-object RPC rejects the call *and* the disposable it hands back —
 * so refusals are caught here instead, and the message is asserted like any
 * other value.
 */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected this call to be refused");
}

/** One enrolled machine, through the same two RPCs the routes call. */
async function enrolled(userId: string, label = "Workerd-Mac.local") {
  const rpc = machines(userId);
  const offer = await rpc.createMachinePairing({ schemaVersion: 1, userId });
  const receipt = await rpc.enrollMachine({
    schemaVersion: 1,
    userId,
    machineId: offer.machineId,
    enrollment: {
      schemaVersion: 1,
      code: offer.code,
      label,
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
    },
  });
  return {
    rpc,
    machineId: offer.machineId,
    token: receipt.token,
    claims: { u: userId, m: offer.machineId, v: receipt.keyVersion },
    digest: await machineTokenDigestV1(receipt.token),
  };
}

/** Presence, read the way the settings surface reads it. */
async function connected(userId: string): Promise<boolean | undefined> {
  return (await machines(userId).listMachines({ schemaVersion: 1, userId }))
    .machines[0]?.connected;
}

/** A socket close is delivered to the object asynchronously. */
async function eventuallyDisconnected(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await connected(userId)) === false) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the machine still reads connected");
}

function command(machineId: string, commandId: string): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId,
    machineId,
    botId: "machine-bot",
    runId: "run-1",
    turn: 1,
    approvalId: commandId,
    op: {
      kind: "exec",
      command: "git status --short",
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    },
    issuedAt: new Date().toISOString(),
    status: "queued",
  };
}

describe("registered machines in Workerd", () => {
  test("enroll, push, claim and result survive eviction between claim and answer", async () => {
    const userId = `machines-user-${crypto.randomUUID()}`;
    const machine = await enrolled(userId);
    const envelope = {
      schemaVersion: 1 as const,
      userId,
      machineId: machine.machineId,
      claims: machine.claims,
      tokenDigest: machine.digest,
    };

    // Connecting to an empty queue is answered with an empty frame.
    const socket = await connect(userId, machine);
    expect(await nextFrame(socket)).toEqual([]);

    // A dispatch reaches the open socket without the machine asking.
    expect(
      await machine.rpc.dispatchMachineCommand({
        schemaVersion: 1,
        userId,
        command: command(machine.machineId, "tool:1:1:0"),
      }),
    ).toMatchObject({ status: "queued" });
    expect(await nextFrame(socket)).toEqual(["tool:1:1:0"]);

    const claimed = await machine.rpc.claimMachineCommand({
      ...envelope,
      commandId: "tool:1:1:0",
    });
    expect(claimed.status).toBe("claimed");

    // The agent goes away and the object is evicted while the command is
    // claimed. Nothing about the claim was resident.
    socket.close();
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));

    const second = await machines(userId).claimMachineCommand({
      ...envelope,
      commandId: "tool:1:1:0",
    });
    expect(second).toMatchObject({
      status: "already-claimed",
      leaseExpiresAt: claimed.leaseExpiresAt,
    });

    const recorded = await machines(userId).recordMachineResult({
      ...envelope,
      commandId: "tool:1:1:0",
      result: {
        schemaVersion: 1,
        commandId: "tool:1:1:0",
        finishedAt: new Date().toISOString(),
        outcome: "ok",
        truncated: false,
        exitCode: 0,
        stdout: " M README.md",
      },
    });
    expect(recorded.status).toBe("recorded");

    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    // The replay of a result the object has already recorded changes nothing,
    // across an eviction: `commandId` is the effect id, and that is what makes
    // an agent's retry safe.
    expect(
      await machines(userId).recordMachineResult({
        ...envelope,
        commandId: "tool:1:1:0",
        result: {
          schemaVersion: 1,
          commandId: "tool:1:1:0",
          finishedAt: new Date().toISOString(),
          outcome: "error",
          truncated: false,
          exitCode: 1,
          stdout: "a different story",
        },
      }),
    ).toMatchObject({ status: "replayed" });
    expect(
      await machines(userId).readMachineResult({
        schemaVersion: 1,
        userId,
        commandId: "tool:1:1:0",
      }),
    ).toMatchObject({ outcome: "ok", stdout: " M README.md" });
  });

  test("a machine that connects is sent every command still waiting", async () => {
    const userId = `machines-pending-${crypto.randomUUID()}`;
    const machine = await enrolled(userId);
    for (const commandId of ["tool:2:1:0", "tool:2:2:0"]) {
      await machines(userId).dispatchMachineCommand({
        schemaVersion: 1,
        userId,
        command: command(machine.machineId, commandId),
      });
    }
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    const socket = await connect(userId, machine);
    expect(await nextFrame(socket)).toEqual(["tool:2:1:0", "tool:2:2:0"]);
    socket.close();
  });

  test("the registry reads connected while a socket is open, and revocation closes it", async () => {
    const userId = `machines-revoke-${crypto.randomUUID()}`;
    const machine = await enrolled(userId, "Revoked-Mac.local");
    const envelope = {
      schemaVersion: 1 as const,
      userId,
      machineId: machine.machineId,
      claims: machine.claims,
      tokenDigest: machine.digest,
    };
    expect(await connected(userId)).toBe(false);
    const first = await connect(userId, machine);
    await nextFrame(first);
    await nextMachineFrameOf(first, "modules");
    expect(
      (await machine.rpc.listMachines({ schemaVersion: 1, userId })).machines,
    ).toMatchObject([{ label: "Revoked-Mac.local", connected: true }]);
    // The keep-alive is answered without the object.
    first.send("ping");
    expect(await first.receive()).toEqual({ type: "message", data: "pong" });
    first.close();
    await eventuallyDisconnected(userId);

    const socket = await connect(userId, machine);
    await nextFrame(socket);
    await nextMachineFrameOf(socket, "modules");
    expect(await connected(userId)).toBe(true);
    const revoked = await machine.rpc.revokeMachine({
      schemaVersion: 1,
      userId,
      machineId: machine.machineId,
    });
    // The row stays, as evidence; presence does not, and the socket is shut.
    expect(revoked.machines).toMatchObject([{ connected: false }]);
    expect(await socket.receive()).toMatchObject({
      type: "close",
      code: MACHINE_SOCKET_REVOKED_CODE_V1,
    });

    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect((await upgrade(userId, machine)).status).toBe(401);
    for (const call of [
      () =>
        machines(userId).claimMachineCommand({
          ...envelope,
          commandId: "tool:1:1:0",
        }),
      () =>
        machines(userId).recordMachineResult({
          ...envelope,
          commandId: "tool:1:1:0",
          result: {
            schemaVersion: 1,
            commandId: "tool:1:1:0",
            finishedAt: new Date().toISOString(),
            outcome: "ok",
            truncated: false,
          },
        }),
    ]) {
      expect(await refusal(call)).toMatch(/invalid/);
    }
  });

  test("a token for another machine, or minted elsewhere, reaches nothing", async () => {
    const userId = `machines-forged-${crypto.randomUUID()}`;
    const machine = await enrolled(userId);
    const foreign = await mintMachineTokenV1(env.MACHINE_TOKEN_SECRET, {
      u: userId,
      m: crypto.randomUUID(),
      v: 1,
    });
    // The digest is the authority's check: a well-formed token for another
    // machine has a digest this record does not hold.
    const foreignDigest = await machineTokenDigestV1(foreign);
    expect(
      (await upgrade(userId, { ...machine, digest: foreignDigest })).status,
    ).toBe(401);
    // …and so does a token at a key version the record has moved past.
    expect(
      (
        await upgrade(userId, {
          ...machine,
          claims: { ...machine.claims, v: machine.claims.v + 1 },
        })
      ).status,
    ).toBe(401);
    // A socket is only ever an upgrade.
    expect((await upgrade(userId, machine, {})).status).toBe(426);
    expect(await connected(userId)).toBe(false);
  });

  test("a machine cannot be enrolled twice with one pairing code", async () => {
    const userId = `machines-once-${crypto.randomUUID()}`;
    const rpc = machines(userId);
    const offer = await rpc.createMachinePairing({ schemaVersion: 1, userId });
    const enrollment = {
      schemaVersion: 1,
      code: offer.code,
      label: "Once.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec"],
    };
    await rpc.enrollMachine({
      schemaVersion: 1,
      userId,
      machineId: offer.machineId,
      enrollment,
    });
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect(
      await refusal(() =>
        machines(userId).enrollMachine({
          schemaVersion: 1,
          userId,
          machineId: offer.machineId,
          enrollment,
        }),
      ),
    ).toMatch(/invalid or has expired/);
  });
});
