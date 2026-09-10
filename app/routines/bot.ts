// The Bot Durable Object's half of the Routines seam.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, and Composition." The Routines Package holds the
// records, the codecs, the command semantics and the scheduler; this module
// supplies the two things the Package cannot own — the Durable Object's storage,
// and the one call that admits a Turn.
//
// FIRING IS AN IN-OBJECT CALL. `authority.run` is a method on the kernel
// authority, reached from `settleScheduledWork` inside the object. No HTTP path
// and no RPC reaches it, so nothing outside the Bot can cause a Routine to run
// as an automation Turn.
//
// HIBERNATION. Nothing here reaches a Computer. "The Agent loop, Memory,
// Skills, Package composition, and Routines function correctly while the
// Computer is hibernated and do not wake it": a Routine is Durable Object
// storage, an alarm, and a Turn.
import {
  RoutineScheduler,
  type RoutineFireOutcomeV1,
} from "@frockbot/app/routines/scheduler";
import {
  routineSessionIdV1,
  type RoutineFireV1,
} from "@frockbot/app/routines/firing";
import {
  RoutineStore,
  type RoutineHookMinterV1,
  type RoutineStorageV1,
} from "@frockbot/app/routines/store";
import {
  mintRoutineHookTokenV1,
  routineHookDigestV1,
} from "@frockbot/app/routines/hook";
import { routineHookPathV1 } from "@frockbot/app/routines/shared";
import type { RoutinesRuntimeHostV1 } from "@frockbot/app/routines/agent";
import { routineHandoffTextV1 } from "@frockbot/app/routines/inbox";
import {
  routineTerminalRecordsV1,
  type RoutineTerminalRecordsV1,
} from "@frockbot/app/routines/inbox-store";
import { decodeRoutineRecordV1 } from "@frockbot/app/routines/records";
import {
  ROUTINE_ACCOUNT_TIMEZONE_KEY,
  routineFailureMessageKeyV1,
  routineKeyV1,
} from "@frockbot/app/routines/storage-keys";
import { isRoutineTimezoneV1 } from "@frockbot/app/routines/cron";
import {
  messageIdV1,
  visibleMessageRecordsV1,
} from "@frockbot/app/notifications/messages";
import {
  ROUTINE_RUN_EVENT_MAX,
  type RoutineInboxEntryViewV1,
  type RoutineRunDetailViewV1,
} from "@frockbot/app/routines/shared";
import type { RoutineInboxEntryV1 } from "@frockbot/app/routines/inbox";
import { routineFailureMessageV1 } from "@frockbot/app/routines/inbox";
import { RoutineNotFoundError } from "@frockbot/app/routines/store";
import type {
  RoutineCommandReceiptV1,
  RoutineCommandV1,
  RoutineInboxCommandV1,
  RoutineInboxReceiptV1,
  RoutineInboxViewV1,
  RoutineListViewV1,
  RoutineRunListViewV1,
} from "@frockbot/app/routines/shared";
import type { RoutineWriterV1 } from "@frockbot/app/routines/records";
import { readBotSettingsV1 } from "@frockbot/app/settings/bot";
import { expireDueApprovals } from "@frockbot/app/approvals/bot";
import {
  APPROVAL_PREFIX,
  decodeApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import {
  reconcileOverdueTasks,
  runOwedSubagentTurns,
} from "@frockbot/app/subagents/bot";
import { decodeSubagentTaskContextV1 } from "@frockbot/app/subagents/durable-binding";
import { replayPendingWakeNotifications } from "@frockbot/app/machine/bot";
import type { TaskRecordV1 } from "@frockbot/app/subagents/records";
import {
  taskKeyV1,
  TASK_ACTIVE_PREFIX,
  TASK_CONTEXT_PREFIX,
} from "@frockbot/app/subagents/storage-keys";
import type { BotIdentity } from "@frockbot/core/durable";
import type { SessionEvent } from "@frockbot/core/contracts";

/** The Bot and User whose Routines a caller may reach. */
export interface BotRoutinesIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a Bot-authored Routine records as its writer. */
export interface BotRoutinesTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

interface RoutineAccountTimezoneProjectionV1 {
  schemaVersion: 1;
  revision: number;
  timezone: string;
}

function routineAccountTimezoneProjectionV1(
  value: unknown,
): RoutineAccountTimezoneProjectionV1 | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3
  ) {
    return undefined;
  }
  const projection = value as Record<string, unknown>;
  return projection.schemaVersion === 1 &&
    Number.isSafeInteger(projection.revision) &&
    (projection.revision as number) >= 0 &&
    typeof projection.timezone === "string" &&
    isRoutineTimezoneV1(projection.timezone)
    ? {
        schemaVersion: 1,
        revision: projection.revision as number,
        timezone: projection.timezone,
      }
    : undefined;
}

/** The account clock projected into the Bot so alarms need no cross-DO read. */
export async function routineAccountTimezoneV1(reads: {
  get<T>(key: string): Promise<T | undefined>;
}): Promise<string> {
  const projection = routineAccountTimezoneProjectionV1(
    await reads.get<unknown>(ROUTINE_ACCOUNT_TIMEZONE_KEY),
  );
  return projection?.timezone ?? "UTC";
}

/**
 * Adopt the User authority's current timezone and re-arm the alarm under it.
 *
 * Nothing derived is discarded here. A stored clock records the zone it was
 * computed in, so it recomputes itself exactly when the zone it names has
 * moved; deleting clocks outright threw away every backoff and hold on any
 * settings change, whether or not the zone was one of them.
 */
export async function projectRoutineAccountTimezoneV1(
  state: ShellBotStateV1,
  timezone: string,
  revision: number,
): Promise<void> {
  if (!isRoutineTimezoneV1(timezone)) {
    throw new Error(`timezone "${timezone}" is not an IANA time zone`);
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("timezone revision must be a non-negative integer");
  }
  await state.ctx.storage.transaction(async (transaction) => {
    const current = routineAccountTimezoneProjectionV1(
      await transaction.get<unknown>(ROUTINE_ACCOUNT_TIMEZONE_KEY),
    );
    // User RPCs may finish out of order after yielding across Durable Objects.
    // The settings revision keeps an older fan-out from reverting a newer zone.
    if (current && current.revision >= revision) {
      return;
    }
    await transaction.put(ROUTINE_ACCOUNT_TIMEZONE_KEY, {
      schemaVersion: 1,
      revision,
      timezone,
    } satisfies RoutineAccountTimezoneProjectionV1);
    await state.authority.refreshRecoveryAlarm(transaction);
  });
}

/**
 * The Routines authority for one Bot Durable Object: the record store and the
 * scheduler that fires it, built together because the command path needs the
 * scheduler (`routine/run`) and the scheduler needs the records.
 *
 * `DurableObjectState.storage` already satisfies `RoutineStorageV1`; naming the
 * narrow seam here is what keeps the Package testable without a Durable Object.
 */
export function createBotRoutines(
  storage: RoutineStorageV1,
  hookKeys?: RoutineHookMinterV1,
): {
  store: RoutineStore;
  scheduler: RoutineScheduler;
} {
  const scheduler = new RoutineScheduler(storage);
  return {
    scheduler,
    store: new RoutineStore(storage, {
      firings: scheduler,
      ...(hookKeys ? { hookKeys } : {}),
    }),
  };
}

/**
 * The webhook key minter for one Bot.
 *
 * The token is derived from the Worker secret and the Routine's identity, so it
 * is reproducible and never stored; what the Bot keeps is its digest. Without
 * the secret there is no minter at all, and a webhook Routine is refused with
 * that reason rather than given a key that cannot be verified.
 */
export function createBotRoutineHookMinter(
  identity: () => Promise<BotRoutinesIdentity | undefined>,
  secret: string | undefined,
): RoutineHookMinterV1 | undefined {
  if (!secret) return undefined;
  return {
    async mint({ routineId, keyVersion }) {
      // The Bot's durable identity, not a constructor argument: a Durable
      // Object learns who it is from its own storage, and a key that named the
      // wrong Bot would verify at the edge against an object that never holds it.
      const owner = await identity();
      if (!owner) {
        throw new Error("this Bot has no durable identity to key a webhook to");
      }
      const token = await mintRoutineHookTokenV1(secret, {
        u: owner.userId,
        b: owner.botId,
        r: routineId,
        v: keyVersion,
      });
      return {
        token,
        digest: await routineHookDigestV1(token),
        path: routineHookPathV1(owner.botId, routineId),
      };
    },
  };
}

/** Kept for callers that only want the record store. */
export function createBotRoutineStore(storage: RoutineStorageV1): RoutineStore {
  return createBotRoutines(storage).store;
}

/**
 * The Turn command one firing is admitted as.
 *
 * `turnType: "automation"` is the ceiling the firing runs under, and
 * `origin` names the Routine and the firing, so the run stays attributable
 * after the bounded run log has trimmed its index row away. The Session is the
 * Routine's own — never the User's visible conversation.
 */
export function routineTurnCommandV1(
  identity: BotRoutinesIdentity,
  fire: RoutineFireV1,
  acceptedAt: string,
) {
  return {
    userId: identity.userId,
    botId: identity.botId,
    runId: fire.fireId,
    sessionId: routineSessionIdV1(fire.routineId),
    acceptedAt,
    text: fire.cue,
    turnType: "automation" as const,
    origin: {
      kind: "routine" as const,
      routineId: fire.routineId,
      fireId: fire.fireId,
      trigger: fire.trigger,
    },
  };
}

/**
 * What the run log records for a firing, read off the durable run rather than
 * off the completion value: the run record is the authority for whether the
 * Turn succeeded, and it survives an eviction that loses the value.
 */
export function routineFireOutcomeV1(
  run: { status: string; failure?: string; responseText?: string } | undefined,
  thrown?: unknown,
): RoutineFireOutcomeV1 {
  if (thrown !== undefined) {
    return {
      status: "failed",
      summary: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  if (!run) return { status: "failed", summary: "the firing recorded no run" };
  if (run.status === "cancelled") {
    return {
      status: "cancelled",
      ...(run.failure === undefined ? {} : { summary: run.failure }),
    };
  }
  if (run.status === "completed") {
    // A Turn that ended by handing off writes no assistant message, so its
    // response text is empty; the log records the outcome and leaves the
    // summary off rather than carrying an empty one.
    return {
      status: "ok",
      ...(run.responseText === undefined || run.responseText.trim().length === 0
        ? {}
        : { summary: run.responseText }),
    };
  }
  return {
    status: "failed",
    summary: run.failure ?? `the firing's run is ${run.status}`,
  };
}

/**
 * The provenance half of the Routines seam one admitted Turn runs under. A Turn
 * is required: a Bot writes a Routine only inside a Turn whose Session and Turn
 * its provenance can name, exactly as it writes a Skill or authors a Package.
 *
 * Reading and writing are the caller's: both need the account zone the Bot is
 * projected under, which is storage the mount already holds.
 */
export function createBotRoutinesHost(
  identity: BotRoutinesIdentity,
  turn: BotRoutinesTurn,
): Omit<RoutinesRuntimeHostV1, "list" | "execute"> {
  return {
    botId: identity.botId,
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
  };
}

/**
 * The Routine a settled run belongs to, or `undefined` when it is an ordinary
 * conversational Turn. Read off the durable admission record, so it survives an
 * eviction and a trimmed run log alike.
 */
export function settledRoutineOriginV1(run: {
  admission?: {
    turnType?: string;
    origin?: { kind: string; routineId?: string };
  };
}): { routineId: string } | undefined {
  if (run.admission?.turnType !== "automation") return undefined;
  const origin = run.admission.origin;
  // A `subagent` origin reaches here on no path today — it is not an
  // `automation` Turn — but the kind is checked rather than assumed, and the id
  // it carries is checked with it.
  if (!origin || origin.kind !== "routine" || !origin.routineId) {
    return undefined;
  }
  return { routineId: origin.routineId };
}

/**
 * The records one settled automation Turn contributes to the transaction that
 * settles it: its completion-inbox entry, and — only when the Turn called
 * `wake_parent` — the pending input the Bot's next conversational Turn is owed.
 *
 * A failed or cancelled firing reaches none of this: `completeStoredRun` is the
 * only caller, so a firing that did not complete leaves a `failed` run-log
 * entry and no inbox entry, which is the row's "durable, visible failure".
 */
export async function routineTerminalRecordsForRunV1(input: {
  run: {
    runId: string;
    events: readonly { type: string }[];
    responseText?: string;
    admission?: {
      turnType?: string;
      origin?: { kind: string; routineId?: string };
    };
  };
  read<T>(key: string): Promise<T | undefined>;
  now: string;
}): Promise<RoutineTerminalRecordsV1 | undefined> {
  const origin = settledRoutineOriginV1(input.run);
  if (!origin) return undefined;
  const stored = await input.read<unknown>(routineKeyV1(origin.routineId));
  const name =
    stored === undefined
      ? origin.routineId
      : decodeRoutineRecordV1(stored).name;
  const handoff = routineHandoffTextV1(input.run.events);
  return routineTerminalRecordsV1({
    runId: input.run.runId,
    routineId: origin.routineId,
    routineName: name,
    now: input.now,
    read: input.read,
    ...(handoff === undefined ? {} : { handoff }),
    ...(input.run.responseText === undefined
      ? {}
      : { responseText: input.run.responseText }),
  });
}

/** One inbox entry, as the hosted client is told it. Never the wake id. */
export function routineInboxEntryViewV1(
  entry: RoutineInboxEntryV1,
): RoutineInboxEntryViewV1 {
  return {
    schemaVersion: 1,
    entryId: entry.entryId,
    runId: entry.runId,
    routineId: entry.routineId,
    text: entry.text,
    attribution: entry.attribution,
    createdAt: entry.createdAt,
    acknowledged: entry.acknowledged,
    ...(entry.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: entry.acknowledgedAt }),
    ...(entry.repeatCount === undefined
      ? {}
      : { repeatCount: entry.repeatCount }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
  };
}

/** What one event of an automation run says, in one line, for the run log. */
function routineRunEventSummaryV1(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "turn/start":
      return "The firing's Turn started.";
    case "user/message":
      return `Cue: ${event.text}`;
    case "assistant/message":
      return event.toolCalls.length === 0
        ? `Assistant: ${event.text}`
        : `Assistant called ${event.toolCalls.map((call) => call.name).join(", ")}.`;
    case "tool/result":
      return `${event.name} ${event.isError ? "failed" : "returned"}: ${event.content}`;
    case "wake/parent":
      return `Handed off to the conversation: ${event.message}`;
    case "turn/end":
      return `The firing's Turn ended: ${event.outcome}${
        event.reason === undefined ? "" : ` (${event.reason})`
      }`;
    default:
      return undefined;
  }
}

/**
 * One automation run, read-only.
 *
 * It carries no model request and no tool input: the run log answers "what did
 * this firing do", and the durable log stays the place a full reconstruction
 * comes from.
 */
export function routineRunDetailViewV1(
  botId: string,
  routineId: string,
  run: {
    runId: string;
    status: string;
    acceptedAt: string;
    input: string;
    events: readonly SessionEvent[];
    responseText?: string;
    failure?: string;
  },
): RoutineRunDetailViewV1 {
  const events: RoutineRunDetailViewV1["events"] = [];
  for (const event of run.events) {
    const summary = routineRunEventSummaryV1(event);
    if (summary === undefined) continue;
    events.push({
      type: event.type,
      at: event.timestamp,
      summary: summary.slice(0, 2_000),
    });
  }
  const outcome = run.failure ?? run.responseText;
  return {
    schemaVersion: 1,
    botId,
    routineId,
    runId: run.runId,
    status: run.status,
    admittedAt: run.acceptedAt,
    input: run.input.slice(0, 16_000),
    events: events.slice(-ROUTINE_RUN_EVENT_MAX),
    ...(outcome === undefined || outcome.length === 0
      ? {}
      : { outcome: outcome.slice(0, 4_000) }),
  };
}

/** Everything this object's one alarm is owed, in one list. */
export async function scheduledDeadlines(
  state: ShellBotStateV1,
  transaction: DurableObjectTransaction,
): Promise<number[]> {
  // A pending approval is a deadline like any other: the object already owns
  // one alarm, and expiry rides it rather than inventing a second clock.
  const approvals = await transaction.list<unknown>({
    prefix: APPROVAL_PREFIX,
  });
  const expiries: number[] = [];
  for (const stored of approvals.values()) {
    const approval = decodeApprovalRecordV1(stored);
    if (approval.decision !== "pending") continue;
    expiries.push(Date.parse(approval.expiresAt));
  }
  return [
    ...(await state.routineScheduler.deadlines(
      transaction,
      await routineAccountTimezoneV1(transaction),
    )),
    ...expiries.filter((at) => Number.isFinite(at)),
    // A dispatched task's 30-minute lifetime, and a child's own owed Turn,
    // both ride the one alarm this object already has: the parent reconciles
    // a child that never reported, and the child runs the Turn it was handed
    // on its next alarm rather than on a floating promise.
    ...(await subagentDeadlines(transaction)),
    ...(state.hostScheduled.deadlines
      ? await state.hostScheduled.deadlines(transaction)
      : []),
  ];
}

/**
 * The deadlines subagent work contributes to this object's one alarm.
 *
 * Two kinds, and which one an object has says which side of the dispatch it
 * is on. A *parent* has task records whose `deadlineAt` is when it must go
 * and ask what became of a child. A *child* has one task context, and while
 * that context is `queued` its deadline is *now*: accepting a task arms the
 * alarm, and the alarm is what runs the Turn.
 */
async function subagentDeadlines(
  transaction: DurableObjectTransaction,
): Promise<number[]> {
  const deadlines: number[] = [];
  const active = await transaction.list<unknown>({
    prefix: TASK_ACTIVE_PREFIX,
  });
  for (const key of active.keys()) {
    const stored = await transaction.get<unknown>(
      taskKeyV1(key.slice(TASK_ACTIVE_PREFIX.length)),
    );
    if (stored === undefined) continue;
    const at = Date.parse((stored as TaskRecordV1).deadlineAt);
    if (Number.isFinite(at)) deadlines.push(at);
  }
  const contexts = await transaction.list<unknown>({
    prefix: TASK_CONTEXT_PREFIX,
  });
  for (const stored of contexts.values()) {
    const context = decodeSubagentTaskContextV1(stored);
    if (context.status === "queued") deadlines.push(Date.now());
  }
  return deadlines;
}

export async function deferScheduledWork(
  state: ShellBotStateV1,
  transaction: DurableObjectTransaction,
): Promise<void> {
  // A Routine's deadline is a debt, so the scheduler holds it rather than
  // moving it while other durable work remains in flight.
  await state.routineScheduler.defer(
    transaction,
    await routineAccountTimezoneV1(transaction),
  );
  await state.hostScheduled.defer?.(transaction);
}

export async function settleScheduledWork(
  state: ShellBotStateV1,
): Promise<void> {
  // The re-arm is in a `finally` because it is the object's only way back.
  // The alarm that woke this object has already been consumed by the
  // platform; a throw in any one settler used to skip the re-arm, and then
  // nothing — no Routine, no approval expiry, no owed subagent Turn — ever
  // woke this Bot again except by a caller's luck. One producer failing must
  // cost that producer its pass, never the clock.
  try {
    await settleRoutineFirings(state);
    await runOwedSubagentTurns(state);
    await reconcileOverdueTasks(state);
    await expireDueApprovals(state);
    await replayPendingWakeNotifications(state);
    await state.hostScheduled.settle?.();
  } finally {
    await state.ctx.storage.transaction((transaction) =>
      state.authority.refreshRecoveryAlarm(transaction),
    );
  }
}

/**
 * Drain the Routines that are owed a firing.
 *
 * The scheduler mints the durable firing; this closure is the only thing that
 * admits a Turn for it, and it does so with `authority.run` — a direct call
 * inside the Durable Object. `turnType: "automation"` and the recorded origin
 * come from `routineTurnCommandV1`, and the fire id *is* the run id, so a
 * retry after eviction is refused by the kernel's own idempotency rather than
 * running the Routine a second time.
 */
async function settleRoutineFirings(state: ShellBotStateV1): Promise<void> {
  const identity = await state.authority.readDurableIdentity();
  if (!identity) return;
  // A run already occupies the object. `alarm()` defers before it reaches
  // here whenever the Turn is executing in this isolate, but a durable active
  // run outlives an eviction, and admitting a firing against one would burn
  // the occurrence on an error instead of holding the debt.
  //
  // Returning was not enough: the debt stayed past-due, so `deadlines()`
  // re-armed on a moment already gone and the alarm spun straight back into
  // this same bail-out — which is how a Routine racing a long chat Turn
  // failed once a minute for ever. The hold is what turns the bail-out into
  // a deferral: `dueAt` does not move, so the firing still lands.
  if (await state.authority.readActiveRunId()) {
    await state.ctx.storage.transaction((transaction) =>
      routineAccountTimezoneV1(transaction).then((timezone) =>
        state.routineScheduler.defer(transaction, timezone),
      ),
    );
    return;
  }
  await state.routineScheduler.settle(
    async (fire) => {
      const outcome = await runOneFiring(state, identity, fire);
      await notifyFailedFiring(state, identity, fire, outcome);
      return outcome;
    },
    await routineAccountTimezoneV1(state.ctx.storage),
  );
}

async function runOneFiring(
  state: ShellBotStateV1,
  identity: BotIdentity,
  fire: RoutineFireV1,
): Promise<RoutineFireOutcomeV1> {
  try {
    await state.authority.run(
      routineTurnCommandV1(identity, fire, new Date().toISOString()),
    );
  } catch (error) {
    return routineFireOutcomeV1(
      await state.authority.readStoredRun(fire.fireId),
      error,
    );
  }
  return routineFireOutcomeV1(await state.authority.readStoredRun(fire.fireId));
}

/**
 * The name a message about a Routine calls it by.
 *
 * Falls back to the id when the record is gone or unreadable, for the same
 * reason the scheduler's does: a message naming a Routine badly is worth more
 * than one that names nothing, and a broken record must not cost the person
 * the only thing telling them their automation has stopped.
 */
async function routineMessageNameV1(
  state: ShellBotStateV1,
  routineId: string,
): Promise<string> {
  const stored = await state.ctx.storage.get<unknown>(routineKeyV1(routineId));
  if (stored === undefined) return routineId;
  try {
    return decodeRoutineRecordV1(stored).name;
  } catch {
    return routineId;
  }
}

/**
 * Tell the person that a firing did not work.
 *
 * The scheduler has already written the durable completion-inbox entry in the
 * transaction that settled the firing; this is the delivery half. It is an
 * ordinary message: a Routine's result, an approval and a reply are one kind of
 * thing, and a Routine that breaks is told through the same index, the same
 * unread cursor and the same push outbox rather than through a directory entry
 * nothing on the device reads. `notifications.enabled` is the mute on
 * *alerting* only — a muted Bot still counts the failure as unread, and nobody
 * is woken for it.
 *
 * The message is one a person can actually read. It takes the next send
 * ordinal on the firing's own run — past whatever the Turn had already said
 * before it broke, so no two messages of that run share an id — and the run
 * carries it into the transcript, where opening the conversation clears the
 * badge it raised. A firing refused before admission recorded no run at all,
 * and a message needs one to belong to, so the terminal record admission did
 * not write is written first: the failure is then the same message with the
 * same badge, read the same way, rather than a second kind of thing.
 *
 * The firing keys the receipt, so a firing settled twice is one message.
 */
async function notifyFailedFiring(
  state: ShellBotStateV1,
  identity: BotIdentity,
  fire: RoutineFireV1,
  outcome: RoutineFireOutcomeV1,
): Promise<void> {
  if (outcome.status === "ok") return;
  const settings = await readBotSettingsV1(state, identity);
  const receiptKey = routineFailureMessageKeyV1(fire.fireId);
  const createdAt = state.now().toISOString();
  const run =
    (await state.authority.readStoredRun(fire.fireId)) ??
    (await state.authority.recordUnadmittedFailure({
      command: routineTurnCommandV1(identity, fire, createdAt),
      failure: outcome.summary ?? "the firing recorded no run",
      snapshot: settings,
    }));
  const body = routineFailureMessageV1({
    routineName: await routineMessageNameV1(state, fire.routineId),
    cancelled: outcome.status === "cancelled",
    ...(run?.failure === undefined
      ? outcome.summary === undefined
        ? {}
        : { failure: outcome.summary }
      : { failure: run.failure }),
    ...(run?.events === undefined ? {} : { events: run.events }),
  }).slice(0, 240);
  const ordinal =
    run?.events.filter((event) => event.type === "send/to-user").length ?? 0;
  let committed = false;
  await state.ctx.storage.transaction(async (transaction) => {
    if (await transaction.get(receiptKey)) return;
    const records = await visibleMessageRecordsV1({
      settings,
      read: (key) => transaction.get(key),
      messages: [
        {
          messageId: messageIdV1(fire.fireId, ordinal),
          runId: fire.fireId,
          createdAt,
          // Names the Routine and says why in the product's own words. A
          // message is the one surface a person reads without asking for it,
          // so it is the last place a kernel diagnostic belongs.
          body,
          automation: true,
          projectedSendOrdinal: ordinal,
        },
      ],
    });
    for (const [key, value] of Object.entries(records)) {
      await transaction.put(key, value);
    }
    await transaction.put(receiptKey, {
      schemaVersion: 1,
      // The directory id the failure used to be filed under, kept so the
      // internal hand-off between the settling transaction and this one is
      // still one identity per firing.
      notificationId: notificationIdV1("routine-failed", fire.fireId),
      at: createdAt,
    });
    committed = true;
  });
  // The message is written here rather than through the Turn's own settlement,
  // so the drain that a committed message wakes is asked for here too: a
  // broken Routine reaches the device now, not on whatever alarm comes next.
  if (committed) state.messagesCommitted();
}

/** Every Routine this Bot holds. Bot-scoped: the caller proved membership. */
export async function listRoutines(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<RoutineListViewV1> {
  const timezone = await routineAccountTimezoneV1(state.ctx.storage);
  return state.routines.list(
    identity.botId,
    await state.routineScheduler.nextRuns(timezone),
    timezone,
  );
}

/**
 * One Routine command, applied by the Bot Durable Object. The writer is a User
 * here; the `routine_manage` tool calls the same store with a Bot writer, so
 * the two paths cannot drift.
 */
export async function executeRoutineCommand(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: RoutineCommandV1,
  writer: RoutineWriterV1 = { kind: "user" },
): Promise<RoutineCommandReceiptV1> {
  if (command.botId !== identity.botId) {
    throw new RoutineNotFoundError(command.routineId ?? command.botId);
  }
  const receipt = await state.routines.execute(
    command,
    writer,
    await routineAccountTimezoneV1(state.ctx.storage),
  );
  // A created, re-timed, resumed or manually fired Routine changes what the
  // object is owed next, so the alarm is re-armed in the same call that wrote
  // the record rather than waiting for the next one to happen by.
  await state.ctx.storage.transaction((transaction) =>
    state.authority.refreshRecoveryAlarm(transaction),
  );
  return receipt;
}

/**
 * One webhook delivery, after the edge proved the key was minted here.
 *
 * The Bot re-checks the key against its own durable record, because the edge
 * knows only that the signature is this deployment's — not whether the key is
 * still this Routine's. The delivery is enqueued, never run inline: an HTTP
 * caller must not be able to hold a Turn open.
 */
export async function deliverRoutineHook(
  state: ShellBotStateV1,
  input: {
    routineId: string;
    keyVersion: number;
    digest: string;
    deliveryId: string;
    body: string;
    contentType?: string | null;
  },
): Promise<{ status: "accepted" | "duplicate"; fireId: string }> {
  const accepted = await state.routines.deliverHook(input);
  await state.ctx.storage.transaction((transaction) =>
    state.authority.refreshRecoveryAlarm(transaction),
  );
  return accepted;
}

/** The completion inbox, newest first, with the badge count beside it. */
export async function listRoutineInbox(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<RoutineInboxViewV1> {
  await state.authority.validateIdentity(identity);
  const entries = await state.routineInbox.list();
  return {
    schemaVersion: 1,
    botId: identity.botId,
    entries: entries.map((entry) => routineInboxEntryViewV1(entry)),
    unacknowledged: entries.filter((entry) => !entry.acknowledged).length,
  };
}

/** Count inputs waiting for the next conversational Turn without draining them. */
export async function pendingInputCount(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<number> {
  await state.authority.validateIdentity(identity);
  return (await state.routineInbox.pending()).length;
}

/**
 * Acknowledge inbox entries. An explicit command, never a side effect of
 * reading: a background poll must not clear the badge.
 */
export async function executeRoutineInboxCommand(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: RoutineInboxCommandV1,
): Promise<RoutineInboxReceiptV1> {
  if (command.botId !== identity.botId) {
    throw new RoutineNotFoundError(command.botId);
  }
  await state.authority.validateIdentity(identity);
  await state.routineInbox.acknowledge(command.entryIds);
  return {
    schemaVersion: 1,
    commandId: command.commandId,
    status: "applied",
    inbox: await listRoutineInbox(state, identity),
  };
}

/**
 * One automation run, read-only.
 *
 * An automation Turn is absent from `listRuns` by construction, so this is the
 * only read of one, and it is reached through the Routine's own run log: a run
 * whose recorded origin names a different Routine is a 404 here.
 */
export async function readRoutineRun(
  state: ShellBotStateV1,
  identity: BotIdentity,
  routineId: string,
  runId: string,
): Promise<RoutineRunDetailViewV1> {
  await state.authority.validateIdentity(identity);
  const run = await state.authority.readStoredRun(runId);
  const origin = run ? settledRoutineOriginV1(run) : undefined;
  if (!run || origin?.routineId !== routineId) {
    throw new RoutineNotFoundError(runId);
  }
  return routineRunDetailViewV1(identity.botId, routineId, run);
}

/** One Routine's bounded run log, newest first. */
export async function listRoutineRuns(
  state: ShellBotStateV1,
  identity: BotIdentity,
  routineId: string,
): Promise<RoutineRunListViewV1> {
  return state.routines.listRuns(identity.botId, routineId);
}
