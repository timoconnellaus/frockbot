import {
  decodeSessionEvent,
  decodeTurnTypeV1,
  type SessionEvent,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";

/**
 * The kernel records the Composition/configuration snapshot a Turn was admitted
 * under, but never interprets it: the owning Package supplies the decoder.
 */
export interface StoredRunCodecOptionsV1 {
  decodeRunId(value: unknown): string;
  decodeConfigurationSnapshot(value: unknown): unknown;
}

export interface StoredRunCodecV1<Snapshot> {
  require(input: unknown): StoredRunV1<Snapshot>;
  optional(input: unknown): StoredRunV1<Snapshot> | undefined;
}

export type StoredRunStatus =
  "running" | "completed" | "failed" | "cancelled" | "reconciliation-required";

export type StoredEffectAdmissionOutcome = "admitted" | "fenced";

/** Durable linearization result for one exact provider or tool effect. */
export interface StoredEffectAdmission {
  kind: "model" | "tool";
  effectId: string;
  outcome: StoredEffectAdmissionOutcome;
}

/** What produced a Turn, when it was not a person speaking to the Bot. */
export interface StoredRunOriginV1 {
  kind: "routine";
  routineId: string;
  fireId: string;
  trigger: "cron" | "webhook" | "integration" | "manual";
}

const STORED_RUN_ORIGIN_TRIGGERS: readonly StoredRunOriginV1["trigger"][] = [
  "cron",
  "webhook",
  "integration",
  "manual",
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
  origin?: StoredRunOriginV1;
}

export type StoredRunPhase =
  "admitted" | "executing" | "reconciliation-required";

export interface StoredRunV1<Snapshot = unknown> {
  runId: string;
  commandFingerprint: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: SessionEvent[];
  effectAdmissions: StoredEffectAdmission[];
  status: StoredRunStatus;
  responseText?: string;
  failure?: string;
  phase: StoredRunPhase;
  /** Durable Stop intent; orthogonal to status and phase. */
  stopRequestedAt?: string;
  /** The Composition generation pinned in the same transaction that admitted the run. */
  compositionGenerationId: string;
  configurationSnapshot: Snapshot;
  previousEventCount: number;
  /** Absent ⇒ the run was admitted as a `chat` Turn. */
  admission?: StoredRunAdmissionV1;
}

/** The turn type a stored run re-mounts on. */
export function storedRunTurnTypeV1(run: {
  admission?: StoredRunAdmissionV1;
}): TurnTypeV1 {
  return run.admission?.turnType ?? "chat";
}

/**
 * The `admission` field a Turn records — nothing at all for a chat Turn with
 * no recorded origin, so no stored bytes change for the Turn every producer
 * writes today.
 */
export function storedRunAdmissionV1(
  turnType: TurnTypeV1 | undefined,
  origin?: StoredRunOriginV1,
): { admission?: StoredRunAdmissionV1 } {
  const admitted = turnType ?? "chat";
  if (admitted === "chat" && origin === undefined) return {};
  return {
    admission: {
      schemaVersion: 1,
      turnType: admitted,
      ...(origin ? { origin } : {}),
    },
  };
}

const STORED_RUN_STATUSES: readonly StoredRunStatus[] = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "reconciliation-required",
];
const STORED_RUN_PHASES: readonly StoredRunPhase[] = [
  "admitted",
  "executing",
  "reconciliation-required",
];
const STORED_RUN_REQUIRED_KEYS = [
  "runId",
  "commandFingerprint",
  "sessionId",
  "acceptedAt",
  "input",
  "events",
  "effectAdmissions",
  "status",
  "phase",
  "compositionGenerationId",
  "configurationSnapshot",
  "previousEventCount",
] as const;
const STORED_RUN_OPTIONAL_KEYS = [
  "responseText",
  "failure",
  "stopRequestedAt",
  "admission",
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

function decodeStoredRunOrigin(
  value: unknown,
  runId: string,
): StoredRunOriginV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`run "${runId}" has invalid admission origin`);
  }
  const candidate = value as Record<PropertyKey, unknown>;
  const fields = ["kind", "routineId", "fireId", "trigger"];
  const ownKeys = Reflect.ownKeys(candidate);
  if (
    ownKeys.length !== fields.length ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((key) => Object.hasOwn(candidate, key))
  ) {
    throw new Error(`run "${runId}" has invalid admission origin fields`);
  }
  if (candidate.kind !== "routine") {
    throw new Error(`run "${runId}" has an invalid admission origin kind`);
  }
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
    routineId: candidate.routineId,
    fireId: candidate.fireId,
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
  const allowed = new Set(["schemaVersion", "turnType", "origin"]);
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
  return {
    schemaVersion: 1,
    turnType,
    ...(candidate.origin === undefined
      ? {}
      : { origin: decodeStoredRunOrigin(candidate.origin, runId) }),
  };
}

function decodeStoredRunEvents(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new Error("stored run has invalid events");
  return value.map(decodeSessionEvent);
}

const STORED_EFFECT_ADMISSIONS_MAX = 256;
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
  options: StoredRunCodecOptionsV1,
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
  options: StoredRunCodecOptionsV1,
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
  const events = decodeStoredRunEvents(candidate.events);
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
    !Number.isSafeInteger(candidate.previousEventCount) ||
    (candidate.previousEventCount as number) < 0
  ) {
    throw new Error(`run "${runId}" has no valid previous event count`);
  }
  options.decodeConfigurationSnapshot(candidate.configurationSnapshot);
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
    status === "failed" || status === "reconciliation-required"
      ? candidate.failure === undefined
      : candidate.failure !== undefined
  ) {
    throw new Error(`run "${runId}" has invalid failure fields`);
  }
  if (status === "cancelled" && candidate.stopRequestedAt === undefined) {
    throw new Error(`run "${runId}" has no durable stop intent`);
  }
  if (
    (status === "reconciliation-required") !==
    (phase === "reconciliation-required")
  ) {
    throw new Error(`run "${runId}" has inconsistent recovery state`);
  }
  return {
    runId,
    commandFingerprint: candidate.commandFingerprint,
    sessionId: candidate.sessionId,
    acceptedAt: candidate.acceptedAt,
    input: candidate.input,
    events,
    effectAdmissions,
    status,
    phase,
    compositionGenerationId: candidate.compositionGenerationId,
    configurationSnapshot: candidate.configurationSnapshot as Snapshot,
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
  };
}

export interface BotTurnCommand {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  text: string;
  /**
   * Absent ⇒ `chat`. Only an in-Durable-Object producer may name another type;
   * the HTTP Turn path always admits `chat`.
   */
  turnType?: TurnTypeV1;
  /**
   * What produced this Turn. In-Durable-Object producers only; the HTTP Turn
   * path never forwards it.
   */
  origin?: StoredRunOriginV1;
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
  if (turnType !== "chat" || command.origin !== undefined) {
    return `bot-turn-command-v2:${JSON.stringify({
      userId: command.userId,
      botId: command.botId,
      sessionId: command.sessionId,
      text: command.text,
      turnType,
      ...(command.origin ? { origin: command.origin } : {}),
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
}

export interface BotTurnCompletion {
  runId: string;
  text: string;
  events: SessionEvent[];
  notification?: BotNotificationIntent;
}
