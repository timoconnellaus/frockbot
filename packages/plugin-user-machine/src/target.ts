// One machine, as the tool that is about to ask for it needs to see it.
//
// A control tool has five things to check before it may put a card in front of
// a person — is the machine registered, is it revoked, is it connected, does it
// report the capability the op needs, and is the User inside their quota — and
// four of them are facts only the User Durable Object holds. Resolving them one
// at a time would be four round trips and four chances to answer against a
// different instant, so this is the single narrow view the tool reads: the
// registry row, and the two counters the quota is arithmetic over.
//
// It carries no token digest, no key version and no user id. A projection hands
// out what the caller renders a decision from, and nothing that proves
// anything.
import {
  MachineDecodeError,
  decodeMachineListEntryV1,
  type MachineListEntryV1,
} from "@frockbot/machine-protocol";

export interface MachineTargetViewV1 {
  schemaVersion: 1;
  machineId: string;
  /** Absent when this User has no machine by that id. */
  entry?: MachineListEntryV1;
  /** Commands already waiting on this machine's queue. */
  queuedCommands: number;
  /** Commands this User has dispatched today, across every machine. */
  commandsToday: number;
  serverTime: string;
}

export function decodeMachineTargetViewV1(
  input: unknown,
  label = "machine target",
): MachineTargetViewV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (
      ![
        "schemaVersion",
        "machineId",
        "entry",
        "queuedCommands",
        "commandsToday",
        "serverTime",
      ].includes(key)
    ) {
      throw new MachineDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new MachineDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (typeof value.machineId !== "string" || value.machineId.length === 0) {
    throw new MachineDecodeError(`${label} machineId must be a string`);
  }
  const count = (candidate: unknown, name: string): number => {
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0
    ) {
      throw new MachineDecodeError(`${label} ${name} is invalid`);
    }
    return candidate;
  };
  if (
    typeof value.serverTime !== "string" ||
    Number.isNaN(Date.parse(value.serverTime))
  ) {
    throw new MachineDecodeError(`${label} serverTime is not a timestamp`);
  }
  return {
    schemaVersion: 1,
    machineId: value.machineId,
    ...(value.entry === undefined
      ? {}
      : { entry: decodeMachineListEntryV1(value.entry, `${label} entry`) }),
    queuedCommands: count(value.queuedCommands, "queuedCommands"),
    commandsToday: count(value.commandsToday, "commandsToday"),
    serverTime: value.serverTime,
  };
}
