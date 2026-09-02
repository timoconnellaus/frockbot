import {
  decodeSessionEvent,
  decodeTurnTypeV1,
  formatSkillRefV1,
  type SessionEvent,
  type SkillRefV1,
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

/** How a Turn that no person started came to be started. */
export type StoredRunTriggerV1 = "cron" | "webhook" | "integration" | "manual";

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

/** What produced a Turn, when it was not a person speaking to the Bot. */
export type StoredRunOriginV1 =
  StoredRunRoutineOriginV1 | StoredRunSubagentOriginV1;

const STORED_RUN_ORIGIN_TRIGGERS: readonly StoredRunTriggerV1[] = [
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
  /**
   * The subagent role the Turn was admitted under, when it had one. Recorded
   * for the same reason the turn type is: recovery after eviction has to
   * re-mount the *same* catalog, and the role is half of what selects it.
   */
  subagentRole?: string;
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
  /** An ordinary admitted Turn whose only action is one caller-selected tool. */
  directTool?: DirectToolCommandV1;
}

export interface DirectToolCommandV1 {
  generationId: string;
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

/**
 * The `admission` field a Turn records — nothing at all for a chat Turn with
 * no recorded origin, so no stored bytes change for the Turn every producer
 * writes today.
 */
export function storedRunAdmissionV1(
  turnType: TurnTypeV1 | undefined,
  origin?: StoredRunOriginV1,
  subagentRole?: string,
): { admission?: StoredRunAdmissionV1 } {
  const admitted = turnType ?? "chat";
  if (admitted === "chat" && origin === undefined && subagentRole === undefined)
    return {};
  return {
    admission: {
      schemaVersion: 1,
      turnType: admitted,
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
  "directTool",
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

function decodeDirectToolCommandV1(value: unknown): DirectToolCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored run has invalid direct tool command");
  }
  const candidate = value as Record<PropertyKey, unknown>;
  const fields = ["generationId", "packageId", "name", "input"];
  if (
    Reflect.ownKeys(candidate).length !== fields.length ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(candidate, field)) ||
    !boundedString(candidate.generationId, 256) ||
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
    generationId: candidate.generationId,
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
    ...(candidate.directTool === undefined
      ? {}
      : { directTool: decodeDirectToolCommandV1(candidate.directTool) }),
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
  if (
    turnType !== "chat" ||
    command.origin !== undefined ||
    command.subagentRole !== undefined ||
    skills.length > 0 ||
    command.directTool !== undefined
  ) {
    return `bot-turn-command-v2:${JSON.stringify({
      userId: command.userId,
      botId: command.botId,
      sessionId: command.sessionId,
      text: command.text,
      turnType,
      ...(command.subagentRole ? { subagentRole: command.subagentRole } : {}),
      ...(command.origin ? { origin: command.origin } : {}),
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
