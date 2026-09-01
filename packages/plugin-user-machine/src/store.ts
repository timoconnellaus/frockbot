// The registry, the queue, the lease and the results — as durable state.
//
// Every function here takes a storage seam and a clock and returns a decision.
// Nothing here reads a secret, mints a token, or answers an HTTP request: the
// gateway Contribution does the first two at the edge and the User backend
// Contribution owns the third, so the rules a machine's authority actually
// turns on can be exercised without either.
//
// Four invariants this module exists to hold:
//
//  1. **Presence is arithmetic.** `connected` is never stored. A laptop that
//     stops polling goes offline on its own, and an evicted Durable Object has
//     nothing to reconcile when it wakes.
//  2. **A claim is first-write-wins.** A duplicate delivery — a poll answered
//     twice, an agent that retried — cannot run a command twice, because the
//     second claim answers `already-claimed` and the agent stops.
//  3. **A lease expiry re-queues once, then terminates.** A machine that
//     claimed a command and vanished gets the command offered again exactly
//     once; the second expiry marks it `unknown`, which is the audit
//     vocabulary's word for "nobody can say whether this ran".
//  4. **A result is idempotent on `commandId`.** `commandId` *is* the Bot
//     Durable Object's `effectId`, so a replayed result answers `replayed` and
//     changes nothing.

import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  checkMachineQuotaV1,
  decodeMachineCommandResultV1,
  decodeMachineCommandV1,
  decodeMachineRecordV1,
  machineConnectedV1,
  machineListEntryV1,
  machineMessagesPermissionsFromResultV1,
  machineQuotaRefusalV1,
  machineOpCapabilityV1,
  type MachineCapabilityV1,
  type MachineClaimReceiptV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineEnrollmentV1,
  type MachineListViewV1,
  type MachineRecordV1,
  type MachineResultReceiptV1,
} from "@frockbot/machine-protocol";
import {
  MACHINE_PREFIX,
  machineKeyV1,
  machinePairingKeyV1,
  machineQueueKeyV1,
  machineQueuePrefixV1,
  machineRequeueKeyV1,
  machineResultKeyV1,
  machineUsageKeyV1,
  nextMachineQueueSequenceV1,
} from "./storage-keys.js";

// ---------------------------------------------------------------------------
// The storage seam
// ---------------------------------------------------------------------------

export interface MachineStorageWritesV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface MachineStorageV1 extends MachineStorageWritesV1 {
  transaction<T>(
    closure: (transaction: MachineStorageWritesV1) => Promise<T>,
  ): Promise<T>;
}

/** A refusal with the status the route should answer. */
export class MachineRegistryError extends Error {
  override readonly name = "MachineRegistryError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * One unspent pairing offer.
 *
 * The code itself is absent by construction: only `SHA-256(code)` is kept, so
 * a dump of this object's storage hands nobody a machine.
 */
export interface MachinePairingRecordV1 {
  schemaVersion: 1;
  machineId: string;
  userId: string;
  label?: string;
  codeDigest: string;
  createdAt: string;
  expiresAt: string;
}

function iso(now: number | Date): string {
  return new Date(now).toISOString();
}

export async function writeMachinePairingV1(
  storage: MachineStorageV1,
  input: {
    userId: string;
    machineId: string;
    label?: string;
    codeDigest: string;
    now: number | Date;
    ttlMs?: number;
  },
): Promise<MachinePairingRecordV1> {
  const ttl = input.ttlMs ?? MACHINE_LIMITS_V1.pairingTtlMs;
  const record: MachinePairingRecordV1 = {
    schemaVersion: 1,
    machineId: input.machineId,
    userId: input.userId,
    ...(input.label === undefined ? {} : { label: input.label }),
    codeDigest: input.codeDigest,
    createdAt: iso(input.now),
    expiresAt: iso(new Date(input.now).getTime() + ttl),
  };
  await storage.put(machinePairingKeyV1(input.machineId), record);
  return record;
}

export async function readMachinePairingV1(
  storage: MachineStorageWritesV1,
  machineId: string,
): Promise<MachinePairingRecordV1 | undefined> {
  return storage.get<MachinePairingRecordV1>(machinePairingKeyV1(machineId));
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export async function listMachineRecordsV1(
  storage: MachineStorageWritesV1,
): Promise<MachineRecordV1[]> {
  const stored = await storage.list<unknown>({
    prefix: MACHINE_PREFIX,
    limit: MACHINE_LIMITS_V1.maxMachinesPerUser * 4,
  });
  const records: MachineRecordV1[] = [];
  for (const [key, value] of stored) {
    // `machine-queue:` and friends share no prefix with `machine:`… except
    // that `machine:` is a prefix of nothing else only because every other key
    // uses a hyphen. Decoding is the check that says so out loud.
    if (!key.startsWith(MACHINE_PREFIX)) continue;
    try {
      records.push(decodeMachineRecordV1(value, "stored machine record"));
    } catch {
      // A record this build cannot decode is a row the registry does not
      // show, never a reason the whole registry fails to answer.
    }
  }
  return records.sort((left, right) =>
    left.registeredAt.localeCompare(right.registeredAt),
  );
}

export async function readMachineRecordV1(
  storage: MachineStorageWritesV1,
  machineId: string,
): Promise<MachineRecordV1 | undefined> {
  const stored = await storage.get<unknown>(machineKeyV1(machineId));
  if (stored === undefined) return undefined;
  return decodeMachineRecordV1(stored, "stored machine record");
}

export function machineListViewV1(
  records: readonly MachineRecordV1[],
  now: number | Date,
): MachineListViewV1 {
  return {
    schemaVersion: 1,
    machines: records.map((record) => machineListEntryV1(record, now)),
    serverTime: iso(now),
  };
}

/**
 * Enrollment: the pairing offer is spent and the registry row is written, in
 * one transaction.
 *
 * "Admit input durably before acknowledging" — the machine is registered
 * before the token it will present is handed back, so an agent that reads the
 * response is holding a key to a record that already exists.
 */
export async function enrollMachineV1(
  storage: MachineStorageV1,
  input: {
    userId: string;
    machineId: string;
    enrollment: MachineEnrollmentV1;
    codeDigest: string;
    tokenDigest: string;
    now: number | Date;
  },
): Promise<MachineRecordV1> {
  return storage.transaction(async (transaction) => {
    const pairing = await readMachinePairingV1(transaction, input.machineId);
    // Missing, spent, expired, for another User, or for another code: one
    // answer, because telling them apart tells a prober which it was.
    if (
      !pairing ||
      pairing.userId !== input.userId ||
      pairing.codeDigest !== input.codeDigest ||
      Date.parse(pairing.expiresAt) <= new Date(input.now).getTime()
    ) {
      throw new MachineRegistryError(
        401,
        "machine pairing code is invalid or has expired",
      );
    }
    const registered = await listMachineRecordsV1(transaction);
    const quota = checkMachineQuotaV1({
      kind: "register",
      registeredMachines: registered.filter(
        (record) => record.revokedAt === undefined,
      ).length,
    });
    if (quota.status === "refused") {
      throw new MachineRegistryError(429, machineQuotaRefusalV1(quota));
    }
    const record: MachineRecordV1 = decodeMachineRecordV1(
      {
        schemaVersion: 1,
        machineId: input.machineId,
        userId: input.userId,
        label: input.enrollment.label,
        platform: input.enrollment.platform,
        agentVersion: input.enrollment.agentVersion,
        capabilities: input.enrollment.capabilities,
        registeredAt: iso(input.now),
        lastSeenAt: iso(input.now),
        keyVersion: 1,
        tokenDigest: input.tokenDigest,
      },
      "machine record",
    );
    await transaction.put(machineKeyV1(record.machineId), record);
    // One-time: the offer is gone whether or not the agent ever polls.
    await transaction.delete(machinePairingKeyV1(input.machineId));
    return record;
  });
}

/** Every issued token dies, the queue is purged, and the row stays as evidence. */
export async function revokeMachineV1(
  storage: MachineStorageV1,
  machineId: string,
  now: number | Date,
): Promise<MachineRecordV1> {
  return storage.transaction(async (transaction) => {
    const record = await readMachineRecordV1(transaction, machineId);
    if (!record) {
      throw new MachineRegistryError(404, "machine was not found");
    }
    const revoked: MachineRecordV1 = {
      ...record,
      keyVersion: record.keyVersion + 1,
      revokedAt: record.revokedAt ?? iso(now),
    };
    await transaction.put(machineKeyV1(machineId), revoked);
    const queued = await transaction.list<unknown>({
      prefix: machineQueuePrefixV1(machineId),
    });
    for (const key of queued.keys()) await transaction.delete(key);
    return revoked;
  });
}

/** Every poll refreshes presence. This is the whole of how `connected` is fed. */
export async function touchMachineV1(
  storage: MachineStorageV1,
  machineId: string,
  now: number | Date,
): Promise<MachineRecordV1> {
  const record = await readMachineRecordV1(storage, machineId);
  if (!record) throw new MachineRegistryError(404, "machine was not found");
  const touched: MachineRecordV1 = { ...record, lastSeenAt: iso(now) };
  await storage.put(machineKeyV1(machineId), touched);
  return touched;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

interface StoredCommandV1 {
  key: string;
  command: MachineCommandV1;
}

async function readQueueV1(
  storage: MachineStorageWritesV1,
  machineId: string,
): Promise<StoredCommandV1[]> {
  const stored = await storage.list<unknown>({
    prefix: machineQueuePrefixV1(machineId),
    limit: MACHINE_LIMITS_V1.maxQueue * 4,
  });
  const commands: StoredCommandV1[] = [];
  for (const [key, value] of stored) {
    try {
      commands.push({
        key,
        command: decodeMachineCommandV1(value, "stored machine command"),
      });
    } catch {
      // Same rule as the registry: an undecodable row is not delivered and is
      // not a reason a poll fails.
    }
  }
  return commands;
}

export type MachineDispatchOutcomeV1 =
  | { status: "queued"; command: MachineCommandV1 }
  | { status: "duplicate"; command: MachineCommandV1 }
  | { status: "refused"; reason: string };

async function readUsageV1(
  storage: MachineStorageWritesV1,
  now: number | Date,
): Promise<number> {
  const stored = await storage.get<{ schemaVersion: 1; count: number }>(
    machineUsageKeyV1(now),
  );
  return Number.isSafeInteger(stored?.count) ? stored!.count : 0;
}

/**
 * Put one approved command on a machine's queue.
 *
 * Idempotent on `commandId`: a re-dispatch of the same `effectId` — a retried
 * settlement, a replayed decision — finds the command already queued and
 * answers `duplicate` rather than queueing a second copy of somebody's laptop
 * running `rm`.
 */
export async function dispatchMachineCommandV1(
  storage: MachineStorageV1,
  input: unknown,
  now: number | Date,
): Promise<MachineDispatchOutcomeV1> {
  const command = decodeMachineCommandV1(input, "machine command");
  if (command.status !== "queued") {
    throw new MachineDecodeError("a dispatched machine command must be queued");
  }
  return storage.transaction(async (transaction) => {
    const record = await readMachineRecordV1(transaction, command.machineId);
    if (!record || record.revokedAt !== undefined) {
      return {
        status: "refused",
        reason: "Refused: this machine is not registered.",
      };
    }
    const needed: MachineCapabilityV1 = machineOpCapabilityV1(command.op);
    if (!record.capabilities.includes(needed)) {
      return {
        status: "refused",
        reason: `Refused: this machine does not report the ${needed} capability.`,
      };
    }
    const queue = await readQueueV1(transaction, command.machineId);
    const existing = queue.find(
      (entry) => entry.command.commandId === command.commandId,
    );
    if (existing) return { status: "duplicate", command: existing.command };
    // A command that already has a result is terminal; a replayed dispatch of
    // it is a duplicate, not a second run.
    const settled = await transaction.get<unknown>(
      machineResultKeyV1(command.commandId),
    );
    if (settled !== undefined) return { status: "duplicate", command };
    const commandsToday = await readUsageV1(transaction, now);
    const quota = checkMachineQuotaV1({
      kind: "dispatch",
      queuedCommands: queue.length,
      commandsToday,
    });
    if (quota.status === "refused") {
      return { status: "refused", reason: machineQuotaRefusalV1(quota) };
    }
    const seq = nextMachineQueueSequenceV1([
      ...queue.map((entry) => entry.key),
    ]);
    await transaction.put(machineQueueKeyV1(command.machineId, seq), command);
    await transaction.put(machineUsageKeyV1(now), {
      schemaVersion: 1,
      count: commandsToday + 1,
    });
    return { status: "queued", command };
  });
}

/**
 * Expire the leases a vanished agent left behind.
 *
 * Run before every poll and every claim, so the sweep needs no alarm of its
 * own: the only party who can be harmed by a stuck lease is the machine whose
 * queue it is on, and that machine is the one asking.
 */
export async function sweepMachineLeasesV1(
  storage: MachineStorageV1,
  machineId: string,
  now: number | Date,
): Promise<{ requeued: string[]; terminated: string[] }> {
  const at = new Date(now).getTime();
  return storage.transaction(async (transaction) => {
    const queue = await readQueueV1(transaction, machineId);
    const requeued: string[] = [];
    const terminated: string[] = [];
    for (const entry of queue) {
      const command = entry.command;
      if (command.status !== "claimed") continue;
      if (
        command.leaseExpiresAt === undefined ||
        Date.parse(command.leaseExpiresAt) > at
      ) {
        continue;
      }
      // One re-queue, then `unknown`: recovery never silently duplicates, and
      // it never loops. The count is the backend's own bookkeeping, held
      // beside the command rather than on it — see `MACHINE_REQUEUE_PREFIX`.
      const attempts =
        (
          await transaction.get<{ schemaVersion: 1; count: number }>(
            machineRequeueKeyV1(command.commandId),
          )
        )?.count ?? 0;
      if (attempts < 1) {
        const { leaseExpiresAt: _expired, ...rest } = command;
        await transaction.put(entry.key, {
          ...rest,
          status: "queued",
        } satisfies MachineCommandV1);
        await transaction.put(machineRequeueKeyV1(command.commandId), {
          schemaVersion: 1,
          count: attempts + 1,
        });
        requeued.push(command.commandId);
        continue;
      }
      const { leaseExpiresAt: _lease, ...rest } = command;
      await transaction.put(entry.key, {
        ...rest,
        status: "unknown",
      } satisfies MachineCommandV1);
      // The terminal fact is durable, and it is the *audit* answer: nobody can
      // say whether this ran on the User's laptop.
      await transaction.put(machineResultKeyV1(command.commandId), {
        schemaVersion: 1,
        commandId: command.commandId,
        finishedAt: iso(now),
        outcome: "error",
        truncated: false,
        message:
          "the machine claimed this command and never reported a result; its outcome is unknown",
      } satisfies MachineCommandResultV1);
      await transaction.delete(machineRequeueKeyV1(command.commandId));
      terminated.push(command.commandId);
    }
    return { requeued, terminated };
  });
}

/** What a poll answers with: every command still waiting for this machine. */
export async function pendingMachineCommandsV1(
  storage: MachineStorageWritesV1,
  machineId: string,
): Promise<MachineCommandV1[]> {
  const queue = await readQueueV1(storage, machineId);
  return queue
    .filter((entry) => entry.command.status === "queued")
    .map((entry) => entry.command);
}

/**
 * A claim, first-write-wins.
 *
 * The second claim of a command answers `already-claimed` with the lease the
 * first claim took, which is the whole reason a duplicate delivery can never
 * run twice on somebody's laptop.
 */
export async function claimMachineCommandV1(
  storage: MachineStorageV1,
  machineId: string,
  commandId: string,
  now: number | Date,
): Promise<MachineClaimReceiptV1> {
  return storage.transaction(async (transaction) => {
    const queue = await readQueueV1(transaction, machineId);
    const entry = queue.find(
      (candidate) => candidate.command.commandId === commandId,
    );
    if (!entry) {
      throw new MachineRegistryError(404, "machine command was not found");
    }
    const command = entry.command;
    if (command.status !== "queued") {
      return {
        schemaVersion: 1,
        status: "already-claimed",
        commandId,
        leaseExpiresAt: command.leaseExpiresAt ?? iso(new Date(now).getTime()),
      };
    }
    const leaseExpiresAt = iso(
      new Date(now).getTime() + MACHINE_LIMITS_V1.leaseMs,
    );
    await transaction.put(entry.key, {
      ...command,
      status: "claimed",
      claimedAt: command.claimedAt ?? iso(now),
      leaseExpiresAt,
    } satisfies MachineCommandV1);
    return { schemaVersion: 1, status: "claimed", commandId, leaseExpiresAt };
  });
}

/**
 * One result, recorded once.
 *
 * The command leaves the queue and the result becomes the durable answer. A
 * second POST of the same `commandId` answers `replayed` and changes nothing —
 * which is what makes the agent's own retry safe.
 */
export async function recordMachineResultV1(
  storage: MachineStorageV1,
  machineId: string,
  input: unknown,
  now: number | Date,
): Promise<{
  receipt: MachineResultReceiptV1;
  result: MachineCommandResultV1;
  /**
   * The command the result answers, present only on the write that recorded
   * it. The queue entry is deleted in the same transaction, so this is the one
   * moment the Bot that asked is still nameable — and a replay must not deliver
   * a second time, which is exactly why it is absent on one.
   */
  command?: MachineCommandV1;
}> {
  const result = decodeMachineCommandResultV1(input, "machine command result");
  return storage.transaction(async (transaction) => {
    const existing = await transaction.get<unknown>(
      machineResultKeyV1(result.commandId),
    );
    if (existing !== undefined) {
      return {
        receipt: {
          schemaVersion: 1,
          status: "replayed",
          commandId: result.commandId,
        },
        result: decodeMachineCommandResultV1(existing, "stored machine result"),
      };
    }
    const queue = await readQueueV1(transaction, machineId);
    const entry = queue.find(
      (candidate) => candidate.command.commandId === result.commandId,
    );
    if (!entry) {
      throw new MachineRegistryError(404, "machine command was not found");
    }
    await transaction.put(machineResultKeyV1(result.commandId), result);
    await transaction.delete(entry.key);
    await transaction.delete(machineRequeueKeyV1(result.commandId));
    // Row 57g's third gate is a fact the *machine* reports, and this is the one
    // moment it arrives: a permission check that answered `ok` updates the
    // registry row, and every other result leaves it exactly as it was. The
    // rule is the protocol's and pure, so the registry cannot start believing
    // something the agent did not say.
    const reported = machineMessagesPermissionsFromResultV1(
      entry.command.op,
      result,
    );
    if (reported) {
      const record = await readMachineRecordV1(transaction, machineId);
      if (record) {
        await transaction.put(machineKeyV1(machineId), {
          ...record,
          messagesPermissions: reported,
        } satisfies MachineRecordV1);
      }
    }
    return {
      receipt: {
        schemaVersion: 1,
        status: "recorded",
        commandId: result.commandId,
      },
      result,
      command: entry.command,
    };
  });
}

/**
 * The two counters a dispatch quota is arithmetic over, for one machine.
 *
 * Read by the tool *before* it asks a person anything: a card the User approves
 * and the queue then refuses is a question that wasted their attention, so the
 * refusal happens where the Bot can still say something useful about it.
 */
export async function machineQuotaSnapshotV1(
  storage: MachineStorageWritesV1,
  machineId: string,
  now: number | Date,
): Promise<{ queuedCommands: number; commandsToday: number }> {
  const queue = await readQueueV1(storage, machineId);
  return {
    queuedCommands: queue.length,
    commandsToday: await readUsageV1(storage, now),
  };
}

export async function readMachineResultV1(
  storage: MachineStorageWritesV1,
  commandId: string,
): Promise<MachineCommandResultV1 | undefined> {
  const stored = await storage.get<unknown>(machineResultKeyV1(commandId));
  if (stored === undefined) return undefined;
  return decodeMachineCommandResultV1(stored, "stored machine result");
}

/** Re-exported so a caller reads presence from one place. */
export { machineConnectedV1 };
