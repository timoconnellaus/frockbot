// Pruning older tool results once a Bot has gone quiet.
//
// Any change to a message a request has already sent invalidates the
// provider's prompt cache from that message on, so history is only rewritten
// when the cache has gone cold anyway: once the Bot has made no model request
// for PRUNE_AFTER_IDLE_MS_V1. A judge decides which results the next Turn can
// do without; the decision is recorded as a session event, and the working
// context replaces each chosen result with the pruned marker from then on.

import {
  TOOL_RESULTS_PRUNED_MAX,
  type LlmMessage,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import {
  SessionEventLog,
  type WorkingContextStorageV1,
} from "@frockbot/core/durable";
import {
  PRUNE_MIN_RESULT_CHARS_V1,
  PRUNED_TOOL_RESULT_V1,
} from "./compaction.js";
import { storedCompactionWindowV1 } from "./working-context-store.js";

/**
 * How long after its last model request a Bot's history may be rewritten.
 * Together's serverless cache publishes no lifetime; this is the common one.
 */
export const PRUNE_AFTER_IDLE_MS_V1 = 5 * 60_000;

/** One line of what the conversation has been about, for the judge. */
export interface ToolResultPruneLineV1 {
  readonly from: "person" | "assistant";
  readonly text: string;
}

/** One tool result the judge may prune. */
export interface ToolResultPruneCandidateV1 {
  readonly tool: string;
  readonly text: string;
}

export interface ToolResultPruneInputV1 {
  readonly conversation: readonly ToolResultPruneLineV1[];
  readonly results: readonly ToolResultPruneCandidateV1[];
}

/**
 * For each result, in order, whether it is pruned. `undefined` when the judge
 * could not say, which prunes nothing.
 */
export type ToolResultPrunerV1 = (
  input: ToolResultPruneInputV1,
  signal?: AbortSignal,
) => Promise<readonly boolean[] | undefined>;

/** Where a Session's owed pass is kept. One per Session; a newer run replaces it. */
export const TOOL_RESULT_PRUNE_DUE_PREFIX_V1 = "tool-result-prune-due:";

/** How far a pass due while a Turn runs is pushed each time. */
export const TOOL_RESULT_PRUNE_DEFERRAL_MS_V1 = 2_000;

/** The person's latest messages the judge reads for what the conversation is about. */
const TOOL_RESULT_PRUNE_CONVERSATION_LINES_V1 = 12;

export interface ToolResultPruneDueV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  /** The run that settled last; the pass's event joins the log after its own. */
  readonly runId: string;
  readonly dueAt: number;
}

function decodeDue(value: unknown): ToolResultPruneDueV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const due = value as Partial<ToolResultPruneDueV1>;
  if (
    due.schemaVersion !== 1 ||
    typeof due.sessionId !== "string" ||
    typeof due.runId !== "string" ||
    typeof due.dueAt !== "number" ||
    !Number.isFinite(due.dueAt)
  ) {
    return undefined;
  }
  return due as ToolResultPruneDueV1;
}

/**
 * The terminal record a settled chat run leaves: a pass owed once its model
 * requests have gone quiet. A run's last model request is within moments of
 * its settlement, so the settlement's instant stands in for it.
 */
export function toolResultPruneTerminalRecordsV1(input: {
  run: {
    runId: string;
    sessionId: string;
    admission?: { turnType?: string };
  };
  now: string;
}): Record<string, ToolResultPruneDueV1> {
  if ((input.run.admission?.turnType ?? "chat") !== "chat") return {};
  const settledAt = Date.parse(input.now);
  if (!Number.isFinite(settledAt)) return {};
  return {
    [`${TOOL_RESULT_PRUNE_DUE_PREFIX_V1}${input.run.sessionId}`]: {
      schemaVersion: 1,
      sessionId: input.run.sessionId,
      runId: input.run.runId,
      dueAt: settledAt + PRUNE_AFTER_IDLE_MS_V1,
    },
  };
}

interface DueStorageV1 {
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
}

async function listDue(storage: DueStorageV1) {
  const listed = await storage.list<unknown>({
    prefix: TOOL_RESULT_PRUNE_DUE_PREFIX_V1,
  });
  return [...listed.entries()].flatMap(([key, value]) => {
    const due = decodeDue(value);
    return due ? [{ key, due }] : [];
  });
}

/** The deadlines owed passes contribute to the object's one alarm. */
export async function toolResultPruneDeadlinesV1(
  storage: DueStorageV1,
): Promise<number[]> {
  return (await listDue(storage)).map(({ due }) => due.dueAt);
}

/**
 * The alarm cannot prune while a Turn executes, and re-arms at once: a pass
 * already due would fire it back to back until the Turn settled.
 */
export async function deferToolResultPruningV1(
  storage: DueStorageV1,
  now: number,
): Promise<void> {
  for (const { key, due } of await listDue(storage)) {
    if (due.dueAt > now) continue;
    await storage.put(key, {
      ...due,
      dueAt: now + TOOL_RESULT_PRUNE_DEFERRAL_MS_V1,
    });
  }
}

/** One tool result the pass may prune, with where it lives. */
export interface ToolResultPruneTargetV1 extends ToolResultPruneCandidateV1 {
  readonly turn: number;
  readonly callId: string;
}

/** What the judge is shown, from the messages the next Turn would carry. */
export function toolResultPruneCandidatesV1(window: {
  messages: readonly LlmMessage[];
  turns: readonly number[];
}): {
  conversation: ToolResultPruneLineV1[];
  targets: ToolResultPruneTargetV1[];
} {
  const conversation: ToolResultPruneLineV1[] = [];
  const targets: ToolResultPruneTargetV1[] = [];
  window.messages.forEach((message, index) => {
    if (message.role === "user" && message.content.trim()) {
      conversation.push({ from: "person", text: message.content });
    }
    if (message.role !== "tool") return;
    if (message.content === PRUNED_TOOL_RESULT_V1) return;
    if (message.content.length <= PRUNE_MIN_RESULT_CHARS_V1) return;
    targets.push({
      turn: window.turns[index]!,
      callId: message.callId,
      tool: message.name,
      text: message.content,
    });
  });
  return {
    conversation: conversation.slice(-TOOL_RESULT_PRUNE_CONVERSATION_LINES_V1),
    targets,
  };
}

export interface ToolResultPrunePassV1 {
  storage: WorkingContextStorageV1 & DueStorageV1;
  pruner: ToolResultPrunerV1 | undefined;
  append(input: {
    runId: string;
    sessionId: string;
    expectedEventCount: number;
    events: readonly SessionEventInput[];
  }): Promise<boolean>;
  now(): number;
}

/**
 * Runs every pass that is due. A pass that finds nothing to prune, or whose
 * judge could not say, is spent all the same: the next settled run owes the
 * next one. So is a pass that fails. A pass refused because a Turn arrived is spent too, for the same
 * reason — that Turn's settlement owes a fresh pass.
 */
export async function settleToolResultPruningV1(
  pass: ToolResultPrunePassV1,
): Promise<void> {
  for (const { key, due } of await listDue(pass.storage)) {
    if (due.dueAt > pass.now()) continue;
    try {
      await pruneSessionV1(pass, due);
    } catch (error) {
      // One pass failing costs that pass, never the other settlers on the
      // alarm; the next settled run owes the next one.
      console.warn("Tool result pruning failed", error);
    } finally {
      const current = decodeDue(await pass.storage.get<unknown>(key));
      if (current?.runId === due.runId) await pass.storage.delete(key);
    }
  }
}

async function pruneSessionV1(
  pass: ToolResultPrunePassV1,
  due: ToolResultPruneDueV1,
): Promise<void> {
  if (!pass.pruner) return;
  const expectedEventCount = await new SessionEventLog(
    pass.storage as never,
  ).eventCount(due.sessionId);
  const window = await storedCompactionWindowV1(pass.storage, {
    sessionId: due.sessionId,
    currentTurn: Number.MAX_SAFE_INTEGER,
    currentMessages: [],
  });
  const { conversation, targets } = toolResultPruneCandidatesV1(window);
  if (targets.length === 0) return;
  const decided = await pass.pruner({ conversation, results: targets });
  if (!decided || decided.length !== targets.length) return;
  const results = targets
    .filter((_, index) => decided[index])
    .map(({ turn, callId }) => ({ turn, callId }));
  if (results.length === 0) return;
  const events: SessionEventInput[] = [];
  for (let at = 0; at < results.length; at += TOOL_RESULTS_PRUNED_MAX) {
    events.push({
      type: "conversation/tool-results-pruned",
      results: results.slice(at, at + TOOL_RESULTS_PRUNED_MAX),
    });
  }
  await pass.append({
    runId: due.runId,
    sessionId: due.sessionId,
    expectedEventCount,
    events,
  });
}
