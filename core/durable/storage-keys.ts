/**
 * Durable keys the Bot Durable Object authority owns. Packages that share the
 * object's storage read them through the authority, never by key.
 */
export const RUN_PREFIX = "run:";
export const RUN_INDEX_PREFIX = "run-index:";
export const RUN_ADMISSION_FENCE_PREFIX = "run-admission-fence:";
export const RUN_ADMISSION_FENCE_INDEX_KEY = "run-admission-fences";
export const MAX_RUN_ADMISSION_FENCES = 256;
export const ACTIVE_RUN_KEY = "active-run";
/**
 * The one admitted user-lane Turn waiting for the object to become free.
 *
 * A single slot, not a queue: a second user message supersedes the first
 * waiting one exactly as it supersedes a running one, so the Bot is never
 * working through a backlog of things the User has already replaced.
 */
export const PENDING_RUN_KEY = "pending-run";
/** Agent-lane Turns wait FIFO behind conversational work. */
export const PENDING_AGENT_RUN_PREFIX = "pending-agent-run:";
/** A Bot cannot accumulate an unbounded cross-Bot inbox. */
export const MAX_PENDING_AGENT_RUNS_V1 = 32;
/**
 * Due repair of a running record that is no longer the active Turn.
 * The due time is padded so a prefix list is chronological.
 */
export const REPAIR_DUE_PREFIX = "repair-due:";
export const REPAIR_RUN_PREFIX = "repair-run:";
/** Committed visible-status publication the alarm drains without starting a Turn. */
export const PUBLICATION_PENDING_PREFIX = "publication-pending:";
/** @deprecated S5 merged this scalar into PublicationHead.lastCursor. */
export const PUBLICATION_CURSOR_KEY = "publication-cursor";
export const PUBLICATION_HEAD_KEY = "publication:head:v1";
export const CONVERSATION_ROW_PREFIX = "conversation:row:v1:";
export const CONVERSATION_UPDATE_PREFIX = "conversation:update:v1:";
export const CONVERSATION_VISIBLE_INDEX_KEY = "conversation:visible-index:v1";
/** Local maintenance drained in one alarm pass. */
export const MAINTENANCE_BATCH_V1 = 8;
/** Replay keeps this many committed updates, by count. */
export const PUBLICATION_REPLAY_MAX_EVENTS_V1 = 64;
/** Replay keeps at most this many UTF-8 bytes of retained update payloads. */
export const PUBLICATION_REPLAY_MAX_BYTES_V1 = 1_048_576;
/** Newest visible runs retained in the conversation snapshot index. */
export const CONVERSATION_VISIBLE_RUN_LIMIT_V1 = 32;
/** Newest announcements retained in the conversation snapshot index. */
export const CONVERSATION_VISIBLE_ANNOUNCEMENT_LIMIT_V1 = 32;

export function repairDueKey(dueAt: number, runId: string): string {
  return `${REPAIR_DUE_PREFIX}${String(dueAt).padStart(16, "0")}:${runId}`;
}

export function repairRunKey(runId: string): string {
  return `${REPAIR_RUN_PREFIX}${runId}`;
}

export function publicationPendingKey(cursor: number): string {
  return `${PUBLICATION_PENDING_PREFIX}${String(cursor).padStart(16, "0")}`;
}

export function conversationRowKeyV1(entityId: string): string {
  return `${CONVERSATION_ROW_PREFIX}${entityId}`;
}

export function conversationUpdateKeyV1(cursor: number): string {
  return `${CONVERSATION_UPDATE_PREFIX}${String(cursor).padStart(16, "0")}`;
}

/** Whether one durable key changes the run state projected to a client. */
export function isRunStateStorageKeyV1(key: string): boolean {
  return (
    key === ACTIVE_RUN_KEY ||
    key === PENDING_RUN_KEY ||
    key.startsWith(RUN_PREFIX) ||
    key.startsWith(RUN_INDEX_PREFIX)
  );
}
/** Legacy Session value, read only for transparent migration. */
export const LATEST_EVENTS_KEY = "latest-events";
export const SESSION_EVENT_LOG_PREFIX = "session-events:";
export const SESSION_EVENT_LOG_INDEX_PREFIX = `${SESSION_EVENT_LOG_PREFIX}index:`;
export const SESSION_EVENT_LOG_PAGE_PREFIX = `${SESSION_EVENT_LOG_PREFIX}page:`;
export const SESSION_EVENT_PAYLOAD_PREFIX = `${SESSION_EVENT_LOG_PREFIX}payload:`;
/** Working-context projection. Derived; the event log stays authoritative. */
export const WORKING_CONTEXT_PREFIX = "context:";
export const WORKING_CONTEXT_HEAD_PREFIX = `${WORKING_CONTEXT_PREFIX}head:`;
export const WORKING_CONTEXT_TURN_PREFIX = `${WORKING_CONTEXT_PREFIX}turn:`;
export const WORKING_CONTEXT_PAGE_PREFIX = `${WORKING_CONTEXT_PREFIX}page:`;
export const WORKING_CONTEXT_CHUNK_PREFIX = `${WORKING_CONTEXT_PREFIX}chunk:`;
export const WORKING_CONTEXT_VOICE_PREFIX = `${WORKING_CONTEXT_PREFIX}voice:`;

function contextSessionPart(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function workingContextHeadKeyV1(sessionId: string): string {
  return `${WORKING_CONTEXT_HEAD_PREFIX}${contextSessionPart(sessionId)}`;
}

export function workingContextTurnPrefixV1(sessionId: string): string {
  return `${WORKING_CONTEXT_TURN_PREFIX}${contextSessionPart(sessionId)}:`;
}

export function workingContextTurnKeyV1(
  sessionId: string,
  turn: number,
): string {
  return `${workingContextTurnPrefixV1(sessionId)}${String(turn).padStart(10, "0")}`;
}

export function workingContextPagePrefixV1(
  sessionId: string,
  turn: number,
): string {
  return `${WORKING_CONTEXT_PAGE_PREFIX}${contextSessionPart(sessionId)}:${String(turn).padStart(10, "0")}:`;
}

export function workingContextPageKeyV1(
  sessionId: string,
  turn: number,
  page: number,
): string {
  return `${workingContextPagePrefixV1(sessionId, turn)}${String(page).padStart(6, "0")}`;
}

export function workingContextChunkKeyV1(
  sessionId: string,
  turn: number,
  messageIndex: number,
  chunk: number,
): string {
  return `${WORKING_CONTEXT_CHUNK_PREFIX}${contextSessionPart(sessionId)}:${String(turn).padStart(10, "0")}:${String(messageIndex).padStart(6, "0")}:${String(chunk).padStart(6, "0")}`;
}

export function workingContextVoiceKeyV1(sessionId: string): string {
  return `${WORKING_CONTEXT_VOICE_PREFIX}${contextSessionPart(sessionId)}`;
}
export const IDENTITY_KEY = "identity";
export const NOTIFICATION_PREFIX = "notification:";
// The Composition keys below are the User Durable Object's records (ADR 0026)
// and, on a Bot, the mirror of them its admission pins from.
export const COMPOSITION_CURRENT_KEY = "composition:current";
export const COMPOSITION_GENERATION_PREFIX = "composition:generation:";
export const COMPOSITION_INDEX_PREFIX = "composition:index:";
export const COMPOSITION_LAST_KNOWN_GOOD_KEY = "composition:last-known-good";
export const COMPOSITION_FAILURE_PREFIX = "composition:failure:";
export const COMPOSITION_FAILURE_COUNT_PREFIX = "composition:failure-count:";
export const COMPOSITION_QUARANTINE_PREFIX = "composition:quarantine:";
/** Attempts are zero-padded so the prefix listing is attempt-ordered. */
export const COMPOSITION_FAILURE_ATTEMPT_DIGITS = 4;
export const RECOVERY_ALARM_DELAY_MS = 60_000;
/** The current generation of one durable-root file. */
export const WORKSPACE_GENERATION_PREFIX = "workspace:generation:";
/** Preserved losing writes for one durable-root file. */
export const WORKSPACE_CONFLICT_PREFIX = "workspace:conflict:";
/** One unsettled durable-root sync push intent, by effect id. */
export const WORKSPACE_SYNC_EFFECT_PREFIX = "workspace:sync-effect:";
/** The monotonic cursor every minted Workspace generation id advances. */
export const WORKSPACE_GENERATION_CURSOR_KEY = "workspace:generation-cursor";
/**
 * Skill metadata for one instruction root. Current pointer, immutable
 * revision snapshots, and holds for admitted runs. Bodies live in object
 * storage under `skill-bodies/v1/`, not under these keys.
 */
export const SKILL_INDEX_PREFIX = "skill-index:v1:";

export function skillIndexCurrentKeyV1(rootKey: string): string {
  return `${SKILL_INDEX_PREFIX}current:${rootKey}`;
}

export function skillIndexSnapshotKeyV1(
  rootKey: string,
  revision: string,
): string {
  return `${SKILL_INDEX_PREFIX}rev:${rootKey}:${revision}`;
}

export function skillIndexHoldKeyV1(runId: string): string {
  return `${SKILL_INDEX_PREFIX}hold:${runId}`;
}
/** Longest readable key tail before it is fingerprinted; Durable Object keys are bounded. */
const WORKSPACE_KEY_TAIL_LIMIT = 900;

function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The key tail identifying one file in one durable root. Readable while it
 * fits — a root key plus a relative path — and fingerprinted past that, so a
 * long path can never push a Durable Object key over its bound.
 */
export function workspaceFileKeyTail(rootKey: string, path: string): string {
  const tail = `${rootKey}:${path}`;
  if (tail.length <= WORKSPACE_KEY_TAIL_LIMIT) return tail;
  return `${tail.slice(0, WORKSPACE_KEY_TAIL_LIMIT - 20)}#${fingerprint(tail)}`;
}

export function workspaceGenerationKey(rootKey: string, path: string): string {
  return `${WORKSPACE_GENERATION_PREFIX}${workspaceFileKeyTail(rootKey, path)}`;
}

export function workspaceConflictPrefix(rootKey: string, path: string): string {
  return `${WORKSPACE_CONFLICT_PREFIX}${workspaceFileKeyTail(rootKey, path)}:`;
}

export function workspaceConflictKey(
  rootKey: string,
  path: string,
  generationId: string,
): string {
  return `${workspaceConflictPrefix(rootKey, path)}${generationId}`;
}

export function runIndexKey(acceptedAt: string, runId: string): string {
  return `${RUN_INDEX_PREFIX}${acceptedAt}:${runId}`;
}

export function pendingAgentRunKey(acceptedAt: string, runId: string): string {
  return `${PENDING_AGENT_RUN_PREFIX}${acceptedAt}:${runId}`;
}

export function compositionGenerationKey(generationId: string): string {
  return `${COMPOSITION_GENERATION_PREFIX}${generationId}`;
}

export function compositionIndexKey(
  createdAt: string,
  generationId: string,
): string {
  return `${COMPOSITION_INDEX_PREFIX}${createdAt}:${generationId}`;
}

export function compositionFailurePrefix(generationId: string): string {
  return `${COMPOSITION_FAILURE_PREFIX}${generationId}:`;
}

export function compositionFailureKey(
  generationId: string,
  attempt: number,
): string {
  return `${compositionFailurePrefix(generationId)}${String(attempt).padStart(
    COMPOSITION_FAILURE_ATTEMPT_DIGITS,
    "0",
  )}`;
}

export function compositionFailureCountKey(generationId: string): string {
  return `${COMPOSITION_FAILURE_COUNT_PREFIX}${generationId}`;
}

/**
 * The Bot's own consecutive-failure streak, across generations.
 *
 * The per-generation counter alone left quarantine as dead code in the path a
 * real user takes: the model's natural repair is to *author a new generation*,
 * which supersedes the failed one at attempt 1, so no generation ever reached
 * three. Every repair attempt then added one more dead generation, forever.
 * This key counts the Bot's consecutive activation failures however many
 * generations they are spread over, and a generation that finally activates
 * clears it.
 */
export const COMPOSITION_FAILURE_STREAK_KEY = "composition:failure-streak";

export function compositionQuarantineKey(generationId: string): string {
  return `${COMPOSITION_QUARANTINE_PREFIX}${generationId}`;
}

export function storedRunAdmissionFences(input: unknown): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > MAX_RUN_ADMISSION_FENCES ||
    input.some(
      (runId) =>
        typeof runId !== "string" || runId.length < 1 || runId.length > 128,
    )
  ) {
    throw new Error("Stored run admission fences are invalid");
  }
  return [...new Set(input)];
}

/**
 * The key one sync push intent is recorded under. The effect id is already a
 * bounded digest minted by the sync, so it is used verbatim.
 */
export function workspaceSyncEffectKey(effectId: string): string {
  return `${WORKSPACE_SYNC_EFFECT_PREFIX}${effectId}`;
}
