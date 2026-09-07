// One admitted Turn, from the command that starts it to the effect fence that
// linearizes what it dispatches.
//
// Admission and the durable log are kernel authority; this module is the app's
// half: what a Turn runs on, the Composition it mounts, the Stop intent that
// fences it, and the one alarm that recovers it.

import type { AgentEffectAdmission } from "@frockbot/core/agent-loop/agent";
import { firstPartyPackageToolAllowedV1 } from "@frockbot/applets/pages";
import {
  validateToolOccurrenceJournal,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import {
  activateCompositionV1,
  ACTIVE_RUN_KEY,
  IDENTITY_KEY,
  RUN_PREFIX,
  SessionEventLog,
  storedRunRecordV2,
  type BotIdentity,
  type BotTurnExecutionInput,
  type CompositionFailureV1,
  type CompositionGenerationV1,
  type CompositionMountHost,
  type OwnedBotTurnCommand,
} from "@frockbot/core/durable";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import { resolveAppletComposition } from "@frockbot/app/applets-host/bot";
import { createAppletInstanceBindingV1 } from "@frockbot/app/applets-host/records";
import { isolateMountOptions } from "@frockbot/app/isolates/bot";
import { pendingBotInputPreambleV1 } from "@frockbot/app/routines/inbox";
import { resolveExecutionContextV1 } from "@frockbot/app/settings/bot";
import {
  createShellCompositionHost,
  type ShellAppletMountOptions,
  type ShellMountedComposition,
} from "./backend-composition.js";
import { compositionFailureTurnTextV1 } from "./backend-composition-input.js";
import {
  botStopCommandFingerprintV1,
  requireStoredRunV1,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";
import { latestModelRequestJournalState } from "./backend-recovery.js";
import { executeBotTurn, executeDirectToolTurn } from "./backend-runner.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import { yieldCompactionWorkV1 } from "./compaction-scheduler.js";
import { notificationIdV1 } from "./notification-id.js";
import { agentRuntime } from "./runtime-mount.js";
import {
  createClientRunStopReceiptV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunStopReceiptV1,
  type ClientTurnV1,
} from "./run-protocol.js";

const STOP_RECEIPT_PREFIX = "stop-receipt:";
/** Durable idempotency receipt for one exact Stop command. */
interface StoredStopReceipt {
  schemaVersion: 1;
  commandFingerprint: string;
  commandId: string;
  runId: string;
  stopRequestedAt: string;
}

function isTerminalStoredRunStatus(status: StoredRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "superseded"
  );
}

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
}

export async function run(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<ClientTurnV1> {
  // Before the authority reads the session log, so a compaction detached
  // from the previous Turn has already handed the log back.
  await yieldCompactionWorkV1(command.sessionId);
  // Before admission, so the pin this Turn takes already carries whatever
  // the User's Applet directory says now.
  await resolveAppletComposition(
    state,
    { userId: command.userId, botId: command.botId },
    command,
  );
  return projectClientTurnV1(await state.authority.run(command));
}

/**
 * Durably records Stop intent and an idempotency receipt before signalling
 * the resident Agent. The acknowledged projection reports the run's current
 * durable state and never claims terminal cancellation.
 */
export async function stopRun(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: unknown,
): Promise<ClientRunStopReceiptV1> {
  const command = decodeClientRunStopCommandV1(input);
  await state.authority.validateIdentity(identity);
  const commandFingerprint = botStopCommandFingerprintV1({
    userId: identity.userId,
    botId: identity.botId,
    commandId: command.commandId,
    runId: command.runId,
  });
  const key = `${RUN_PREFIX}${command.runId}`;
  const receiptKey = `${STOP_RECEIPT_PREFIX}${command.commandId}`;
  const admitted = await state.ctx.storage.transaction(async (transaction) => {
    const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
    if (
      durableIdentity &&
      (durableIdentity.userId !== identity.userId ||
        durableIdentity.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
    }
    const existing = await transaction.get<StoredStopReceipt>(receiptKey);
    if (existing && existing.commandFingerprint !== commandFingerprint) {
      throw new Error(
        `Stop idempotency key "${command.commandId}" was reused for a different command`,
      );
    }
    const run = optionalStoredRun(await transaction.get<unknown>(key));
    if (!run) throw new Error(`run "${command.runId}" was not admitted`);
    if (existing) return run;
    if (
      isTerminalStoredRunStatus(run.status) ||
      run.events.some((event) => event.type === "turn/end")
    ) {
      throw new Error(`run "${command.runId}" is already terminal`);
    }
    const stopRequestedAt = run.stopRequestedAt ?? new Date().toISOString();
    const stopped = requireStoredRunV1({
      ...run,
      stopRequestedAt,
    } satisfies StoredRun);
    await transaction.put({
      [key]: structuredClone(stopped),
      [receiptKey]: {
        schemaVersion: 1,
        commandFingerprint,
        commandId: command.commandId,
        runId: command.runId,
        stopRequestedAt,
      } satisfies StoredStopReceipt,
    });
    await state.authority.refreshRecoveryAlarm(transaction);
    return stopped;
  });
  // The Agent signal is advisory and always follows the durable intent.
  state.turn.cancel({
    sessionId: admitted.sessionId,
    runId: command.runId,
  });
  // Hydrated, like every other read the transcript is drawn from. A run
  // record stores its journal by range, not inline, so reading the record on
  // its own gives a Turn with no events — and a Turn with no events has said
  // nothing. The receipt is what the thread redraws the stopped Turn from,
  // so that erased the words the person had just watched arrive and left
  // "You stopped this." standing alone over an empty bubble.
  const current =
    (await state.authority.readStoredRunForDisplay(command.runId)) ?? admitted;
  return createClientRunStopReceiptV1(command, projectClientRunV1(current));
}

export async function executeTurn(
  state: ShellBotStateV1,
  input: BotTurnExecutionInput<BotSettingsViewV1>,
): Promise<BotTurnCompletion> {
  // A compaction detached from the previous Turn yields to this one rather
  // than holding it. Free when none is running, and an abort when one is, so
  // this Turn is the only writer of the session log.
  await yieldCompactionWorkV1(input.command.sessionId);
  const settings = input.configurationSnapshot;
  const turn = {
    runId: input.command.runId,
    // One admitted Turn is one run; the Turn ordinal lives in the session log.
    turnId: input.command.runId,
    sessionId: input.command.sessionId,
    // The admitted configuration snapshot is durable, so a recovered
    // bot_message reuses the same sender display name in its target command.
    fromBotName: settings.profile.name,
    // The pin this Turn was admitted under, and the type it was admitted as.
    // A subagent dispatched from here runs on this generation, and the model
    // catalog it is offered is narrowed by this turn type.
    compositionGenerationId: input.compositionGenerationId,
    turnType: input.command.turnType ?? "chat",
    // The role half of the same admission. A `subagent` Turn carries one; no
    // other turn type ever does.
    ...(input.command.subagentRole
      ? { subagentRole: input.command.subagentRole }
      : {}),
    // In a Subagent Durable Object, which task this Turn *is*. It is what
    // lets the child claim the messages its parent queued for it.
    ...(input.command.origin?.kind === "subagent"
      ? { subagentTaskId: input.command.origin.taskId }
      : {}),
    ...(input.command.origin?.kind === "bot"
      ? {
          inboundAgent: {
            kind: "bot" as const,
            fromBotId: input.command.origin.fromBotId,
            fromBotName: input.command.origin.fromBotName,
          },
        }
      : {}),
  };
  const runtime = await agentRuntime(
    state,
    input.identity,
    settings,
    input.admittedRequest,
    turn,
  );
  const promptParts = [
    `You are ${settings.profile.name}.`,
    settings.profile.description,
  ].filter((part): part is string => Boolean(part?.trim()));
  // The pin, never the current generation: activation takes effect at the
  // next admitted Turn, and an in-flight Turn completes on what it pinned.
  // The isolate bindings follow the generation actually being mounted, so a
  // fail-closed fallback loads the last known good's members, not the
  // pinned generation's.
  // Applet tools route to the Applet Durable Object, which forwards to the
  // facet. The instance binding is minted once per Turn; the facet stub
  // itself never leaves that object.
  const appletInstances = state.env.APPLET_STATES
    ? createAppletInstanceBindingV1(
        state.env.APPLET_STATES,
        input.identity.userId,
      )
    : undefined;
  const appletRouting: ShellAppletMountOptions | undefined = appletInstances
    ? {
        invokeTool: (request) =>
          appletInstances(request.appletId).invokeTool(request),
      }
    : undefined;
  const host: CompositionMountHost<ShellMountedComposition> = {
    mount: async (mounting, signal) => {
      const isolate = await isolateMountOptions(state, input.identity, {
        runId: input.command.runId,
        sessionId: input.command.sessionId,
        generationId: mounting.generationId,
        settings,
      });
      const mounted = await createShellCompositionHost({
        botId: input.identity.botId,
        sessionId: input.command.sessionId,
        sessionEvents: input.previousEvents,
        persistSessionEvents: input.persistSessionEvents,
        agentPackages: runtime.agentPackages,
        modelSelection: runtime.modelSelection,
        systemPromptSection: promptParts.join("\n\n"),
        // The turn type the run was admitted as; recovery reads it back from
        // the durable record, so a resumed Turn mounts the same catalog.
        turnType: input.command.turnType ?? "chat",
        // And the role it was admitted under, read back the same way.
        ...(input.command.subagentRole
          ? { subagentRole: input.command.subagentRole }
          : {}),
        // Durable Stop fences every provider and tool effect immediately
        // before it is used, in the Bot Durable Object's own transaction.
        admitEffect: (effect) =>
          admitRunEffect(
            state,
            input.identity,
            input.command.runId,
            input.command.sessionId,
            effect,
          ),
        ...(isolate ? { isolate } : {}),
        ...(appletRouting ? { applets: appletRouting } : {}),
      }).mount(mounting, signal);
      return mounted;
    },
  };
  const controller = new AbortController();
  // Composition fails closed: a generation that does not resolve, mount, or
  // pass `health()` leaves the last known good resident, records a durable
  // failure, raises a visible one, and the Turn is admitted anyway.
  const activation = await activateCompositionV1({
    generationId: input.compositionGenerationId,
    store: {
      read: (generationId) => state.authority.composition.read(generationId),
      lastKnownGood: () => state.authority.composition.lastKnownGood(),
      commit: (generationId) =>
        state.authority.composition.commit(generationId),
      fail: (generationId, options) =>
        state.authority.composition.fail(generationId, options),
    },
    failures: state.authority.compositionFailures,
    host,
    signal: controller.signal,
    onFailure: (failure, fallback) =>
      recordCompositionFailureNotification(
        state,
        settings,
        input.command.runId,
        failure,
        fallback,
      ),
  });
  if (activation.status === "failed-closed") {
    // The durable record names what the Turn actually ran under.
    await state.authority.repinRun(
      input.command.runId,
      activation.fallback.generationId,
    );
  }
  // The exact resident Agent this Turn runs on, so a durable Stop reaches
  // that run and never a different one.
  const active = {
    runId: input.command.runId,
    sessionId: input.command.sessionId,
    turnId: input.command.runId,
    generationId: activation.mounted.generation.generationId,
    turnType: input.command.turnType ?? "chat",
    ...(input.command.subagentRole
      ? { subagentRole: input.command.subagentRole }
      : {}),
    mounted: activation.mounted,
    signal: controller.signal,
    cancel: (detail?: string) => {
      controller.abort("user");
      activation.mounted.runtime.agent.agent.cancel("user", detail);
    },
  };
  state.turn.set(active);
  try {
    const directTool = input.command.directTool;
    if (directTool) {
      // The page registry is the declaration, and it is checked again here
      // rather than trusted from the admitted command: a durable run replayed
      // after a deploy that withdrew a page must not still run its tool.
      if (
        !firstPartyPackageToolAllowedV1(directTool.packageId, directTool.name)
      ) {
        throw new Error(
          `Package "${directTool.packageId}" did not declare tool "${directTool.name}" for its pages`,
        );
      }
      return await executeDirectToolTurn({
        command: { ...input.command, directTool },
        previousEvents: input.previousEvents,
        composition: activation.mounted,
        admitEffect: (effect) =>
          admitRunEffect(
            state,
            input.identity,
            input.command.runId,
            input.command.sessionId,
            effect,
          ),
        signal: controller.signal,
      });
    }
    const ordinaryInput = await turnInputTextV1(state, input.command);
    const durableInput =
      activation.status === "failed-closed"
        ? compositionFailureTurnTextV1(ordinaryInput, {
            attemptedGenerationId: input.compositionGenerationId,
            ...(activation.generation
              ? { generation: activation.generation }
              : {}),
            ...(activation.failure ? { failure: activation.failure } : {}),
            quarantined: activation.quarantined,
          })
        : ordinaryInput;
    return await executeBotTurn({
      command: {
        ...input.command,
        text: durableInput,
      },
      previousEvents: input.previousEvents,
      composition: activation.mounted,
      resume: input.resume,
    });
  } finally {
    state.turn.clear(active);
  }
}

/**
 * The text one admitted Turn actually runs on.
 *
 * A chat Turn drains the pending-input queue first — "its outcome is
 * delivered to the Bot's next conversational Turn as durable input" — and
 * carries the hand-offs as a preamble ahead of the person's own words. The
 * drain is a durable receipt named by the run, so a resumed or recovered Turn
 * reads back exactly the inputs it drained rather than draining a second
 * time, and the recorded `model/request` stays reconstructible.
 *
 * An automation Turn drains nothing: a firing is not the conversation, and a
 * hand-off addressed to the parent must not be consumed by another firing.
 */
async function turnInputTextV1(
  state: ShellBotStateV1,
  command: {
    runId: string;
    text: string;
    turnType?: TurnTypeV1;
  },
): Promise<string> {
  if ((command.turnType ?? "chat") !== "chat") return command.text;
  const drained = await state.routineInbox.drainInto(command.runId);
  const preamble = pendingBotInputPreambleV1(drained);
  return preamble.length === 0 ? command.text : `${preamble}\n${command.text}`;
}

/** The visible half of failing closed, through the Bot's notifications. */
async function recordCompositionFailureNotification(
  state: ShellBotStateV1,
  settings: BotSettingsViewV1,
  runId: string,
  failure: CompositionFailureV1,
  fallback: CompositionGenerationV1,
): Promise<void> {
  await state.authority.recordNotification({
    notificationId: notificationIdV1(
      "composition-failure",
      failure.generationId,
      failure.attempt,
    ),
    runId,
    createdAt: failure.at,
    title: `${settings.profile.name} kept its last working Packages`,
    body: `Composition generation "${failure.generationId}" failed to activate at ${failure.phase} (attempt ${failure.attempt}); running "${fallback.generationId}" instead: ${failure.message}`.slice(
      0,
      240,
    ),
  });
}

export async function resolveAdmissionSnapshot(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<BotSettingsViewV1> {
  return (await resolveExecutionContextV1(state, command)).settings;
}

export async function alarm(state: ShellBotStateV1): Promise<void> {
  // One alarm: the kernel defers while work is in flight, settles Package
  // scheduled work, and recovers the active run. Recovery re-issues whatever
  // the interrupted Turn had dispatched, under the keys the log already
  // carries.
  await state.authority.alarm();
}

export async function fenceRunAdmission(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: unknown,
): Promise<ClientRunLookupV1> {
  const query = decodeClientRunLookupQueryV1(input);
  return projectClientRunLookupV1(
    await state.authority.fenceRunAdmission(identity, query.runId),
  );
}

/**
 * Linearizes one new external effect against durable Stop. The Agent has
 * already journaled intent; this transaction atomically persists the exact
 * admitted/fenced outcome used before the provider/tool invocation.
 *
 * Public because the `schedule` grant reaches the Bot's own tools through
 * `app/isolates/bot.ts`, which is handed this fence rather than the object.
 */
export async function admitRunEffect(
  state: ShellBotStateV1,
  identity: BotIdentity,
  runId: string,
  sessionId: string,
  effect: AgentEffectAdmission,
): Promise<boolean> {
  return state.ctx.storage.transaction(async (transaction) => {
    const [activeRunId, durableIdentity, candidate] = await Promise.all([
      transaction.get<string>(ACTIVE_RUN_KEY),
      transaction.get<BotIdentity>(IDENTITY_KEY),
      transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
    ]);
    const storedRun = optionalStoredRun(candidate);
    let run = storedRun;
    if (storedRun?.eventRange) {
      const events = await new SessionEventLog(transaction).readRange(
        storedRun.sessionId,
        storedRun.eventRange.startSeq,
        storedRun.eventRange.endSeq,
      );
      if (
        events.length !==
        storedRun.eventRange.endSeq - storedRun.eventRange.startSeq
      ) {
        throw new Error(
          `run "${storedRun.runId}" has an incomplete event range`,
        );
      }
      run = requireStoredRunV1({ ...storedRun, events });
    }
    if (
      activeRunId !== runId ||
      !run ||
      run.sessionId !== sessionId ||
      durableIdentity?.userId !== identity.userId ||
      durableIdentity.botId !== identity.botId ||
      !(run.status === "running" && run.phase === "executing")
    ) {
      return false;
    }
    const prior = run.effectAdmissions.find(
      (admission) => admission.effectId === effect.effectId,
    );
    if (prior) {
      if (prior.kind !== effect.kind) {
        throw new Error(
          `effect admission "${effect.effectId}" collides with ${prior.kind}`,
        );
      }
      return prior.outcome === "admitted";
    }
    let matchesIntent = false;
    if (effect.kind === "model") {
      const model = latestModelRequestJournalState(run.events);
      matchesIntent =
        model.status === "unresolved" &&
        model.request.request.requestId === effect.effectId;
    } else {
      try {
        const tool = validateToolOccurrenceJournal(run.events).get(
          effect.effectId,
        );
        matchesIntent = Boolean(tool?.intent && !tool.result);
      } catch {
        matchesIntent = false;
      }
    }
    if (!matchesIntent) {
      throw new Error(
        `effect admission "${effect.effectId}" does not match durable intent`,
      );
    }
    // Supersede fences exactly as Stop does. It is what makes an interrupt
    // durable rather than advisory: a Turn whose Agent never got the signal
    // — because the object was evicted and resumed — still starts no new
    // provider call or tool effect once the intent is recorded.
    const outcome =
      run.stopRequestedAt || run.supersededAt ? "fenced" : "admitted";
    const next = requireStoredRunV1({
      ...run,
      effectAdmissions: [
        ...run.effectAdmissions,
        { kind: effect.kind, effectId: effect.effectId, outcome },
      ],
    } satisfies StoredRun);
    await transaction.put(
      `${RUN_PREFIX}${runId}`,
      structuredClone(storedRunRecordV2(next)),
    );
    return outcome === "admitted";
  });
}
