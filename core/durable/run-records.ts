import {
  decodeSessionEvent,
  decodeTurnTypeV1,
  formatSkillRefV1,
  type SessionEvent,
  type SkillRefV1,
  type TurnTypeV1,
} from "@frockbot/core/contracts";

/**
 * The kernel records the Composition/configuration snapshot a Turn was admitted
 * under, but never interprets it: the owning Package supplies the decoder.
 */
export interface StoredRunCodecOptionsV1<Snapshot> {
  decodeRunId(value: unknown): string;
  decodeConfigurationSnapshot(value: unknown): Snapshot;
  /** Validates the admission preparation when a run carries one. */
  decodePreparedInputs?(value: unknown): unknown;
}

export interface StoredRunCodecV1<Snapshot> {
  require(input: unknown): StoredRunV1<Snapshot>;
  optional(input: unknown): StoredRunV1<Snapshot> | undefined;
}

export type StoredRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * The admission lane a Turn was accepted on.
 *
 * A `user` admission is a person speaking to the Bot: it queues ahead of
 * agent work, and a chat Turn on this lane ends at its next step boundary when
 * one is waiting. An `agent` admission queues FIFO behind it; a `background`
 * admission — a Routine firing, a subagent dispatch — is refused while
 * anything runs. The lane is durable because it decides which Turn yields,
 * and that has to survive eviction alongside the run.
 */
export type RunLaneV1 = "user" | "agent" | "background";

const RUN_LANES_V1: readonly RunLaneV1[] = ["user", "agent", "background"];

/**
 * The lane a turn type belongs to when its record names none. Chat is the
 * conversation, so it is the User's lane; every other turn type is work the
 * Bot started for itself.
 */
export function defaultRunLaneV1(turnType: TurnTypeV1): RunLaneV1 {
  if (turnType === "chat") return "user";
  return turnType === "agent" ? "agent" : "background";
}

export type StoredEffectAdmissionOutcome = "admitted" | "fenced";

/** Durable linearization result for one exact provider or tool effect. */
export interface StoredEffectAdmission {
  kind: "model" | "tool";
  effectId: string;
  outcome: StoredEffectAdmissionOutcome;
}

/** How a Turn that no person started came to be started. */
export type StoredRunTriggerV1 = "cron" | "webhook" | "manual" | "connection";

/** A Turn a Routine's firing produced. */
export interface StoredRunRoutineOriginV1 {
  kind: "routine";
  routineId: string;
  fireId: string;
  trigger: StoredRunTriggerV1;
}

/**
 * A Turn a parent Turn dispatched as a subagent task.
 *
 * It is recorded in the *child* object: the Subagent Durable Object runs the
 * Turn, and this is how the run it wrote says whose task it was and which of
 * the parent's runs asked for it. The parent's own authority — the task record,
 * the bounds, the terminal outcome — lives in the parent object and never here.
 */
export interface StoredRunSubagentOriginV1 {
  kind: "subagent";
  taskId: string;
  parentRunId: string;
}

/**
 * A Turn this Bot handed off to itself so the Turn that asked could reply
 * without waiting for the work — the `subagent` tool.
 *
 * `depth` is the whole of the recursion bound and it travels on the record
 * rather than in memory: the Turn this origin belongs to is the one that may
 * not hand off again, and it has to be able to tell after an eviction.
 */
export interface StoredRunHandoffOriginV1 {
  kind: "handoff";
  /** The run whose `subagent` call asked for this Turn. */
  parentRunId: string;
  /** How many hand-offs deep this Turn is. One is the only value today. */
  depth: number;
}

/** A same-User Bot asking this Bot a question. */
export interface StoredRunBotOriginV1 {
  kind: "bot";
  fromBotId: string;
  fromBotName: string;
  messageId: string;
}

/**
 * The account's voice session asking this Bot a question.
 *
 * The three ids are one fixed return address, written before the Bot is asked
 * anything: which call was live, which spoken Turn the person was taking, and
 * which request this is. Recovery reads the answer back to *that* request
 * rather than to whatever the Bot said most recently.
 */
export interface StoredRunVoiceOriginV1 {
  kind: "voice";
  callId: string;
  /** The spoken Turn the person was taking when they asked. */
  voiceTurnId: string;
  /** The durable voice request id; also this Turn's run id. */
  requestId: string;
}

/**
 * A conversational Turn opened to deliver what an automation Turn handed off.
 *
 * A firing's hand-off is queued for the Bot's next conversational Turn, and
 * nothing used to open one: the hand-off waited until the person happened to
 * speak, which for a morning triage meant hours, or a day, or never. This is
 * that Turn — an ordinary `chat` Turn, so the Bot answers with the
 * conversation in front of it and says what matters in its own voice, rather
 * than the firing's words being posted into a thread they were written
 * without.
 *
 * `wakeRunId` is the automation run whose hand-off is owed, and it is what
 * makes the delivery idempotent: one delivery Turn per hand-off, refused by
 * the kernel's own run-id idempotency if the alarm asks twice.
 */
export interface StoredRunRoutineDeliveryOriginV1 {
  kind: "routine-delivery";
  wakeRunId: string;
}

/**
 * A Group Chat asking one of its members for a Turn.
 *
 * The group, its name and members as the Turn was asked, and the last group
 * message the Turn was given — which is how a newer message tells the Turn to
 * yield, and how the group knows what the member has read.
 */
export interface StoredRunGroupOriginV1 {
  kind: "group";
  groupId: string;
  groupName: string;
  members: Array<{ botId: string; name: string }>;
  throughSeq: number;
  /**
   * Why the member was asked: the person or a member @mentioned it, it yielded
   * before answering, Retry, or Jev judged the message was for it.
   */
  reason: "mention" | "continue" | "retry" | "jev";
}

/**
 * A conversational Turn opened because a pending input landed: a person's
 * answer to an approval, their press on a card, a command their Mac finished.
 *
 * Each reaches the Bot only through the pending-input queue, which its next
 * conversational Turn drains — and nothing opened one, so the person approved
 * a Plugin, picked an answer, or waited on a command, and then had to ask
 * before the Bot said anything. This is that Turn, opened by the input itself.
 * It drains the whole queue, not only the input that opened it.
 *
 * `inputId` is that input's id in the queue (`pendingBotInputIdV1`).
 */
export interface StoredRunInputDeliveryOriginV1 {
  kind: "input-delivery";
  inputId: string;
}

/** What produced a Turn, when it was not a person speaking to the Bot. */
export type StoredRunOriginV1 =
  | StoredRunRoutineOriginV1
  | StoredRunRoutineDeliveryOriginV1
  | StoredRunInputDeliveryOriginV1
  | StoredRunSubagentOriginV1
  | StoredRunHandoffOriginV1
  | StoredRunBotOriginV1
  | StoredRunVoiceOriginV1
  | StoredRunGroupOriginV1;

/**
 * How deep a hand-off chain may go. One: a Turn a person or a Routine started
 * may hand off, and the Turn it hands to may not.
 */
export const STORED_RUN_HANDOFF_MAX_DEPTH = 1;

const STORED_RUN_ORIGIN_TRIGGERS: readonly StoredRunTriggerV1[] = [
  "cron",
  "webhook",
  "manual",
  "connection",
];

/**
 * The turn type an admitted run was accepted as, and what produced it,
 * recorded so recovery after eviction re-mounts the same catalog and the firing
 * stays attributable. Absent means `chat` with no recorded origin: it is
 * written only for a Turn that has one, so a record admitted before turn
 * admission existed and a chat record written after it are byte-for-byte the
 * same.
 */
export interface StoredRunAdmissionV1 {
  schemaVersion: 1;
  turnType: TurnTypeV1;
  /**
   * The lane this Turn was admitted on. Absent means the lane its turn type
   * defaults to, so no producer writing today's lanes changes a stored byte;
   * a later lane that is not a turn type's default — bot-to-bot messaging's
   * `agent` lane — names itself here.
   */
  lane?: RunLaneV1;
  /**
   * The subagent role the Turn was admitted under, when it had one. Recorded
   * for the same reason the turn type is: recovery after eviction has to
   * re-mount the *same* catalog, and the role is half of what selects it.
   */
  subagentRole?: string;
  origin?: StoredRunOriginV1;
}

export type StoredRunPhase = "queued" | "admitted" | "executing";

export interface StoredRunV1<Snapshot = unknown> {
  runId: string;
  commandFingerprint: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  /** A fresh execution attempt of the same visible user message. */
  retryOf?: string;
  /** Recorded on the predecessor in the same transaction as its retry. */
  retriedBy?: string;
  /** Self-contained identity and time even when the first attempt is off-page. */
  messageRunId?: string;
  messageAdmittedAt?: string;
  events: SessionEvent[];
  /**
   * Inclusive/exclusive coordinates of this Turn in the authoritative Session
   * log. New durable records carry this instead of embedding `events`; the
   * in-memory record is hydrated through the Session log accessor.
   */
  eventRange?: StoredRunEventRangeV1;
  effectAdmissions: StoredEffectAdmission[];
  status: StoredRunStatus;
  responseText?: string;
  failure?: string;
  phase: StoredRunPhase;
  /** Durable Stop intent; orthogonal to status and phase. */
  stopRequestedAt?: string;
  /** The Composition generation pinned in the same transaction that admitted the run. */
  compositionGenerationId: string;
  /**
   * The generation the Turn actually mounted when activation fell closed onto
   * the last known good. The requested pin stays `compositionGenerationId`.
   */
  mountedCompositionGenerationId?: string;
  /**
   * Account, Bot, Composition and context versions this Turn was admitted
   * under. Absent on a record that has not been prepared; execution refuses
   * those rather than substituting the live account.
   */
  preparedInputs?: unknown;
  configurationSnapshot: Snapshot;
  previousEventCount: number;
  /** Absent ⇒ the run was admitted as a `chat` Turn. */
  admission?: StoredRunAdmissionV1;
  /** An ordinary admitted Turn whose only action is one caller-selected tool. */
  directTool?: DirectToolCommandV1;
}

export interface StoredRunEventRangeV1 {
  startSeq: number;
  endSeq: number;
}

/** Keeps a hydrated journal and its durable coordinates in lockstep. */
export function storedRunEventFieldsV2(
  previousEventCount: number,
  events: SessionEvent[],
): { events: SessionEvent[]; eventRange: StoredRunEventRangeV1 } {
  return {
    events,
    eventRange: {
      startSeq: previousEventCount,
      endSeq: previousEventCount + events.length,
    },
  };
}

/**
 * The compact durable run shape. Keeping this encoder beside the strict
 * decoder makes it difficult for a metadata update to accidentally put a
 * hydrated multi-megabyte journal back into one SQLite value.
 */
export function storedRunRecordV2<Snapshot>(
  run: StoredRunV1<Snapshot>,
): Omit<StoredRunV1<Snapshot>, "events"> {
  const { events, ...record } = run;
  const eventRange =
    events.length === 0 && run.eventRange
      ? run.eventRange
      : {
          startSeq: run.previousEventCount,
          endSeq: run.previousEventCount + events.length,
        };
  return { ...record, eventRange };
}

export interface DirectToolCommandV1 {
  packageId: string;
  name: string;
  input: unknown;
}

/** The subagent role a stored run re-mounts under, if any. */
export function storedRunSubagentRoleV1(run: {
  admission?: StoredRunAdmissionV1;
}): string | undefined {
  return run.admission?.subagentRole;
}

/** The turn type a stored run re-mounts on. */
export function storedRunTurnTypeV1(run: {
  admission?: StoredRunAdmissionV1;
}): TurnTypeV1 {
  return run.admission?.turnType ?? "chat";
}

/** The lane a stored run was admitted on. */
export function storedRunLaneV1(run: {
  admission?: StoredRunAdmissionV1;
}): RunLaneV1 {
  return (
    run.admission?.lane ?? defaultRunLaneV1(run.admission?.turnType ?? "chat")
  );
}

/**
 * Whether a Turn with this origin is a delivery Turn: one opened only to carry
 * the pending queue — a Routine's hand-off, or an input that landed — with
 * nobody having spoken.
 */
export function isDeliveryOriginV1(origin?: { kind?: string }): boolean {
  return (
    origin?.kind === "routine-delivery" || origin?.kind === "input-delivery"
  );
}

/**
 * Whether this run is a delivery Turn.
 *
 * A chat Turn drains the pending queue before the model runs, so a Turn that
 * does not complete has consumed inputs it never delivered. Only a delivery
 * Turn gives them back: it is a Turn nobody asked for, so losing what it
 * drained loses a morning's triage, or a person's answer, with no one
 * there to ask again. A Turn the person started keeps the behaviour it has
 * always had — they were there, and re-queuing what it drained would make the
 * Bot re-tell them something it has already said.
 */
export function storedRunIsDeliveryV1(run: {
  // Structural rather than `StoredRunAdmissionV1`, so the one predicate also
  // answers for the Shell's deliberately wide settled-run shape.
  admission?: { origin?: { kind?: string } };
}): boolean {
  return isDeliveryOriginV1(run.admission?.origin);
}

/**
 * The `admission` field a Turn records — nothing at all for a chat Turn with
 * no recorded origin, so no stored bytes change for the Turn every producer
 * writes today.
 */
export function storedRunAdmissionV1(
  turnType: TurnTypeV1 | undefined,
  origin?: StoredRunOriginV1,
  subagentRole?: string,
  lane?: RunLaneV1,
): { admission?: StoredRunAdmissionV1 } {
  const admitted = turnType ?? "chat";
  // A lane that is already the turn type's default is not written: it says
  // nothing the record does not, and writing it would change the bytes of the
  // Turn every producer writes today.
  const named = lane && lane !== defaultRunLaneV1(admitted) ? lane : undefined;
  if (
    admitted === "chat" &&
    origin === undefined &&
    subagentRole === undefined &&
    named === undefined
  )
    return {};
  return {
    admission: {
      schemaVersion: 1,
      turnType: admitted,
      ...(named ? { lane: named } : {}),
      ...(subagentRole ? { subagentRole } : {}),
      ...(origin ? { origin } : {}),
    },
  };
}

/** How long a recorded subagent role may be. It is an opaque bounded string. */
const STORED_RUN_SUBAGENT_ROLE_MAX = 64;

const STORED_RUN_STATUSES: readonly StoredRunStatus[] = [
  "running",
  "completed",
  "failed",
  "cancelled",
];
const STORED_RUN_PHASES: readonly StoredRunPhase[] = [
  "queued",
  "admitted",
  "executing",
];
const STORED_RUN_REQUIRED_KEYS = [
  "runId",
  "commandFingerprint",
  "sessionId",
  "acceptedAt",
  "input",
  "effectAdmissions",
  "status",
  "phase",
  "compositionGenerationId",
  "configurationSnapshot",
  "previousEventCount",
] as const;
const STORED_RUN_OPTIONAL_KEYS = [
  "events",
  "eventRange",
  "responseText",
  "failure",
  "stopRequestedAt",
  "admission",
  "directTool",
  "retryOf",
  "retriedBy",
  "messageRunId",
  "messageAdmittedAt",
  "mountedCompositionGenerationId",
  "preparedInputs",
] as const;
const UTF8_ENCODER = new TextEncoder();

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    UTF8_ENCODER.encode(value).byteLength <= maximum
  );
}

/** The largest failure a run record may carry, in UTF-8 bytes. */
export const MAX_RUN_FAILURE_BYTES_V1 = 8_000;

/**
 * The failure a settlement may durably write, cut to what the record allows.
 *
 * A failure string is whatever an error's `message` happened to be, and nothing
 * upstream bounds it — a provider that echoes a request back, or a message
 * built by concatenating one, easily runs past the limit. Writing it anyway
 * produced a record the codec refused on every later read, so a Turn that
 * failed once went on to 500 the transcript endpoint for ever. The message is
 * for a person to read: cutting it costs nothing the record does not already
 * hold, and losing the whole transcript costs everything.
 */
export function boundedRunFailureV1(failure: string): string {
  if (UTF8_ENCODER.encode(failure).byteLength <= MAX_RUN_FAILURE_BYTES_V1) {
    return failure;
  }
  const ellipsis = "…";
  const budget =
    MAX_RUN_FAILURE_BYTES_V1 - UTF8_ENCODER.encode(ellipsis).byteLength;
  let kept = failure;
  // Cutting by characters and re-measuring keeps the result valid UTF-8; a
  // byte-wise slice can land inside a multi-byte sequence.
  while (UTF8_ENCODER.encode(kept).byteLength > budget) {
    kept = kept.slice(0, Math.max(0, Math.floor(kept.length * 0.9) - 1));
  }
  return `${kept}${ellipsis}`;
}

function decodeDirectToolCommandV1(value: unknown): DirectToolCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored run has invalid direct tool command");
  }
  const candidate = value as Record<PropertyKey, unknown>;
  const fields = ["packageId", "name", "input"];
  if (
    Reflect.ownKeys(candidate).length !== fields.length ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(candidate, field)) ||
    !boundedString(candidate.packageId, 64) ||
    !boundedString(candidate.name, 64) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.name)
  ) {
    throw new Error("stored run has invalid direct tool command fields");
  }
  let input: unknown;
  try {
    const encoded = JSON.stringify(candidate.input);
    if (
      encoded === undefined ||
      UTF8_ENCODER.encode(encoded).byteLength > 64_000
    ) {
      throw new Error("invalid input");
    }
    input = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("stored run has invalid direct tool input");
  }
  return {
    packageId: candidate.packageId,
    name: candidate.name,
    input,
  };
}

/**
 * Exact fields, per origin kind. Each kind gets its own branch rather than a
 * union of optional fields: a `routine` origin carrying a `taskId` is not a
 * record with a spare field, it is a record this codec has never written.
 */
function requireExactOriginFields(
  candidate: Record<PropertyKey, unknown>,
  fields: readonly string[],
  runId: string,
): void {
  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== fields.length ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((key) => Object.hasOwn(candidate, key))
  ) {
    throw new Error(`run "${runId}" has invalid admission origin fields`);
  }
}

function decodeStoredRunOrigin(
  value: unknown,
  runId: string,
): StoredRunOriginV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`run "${runId}" has invalid admission origin`);
  }
  const candidate = value as Record<PropertyKey, unknown>;
  if (candidate.kind === "subagent") {
    requireExactOriginFields(
      candidate,
      ["kind", "taskId", "parentRunId"],
      runId,
    );
    if (
      !boundedString(candidate.taskId, 256) ||
      !boundedString(candidate.parentRunId, 256)
    ) {
      throw new Error(`run "${runId}" has an invalid admission origin id`);
    }
    return {
      kind: "subagent",
      taskId: candidate.taskId,
      parentRunId: candidate.parentRunId,
    };
  }
  if (candidate.kind === "handoff") {
    requireExactOriginFields(
      candidate,
      ["kind", "parentRunId", "depth"],
      runId,
    );
    if (!boundedString(candidate.parentRunId, 128)) {
      throw new Error(`run "${runId}" has an invalid admission origin id`);
    }
    // One hand-off deep is the whole of what the tool admits, so a record
    // claiming more depth than the tool can produce is not a record this codec
    // wrote.
    if (
      typeof candidate.depth !== "number" ||
      !Number.isSafeInteger(candidate.depth) ||
      candidate.depth < 1 ||
      candidate.depth > STORED_RUN_HANDOFF_MAX_DEPTH
    ) {
      throw new Error(`run "${runId}" has an invalid admission origin depth`);
    }
    return {
      kind: "handoff",
      parentRunId: candidate.parentRunId,
      depth: candidate.depth,
    };
  }
  if (candidate.kind === "bot") {
    requireExactOriginFields(
      candidate,
      ["kind", "fromBotId", "fromBotName", "messageId"],
      runId,
    );
    if (
      !boundedString(candidate.fromBotId, 128) ||
      !boundedString(candidate.fromBotName, 100) ||
      !boundedString(candidate.messageId, 256)
    ) {
      throw new Error(`run "${runId}" has an invalid admission origin`);
    }
    return {
      kind: "bot",
      fromBotId: candidate.fromBotId,
      fromBotName: candidate.fromBotName,
      messageId: candidate.messageId,
    };
  }
  if (candidate.kind === "group") {
    requireExactOriginFields(
      candidate,
      ["kind", "groupId", "groupName", "members", "throughSeq", "reason"],
      runId,
    );
    const members = candidate.members;
    if (
      !boundedString(candidate.groupId, 128) ||
      !boundedString(candidate.groupName, 1_000) ||
      !Array.isArray(members) ||
      members.length === 0 ||
      members.length > 8 ||
      typeof candidate.throughSeq !== "number" ||
      !Number.isSafeInteger(candidate.throughSeq) ||
      candidate.throughSeq < 0 ||
      (candidate.reason !== "mention" &&
        candidate.reason !== "continue" &&
        candidate.reason !== "retry" &&
        candidate.reason !== "jev")
    ) {
      throw new Error(`run "${runId}" has an invalid admission origin`);
    }
    return {
      kind: "group",
      groupId: candidate.groupId,
      groupName: candidate.groupName,
      members: members.map((member: unknown) => {
        if (!member || typeof member !== "object" || Array.isArray(member)) {
          throw new Error(`run "${runId}" has an invalid admission origin`);
        }
        const value = member as Record<PropertyKey, unknown>;
        requireExactOriginFields(value, ["botId", "name"], runId);
        if (
          !boundedString(value.botId, 128) ||
          !boundedString(value.name, 100)
        ) {
          throw new Error(`run "${runId}" has an invalid admission origin`);
        }
        return { botId: value.botId, name: value.name };
      }),
      throughSeq: candidate.throughSeq,
      reason: candidate.reason,
    };
  }
  if (candidate.kind === "voice") {
    requireExactOriginFields(
      candidate,
      ["kind", "callId", "voiceTurnId", "requestId"],
      runId,
    );
    if (
      !boundedString(candidate.callId, 128) ||
      !boundedString(candidate.voiceTurnId, 256) ||
      !boundedString(candidate.requestId, 128)
    ) {
      throw new Error(`run "${runId}" has an invalid admission origin id`);
    }
    return {
      kind: "voice",
      callId: candidate.callId,
      voiceTurnId: candidate.voiceTurnId,
      requestId: candidate.requestId,
    };
  }
  if (candidate.kind === "routine-delivery") {
    requireExactOriginFields(candidate, ["kind", "wakeRunId"], runId);
    if (!boundedString(candidate.wakeRunId, 256)) {
      throw new Error(`run "${runId}" has an invalid admission origin id`);
    }
    return {
      kind: "routine-delivery",
      wakeRunId: candidate.wakeRunId,
    };
  }
  if (candidate.kind === "input-delivery") {
    requireExactOriginFields(candidate, ["kind", "inputId"], runId);
    // An approval id is up to 256 characters, and a machine command's input
    // id prefixes one.
    if (!boundedString(candidate.inputId, 512)) {
      throw new Error(`run "${runId}" has an invalid admission origin id`);
    }
    return {
      kind: "input-delivery",
      inputId: candidate.inputId,
    };
  }
  if (candidate.kind !== "routine") {
    throw new Error(`run "${runId}" has an invalid admission origin kind`);
  }
  requireExactOriginFields(
    candidate,
    ["kind", "routineId", "fireId", "trigger"],
    runId,
  );
  const trigger = STORED_RUN_ORIGIN_TRIGGERS.find(
    (value) => value === candidate.trigger,
  );
  if (!trigger) {
    throw new Error(`run "${runId}" has an invalid admission origin trigger`);
  }
  if (
    !boundedString(candidate.routineId, 256) ||
    !boundedString(candidate.fireId, 256)
  ) {
    throw new Error(`run "${runId}" has an invalid admission origin id`);
  }
  return {
    kind: "routine",
    routineId: candidate.routineId as string,
    fireId: candidate.fireId as string,
    trigger,
  };
}

function decodeStoredRunAdmission(
  value: unknown,
  runId: string,
): StoredRunAdmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`run "${runId}" has invalid admission`);
  }
  const candidate = value as Record<PropertyKey, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "turnType",
    "lane",
    "subagentRole",
    "origin",
  ]);
  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== Object.keys(candidate).length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    !Object.hasOwn(candidate, "schemaVersion") ||
    !Object.hasOwn(candidate, "turnType") ||
    candidate.schemaVersion !== 1
  ) {
    throw new Error(`run "${runId}" has invalid admission fields`);
  }
  let turnType: TurnTypeV1;
  try {
    turnType = decodeTurnTypeV1(candidate.turnType);
  } catch {
    throw new Error(`run "${runId}" has an invalid admission turn type`);
  }
  const lane =
    candidate.lane === undefined
      ? undefined
      : RUN_LANES_V1.find((value) => value === candidate.lane);
  if (candidate.lane !== undefined && !lane) {
    throw new Error(`run "${runId}" has an invalid admission lane`);
  }
  if (
    candidate.subagentRole !== undefined &&
    (typeof candidate.subagentRole !== "string" ||
      candidate.subagentRole.trim().length === 0 ||
      candidate.subagentRole.length > STORED_RUN_SUBAGENT_ROLE_MAX)
  ) {
    throw new Error(`run "${runId}" has an invalid admission subagent role`);
  }
  return {
    schemaVersion: 1,
    turnType,
    ...(lane === undefined ? {} : { lane }),
    ...(candidate.subagentRole === undefined
      ? {}
      : { subagentRole: candidate.subagentRole as string }),
    ...(candidate.origin === undefined
      ? {}
      : { origin: decodeStoredRunOrigin(candidate.origin, runId) }),
  };
}

function decodeStoredRunEvents(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new Error("stored run has invalid events");
  return value.map(decodeSessionEvent);
}

function decodeStoredRunEventRange(
  value: unknown,
  runId: string,
): StoredRunEventRangeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`run "${runId}" has an invalid event range`);
  }
  const candidate = value as Record<PropertyKey, unknown>;
  if (
    Reflect.ownKeys(candidate).length !== 2 ||
    Object.keys(candidate).length !== 2 ||
    !Object.hasOwn(candidate, "startSeq") ||
    !Object.hasOwn(candidate, "endSeq") ||
    !Number.isSafeInteger(candidate.startSeq) ||
    !Number.isSafeInteger(candidate.endSeq) ||
    (candidate.startSeq as number) < 0 ||
    (candidate.endSeq as number) < (candidate.startSeq as number)
  ) {
    throw new Error(`run "${runId}" has an invalid event range`);
  }
  return {
    startSeq: candidate.startSeq as number,
    endSeq: candidate.endSeq as number,
  };
}

/**
 * Most effect admissions one run record may carry. The decoder enforces it, so
 * a run that would exceed it cannot be stored; anything that plans several
 * admissions at once reads the bound from here rather than restating it.
 */
export const STORED_EFFECT_ADMISSIONS_MAX = 256;
const STORED_EFFECT_ID_MAX_BYTES = 512;

function decodeStoredEffectAdmissions(value: unknown): StoredEffectAdmission[] {
  if (!Array.isArray(value) || value.length > STORED_EFFECT_ADMISSIONS_MAX) {
    throw new Error("stored run has invalid effect admissions");
  }
  const effectIds = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("stored run has invalid effect admission");
    }
    const candidate = entry as Record<PropertyKey, unknown>;
    const ownKeys = Reflect.ownKeys(candidate);
    if (
      ownKeys.length !== 3 ||
      Object.keys(candidate).length !== 3 ||
      !["kind", "effectId", "outcome"].every((key) =>
        Object.hasOwn(candidate, key),
      )
    ) {
      throw new Error("stored run has invalid effect admission fields");
    }
    if (candidate.kind !== "model" && candidate.kind !== "tool") {
      throw new Error("stored run has invalid effect admission kind");
    }
    if (!boundedString(candidate.effectId, STORED_EFFECT_ID_MAX_BYTES)) {
      throw new Error("stored run has invalid effect admission id");
    }
    if (candidate.outcome !== "admitted" && candidate.outcome !== "fenced") {
      throw new Error("stored run has invalid effect admission outcome");
    }
    if (effectIds.has(candidate.effectId)) {
      throw new Error("stored run has colliding effect admissions");
    }
    effectIds.add(candidate.effectId);
    return {
      kind: candidate.kind,
      effectId: candidate.effectId,
      outcome: candidate.outcome,
    };
  });
}

export function createStoredRunCodecV1<Snapshot>(
  options: StoredRunCodecOptionsV1<Snapshot>,
): StoredRunCodecV1<Snapshot> {
  const require = (input: unknown): StoredRunV1<Snapshot> =>
    requireStoredRunRecordV1(input, options);
  return {
    require,
    optional: (input) => (input === undefined ? undefined : require(input)),
  };
}

function requireStoredRunRecordV1<Snapshot>(
  input: unknown,
  options: StoredRunCodecOptionsV1<Snapshot>,
): StoredRunV1<Snapshot> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("stored run is invalid");
  }
  const candidate = input as Record<PropertyKey, unknown>;
  const allowed = new Set<string>([
    ...STORED_RUN_REQUIRED_KEYS,
    ...STORED_RUN_OPTIONAL_KEYS,
  ]);
  // Exact decoding: a symbol-keyed or non-enumerable own property is a field
  // this record does not have, so it is rejected rather than ignored.
  const enumerableKeys = Object.keys(candidate);
  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== enumerableKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    !STORED_RUN_REQUIRED_KEYS.every((key) => Object.hasOwn(candidate, key))
  ) {
    throw new Error("stored run has invalid fields");
  }
  let runId: string;
  try {
    runId = options.decodeRunId(candidate.runId);
  } catch {
    throw new Error("stored run has invalid runId");
  }
  if (!boundedString(candidate.commandFingerprint, 65_536)) {
    throw new Error(`run "${runId}" has no valid command fingerprint`);
  }
  if (!boundedString(candidate.sessionId, 257)) {
    throw new Error(`run "${runId}" has no valid session id`);
  }
  if (
    !boundedString(candidate.acceptedAt, 64) ||
    !Number.isFinite(Date.parse(candidate.acceptedAt))
  ) {
    throw new Error(`run "${runId}" has no valid acceptance time`);
  }
  if (!boundedString(candidate.input, 32_000)) {
    throw new Error(`run "${runId}" has no valid input`);
  }
  if (candidate.events === undefined && candidate.eventRange === undefined) {
    throw new Error(`run "${runId}" has no event journal reference`);
  }
  const events =
    candidate.events === undefined
      ? []
      : decodeStoredRunEvents(candidate.events);
  const eventRange =
    candidate.eventRange === undefined
      ? undefined
      : decodeStoredRunEventRange(candidate.eventRange, runId);
  const effectAdmissions = decodeStoredEffectAdmissions(
    candidate.effectAdmissions,
  );
  const status = STORED_RUN_STATUSES.find(
    (value) => value === candidate.status,
  );
  if (!status) {
    throw new Error(`run "${runId}" has no valid status`);
  }
  const phase = STORED_RUN_PHASES.find((value) => value === candidate.phase);
  if (!phase) {
    throw new Error(`run "${runId}" has no valid phase`);
  }
  if (!boundedString(candidate.compositionGenerationId, 256)) {
    throw new Error(`run "${runId}" has no valid Composition generation`);
  }
  if (
    candidate.mountedCompositionGenerationId !== undefined &&
    !boundedString(candidate.mountedCompositionGenerationId, 256)
  ) {
    throw new Error(
      `run "${runId}" has no valid mounted Composition generation`,
    );
  }
  if (
    !Number.isSafeInteger(candidate.previousEventCount) ||
    (candidate.previousEventCount as number) < 0
  ) {
    throw new Error(`run "${runId}" has no valid previous event count`);
  }
  if (
    eventRange &&
    (eventRange.startSeq !== candidate.previousEventCount ||
      (events.length > 0 &&
        (events[0]?.seq !== eventRange.startSeq ||
          events.at(-1)!.seq + 1 !== eventRange.endSeq)))
  ) {
    throw new Error(`run "${runId}" has an inconsistent event range`);
  }
  const lineage: Pick<
    StoredRunV1<Snapshot>,
    "retryOf" | "retriedBy" | "messageRunId" | "messageAdmittedAt"
  > = {};
  for (const field of ["retryOf", "retriedBy", "messageRunId"] as const) {
    if (candidate[field] === undefined) continue;
    if (!boundedString(candidate[field], 128)) {
      throw new Error(`run "${runId}" has invalid ${field}`);
    }
    lineage[field] = options.decodeRunId(candidate[field]);
    if (lineage[field] === runId) {
      throw new Error(`run "${runId}" cannot name itself in ${field}`);
    }
  }
  if (candidate.retryOf === undefined) {
    if (
      candidate.messageRunId !== undefined ||
      candidate.messageAdmittedAt !== undefined
    ) {
      throw new Error(`run "${runId}" has message lineage without a retry`);
    }
  } else if (
    candidate.messageRunId === undefined ||
    !boundedString(candidate.messageAdmittedAt, 64) ||
    !Number.isFinite(Date.parse(candidate.messageAdmittedAt))
  ) {
    throw new Error(`run "${runId}" has incomplete retry lineage`);
  } else {
    lineage.messageAdmittedAt = candidate.messageAdmittedAt;
  }
  if (candidate.retriedBy !== undefined && status !== "failed") {
    throw new Error(`run "${runId}" has a successor but is not failed`);
  }
  const configurationSnapshot = options.decodeConfigurationSnapshot(
    candidate.configurationSnapshot,
  );
  let preparedInputs: unknown;
  if (candidate.preparedInputs !== undefined) {
    if (
      !candidate.preparedInputs ||
      typeof candidate.preparedInputs !== "object" ||
      Array.isArray(candidate.preparedInputs)
    ) {
      throw new Error(`run "${runId}" has invalid prepared inputs`);
    }
    preparedInputs = options.decodePreparedInputs
      ? options.decodePreparedInputs(candidate.preparedInputs)
      : candidate.preparedInputs;
  }
  if (
    candidate.responseText !== undefined &&
    !boundedString(candidate.responseText, 64_000, true)
  ) {
    throw new Error(`run "${runId}" has invalid responseText`);
  }
  if (
    candidate.failure !== undefined &&
    !boundedString(candidate.failure, 8_000)
  ) {
    throw new Error(`run "${runId}" has invalid failure`);
  }
  if (
    candidate.stopRequestedAt !== undefined &&
    (!boundedString(candidate.stopRequestedAt, 64) ||
      !Number.isFinite(Date.parse(candidate.stopRequestedAt as string)))
  ) {
    throw new Error(`run "${runId}" has invalid stopRequestedAt`);
  }
  if (
    status === "completed"
      ? candidate.responseText === undefined || candidate.failure !== undefined
      : candidate.responseText !== undefined
  ) {
    throw new Error(`run "${runId}" has invalid completion fields`);
  }
  if (
    status === "failed"
      ? candidate.failure === undefined
      : candidate.failure !== undefined
  ) {
    throw new Error(`run "${runId}" has invalid failure fields`);
  }
  if (status === "cancelled" && candidate.stopRequestedAt === undefined) {
    throw new Error(`run "${runId}" has no durable stop intent`);
  }
  return {
    runId,
    commandFingerprint: candidate.commandFingerprint,
    sessionId: candidate.sessionId,
    acceptedAt: candidate.acceptedAt,
    input: candidate.input,
    ...lineage,
    events,
    ...(eventRange ? { eventRange } : {}),
    effectAdmissions,
    status,
    phase,
    compositionGenerationId: candidate.compositionGenerationId,
    ...(candidate.mountedCompositionGenerationId === undefined
      ? {}
      : {
          mountedCompositionGenerationId:
            candidate.mountedCompositionGenerationId as string,
        }),
    ...(preparedInputs === undefined ? {} : { preparedInputs }),
    configurationSnapshot,
    previousEventCount: candidate.previousEventCount as number,
    ...(candidate.responseText === undefined
      ? {}
      : { responseText: candidate.responseText as string }),
    ...(candidate.failure === undefined
      ? {}
      : { failure: candidate.failure as string }),
    ...(candidate.stopRequestedAt === undefined
      ? {}
      : { stopRequestedAt: candidate.stopRequestedAt as string }),
    ...(candidate.admission === undefined
      ? {}
      : { admission: decodeStoredRunAdmission(candidate.admission, runId) }),
    ...(candidate.directTool === undefined
      ? {}
      : { directTool: decodeDirectToolCommandV1(candidate.directTool) }),
  };
}

export interface BotTurnCommand {
  runId: string;
  /** Explicit retry of one failed attempt, under this command's fresh id. */
  retryOf?: string;
  sessionId: string;
  acceptedAt: string;
  text: string;
  /**
   * Absent ⇒ `chat`. Only an in-Durable-Object producer may name another type;
   * the HTTP Turn path always admits `chat`.
   */
  turnType?: TurnTypeV1;
  /**
   * The subagent role this Turn is admitted under. In-Durable-Object producers
   * only, and only ever on a `subagent` Turn.
   */
  subagentRole?: string;
  /**
   * What produced this Turn. In-Durable-Object producers only; the HTTP Turn
   * path never forwards it.
   */
  origin?: StoredRunOriginV1;
  /**
   * The Skills the User invoked with this message. Part of the command's
   * identity: the same text with a different Skill attached is a different
   * command, so it must not collide on an idempotency record.
   */
  skills?: SkillRefV1[];
  directTool?: DirectToolCommandV1;
  /**
   * The lane this command asks to be admitted on. Absent means the lane its
   * turn type defaults to.
   */
  lane?: RunLaneV1;
}

/**
 * A chat command keeps the exact v1 fingerprint bytes, so idempotency records
 * written before turn admission existed still match the same command after
 * deploy. Only a Turn carrying a turn type or an origin — neither of which any
 * producer could have written before — emits v2, where both are part of the
 * identity of the command.
 */
export function botTurnCommandFingerprintV1(
  command: BotTurnCommand & { userId: string; botId: string },
): string {
  const turnType = command.turnType ?? "chat";
  const skills = command.skills ?? [];
  const lane = command.lane ?? defaultRunLaneV1(turnType);
  if (
    turnType !== "chat" ||
    command.origin !== undefined ||
    command.subagentRole !== undefined ||
    skills.length > 0 ||
    command.directTool !== undefined ||
    lane !== defaultRunLaneV1(turnType) ||
    command.retryOf !== undefined
  ) {
    return `bot-turn-command-v2:${JSON.stringify({
      userId: command.userId,
      botId: command.botId,
      sessionId: command.sessionId,
      text: command.text,
      turnType,
      ...(lane === defaultRunLaneV1(turnType) ? {} : { lane }),
      ...(command.subagentRole ? { subagentRole: command.subagentRole } : {}),
      ...(command.origin ? { origin: command.origin } : {}),
      ...(command.retryOf ? { retryOf: command.retryOf } : {}),
      ...(skills.length > 0 ? { skills: skills.map(formatSkillRefV1) } : {}),
      ...(command.directTool ? { directTool: command.directTool } : {}),
    })}`;
  }
  return `bot-turn-command-v1:${JSON.stringify({
    userId: command.userId,
    botId: command.botId,
    sessionId: command.sessionId,
    text: command.text,
  })}`;
}

export interface BotStopCommand {
  commandId: string;
  runId: string;
}

export function botStopCommandFingerprintV1(
  command: BotStopCommand & { userId: string; botId: string },
): string {
  return `bot-stop-command-v1:${JSON.stringify({
    userId: command.userId,
    botId: command.botId,
    runId: command.runId,
  })}`;
}

export interface BotNotificationIntent {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
  /**
   * How loudly the User is told. `critical` is for an intent the Bot's own
   * notification policy does not gate — a question that has stopped the Bot
   * rather than an update about one that finished. Absent means `normal`.
   */
  urgency?: "normal" | "critical";
}

export interface BotTurnCompletion {
  runId: string;
  text: string;
  events: SessionEvent[];
  notification?: BotNotificationIntent;
}

/**
 * The server has durably accepted a command. Execution may still be queued
 * or running; the receipt is not a completion.
 */
export interface BotTurnAdmission {
  runId: string;
  state: "queued" | "running" | "terminal";
}

/**
 * The little that can be trusted about a run record nobody can decode.
 *
 * A transcript read is display-only: it never resumes, settles or recovers a
 * Turn, so it does not need the record to be valid — it needs enough to draw
 * one row saying which Turn could not be read. The run id comes from the
 * admission index key, which is authority; everything else is scraped from the
 * raw value and kept only where it is plainly a safe, bounded string, so a
 * record corrupt in any other field still yields a renderable row.
 */
export interface UnreadableStoredRunV1 {
  readonly runId: string;
  readonly sessionId?: string;
  readonly acceptedAt?: string;
  readonly input?: string;
  readonly admission?: { readonly turnType?: TurnTypeV1 };
}

/** Scrape a record that failed to decode down to {@link UnreadableStoredRunV1}. */
export function unreadableStoredRunV1(
  runId: string,
  raw: unknown,
): UnreadableStoredRunV1 {
  const candidate =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const admission =
    candidate.admission &&
    typeof candidate.admission === "object" &&
    !Array.isArray(candidate.admission)
      ? (candidate.admission as Record<string, unknown>)
      : undefined;
  let turnType: TurnTypeV1 | undefined;
  try {
    if (admission?.turnType !== undefined) {
      turnType = decodeTurnTypeV1(admission.turnType);
    }
  } catch {
    turnType = undefined;
  }
  return {
    runId,
    ...(boundedString(candidate.sessionId, 257)
      ? { sessionId: candidate.sessionId }
      : {}),
    ...(boundedString(candidate.acceptedAt, 64) &&
    Number.isFinite(Date.parse(candidate.acceptedAt))
      ? { acceptedAt: candidate.acceptedAt }
      : {}),
    ...(boundedString(candidate.input, 32_000)
      ? { input: candidate.input }
      : {}),
    ...(turnType ? { admission: { turnType } } : {}),
  };
}
