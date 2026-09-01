// What an automation Turn leaves behind, and what the Bot's next conversational
// Turn picks up.
//
// A Routine firing cannot speak to its User: `send_to_user` is not in the
// automation catalog, and nothing an automation Turn writes reaches the visible
// transcript. Its outcome therefore has to land somewhere durable, and it lands
// in two records written in the same transaction that settles the Turn.
//
//   * `RoutineInboxEntryV1` is the User-facing half — the completion inbox
//     GrokBot spells `automation_completion_inbox`, carrying the hand-off text,
//     the attribution "Automation: <name>", and an `acknowledged` flag the User
//     clears. Every completed automation Turn writes one, whether or not it
//     called `wake_parent`.
//
//   * `PendingBotInputV1` is the Bot-facing half, and only a hand-off writes
//     one. `AGENTS.md`: "its outcome is delivered to the Bot's next
//     conversational Turn as durable input". It is a queue of one input each,
//     drained at exactly two points and idempotent on its id, so an eviction
//     between the firing and the next chat Turn loses nothing and a recovery
//     never delivers the same hand-off twice.
//
// `PendingBotInputV1` is deliberately wider than Routines. The `wake` variant is
// the one this slice produced; the `approval` variant is the approval card's,
// and the `machine-result` variant is the registered machine's. Each new
// producer widens this union rather than opening a second queue: two queues
// would mean two drains, two receipts, and two chances to double-deliver.
import {
  isRoutineIdV1,
  RoutineDecodeError,
  routineExactKeys,
  routineText,
  routineTimestamp,
} from "./records.js";

/** "Automation: " plus a Routine name capped at its record's own limit. */
export const ROUTINE_NAME_ATTRIBUTION_MAX = 128;

export function routineAttributionV1(name: string): string {
  return `Automation: ${name}`.slice(0, ROUTINE_NAME_ATTRIBUTION_MAX);
}

/**
 * What produced one completion-inbox entry.
 *
 * The queue was always wider than Routines — the `approval` pending input says
 * so — and a background subagent lands in exactly the same two records for
 * exactly the same reason: it is a Turn that cannot speak to its User, whose
 * outcome has to be durable somewhere the next conversational Turn reads.
 * Absent means `routine`, so every entry written before subagents existed still
 * decodes and still reads as what it was.
 */
export type CompletionSourceV1 = "routine" | "subagent";

/** "Subagent: " plus the task's description, capped like an attribution. */
export function subagentAttributionV1(description: string): string {
  return `Subagent: ${description}`.slice(0, ROUTINE_NAME_ATTRIBUTION_MAX);
}

/** Longest hand-off an inbox entry or a pending wake carries. */
export const ROUTINE_INBOX_TEXT_MAX = 4_000;
/** Longest title a pending wake carries. */
export const ROUTINE_WAKE_TITLE_MAX = 200;

/**
 * One completed automation Turn, waiting to be read. `attribution` is the
 * rendered "Automation: <name>" line rather than a name the reader must
 * assemble, because the Routine may have been deleted since it fired.
 */
export interface RoutineInboxEntryV1 {
  schemaVersion: 1;
  entryId: string;
  runId: string;
  routineId: string;
  text: string;
  attribution: string;
  createdAt: string;
  acknowledged: boolean;
  /** Present when the Turn also handed off, naming the wake it queued. */
  wakeId?: string;
  acknowledgedAt?: string;
  /**
   * What produced this entry. Absent means `routine`; `routineId` then carries
   * the task id, because the field names the automation the entry came from
   * and a subagent task is one.
   */
  source?: CompletionSourceV1;
}

/** A hand-off the Bot has not yet been told about. */
export interface RoutinePendingWakeV1 {
  schemaVersion: 1;
  kind: "wake";
  wakeId: string;
  runId: string;
  routineId: string;
  title: string;
  text: string;
  createdAt: string;
  /**
   * GrokBot's `quietOrigin.automation`: the wake came from the Bot's own
   * automation rather than from a person, so replaying it must not read as the
   * User having said something.
   */
  quiet: { automation: true };
  /** Set once the alarm has re-emitted this wake's notification intent. */
  renotifiedAt?: string;
  /** What produced this wake. Absent means `routine`. */
  source?: CompletionSourceV1;
}

/**
 * A decision the User has already made, waiting to be told to the Bot. Decoded
 * here and produced nowhere: the approval-card slice supplies the producer, and
 * because the variant already crosses the seam it adds no wire change.
 */
export interface RoutinePendingApprovalV1 {
  schemaVersion: 1;
  kind: "approval";
  approvalId: string;
  decision: "approved" | "denied" | "expired";
  createdAt: string;
}

/**
 * A machine command that has finished, waiting to be told to the Bot.
 *
 * The third variant, and the reason there is not a second queue: `plugin-shell`
 * already drains this one at exactly two points and de-duplicates on an id, so
 * a machine result rides the same rails a Routine hand-off and an approval
 * decision do. It carries a *preview* and never the output — the full result is
 * read on demand with `machine_command_check`, so a megabyte of stdout can
 * never push a person's own words out of the next Turn's context.
 */
export interface RoutinePendingMachineResultV1 {
  schemaVersion: 1;
  kind: "machine-result";
  commandId: string;
  machineId: string;
  outcome: "ok" | "error" | "refused" | "timeout";
  preview: string;
  createdAt: string;
}

/** The longest preview a machine-result input carries. */
export const MACHINE_RESULT_PREVIEW_MAX_V1 = 400;

/** One durable input the Bot's next conversational Turn is owed. */
export type PendingBotInputV1 =
  | RoutinePendingWakeV1
  | RoutinePendingApprovalV1
  | RoutinePendingMachineResultV1;

/** The id one pending input is keyed and de-duplicated by. */
export function pendingBotInputIdV1(input: PendingBotInputV1): string {
  if (input.kind === "wake") return input.wakeId;
  if (input.kind === "approval") return input.approvalId;
  return `machine-result:${input.commandId}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function completionSourceV1(value: unknown, label: string): CompletionSourceV1 {
  if (value !== "routine" && value !== "subagent") {
    throw new RoutineDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeRoutineInboxEntryV1(
  value: unknown,
  label = "Routine inbox entry",
): RoutineInboxEntryV1 {
  const candidate = record(value, label);
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "entryId",
      "runId",
      "routineId",
      "text",
      "attribution",
      "createdAt",
      "acknowledged",
    ],
    ["wakeId", "acknowledgedAt", "source"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError(`${label} routineId is invalid`);
  }
  if (typeof candidate.acknowledged !== "boolean") {
    throw new RoutineDecodeError(`${label} acknowledged must be a boolean`);
  }
  return {
    schemaVersion: 1,
    entryId: routineText(candidate.entryId, 256, `${label} entryId`),
    runId: routineText(candidate.runId, 256, `${label} runId`),
    routineId: candidate.routineId,
    text: routineText(candidate.text, ROUTINE_INBOX_TEXT_MAX, `${label} text`),
    attribution: routineText(
      candidate.attribution,
      ROUTINE_NAME_ATTRIBUTION_MAX,
      `${label} attribution`,
    ),
    createdAt: routineTimestamp(candidate.createdAt, `${label} createdAt`),
    acknowledged: candidate.acknowledged,
    ...(candidate.wakeId === undefined
      ? {}
      : { wakeId: routineText(candidate.wakeId, 256, `${label} wakeId`) }),
    ...(candidate.acknowledgedAt === undefined
      ? {}
      : {
          acknowledgedAt: routineTimestamp(
            candidate.acknowledgedAt,
            `${label} acknowledgedAt`,
          ),
        }),
    ...(candidate.source === undefined
      ? {}
      : { source: completionSourceV1(candidate.source, `${label} source`) }),
  };
}

export function decodePendingBotInputV1(
  value: unknown,
  label = "pending Bot input",
): PendingBotInputV1 {
  const candidate = record(value, label);
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.kind === "approval") {
    routineExactKeys(
      candidate,
      ["schemaVersion", "kind", "approvalId", "decision", "createdAt"],
      [],
      label,
    );
    if (
      candidate.decision !== "approved" &&
      candidate.decision !== "denied" &&
      candidate.decision !== "expired"
    ) {
      throw new RoutineDecodeError(`${label} decision is invalid`);
    }
    return {
      schemaVersion: 1,
      kind: "approval",
      approvalId: routineText(candidate.approvalId, 256, `${label} approvalId`),
      decision: candidate.decision,
      createdAt: routineTimestamp(candidate.createdAt, `${label} createdAt`),
    };
  }
  if (candidate.kind === "machine-result") {
    routineExactKeys(
      candidate,
      [
        "schemaVersion",
        "kind",
        "commandId",
        "machineId",
        "outcome",
        "preview",
        "createdAt",
      ],
      [],
      label,
    );
    if (
      candidate.outcome !== "ok" &&
      candidate.outcome !== "error" &&
      candidate.outcome !== "refused" &&
      candidate.outcome !== "timeout"
    ) {
      throw new RoutineDecodeError(`${label} outcome is invalid`);
    }
    return {
      schemaVersion: 1,
      kind: "machine-result",
      commandId: routineText(candidate.commandId, 256, `${label} commandId`),
      machineId: routineText(candidate.machineId, 256, `${label} machineId`),
      outcome: candidate.outcome,
      preview: routineText(
        candidate.preview,
        MACHINE_RESULT_PREVIEW_MAX_V1,
        `${label} preview`,
      ),
      createdAt: routineTimestamp(candidate.createdAt, `${label} createdAt`),
    };
  }
  if (candidate.kind !== "wake") {
    throw new RoutineDecodeError(`${label} kind is invalid`);
  }
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "kind",
      "wakeId",
      "runId",
      "routineId",
      "title",
      "text",
      "createdAt",
      "quiet",
    ],
    ["renotifiedAt", "source"],
    label,
  );
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError(`${label} routineId is invalid`);
  }
  const quiet = record(candidate.quiet, `${label} quiet`);
  routineExactKeys(quiet, ["automation"], [], `${label} quiet`);
  if (quiet.automation !== true) {
    throw new RoutineDecodeError(`${label} quiet.automation must be true`);
  }
  return {
    schemaVersion: 1,
    kind: "wake",
    wakeId: routineText(candidate.wakeId, 256, `${label} wakeId`),
    runId: routineText(candidate.runId, 256, `${label} runId`),
    routineId: candidate.routineId,
    title: routineText(
      candidate.title,
      ROUTINE_WAKE_TITLE_MAX,
      `${label} title`,
    ),
    text: routineText(candidate.text, ROUTINE_INBOX_TEXT_MAX, `${label} text`),
    createdAt: routineTimestamp(candidate.createdAt, `${label} createdAt`),
    quiet: { automation: true },
    ...(candidate.renotifiedAt === undefined
      ? {}
      : {
          renotifiedAt: routineTimestamp(
            candidate.renotifiedAt,
            `${label} renotifiedAt`,
          ),
        }),
    ...(candidate.source === undefined
      ? {}
      : { source: completionSourceV1(candidate.source, `${label} source`) }),
  };
}

/**
 * The hand-off text an automation Turn produced, if it produced one. The
 * `wake/parent` event is the only durable statement a Routine can make to its
 * parent, so the last one recorded in the Turn wins.
 */
export function routineHandoffTextV1(
  events: readonly { type: string }[],
): string | undefined {
  const handoff = events.findLast((event) => event.type === "wake/parent") as
    { type: "wake/parent"; message: string } | undefined;
  return handoff?.message;
}

/**
 * How the drained hand-offs are rendered into the next chat Turn's input.
 *
 * They are prefixed, never merged: the User's own text stays verbatim and last,
 * so the model reads the hand-off as context that arrived before the person
 * spoke rather than as something the person said.
 */
export function pendingBotInputPreambleV1(
  inputs: readonly PendingBotInputV1[],
): string {
  if (inputs.length === 0) return "";
  const lines: string[] = [];
  for (const input of inputs) {
    if (input.kind === "wake") {
      lines.push(
        input.source === "subagent"
          ? `[${input.title}] While you were away, the subagent "${input.routineId}" you dispatched finished. Its summary — not its transcript, which you cannot see — is:`
          : `[${input.title}] While you were away, your Routine "${input.routineId}" finished and handed off:`,
        input.text,
        "",
      );
      continue;
    }
    if (input.kind === "approval") {
      lines.push(
        `[Approval] The decision on "${input.approvalId}" is ${input.decision}.`,
        "",
      );
      continue;
    }
    lines.push(
      `[Machine] Command "${input.commandId}" on machine ${input.machineId} finished ${input.outcome}: ${input.preview}`,
      `Call machine_command_check with commandId "${input.commandId}" to read the whole result.`,
      "",
    );
  }
  return lines.join("\n");
}
