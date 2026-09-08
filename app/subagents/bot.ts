// The parent Bot's subagent authority: the task record, its dispatch to a
// Subagent Durable Object, the desktop and slot leases it holds while it runs,
// and the one settle point every path funnels through.
//
// `app/subagents/backend.ts` is the User-facing gateway contribution; this is
// what runs inside a Bot Durable Object.

import type { TurnTypeV1 } from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import {
  ROUTINE_INBOX_TEXT_MAX,
  ROUTINE_WAKE_TITLE_MAX,
  subagentAttributionV1,
  type RoutineInboxEntryV1,
  type RoutinePendingWakeV1,
} from "@frockbot/app/routines/inbox";
import { readBotSettingsV1 } from "@frockbot/app/settings/bot";
import type {
  SubagentCheckOutcomeV1,
  SubagentDispatchOutcomeV1,
  SubagentDispatchRequestV1,
  SubagentMessageOutcomeV1,
  SubagentResumeRequestV1,
  SubagentStopOutcomeV1,
  SubagentsRuntimeHostV1,
} from "@frockbot/app/subagents/agent";
import {
  decodeSubagentTaskContextV1,
  subagentOutcomeForRunV1,
  subagentTaskContextV1,
  subagentTaskIdV1,
  type SubagentRunTaskRequestV1,
  type SubagentTaskContextV1,
} from "@frockbot/app/subagents/durable-binding";
import type { SubagentModelOptionV1 } from "@frockbot/app/subagents/models";
import {
  decodeSubagentSlotReceiptV1,
  type SubagentSlotBinding,
} from "@frockbot/app/subagents/quota";
import {
  TASK_BLOCKING_POLL_MS_V1,
  TASK_BLOCKING_TIMEOUT_MS_V1,
  TASK_DESKTOP_LEASE_MAX_AGE_SECONDS_V1,
  taskDesktopLeaseOwnerV1,
  taskPromptDigestV1,
  type TaskOutcomeV1,
  type TaskRecordV1,
} from "@frockbot/app/subagents/records";
import {
  taskViewV1,
  type TaskListViewV1,
  type TaskViewV1,
} from "@frockbot/app/subagents/shared";
import {
  TASK_CONTEXT_PREFIX,
  taskAnchorIdV1,
  taskContextKeyV1,
} from "@frockbot/app/subagents/storage-keys";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { appendAnnouncement } from "@frockbot/app/shell/reads";
import { notificationIdV1 } from "@frockbot/app/shell/notification-id";
import {
  COMPUTER_HOST_PROTOCOL_VERSION,
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  decodeComputerHostControlResultV1,
  decodeComputerHostProblemV1,
  encodeComputerHostRequestV1,
} from "@frockbot/computer/host-protocol";

/** The narrow User Durable Object RPC that bounds concurrent subagents per User. */
function subagentSlots(
  state: ShellBotStateV1,
  identity: BotIdentity,
): SubagentSlotBinding {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  // SAFETY: this namespace is bound to UserConfiguration; generated Worker
  // types do not expose its RPC surface.
  const rpc = state.env.USER_CONFIGURATIONS.get(id) as unknown as {
    reserveSubagentSlot(input: unknown): Promise<unknown>;
    releaseSubagentSlot(input: unknown): Promise<unknown>;
  };
  return {
    reserve: async (request) =>
      decodeSubagentSlotReceiptV1(await rpc.reserveSubagentSlot(request)),
    release: async (request) => {
      await rpc.releaseSubagentSlot(request);
    },
  };
}
/**
 * The User-wide `desktop-gui` lease, held at the Computer host.
 *
 * The Bot Durable Object cannot serialize across a User's Bots — they are
 * separate objects — and the User Durable Object owns the Computer
 * allocation but not the desktop. The host's `control` op is already the
 * single writer that serializes human takeover, so it is where a second
 * opinion cannot exist (plan decision 3): the Bot records the intent, the
 * host grants or refuses, and the refusal names the holder.
 *
 * Absent when this deployment has no Computer host — a Bot with no Computer
 * has no desktop to serialize, and a `computerUse` task is then bounded only
 * by this Bot's own lease record.
 */
/**
 * The origin the Computer host service binding is addressed on. A service
 * binding routes by binding, not by name, so the origin is only a syntactic
 * requirement of `Request`.
 */
const COMPUTER_HOST_ORIGIN_V1 = "http://computer-host.internal";

async function desktopLease(
  state: ShellBotStateV1,
  identity: BotIdentity,
  action: "acquire" | "release",
  ownerId: string,
): Promise<
  | { status: "granted"; expiresAt?: string }
  | { status: "refused"; reason: string }
  | { status: "unavailable" }
> {
  const fetcher = state.env.COMPUTER_HOST;
  const hostToken = state.env.COMPUTER_HOST_TOKEN;
  if (!fetcher || !hostToken) return { status: "unavailable" };
  const body = JSON.stringify(
    encodeComputerHostRequestV1({
      version: COMPUTER_HOST_PROTOCOL_VERSION,
      effectId: `${action}:${ownerId}`,
      identity: { userId: identity.userId },
      tenant: { botId: identity.botId },
      credentialRef: `computer:user:${identity.userId}`,
      operation: {
        kind: "control",
        action,
        ownerId,
        maxAgeSeconds: TASK_DESKTOP_LEASE_MAX_AGE_SECONDS_V1,
        scope: "desktop-gui",
      },
    }),
  );
  let response: Response;
  try {
    response = await fetcher.fetch(
      new Request(`${COMPUTER_HOST_ORIGIN_V1}${COMPUTER_HOST_ROUTES.control}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [COMPUTER_HOST_TOKEN_HEADER]: hostToken,
        },
        body,
      }),
    );
  } catch {
    // A host that cannot be reached has granted nothing and holds nothing.
    return { status: "unavailable" };
  }
  if (!response.ok) {
    // 409 is the host's "somebody else holds this", and its message names
    // the holder — which is the whole point of leasing under an owner derived
    // from the Bot and the task.
    let message = "";
    try {
      message = decodeComputerHostProblemV1(await response.json()).message;
    } catch {
      message = "";
    }
    if (response.status === 409) {
      return {
        status: "refused",
        reason: message || "the desktop is held by another subagent",
      };
    }
    return { status: "unavailable" };
  }
  try {
    const result = decodeComputerHostControlResultV1(await response.json());
    return {
      status: "granted",
      ...(result.expiresAt === undefined
        ? {}
        : { expiresAt: result.expiresAt }),
    };
  } catch {
    return { status: "granted" };
  }
}

/**
 * Takes the desktop for one `computerUse` task, in the constitution's order:
 * the intent is already durable (`admit` wrote `task-lease:desktop`), the
 * host is asked, and only a granted lease is recorded back onto the intent.
 */
async function acquireDesktopForTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<{ status: "held" } | { status: "refused"; reason: string }> {
  const outcome = await desktopLease(
    state,
    identity,
    "acquire",
    taskDesktopLeaseOwnerV1(identity.botId, taskId),
  );
  if (outcome.status === "refused") {
    return { status: "refused", reason: outcome.reason };
  }
  // `unavailable` is a deployment with no Computer host. The Bot's own lease
  // record still holds — one `computerUse` task per Bot — and there is no
  // desktop to contend for.
  await state.tasks.recordDesktopLease(
    identity.botId,
    taskId,
    outcome.status === "granted" ? outcome.expiresAt : undefined,
  );
  return { status: "held" };
}

/**
 * Releases the desktop this task held, if it held it. Called on every path
 * that settles a task — completion, failure, `task_stop`, and the deadline
 * reconciliation — so the screen is never held by something that has ended.
 */
async function releaseDesktopForTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<void> {
  const released = await state.tasks.releaseDesktopLease(taskId);
  if (!released) return;
  try {
    await desktopLease(
      state,
      identity,
      "release",
      released.ownerId ?? taskDesktopLeaseOwnerV1(identity.botId, taskId),
    );
  } catch {
    // The host lease lapses on its own. A release that could not be
    // delivered delays the next `computerUse` task by at most the lease's
    // own age; it never leaves the record claiming a desktop this Bot holds.
  }
}

/** The Bot's task list, as the gateway route reads it. */
export async function listTasks(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<TaskListViewV1> {
  await state.authority.validateIdentity(identity);
  return state.tasks.list(identity.botId);
}

/**
 * One dispatch, in the order the constitution requires.
 *
 * Intent before effect: the task record, the active key and the index row are
 * durable — and the per-Bot and per-User bounds have both answered — before
 * any Subagent Durable Object is addressed. A dispatch that dies between the
 * two leaves a task the parent can see, ask about, and settle; it never
 * leaves a child running with nothing to answer for it.
 */
async function dispatchSubagentTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { runId: string; turnId: string; sessionId: string },
  compositionGenerationId: string,
  request: SubagentDispatchRequestV1,
  /** Present only on a resume: which task this continues, and in whose child. */
  resume?: { resumedFrom: string; anchorTaskId: string },
): Promise<SubagentDispatchOutcomeV1> {
  const binding = state.subagentBinding;
  if (!binding) {
    return {
      status: "refused",
      reason:
        "this deployment cannot address a Subagent Durable Object, so no subagent can be dispatched",
    };
  }
  const taskId = subagentTaskIdV1(request.effectId);
  const admission = await state.tasks.admit({
    taskId,
    type: request.type,
    description: request.description,
    promptDigest: await taskPromptDigestV1(request.prompt),
    model: request.model,
    compositionGenerationId,
    background: request.background,
    attachments: request.attachments,
    // The dispatching Turn, and only the three fields that identify it: the
    // `turn` the runtime host carries also holds the pin and the turn type,
    // and neither belongs on the record's provenance.
    dispatch: {
      runId: turn.runId,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
    },
    ...(resume
      ? {
          resumedFrom: resume.resumedFrom,
          anchorTaskId: resume.anchorTaskId,
        }
      : {}),
    now: new Date(),
  });
  if (admission.status === "refused") {
    return { status: "refused", reason: admission.reason };
  }
  if (admission.status === "replayed") {
    // The same tool call, reconciled or retried: the task it already
    // dispatched is the answer, never a second child. A foreground call
    // still waits for it — the caller asked for the result, and returning
    // "dispatched" the instant a replay is recognised is what made a
    // `background:false` Task look like it completed with no output.
    const replayed = admission.record;
    const settled =
      replayed.outcome ??
      (request.background
        ? undefined
        : await awaitBlockingTask(
            state,
            identity,
            taskAnchorIdV1(replayed.childSessionId),
            replayed.taskId,
          ));
    if (settled) {
      return {
        status: "settled",
        taskId: replayed.taskId,
        model: replayed.model.slug,
        taskStatus: settled.status,
        ...(settled.summary === undefined ? {} : { summary: settled.summary }),
        ...(settled.failure === undefined ? {} : { failure: settled.failure }),
      };
    }
    return {
      status: "dispatched",
      taskId: replayed.taskId,
      model: replayed.model.slug,
    };
  }
  const reservation = await subagentSlots(state, identity).reserve({
    schemaVersion: 1,
    userId: identity.userId,
    botId: identity.botId,
    taskId,
    reservedAt: admission.record.createdAt,
  });
  if (reservation.status === "refused") {
    await state.tasks.settle(taskId, {
      status: "failed",
      settledAt: new Date().toISOString(),
      failure: reservation.reason,
    });
    return { status: "refused", reason: reservation.reason };
  }
  // The desktop, for a `computerUse` task only, and after the intent this
  // Bot already recorded: intent → acquire → dispatch. A refusal here is a
  // refusal of the dispatch, and it names the holder.
  if (admission.record.type === "computerUse") {
    const desktop = await acquireDesktopForTask(state, identity, taskId);
    if (desktop.status === "refused") {
      await settleTask(state, identity, taskId, {
        status: "failed",
        settledAt: new Date().toISOString(),
        failure: desktop.reason,
      });
      return { status: "refused", reason: desktop.reason };
    }
  }
  const anchorTaskId = taskAnchorIdV1(admission.record.childSessionId);
  const runTask: SubagentRunTaskRequestV1 = {
    taskId,
    type: admission.record.type,
    parent: {
      userId: identity.userId,
      botId: identity.botId,
      runId: turn.runId,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
    },
    compositionGenerationId,
    model: admission.record.model,
    prompt: request.prompt,
    ...(anchorTaskId === taskId
      ? {}
      : { sessionId: admission.record.childSessionId }),
  };
  try {
    await binding.accept(identity, anchorTaskId, runTask);
  } catch (error) {
    const failure =
      error instanceof Error ? error.message : "the subagent could not start";
    await settleTask(state, identity, taskId, {
      status: "failed",
      settledAt: new Date().toISOString(),
      failure,
    });
    return { status: "refused", reason: failure };
  }
  await state.tasks.markRunning(taskId);
  if (!request.background) {
    const settled = await awaitBlockingTask(
      state,
      identity,
      anchorTaskId,
      taskId,
    );
    if (settled) {
      return {
        status: "settled",
        taskId,
        model: admission.record.model.slug,
        taskStatus: settled.status,
        ...(settled.summary === undefined ? {} : { summary: settled.summary }),
        ...(settled.failure === undefined ? {} : { failure: settled.failure }),
      };
    }
  }
  return {
    status: "dispatched",
    taskId,
    model: admission.record.model.slug,
  };
}

/**
 * Waits, boundedly, for a `background:false` task — and degrades to
 * background rather than holding a Turn open.
 *
 * It *polls durable state*: the parent's own task record first, then the
 * child's context by RPC. It never awaits the child's settle callback, which
 * is an RPC back into this very object while this very Turn is still
 * executing — the reentrancy hazard G1 named. Both reads are ordinary I/O the
 * Durable Object already does inside a Turn, and the outbound probe is the
 * same call reconciliation makes.
 */
export async function awaitBlockingTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  anchorTaskId: string,
  taskId: string,
): Promise<TaskOutcomeV1 | undefined> {
  const binding = state.subagentBinding;
  const deadline = Date.now() + TASK_BLOCKING_TIMEOUT_MS_V1;
  // A read that fails once is transient storage contention, not an answer:
  // abandoning the wait on the first one returned "still running" for a
  // child that was about to settle, and taught the model to poll. Only a
  // record that stays unreadable ends the wait early.
  const readFailureLimit = 3;
  let readFailures = 0;
  for (;;) {
    try {
      const record = await state.tasks.read(taskId);
      readFailures = 0;
      if (record.outcome) return record.outcome;
    } catch {
      readFailures += 1;
      if (readFailures >= readFailureLimit) return undefined;
    }
    if (binding) {
      try {
        const context = await binding.probe(identity, anchorTaskId, taskId);
        if (context?.outcome) {
          // The child finished but its callback has not landed. Settling
          // here is the same idempotent write the callback performs.
          await settleTask(state, identity, taskId, context.outcome);
          return context.outcome;
        }
      } catch {
        // A child that cannot be probed is simply not finished yet.
      }
    }
    if (Date.now() >= deadline) return undefined;
    await state.sleep(
      Math.min(TASK_BLOCKING_POLL_MS_V1, Math.max(0, deadline - Date.now())),
    );
  }
}
/**
 * Records one terminal outcome for a task and gives back what it held.
 *
 * The single settle point. The child calls it when its Turn ends; the
 * parent's own alarm calls it for a child that never reported. It is
 * idempotent on the task id, so both landing is one outcome, not two.
 */
export async function settleTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
  outcome: TaskOutcomeV1,
): Promise<{ status: "settled" | "replayed" }> {
  await state.authority.assertIdentity(identity);
  // The desktop goes back *before* the record settles, because the record is
  // what says this task holds it: settling first would drop the lease record
  // and leave the host lease held by a task that has ended. A task that held
  // nothing releases nothing, so this is a no-op on every other path and on
  // a replayed settle.
  await releaseDesktopForTask(state, identity, taskId);
  const settled = await state.tasks.settle(taskId, outcome);
  if (settled.status === "settled") {
    try {
      await subagentSlots(state, identity).release({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        taskId,
      });
    } catch {
      // The User's slot is a reservation, not the record. A release that
      // could not be delivered is retried the next time this task settles or
      // this object reconciles; it never makes a settled task look unsettled.
    }
    await recordTaskCompletion(state, identity, settled.record);
  }
  await state.ctx.storage.transaction((transaction) =>
    state.authority.refreshRecoveryAlarm(transaction),
  );
  return { status: settled.status };
}

/**
 * What a settled task leaves behind on the parent (l.352: a background
 * completion "also posts a user-visible summary on the parent").
 *
 * Three records, and they are the *same* three a completed Routine firing
 * leaves — slice E's seams, reused rather than paralleled:
 *
 *  * the `task/settled` Session line, on the Bot's announcement log, because
 *    a background task settles when the Turn that dispatched it is over and
 *    there is no live Session to append to;
 *  * a completion-inbox entry and a pending wake, so the summary — never the
 *    child's transcript, which the parent has no door onto — is delivered to
 *    the Bot's next conversational Turn as durable input;
 *  * a notification intent, so a person hears about it too.
 *
 * The inbox half is skipped while the dispatching run is still active: a
 * blocking dispatch is answered by its own tool result, and telling the same
 * Turn the same thing twice is not delivery, it is duplication.
 *
 * Every write is idempotent on the task id, so a settle that races its own
 * reconciliation leaves one of each.
 */
async function recordTaskCompletion(
  state: ShellBotStateV1,
  identity: BotIdentity,
  task: TaskRecordV1,
): Promise<void> {
  const outcome = task.outcome;
  if (!outcome) return;
  const at = outcome.settledAt;
  await state.ctx.storage.transaction((transaction) =>
    appendAnnouncement(transaction, (seq) => ({
      type: "task/settled",
      seq,
      timestamp: at,
      taskId: task.taskId,
      status: outcome.status,
      ...(outcome.summary === undefined
        ? {}
        : { summary: outcome.summary.slice(0, ROUTINE_INBOX_TEXT_MAX) }),
    })),
  );
  // The dispatching Turn is still running: it is waiting on this task and
  // will read the outcome as its own tool result.
  if ((await state.authority.readActiveRunId()) === task.dispatch.runId) {
    return;
  }
  const text = taskCompletionTextV1(state, task, outcome);
  const attribution = subagentAttributionV1(task.description);
  const wakeId = `tw-${task.taskId}`;
  const entry: RoutineInboxEntryV1 = {
    schemaVersion: 1,
    entryId: `ti-${task.taskId}`,
    // The child's run id *is* the task id, so the entry names the run that
    // produced it exactly as a firing's entry does.
    runId: task.taskId,
    routineId: task.taskId,
    text,
    attribution,
    createdAt: at,
    acknowledged: false,
    wakeId,
    source: "subagent",
  };
  await state.routineInbox.append(entry);
  const wake: RoutinePendingWakeV1 = {
    schemaVersion: 1,
    kind: "wake",
    wakeId,
    runId: task.taskId,
    routineId: task.taskId,
    title: attribution.slice(0, ROUTINE_WAKE_TITLE_MAX),
    text,
    createdAt: at,
    quiet: { automation: true },
    source: "subagent",
  };
  await state.routineInbox.enqueue(wake);
  let settings: BotSettingsViewV1;
  try {
    settings = await readBotSettingsV1(state, identity);
  } catch {
    return;
  }
  if (!settings.notifications.enabled) return;
  await state.authority.recordNotification({
    notificationId: notificationIdV1("task-settled", task.taskId),
    runId: task.taskId,
    createdAt: at,
    title: `${settings.profile.name} finished a subagent task`,
    body: text.slice(0, 240),
  });
}

/** The one line a settled task says to its parent. Never a transcript. */
function taskCompletionTextV1(
  state: ShellBotStateV1,
  task: TaskRecordV1,
  outcome: TaskOutcomeV1,
): string {
  const head = `${task.type} subagent "${task.description}" ${outcome.status}.`;
  const body =
    outcome.status === "completed"
      ? (outcome.summary ?? "It left no summary.")
      : (outcome.failure ??
        (outcome.status === "stopped"
          ? "It was stopped."
          : "No reason was recorded."));
  return `${head} ${body}`.slice(0, ROUTINE_INBOX_TEXT_MAX);
}

/** One task, as the gateway detail route reads it. */
export async function readTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<TaskViewV1> {
  await state.authority.validateIdentity(identity);
  return taskViewV1(await state.tasks.read(taskId));
}

/** What `task_check` answers: status, last summary, and nothing to poll on. */
async function checkTask(
  state: ShellBotStateV1,
  taskId: string,
): Promise<SubagentCheckOutcomeV1> {
  let record: TaskRecordV1;
  try {
    record = await state.tasks.read(taskId);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "known",
    taskId: record.taskId,
    taskType: record.type,
    description: record.description,
    taskStatus: record.status,
    model: record.model.slug,
    ...(record.outcome?.summary === undefined
      ? {}
      : { summary: record.outcome.summary }),
    ...(record.outcome?.failure === undefined
      ? {}
      : { failure: record.outcome.failure }),
    // What is *waiting*, not what was ever sent: a message the child has
    // already read is not something the Bot is still waiting on.
    queuedMessages: (await state.tasks.pendingMessages(taskId)).length,
  };
}

/** What `task_message` does: append to the bounded queue, or refuse. */
async function messageTask(
  state: ShellBotStateV1,
  taskId: string,
  message: string,
): Promise<SubagentMessageOutcomeV1> {
  const queued = await state.tasks.appendMessage(taskId, message, new Date());
  if (queued.status === "refused") {
    return { status: "refused", reason: queued.reason };
  }
  return { status: "queued", taskId, depth: queued.depth };
}

/**
 * Explicit, authenticated cancellation of one task. Durable and terminal.
 *
 * The order is the constitution's: the intent is recorded, the child is
 * asked to stop, and only then is the outcome written — so a stop that dies
 * between the two is read back rather than repeated, and a child that cannot
 * be reached does not leave a task the User was told was cancelled still
 * live. The settle is the one idempotent settle every other path uses.
 */
async function stopTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
  requestedBy: "bot" | "user",
): Promise<
  | { status: "stopped"; record: TaskRecordV1 }
  | { status: "refused"; reason: string }
> {
  await state.authority.assertIdentity(identity);
  const requested = await state.tasks.requestStop(
    taskId,
    new Date(),
    requestedBy,
  );
  if (requested.status === "refused") {
    // A task that is already terminal answers with what it already is: a
    // second Stop on a stopped task is not a failure.
    let record: TaskRecordV1 | undefined;
    try {
      record = await state.tasks.read(taskId);
    } catch {
      record = undefined;
    }
    if (record && record.status === "stopped") {
      return { status: "stopped", record };
    }
    return { status: "refused", reason: requested.reason };
  }
  await state.ctx.storage.transaction((transaction) =>
    appendAnnouncement(transaction, (seq) => ({
      type: "task/stopped",
      seq,
      timestamp: new Date().toISOString(),
      taskId,
      requestedBy,
    })),
  );
  const binding = state.subagentBinding;
  if (binding) {
    try {
      await binding.stop(
        identity,
        taskAnchorIdV1(requested.record.childSessionId),
        taskId,
      );
    } catch {
      // The child is an execution host, not the authority. One that cannot
      // be reached reads its own cancelled context back on its next alarm;
      // the terminal state is recorded here either way.
    }
  }
  await settleTask(state, identity, taskId, {
    status: "stopped",
    settledAt: new Date().toISOString(),
    failure: `Stopped by ${requestedBy === "user" ? "your user" : "the Bot"}.`,
  });
  return { status: "stopped", record: await state.tasks.read(taskId) };
}

/** The gateway's cancellation door. Same act, second authenticated caller. */
export async function stopTaskForUser(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<TaskViewV1> {
  await state.authority.validateIdentity(identity);
  const stopped = await stopTask(state, identity, taskId, "user");
  if (stopped.status === "refused") {
    throw new Error(stopped.reason);
  }
  return taskViewV1(stopped.record);
}

/**
 * A new run in a finished task's own child Durable Object and Session.
 *
 * The model is *not* re-resolved: the resumed run keeps the binding the
 * first one pinned, because the transcript it continues was produced by it.
 * `resumedFrom` records which task this continues.
 */
async function resumeTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { runId: string; turnId: string; sessionId: string },
  compositionGenerationId: string,
  request: SubagentResumeRequestV1,
): Promise<SubagentDispatchOutcomeV1> {
  const resumable = await state.tasks.resumable(request.resume);
  if (resumable.status === "refused") {
    return { status: "refused", reason: resumable.reason };
  }
  if (await state.tasks.stopRequested(request.resume)) {
    return {
      status: "refused",
      reason: `task "${request.resume}" was stopped; a stopped subagent is not resumed`,
    };
  }
  return dispatchSubagentTask(
    state,
    identity,
    turn,
    compositionGenerationId,
    {
      description: request.description ?? resumable.record.description,
      prompt: request.prompt,
      type: resumable.record.type,
      background: request.background,
      model: resumable.record.model,
      attachments: [],
      effectId: request.effectId,
    },
    { resumedFrom: request.resume, anchorTaskId: resumable.anchorTaskId },
  );
}

/**
 * The child's door. It records the task and arms its own alarm, and it does
 * not run the Turn: the RPC returns to a parent that is still inside the
 * Turn that dispatched, so anything longer than a write would block it.
 */
export async function acceptSubagentTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  request: SubagentRunTaskRequestV1,
): Promise<{ childSessionId: string }> {
  await state.authority.assertIdentity(identity);
  const key = taskContextKeyV1(request.taskId);
  const existing = await state.ctx.storage.get<unknown>(key);
  if (existing !== undefined) {
    // A retried dispatch reaches the child it already reached.
    return {
      childSessionId: decodeSubagentTaskContextV1(existing).sessionId,
    };
  }
  const context = subagentTaskContextV1(request, new Date().toISOString());
  await state.ctx.storage.put(key, context);
  await state.ctx.storage.transaction((transaction) =>
    state.authority.refreshRecoveryAlarm(transaction),
  );
  return { childSessionId: context.sessionId };
}

/**
 * The child's cancellation door.
 *
 * Durable first: the context is marked settled so a child that is evicted
 * before its Agent notices — or that has not started its Turn yet — cannot
 * come back and run the task anyway. The Agent signal follows, and is
 * advisory, exactly as an authenticated Stop's is.
 */
export async function stopSubagentTask(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<{ status: "stopped" | "unknown" }> {
  await state.authority.assertIdentity(identity);
  const key = taskContextKeyV1(taskId);
  const stored = await state.ctx.storage.get<unknown>(key);
  if (stored === undefined) return { status: "unknown" };
  const context = decodeSubagentTaskContextV1(stored);
  if (context.status !== "settled") {
    await state.ctx.storage.put(key, {
      ...context,
      status: "settled",
      outcome: {
        status: "stopped",
        settledAt: new Date().toISOString(),
        failure: "Stopped by an authenticated cancellation.",
      },
    });
  }
  state.turn.cancel({ sessionId: context.sessionId, runId: taskId });
  return { status: "stopped" };
}

/**
 * The parent's half of message delivery: hand the child everything queued
 * for one task and mark it delivered, in one transaction.
 *
 * Authenticated as every other task RPC is. The claim is idempotent by
 * construction — a second claim reads the marks back and answers nothing —
 * so a child that retries a step after an eviction does not read the same
 * instruction twice.
 */
export async function claimTaskMessages(
  state: ShellBotStateV1,
  identity: BotIdentity,
  taskId: string,
): Promise<{ messages: { seq: number; message: string }[] }> {
  await state.authority.assertIdentity(identity);
  const claimed = await state.tasks.claimMessages(taskId, new Date());
  return {
    messages: claimed.map((entry) => ({
      seq: entry.seq,
      message: entry.message,
    })),
  };
}

/**
 * The child's half: ask the parent for what it has queued, using the parent
 * this child was handed when it accepted the task.
 *
 * A parent that cannot be reached answers nothing; the messages are still
 * queued, still undelivered, and the next step claims them.
 */
async function claimParentTaskMessages(
  state: ShellBotStateV1,
  taskId: string,
): Promise<readonly { seq: number; message: string }[]> {
  const binding = state.subagentBinding;
  if (!binding) return [];
  const context = await readSubagentTaskContext(state, taskId);
  if (!context) return [];
  return binding.claimMessagesOnParent(context.parent, taskId);
}

/** What a child holds for one task, for the parent's reconciliation. */
export async function readSubagentTaskContext(
  state: ShellBotStateV1,
  taskId: string,
): Promise<SubagentTaskContextV1 | undefined> {
  const stored = await state.ctx.storage.get<unknown>(taskContextKeyV1(taskId));
  return stored === undefined ? undefined : decodeSubagentTaskContextV1(stored);
}

/**
 * The child half of the alarm: run the one Turn this object was handed.
 *
 * A `subagent` Turn, on this object's own Session, admitted with the
 * `{kind:"subagent"}` origin so the durable run says whose task it was. The
 * task id *is* the run id, so a retried alarm is refused by the kernel's own
 * idempotency rather than running the child twice.
 */
export async function runOwedSubagentTurns(
  state: ShellBotStateV1,
): Promise<void> {
  const identity = await state.authority.readDurableIdentity();
  if (!identity) return;
  const stored = await state.ctx.storage.list<unknown>({
    prefix: TASK_CONTEXT_PREFIX,
  });
  for (const [key, value] of stored) {
    let context: SubagentTaskContextV1;
    try {
      context = decodeSubagentTaskContextV1(value);
    } catch {
      continue;
    }
    if (context.status !== "queued") continue;
    // A run already occupies this object; the alarm defers rather than
    // burning the task on an error it did not have to take.
    if (await state.authority.readActiveRunId()) return;
    await state.ctx.storage.put(key, { ...context, status: "running" });
    let outcome: TaskOutcomeV1;
    try {
      await state.authority.run({
        ...identity,
        runId: context.taskId,
        sessionId: context.sessionId,
        acceptedAt: new Date().toISOString(),
        text: context.prompt,
        turnType: "subagent",
        // The role is the task's type. It is the second ceiling on the
        // child's catalog: a `browserUse` child is never offered
        // `computer_exec`, and the durable run records the role so a
        // recovered child re-mounts the same catalog.
        subagentRole: context.type,
        origin: {
          kind: "subagent",
          taskId: context.taskId,
          parentRunId: context.parent.runId,
        },
      });
      outcome = subagentOutcomeForRunV1(
        await state.authority.readStoredRun(context.taskId),
        new Date().toISOString(),
      );
    } catch (error) {
      outcome = subagentOutcomeForRunV1(
        await state.authority.readStoredRun(context.taskId),
        new Date().toISOString(),
        error,
      );
    }
    await state.ctx.storage.put(key, {
      ...context,
      status: "settled",
      outcome,
    });
    if (state.subagentBinding) {
      try {
        await state.subagentBinding.settleOnParent(
          context.parent,
          context.taskId,
          outcome,
        );
      } catch {
        // The outcome is durable here. A parent that could not be reached is
        // asked again when its own deadline comes due — the child is never
        // re-dispatched, only re-read.
      }
    }
  }
}

/**
 * The parent half of the alarm: settle a task whose child never reported.
 *
 * The child is *asked*, never re-dispatched. A child that finished but could
 * not deliver its outcome is adopted as it stands; a child that has nothing
 * to say by its deadline is failed, because every admitted Turn must reach a
 * durable terminal state.
 */
export async function reconcileOverdueTasks(
  state: ShellBotStateV1,
): Promise<void> {
  const identity = await state.authority.readDurableIdentity();
  if (!identity) return;
  const binding = state.subagentBinding;
  const now = Date.now();
  for (const task of await state.tasks.active()) {
    if (Date.parse(task.deadlineAt) > now) continue;
    let outcome: TaskOutcomeV1 | undefined;
    if (binding) {
      try {
        outcome = (
          await binding.probe(
            identity,
            taskAnchorIdV1(task.childSessionId),
            task.taskId,
          )
        )?.outcome;
      } catch {
        outcome = undefined;
      }
    }
    await settleTask(
      state,
      identity,
      task.taskId,
      outcome ?? {
        status: "failed",
        settledAt: new Date().toISOString(),
        failure: `the subagent did not report before its deadline of ${task.deadlineAt}`,
      },
    );
  }
}

/**
 * The Subagents seam one admitted Turn runs under. `models` is read lazily,
 * because the Turn's model binding is resolved after the runtime Packages
 * are built and the catalog is only ever read from inside the Turn.
 */
export function subagentsRuntimeHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { runId: string; turnId: string; sessionId: string },
  compositionGenerationId: string,
  turnType: TurnTypeV1,
  models: () => readonly SubagentModelOptionV1[],
  /** Present only in a child: the task this Turn is running. */
  childTaskId?: string,
): SubagentsRuntimeHostV1 {
  return {
    botId: identity.botId,
    writer: turn,
    turnType,
    models,
    ...(childTaskId
      ? {
          taskId: childTaskId,
          // The seam that makes `task_message` delivery rather than
          // queueing: the child claims what its parent queued on its way
          // into each step, and the parent marks the claim durably.
          drainMessages: () => claimParentTaskMessages(state, childTaskId),
        }
      : {}),
    dispatch: (request) =>
      dispatchSubagentTask(
        state,
        identity,
        turn,
        compositionGenerationId,
        request,
      ),
    check: (taskId) => checkTask(state, taskId),
    message: (taskId, message) => messageTask(state, taskId, message),
    stop: async (taskId): Promise<SubagentStopOutcomeV1> => {
      const stopped = await stopTask(state, identity, taskId, "bot");
      return stopped.status === "stopped"
        ? { status: "stopped", taskId }
        : { status: "refused", reason: stopped.reason };
    },
    resume: (request) =>
      resumeTask(state, identity, turn, compositionGenerationId, request),
  };
}
