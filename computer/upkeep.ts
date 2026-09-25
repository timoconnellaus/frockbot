// What a Bot's Durable Object keeps doing for its User's Computer between the
// moments anybody asks: carrying the browser's sign-ins off the machine, and
// keeping a recent checkpoint of it.
//
// SIGN-INS. One browser profile serves all of a User's Bots, and the sign-ins
// in it are the User's credentials. A Computer can be reset to a checkpoint or
// replaced by a fresh machine, and neither keeps a profile, so the sign-ins are
// carried off the machine whenever a person is likely to have just made one —
// a human handing the desktop back, the end of a Turn that drove the browser,
// the moment before an Update or a Reset — and kept by the host application,
// sealed under its credential keyring. They never enter the Workspace, a
// durable root, a log, the Session, or a model request; what this module
// reports is counts.
//
// THE DEBT. An Update or a Reset records, before the machine goes, that the
// next machine is owed the kept sign-ins. Until that debt is settled nothing
// is kept: the browser of a machine that has not had its sign-ins back holds
// none, and keeping that capture would throw the real ones away. The debt is
// settled by putting them back — right after the Update or Reset brings the
// new machine up, or, when that did not happen, at the next open of the
// Computer by any of the User's Bots.
//
// DELETION. "Delete my Computer" outranks all of it. The vault forgets the
// kept sign-ins and any debt, and remembers when: an Update or a Reset asked
// for before then records no debt and changes no machine, one already under
// way stops before it opens a new machine, and no capture made before then is
// kept. Nothing here brings back a Computer, or sign-ins, the User deleted.
//
// CHECKPOINTS. Reset puts the machine back to the newest checkpoint FrockBot
// recorded. One is recorded after every Update, whenever the User asks, and at
// most weekly at the end of a Turn that used the Computer.
import type {
  ComputerCheckpointV1,
  ComputerHostSessionV1,
} from "./core/host.js";

/** One capture as the host application keeps it. */
export interface ComputerLoginsKeptV1 {
  /** The host's own document; opaque here. */
  state: Uint8Array;
  count: number;
  capturedAt: string;
}

/**
 * Why a capture was not kept, or that it was.
 *
 * `stale`: a newer capture is already kept, or the User deleted the
 * Computer after this one was made. `owed`: a machine has not had the kept
 * sign-ins back yet, so this capture is of a browser that lacks them.
 * `too-large`: sealed, it would not fit where captures are kept.
 */
export type ComputerLoginsKeepOutcomeV1 =
  "kept" | "stale" | "owed" | "too-large";

/**
 * Where the User's sign-ins are kept: sealed, off the Computer, outside every
 * durable root. The host application implements it; this Package only drives
 * it, and never sees the key.
 */
export interface ComputerLoginVaultV1 {
  /**
   * When the debt an Update or a Reset left was recorded, or `undefined`
   * when nothing is owed. Asked at every open, so no capture travels with it.
   */
  owed(): Promise<string | undefined>;
  /** The kept capture, opened, or `undefined` before the first. */
  kept(): Promise<ComputerLoginsKeptV1 | undefined>;
  keep(capture: ComputerLoginsKeptV1): Promise<ComputerLoginsKeepOutcomeV1>;
  /**
   * Records that the next machine is owed the kept sign-ins, for an Update or
   * a Reset asked for at `at`. `deleted` when the User deleted the Computer
   * at or after `at`: that Update or Reset must not run, and nothing is owed.
   */
  owe(at: string): Promise<"owed" | "deleted">;
  /** Settles the debt recorded at `owedSince`, and no later one. */
  settle(owedSince: string): Promise<void>;
  /** Whether the User deleted the Computer at or after `at`. */
  deletedSince(at: string): Promise<boolean>;
}

/** What one attempt did, in counts. Never the content. */
export interface ComputerLoginsReportV1 {
  status:
    | ComputerLoginsKeepOutcomeV1
    | "no-browser"
    | "unavailable"
    | "restored"
    | "nothing-owed";
  count: number;
}

/**
 * Captures the browser's sign-ins and keeps them. Never throws: a Computer
 * that cannot be asked keeps whatever was kept before, which is the point of
 * keeping anything.
 */
export async function keepComputerLoginsV1(input: {
  computer: ComputerHostSessionV1;
  vault: ComputerLoginVaultV1;
  effectId: string;
  now: () => Date;
}): Promise<ComputerLoginsReportV1> {
  const logins = input.computer.logins;
  if (!logins) return { status: "unavailable", count: 0 };
  try {
    const capture = await logins.capture({ effectId: input.effectId });
    if (!capture) return { status: "no-browser", count: 0 };
    const status = await input.vault.keep({
      state: capture.state,
      count: capture.count,
      capturedAt: input.now().toISOString(),
    });
    return { status, count: capture.count };
  } catch {
    return { status: "unavailable", count: 0 };
  }
}

/**
 * Puts the kept sign-ins back into a machine that is owed them, and settles
 * the debt. A machine owed nothing is left alone; a debt with nothing kept is
 * settled, because there is nothing it could ever be paid with. Never throws:
 * an unpaid debt is paid by the next open.
 */
export async function restoreOwedComputerLoginsV1(input: {
  computer: ComputerHostSessionV1;
  vault: ComputerLoginVaultV1;
  effectId: string;
}): Promise<ComputerLoginsReportV1> {
  try {
    const owedSince = await input.vault.owed();
    if (!owedSince) return { status: "nothing-owed", count: 0 };
    const kept = await input.vault.kept();
    if (!kept) {
      await input.vault.settle(owedSince);
      return { status: "restored", count: 0 };
    }
    const logins = input.computer.logins;
    if (!logins) return { status: "unavailable", count: 0 };
    const { restored } = await logins.restore(kept.state, {
      effectId: input.effectId,
    });
    await input.vault.settle(owedSince);
    return { status: "restored", count: restored };
  } catch {
    return { status: "unavailable", count: 0 };
  }
}

/** The newest checkpoint this Bot recorded or saw, and when it last asked. */
export const COMPUTER_CHECKPOINT_RECORD_KEY = "computer:checkpoint:v1";
/** When this Bot last carried the sign-ins off at a Turn's end. */
export const COMPUTER_LOGINS_CAPTURE_RECORD_KEY = "computer:logins-captured:v1";

/** A Turn that drove the browser keeps the sign-ins at most this often. */
export const COMPUTER_LOGINS_CAPTURE_INTERVAL_MS = 10 * 60_000;
/** How often a Bot asks whether the machine is due a checkpoint. */
export const COMPUTER_CHECKPOINT_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** The newest checkpoint may be this old before another is recorded. */
export const COMPUTER_CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface StoredComputerCheckpointV1 {
  version: 1;
  /** The newest checkpoint known to this Bot, absent before the first. */
  checkpoint?: ComputerCheckpointV1;
  /** When this Bot last asked the Computer, absent before it has. */
  checkedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Decodes the checkpoint record, or `undefined` for one it does not know. */
export function decodeStoredComputerCheckpointV1(
  value: unknown,
): StoredComputerCheckpointV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    Object.keys(value).some(
      (key) => !["version", "checkpoint", "checkedAt"].includes(key),
    )
  ) {
    return undefined;
  }
  const { checkpoint, checkedAt } = value;
  if (checkedAt !== undefined && !isTime(checkedAt)) return undefined;
  if (checkpoint !== undefined) {
    if (
      !isRecord(checkpoint) ||
      Object.keys(checkpoint).sort().join(",") !== "createdAt,id" ||
      typeof checkpoint.id !== "string" ||
      !checkpoint.id ||
      !isTime(checkpoint.createdAt)
    ) {
      return undefined;
    }
  }
  return {
    version: 1,
    ...(checkpoint
      ? {
          checkpoint: {
            id: (checkpoint as { id: string }).id,
            createdAt: (checkpoint as { createdAt: string }).createdAt,
          },
        }
      : {}),
    ...(checkedAt ? { checkedAt } : {}),
  };
}

/** The Bot Durable Object storage this module reads and writes. */
export interface ComputerUpkeepRecordsV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** What a Turn is handed to keep the Computer with. */
export interface ComputerTurnUpkeepV1 {
  /**
   * The Bot's own Durable Object storage: when it last kept the sign-ins,
   * and the newest checkpoint it knows of.
   */
  records: ComputerUpkeepRecordsV1;
  /** Absent where there is no keyring: no sign-ins are kept there. */
  vault?: ComputerLoginVaultV1;
}

/** Records a checkpoint this Bot recorded, restored, or was answered. */
export async function noteComputerCheckpointV1(
  records: ComputerUpkeepRecordsV1,
  checkpoint: ComputerCheckpointV1,
  checkedAt?: string,
): Promise<void> {
  const held = decodeStoredComputerCheckpointV1(
    await records.get<unknown>(COMPUTER_CHECKPOINT_RECORD_KEY),
  );
  await records.put(COMPUTER_CHECKPOINT_RECORD_KEY, {
    version: 1,
    checkpoint,
    ...((checkedAt ?? held?.checkedAt)
      ? { checkedAt: checkedAt ?? held?.checkedAt }
      : {}),
  } satisfies StoredComputerCheckpointV1);
}

/**
 * The end of a Turn that used the Computer: keep the sign-ins when the Turn
 * drove the browser and the last keep is old enough, and record a checkpoint
 * when the newest is a week old. Both are best effort and neither throws; the
 * Turn is already over.
 */
export async function upkeepComputerAfterTurnV1(input: {
  computer: ComputerHostSessionV1;
  records: ComputerUpkeepRecordsV1;
  vault?: ComputerLoginVaultV1;
  browserUsed: boolean;
  effectIdOf: (step: string) => Promise<string>;
  now: () => Date;
}): Promise<void> {
  const now = input.now();
  try {
    if (input.vault && input.browserUsed && input.computer.logins) {
      const last = await input.records.get<unknown>(
        COMPUTER_LOGINS_CAPTURE_RECORD_KEY,
      );
      const lastAt = isRecord(last) && isTime(last.at) ? last.at : undefined;
      if (
        !lastAt ||
        now.getTime() - Date.parse(lastAt) >=
          COMPUTER_LOGINS_CAPTURE_INTERVAL_MS
      ) {
        const report = await keepComputerLoginsV1({
          computer: input.computer,
          vault: input.vault,
          effectId: await input.effectIdOf("keep-sign-ins"),
          now: input.now,
        });
        if (report.status !== "unavailable") {
          await input.records.put(COMPUTER_LOGINS_CAPTURE_RECORD_KEY, {
            version: 1,
            at: now.toISOString(),
          });
        }
      }
    }
  } catch {
    // Keeping sign-ins is never a reason for a Turn's end to fail.
  }
  const machine = input.computer.machine;
  if (!machine) return;
  let held: StoredComputerCheckpointV1 | undefined;
  try {
    held = decodeStoredComputerCheckpointV1(
      await input.records.get<unknown>(COMPUTER_CHECKPOINT_RECORD_KEY),
    );
    if (
      held?.checkedAt &&
      now.getTime() - Date.parse(held.checkedAt) <
        COMPUTER_CHECKPOINT_CHECK_INTERVAL_MS
    ) {
      return;
    }
    const { checkpoint } = await machine.checkpoint({
      effectId: await input.effectIdOf("checkpoint"),
      maxAgeMs: COMPUTER_CHECKPOINT_MAX_AGE_MS,
    });
    await noteComputerCheckpointV1(
      input.records,
      checkpoint,
      now.toISOString(),
    );
  } catch {
    // A machine mid-update refuses a checkpoint. It is asked again the next
    // day rather than at every Turn's end: the cadence is weekly, and a
    // machine that keeps refusing must not cost every Turn a round trip.
    await input.records
      .put(COMPUTER_CHECKPOINT_RECORD_KEY, {
        version: 1,
        ...(held?.checkpoint ? { checkpoint: held.checkpoint } : {}),
        checkedAt: now.toISOString(),
      } satisfies StoredComputerCheckpointV1)
      .catch(() => undefined);
  }
}
