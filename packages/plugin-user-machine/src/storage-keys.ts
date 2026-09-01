// The User Durable Object storage keys the registered-machine Package owns.
//
// "The User's Durable Object is the authority for everything User-scoped:
// Package availability, Connections, credentials, the Computer assignment,
// User settings, quotas" — a machine is a User asset, so its registry, its
// command queue and its results live here and nowhere else. The keys live in
// the Package rather than in `@frockbot/kernel-do` for the same reason
// `plugin-routines/src/storage-keys.ts` does: the kernel holds no product
// policy and imports no Package.
//
// None of these prefixes collide with the landed set (`user:`, `memory:`,
// `settings:`, `connection:`, `credential:`, `routine-*`, `template-*`).

/** One `MachineRecordV1`: the registry row. */
export const MACHINE_PREFIX = "machine:";
/** One queued `MachineCommandV1`, oldest first. */
export const MACHINE_QUEUE_PREFIX = "machine-queue:";
/** One `MachineCommandResultV1`, keyed by the command it answers. */
export const MACHINE_RESULT_PREFIX = "machine-result:";
/** One unspent `MachinePairingRecordV1`. */
export const MACHINE_PAIRING_PREFIX = "machine-pair:";
/**
 * How many times one command's lease has expired.
 *
 * It is a key of its own rather than a field on the command because
 * `MachineCommandV1` is the wire DTO, decoded exact-key at three runtimes: a
 * recovery counter is the backend's bookkeeping and has no business being
 * something a device agent is handed, or could send.
 */
export const MACHINE_REQUEUE_PREFIX = "machine-requeue:";
/**
 * One day's dispatch count. The per-day quota is a rate, and a rate needs a
 * durable counter rather than a listing: the queue drains, so counting what is
 * in it would let a Bot spend the day's budget many times over.
 */
export const MACHINE_USAGE_PREFIX = "machine-usage:";

export function machineKeyV1(machineId: string): string {
  return `${MACHINE_PREFIX}${machineId}`;
}

export function machinePairingKeyV1(machineId: string): string {
  return `${MACHINE_PAIRING_PREFIX}${machineId}`;
}

export function machineResultKeyV1(commandId: string): string {
  return `${MACHINE_RESULT_PREFIX}${commandId}`;
}

export function machineRequeueKeyV1(commandId: string): string {
  return `${MACHINE_REQUEUE_PREFIX}${commandId}`;
}

export function machineQueuePrefixV1(machineId: string): string {
  return `${MACHINE_QUEUE_PREFIX}${machineId}:`;
}

/**
 * Queue keys ascend, so a prefix listing answers oldest-first: a machine that
 * has been asleep drains its commands in the order they were approved.
 */
const QUEUE_SEQUENCE_CEILING = 1_000_000_000;

export function machineQueueKeyV1(machineId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= QUEUE_SEQUENCE_CEILING) {
    throw new Error("machine queue sequence is out of range");
  }
  return `${machineQueuePrefixV1(machineId)}${String(seq).padStart(10, "0")}`;
}

/** The sequence the next queued command takes, given the keys already held. */
export function nextMachineQueueSequenceV1(keys: readonly string[]): number {
  let highest = -1;
  for (const key of keys) {
    const encoded = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isSafeInteger(encoded)) highest = Math.max(highest, encoded);
  }
  return highest + 1;
}

/** The UTC day a dispatch counts against. Machines cross time zones; the quota does not. */
export function machineUsageDayV1(now: number | Date): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function machineUsageKeyV1(now: number | Date): string {
  return `${MACHINE_USAGE_PREFIX}${machineUsageDayV1(now)}`;
}
