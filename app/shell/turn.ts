// One admitted Turn, from the command that starts it to the effect fence that
// linearizes what it dispatches.
//
// Admission and the durable log are kernel authority; this module is the app's
// half: what a Turn runs on, the Composition it mounts, the Stop intent that
// fences it, and the one alarm that recovers it.

import type { AgentEffectAdmission } from "@frockbot/core/agent-loop/agent";
import {
  validateToolOccurrenceJournal,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import {
  activateCompositionV1,
  ACTIVE_RUN_KEY,
  COMPOSITION_CURRENT_KEY,
  decodeCompositionPinV1,
  IDENTITY_KEY,
  requireConversationHeadV1,
  RUN_PREFIX,
  SessionEventLog,
  STORED_EFFECT_ADMISSIONS_MAX,
  storedRunRecordV2,
  storedRunIsRoutineDeliveryV1,
  workingContextHeadKeyV1,
  type BotIdentity,
  type BotTurnExecutionInput,
  type CompositionFailureV1,
  type CompositionGenerationV1,
  type CompositionMountHost,
  type OwnedBotTurnCommand,
  type StoredRunOriginV1,
} from "@frockbot/core/durable";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import {
  selectStoredWorkingContextV1,
  storedCompactionWindowV1,
} from "./working-context-store.js";
import {
  admitTurnCommandV1,
  admitTurnV1,
  syncCompositionFromUser,
  compositionActivationStoreV1,
  compositionFailureLogV1,
} from "@frockbot/app/composition/bot";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  enabledSeededPluginIdsV1,
} from "@frockbot/app/plugins/catalog";
import { isolateMountOptions } from "@frockbot/app/isolates/bot";
import { settlePluginHealthV1 } from "@frockbot/app/plugins/health";
import { pendingBotInputPreambleV1 } from "@frockbot/app/routines/inbox";
import { requeueDrainedInputsV1 } from "@frockbot/app/routines/inbox-store";
import {
  admittedBotSettingsV1,
  prepareAccountV1,
  readAccountPreparationStampV1,
  readBotSettingsV1,
} from "@frockbot/app/settings/bot";
import { readPluginEnablementV1 } from "@frockbot/app/plugins/enablement";
import {
  createShellCompositionHost,
  type ShellMountedComposition,
} from "./backend-composition.js";
import { compositionFailureTurnTextV1 } from "./backend-composition-input.js";
import { createCardApprovalStoreV1 } from "./cards.js";
import {
  botStopCommandFingerprintV1,
  requireStoredRunV1,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";
import { latestModelRequestJournalState } from "./backend-recovery.js";
import { executeBotTurn } from "./backend-runner.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import { yieldCompactionWorkV1 } from "./compaction-scheduler.js";
import { notificationIdV1 } from "./notification-id.js";
import { agentRuntime } from "./runtime-mount.js";
import {
  heldSkillRevisionsV1,
  holdSkillIndexRevisionsV1,
  readDurableSkillIndexV1,
  releaseSettledSkillHoldsV1,
  releaseUnreferencedSkillSnapshotsV1,
} from "@frockbot/app/skills/index-store";
import { botInstructionRootV1 } from "@frockbot/app/skills/catalog";
import {
  decodePreparedTurnInputsV1,
  gatherPreparedTurnInputsV1,
  pluginSkillsFromMembersV1,
  PreparationConflictError,
  type PreparedTurnInputsV1,
  type PreparationPortsV1,
} from "./prepared-inputs.js";
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

async function prepareTurnAdmission(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<void> {
  // Before the authority reads the session log, so a compaction detached
  // from the previous Turn has already handed the log back.
  await yieldCompactionWorkV1(command.sessionId);
  await syncCompositionFromUser(state, {
    userId: command.userId,
    botId: command.botId,
  });
}

/**
 * Completion-waiting entry. A Routine or another Bot needs the settled Turn.
 * A person's send uses {@link admit}, which returns as soon as the command
 * is durable.
 */
export async function run(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<ClientTurnV1> {
  await prepareTurnAdmission(state, command);
  return projectClientTurnV1(await admitTurnV1(state, command));
}

/**
 * Durably accepts a composer command and returns before the Turn finishes.
 *
 * The same preparation `run` does — compaction yield, then the User's
 * Composition — and then only the admission. Execution is the authority's
 * drive and its recovery alarm.
 */
export async function admit(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<{ schemaVersion: 1; runId: string }> {
  await prepareTurnAdmission(state, command);
  const receipt = await admitTurnCommandV1(state, command);
  return { schemaVersion: 1, runId: receipt.runId };
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
    // A delivery Turn the alarm opened drains the pending queue before the
    // model runs, and a Turn carrying a durable Stop intent never completes —
    // it settles `cancelled`. So a morning's triage would be lost to one press
    // on a Turn nobody asked for. Its drained hand-offs go back on the queue
    // here, in the same transaction as the intent that decided it, and the
    // Bot's next conversational Turn carries them as it did before. A Turn the
    // person started gives back nothing: they stopped it themselves.
    if (storedRunIsRoutineDeliveryV1(run)) {
      await requeueDrainedInputsV1(transaction, command.runId);
    }
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
  if (input.preparedInputs === undefined) {
    throw new Error("this Turn has no admitted preparation");
  }
  const prepared = decodePreparedTurnInputsV1(input.preparedInputs);
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
    // How deep a `subagent` hand-off this Turn is. The tool reads it to refuse
    // a second level, so it has to come off the durable record rather than from
    // the Turn that asked, which is gone by the time this one runs.
    ...(input.command.origin?.kind === "handoff"
      ? { handoffDepth: input.command.origin.depth }
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
    // The other caller on the agent lane. The return address is durable on the
    // run record; what the Turn needs to know is that a person is listening.
    ...(input.command.origin?.kind === "voice"
      ? { inboundAgent: { kind: "voice" as const } }
      : {}),
  };
  const runtime = await agentRuntime(
    state,
    input.identity,
    settings,
    input.admittedRequest,
    turn,
    prepared,
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
  const host: CompositionMountHost<ShellMountedComposition> = {
    mount: async (mounting, signal) => {
      // Skills follow this mount, including a fail-closed fallback. The array
      // is the one the Skills host already holds, filled before features run.
      const liveEnablement = await readPluginEnablementV1(state.ctx.storage);
      const livePlugins = new Set(
        enabledSeededPluginIdsV1(
          mounting.members,
          liveEnablement,
          DEPLOYMENT_PLUGIN_CATALOG_V1,
        ),
      );
      runtime.pluginSkills.splice(
        0,
        runtime.pluginSkills.length,
        ...pluginSkillsFromMembersV1(
          mounting.members,
          runtime.pluginEnablement,
        ).filter((contribution) => livePlugins.has(contribution.pluginId)),
      );
      // The User installed the set; which of it this Bot runs is its own map,
      // and that is also what decides the worker's egress policy.
      const enabled = enabledSeededPluginIdsV1(
        mounting.members,
        runtime.pluginEnablement,
        DEPLOYMENT_PLUGIN_CATALOG_V1,
      );
      const isolate = await isolateMountOptions(state, input.identity, {
        runId: input.command.runId,
        sessionId: input.command.sessionId,
        generationId: mounting.generationId,
        members: mounting.members,
        enabled,
      });
      const mounted = await createShellCompositionHost({
        botId: input.identity.botId,
        sessionId: input.command.sessionId,
        sessionSeed: {
          cursor: input.cursor,
          context: input.context,
          journal: {
            startSeq: input.journal[0]?.seq ?? input.cursor.nextSeq,
            events: input.journal,
          },
        },
        selectWorkingContext: Object.assign(
          input.contextAvailability === "unavailable"
            ? async () => {
                throw new Error(
                  input.contextReason ?? "working context is unavailable",
                );
              }
            : (request: Parameters<typeof selectStoredWorkingContextV1>[1]) =>
                selectStoredWorkingContextV1(state.ctx.storage, request),
          {
            compactionWindow: (window: {
              sessionId: string;
              currentTurn: number;
              currentMessages: Parameters<
                typeof storedCompactionWindowV1
              >[1]["currentMessages"];
            }) => storedCompactionWindowV1(state.ctx.storage, window),
          },
        ),
        billing: state.env.BILLING?.(
          input.identity.userId,
          input.identity.botId,
          input.command.sessionId,
        ),
        persistSessionEvents: input.persistSessionEvents,
        agentPackages: runtime.agentPackages,
        modelSelection: runtime.modelSelection,
        systemPromptSection: promptParts.join("\n\n"),
        // Where a Card's Approvals are bound to the values they authorize.
        // The Bot Durable Object's own storage, because the decision and the
        // binding have to be read back together by the capability that
        // claims one.
        cardApprovals: createCardApprovalStoreV1(state.ctx.storage),
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
        remainingEffectAdmissions: () =>
          remainingRunEffectAdmissions(state, input.command.runId),
        // A model provider Plugin this Bot's selection runs (ADR 0032): the
        // provider contribution registers here, and the credential lease it
        // takes is settled where the loop settles the outcome.
        ...(runtime.pluginModel ? { pluginModel: runtime.pluginModel } : {}),
        ...(isolate ? { isolate } : {}),
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
    store: compositionActivationStoreV1(state, input.identity),
    failures: compositionFailureLogV1(state, input.identity),
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
  await recordMountedPreparationV1(
    state,
    input.command.runId,
    prepared,
    activation.mounted.generation.generationId,
  );
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
      // No first-party package pages remain after the Applets deletion
      // (ADR 0034). Any surviving direct-tool replay is refused.
      throw new Error(
        `Package "${directTool.packageId}" did not declare tool "${directTool.name}" for its pages`,
      );
    }
    const ordinaryInput = await turnInputTextV1(state, input.command);
    if (ordinaryInput === undefined) {
      return { runId: input.command.runId, text: "", events: [] };
    }
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
      composition: activation.mounted,
      resume: input.resume,
      // A resumed journal is the run's own suffix, already numbered from
      // `previousEventCount`. A fresh Turn must include events the Session
      // appended at the admission cursor before `send`.
      ...(input.resume ? {} : { suffixStartSeq: input.cursor.nextSeq }),
    });
  } finally {
    state.turn.clear(active);
    // The Plugins that ran through this Turn without failing are well again;
    // a failing one keeps its count toward the quarantine.
    await settlePluginHealthV1(state.ctx.storage, {
      runId: input.command.runId,
      ran: activation.mounted.generation.members.map(
        (member) => member.packageId,
      ),
    }).catch(() => undefined);
  }
}

/**
 * The text one admitted Turn actually runs on, or `undefined` when it has
 * nothing to run on at all.
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
 *
 * A delivery Turn is the one Turn whose *only* input is the drain: its own
 * text is a cue saying nobody spoke. The alarm decides to open one by reading
 * the queue, and the person's own Turn can drain it in the window between that
 * read and this one — so the drain coming back empty is reachable, and it
 * leaves the cue standing alone over nothing. This is where that is known, so
 * this is where it ends: the caller returns without a model call and without a
 * send rather than letting the Bot speak from an empty hand-off.
 */
export async function turnInputTextV1(
  state: ShellBotStateV1,
  command: {
    runId: string;
    text: string;
    turnType?: TurnTypeV1;
    origin?: StoredRunOriginV1;
  },
): Promise<string | undefined> {
  if ((command.turnType ?? "chat") !== "chat") return command.text;
  const drained = await state.routineInbox.drainInto(command.runId);
  const preamble = pendingBotInputPreambleV1(drained);
  if (preamble.length === 0) {
    return command.origin?.kind === "routine-delivery"
      ? undefined
      : command.text;
  }
  return `${preamble}\n${command.text}`;
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

const preparedForAdmission = new WeakMap<
  BotSettingsViewV1,
  PreparedTurnInputsV1
>();

function preparationPorts(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): PreparationPortsV1 {
  const readHead = async () => {
    const stored = await state.ctx.storage.get(
      workingContextHeadKeyV1(command.sessionId),
    );
    return requireConversationHeadV1(stored, command.sessionId);
  };
  return {
    readAccount: () => prepareAccountV1(state, command),
    readAccountStamp: () => readAccountPreparationStampV1(state, command),
    readBot: async () => {
      const [settings, enablement, head] = await Promise.all([
        readBotSettingsV1(state, command),
        readPluginEnablementV1(state.ctx.storage),
        readHead(),
      ]);
      const skillIndex = await readDurableSkillIndexV1(
        state.ctx.storage,
        botInstructionRootV1(command),
      );
      return {
        settings,
        enablement,
        contextRevision: head?.revision ?? 0,
        contextSequence: head?.nextSeq ?? 0,
        skillIndexRevision: skillIndex.deleted ? "" : skillIndex.revision,
      };
    },
    readBotStamp: async () => {
      const [settings, enablement, pin] = await Promise.all([
        readBotSettingsV1(state, command),
        readPluginEnablementV1(state.ctx.storage),
        state.ctx.storage.get(COMPOSITION_CURRENT_KEY),
      ]);
      const skillIndex = await readDurableSkillIndexV1(
        state.ctx.storage,
        botInstructionRootV1(command),
      );
      return {
        settingsRevision: settings.revision,
        pluginEnablementRevision: enablement.revision,
        compositionGenerationId:
          pin === undefined ? "" : decodeCompositionPinV1(pin).generationId,
        skillIndexRevision: skillIndex.deleted ? "" : skillIndex.revision,
      };
    },
    adoptComposition: async (snapshot) => {
      await state.authority.composition.adopt(snapshot);
    },
    ensureComposition: async () => {
      await state.authority.composition.materialize();
      return state.authority.composition.current();
    },
  };
}

export async function resolveAdmissionSnapshot(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<BotSettingsViewV1> {
  const prepared = await gatherPreparedTurnInputsV1(
    { userId: command.userId, botId: command.botId },
    preparationPorts(state, command),
  );
  const botRevision =
    prepared.skills.indexes.find((index) => index.source === "bot")?.revision ??
    "";
  const userRevision =
    prepared.skills.indexes.find((index) => index.source === "user")
      ?.revision ?? "";
  const settled = await releaseSettledSkillHoldsV1(state.ctx.storage);
  const held = await heldSkillRevisionsV1(state.ctx.storage);
  if (!held.truncated) {
    await releaseUnreferencedSkillSnapshotsV1(
      state.ctx.storage,
      {
        put: async (key, bytes) => {
          await state.env.MEMORY_FILES.put(key, bytes);
        },
        get: async (key) => {
          const object = await state.env.MEMORY_FILES.get(key);
          return object
            ? new Uint8Array(await object.arrayBuffer())
            : undefined;
        },
        delete: async (key) => {
          await state.env.MEMORY_FILES.delete(key);
        },
      },
      botInstructionRootV1(command),
      held.revisions,
    );
  }
  const userConfiguration = state.env.USER_CONFIGURATIONS.get(
    state.env.USER_CONFIGURATIONS.idFromName(command.userId),
  );
  for (const runId of settled) {
    await userConfiguration.releaseSkillIndexHold({
      schemaVersion: 1,
      userId: command.userId,
      runId,
    });
  }
  await holdSkillIndexRevisionsV1(state.ctx.storage, command.runId, {
    botRevision,
    userRevision,
  });
  await userConfiguration.holdSkillIndex({
    schemaVersion: 1,
    userId: command.userId,
    runId: command.runId,
    revision: userRevision,
  });
  preparedForAdmission.set(prepared.bot.settings, prepared);
  return prepared.bot.settings;
}

/** Bot-local revisions still match the value admission is about to store. */
export async function assertAdmittedPreparationV1(
  transaction: DurableObjectTransaction,
  resolved: BotSettingsViewV1,
): Promise<BotSettingsViewV1> {
  const prepared = preparedForAdmission.get(resolved);
  const settings = await admittedBotSettingsV1(transaction, resolved);
  if (!prepared) return settings;
  if (settings.revision !== prepared.bot.revision) {
    throw new PreparationConflictError("bot settings");
  }
  const enablement = await readPluginEnablementV1(transaction);
  if (enablement.revision !== prepared.bot.pluginEnablementRevision) {
    throw new PreparationConflictError("plugin enablement");
  }
  const pin = await transaction.get(COMPOSITION_CURRENT_KEY);
  const generationId =
    pin === undefined ? "" : decodeCompositionPinV1(pin).generationId;
  if (generationId !== prepared.composition.requestedGenerationId) {
    throw new PreparationConflictError("composition");
  }
  return settings;
}

export function preparedInputsForAdmissionV1(
  settings: BotSettingsViewV1,
): PreparedTurnInputsV1 | undefined {
  return preparedForAdmission.get(settings);
}

/** The generation activation actually mounted, on the admitted preparation. */
async function recordMountedPreparationV1(
  state: ShellBotStateV1,
  runId: string,
  prepared: PreparedTurnInputsV1,
  mountedGenerationId: string,
): Promise<void> {
  if (prepared.composition.mountedGenerationId === mountedGenerationId) return;
  const next = decodePreparedTurnInputsV1({
    ...prepared,
    composition: {
      ...prepared.composition,
      mountedGenerationId,
    },
  });
  await state.ctx.storage.transaction(async (transaction) => {
    const key = `${RUN_PREFIX}${runId}`;
    const stored = await transaction.get<unknown>(key);
    if (stored === undefined) return;
    const run = requireStoredRunV1(stored);
    if (run.status !== "running") return;
    await transaction.put(
      key,
      storedRunRecordV2({ ...run, preparedInputs: next }),
    );
  });
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
 * How many further effects this run's record can still admit.
 *
 * The bound is the decoder's own: a record past it cannot be stored, so
 * anything that plans several admissions at once — a `batch` expanding its
 * calls — asks here first and refuses what will not fit, rather than
 * discovering the bound as a throw out of the admission that crossed it.
 */
export async function remainingRunEffectAdmissions(
  state: ShellBotStateV1,
  runId: string,
): Promise<number> {
  const run = optionalStoredRun(
    await state.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
  );
  return Math.max(
    STORED_EFFECT_ADMISSIONS_MAX - (run?.effectAdmissions.length ?? 0),
    0,
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
