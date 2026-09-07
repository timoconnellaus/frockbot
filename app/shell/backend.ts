// The Shell's Bot Durable Object contribution: the state every feature module
// takes, the authority hook table that wires them into the kernel, Turn
// execution and its Composition mount, and the Skill and Workspace writes a
// User makes as themselves.

import type { AgentEffectAdmission } from "@frockbot/core/agent-loop/agent";
import { firstPartyPackageToolAllowedV1 } from "@frockbot/applets/pages";
import {
  decodeSendToUserPayloadV1,
  validateToolOccurrenceJournal,
  type NormalizedModelRequest,
  type PackageIframeCompositionV1,
  type PackageIframeToolCommandV1,
  type SessionEvent,
  type TurnTypeV1,
  type WorkspaceFilesV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { defineBotBackendContribution } from "@frockbot/core/contracts/contributions";
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
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import {
  resolveBotExecutionPlanV1,
  resolveEffectiveBotModelV1,
  resolvePackageSettingValuesV1,
  type BotSettingsViewV1,
  type ConnectionView,
  type EnabledCapabilityV1,
  type PackageSettingValueV1,
  type ResolvedModelBindingV1,
} from "@frockbot/core/configuration";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import {
  appletsRuntimeHost,
  resolveAppletComposition,
} from "@frockbot/app/applets-host/bot";
import { createAppletInstanceBindingV1 } from "@frockbot/app/applets-host/records";
import { isolateMountOptions } from "@frockbot/app/isolates/bot";
import {
  createBotMachineHost,
  createBotMachineMessagesHost,
  machineSeam,
  resolveBotMachineMessagesGateV1,
} from "@frockbot/app/machine/bot";
import {
  acknowledgeNotification,
  createFailureNotification,
  createNotification,
  listNotifications,
  supersededPackageRecords,
  terminalPackageRecords,
} from "@frockbot/app/notifications/bot";
import {
  createBotRoutinesHost,
  deferScheduledWork,
  executeRoutineCommand,
  listRoutines,
  scheduledDeadlines,
  settleScheduledWork,
} from "@frockbot/app/routines/bot";
import { pendingBotInputPreambleV1 } from "@frockbot/app/routines/inbox";
import { decodeAgentTurnSlotReceiptV1 } from "@frockbot/app/flock/quota";
import {
  admittedBotSettingsV1,
  assertLifecycleActiveV1,
  executeConfigurationCommand,
  materializeBotSettingsV1,
  readBotSettingsV1,
  resolveExecutionContextV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import {
  loadFullSkillCatalogV1,
  loadSkillCatalogV1,
  skillRefForLoadedSkillV1,
} from "@frockbot/app/skills/catalog";
import { writeSkillDocumentV1 } from "@frockbot/app/skills/write";
import {
  subagentModelCatalogV1,
  type SubagentModelOptionV1,
} from "@frockbot/app/subagents/models";
import { taskDesktopLeaseOwnerV1 } from "@frockbot/app/subagents/records";
import { subagentsRuntimeHost } from "@frockbot/app/subagents/bot";
import {
  bootstrapCompositionGeneration,
  createShellCompositionHost,
  type ShellAppletMountOptions,
  type ShellMountedComposition,
} from "./backend-composition.js";
import { compositionFailureTurnTextV1 } from "./backend-composition-input.js";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.js";
import {
  botStopCommandFingerprintV1,
  requireStoredRunV1,
  type BotNotificationIntent,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";
import { createBotSelfManagementHost } from "./backend-flock.js";
import { createBotImageHost } from "./backend-image.js";
import { createBotMemoryHost } from "./backend-memory.js";
import { latestModelRequestJournalState } from "./backend-recovery.js";
import { executeBotTurn, executeDirectToolTurn } from "./backend-runner.js";
import { createBotSkillsHost, createBotSkillsReads } from "./backend-skills.js";
import {
  executionPackagesV1,
  ShellBotStateV1,
  type ShellBotBackendHost,
} from "./backend-state.js";
import { yieldCompactionWorkV1 } from "./compaction-scheduler.js";
import { projectFirstPartyPackageIframeV1 } from "./composition-views.js";
import { debugSnapshot } from "./debug.js";
import { type BotDebugSnapshotV1 } from "./debug-protocol.js";
import { notificationIdV1 } from "./notification-id.js";
import {
  announcementsFromSession,
  listConversations,
  listRunEventPage,
  listRuns,
  lookupRun,
  startConversation,
} from "./reads.js";
import {
  createClientRunStopReceiptV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  decodeClientTurnV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientConversationListV1,
  type ClientConversationOutcomeV1,
  type ClientRunListV1,
  type ClientRunLookupV1,
  type ClientRunStopReceiptV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import {
  clientSkillCatalogEntryV1,
  type ClientSkillCatalogEntryV1,
  type ClientSkillCatalogV1,
} from "./skill-protocol.js";
import { turnToolCatalogPin } from "./tool-catalog-pin.js";

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

export type { BotIdentity, OwnedBotTurnCommand };

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
}

/** Server-side allowlist for the untrusted page's only effectful message. */
export function requirePackageUiToolDeclarationV1(
  catalog: PackageIframeCompositionV1,
  command: Pick<PackageIframeToolCommandV1, "packageId" | "name">,
): PackageIframeCompositionV1["contributions"][number] {
  const contribution = catalog.contributions.find(
    (candidate) => candidate.packageId === command.packageId,
  );
  if (!contribution || !contribution.declaredTools.includes(command.name)) {
    throw new Error(
      `Package "${command.packageId}" did not declare tool "${command.name}"`,
    );
  }
  return contribution;
}

export class ShellBotBackendContribution {
  readonly state: ShellBotStateV1;

  constructor(host: ShellBotBackendHost) {
    // The hook table is the wiring: each entry forwards to the feature module
    // that owns the answer, with this object's state as its first argument.
    this.state = new ShellBotStateV1(host, (state) => ({
      resolveAdmissionSnapshot: (command) =>
        this.resolveAdmissionSnapshot(command),
      bootstrapComposition: () =>
        Promise.resolve(
          bootstrapCompositionGeneration(new Date().toISOString()),
        ),
      admittedSnapshot: (transaction, resolved) =>
        admittedBotSettingsV1(transaction, resolved),
      executeTurn: (input) => this.executeTurn(input),
      notification: (snapshot, result) => createNotification(snapshot, result),
      failureNotification: (snapshot, failed) =>
        createFailureNotification(snapshot, failed),
      terminalRecords: (input) => terminalPackageRecords(input),
      supersededRecords: (input) => supersededPackageRecords(input),
      interruptTurn: (runId, reason) => state.turn.interrupt(runId, reason),
      scheduledDeadlines: (transaction) =>
        scheduledDeadlines(state, transaction),
      scheduledWorkInFlight: () => state.hostScheduled.inFlight?.() ?? false,
      deferScheduledWork: (transaction) =>
        deferScheduledWork(state, transaction),
      settleScheduledWork: () => settleScheduledWork(state),
    }));
  }

  /** @see materializeBotSettingsV1 — the Flock host mounts this Bot through it. */
  async materializeSettings(
    identity: BotIdentity,
    initial: { name: string; description?: string },
  ): Promise<BotSettingsViewV1> {
    return materializeBotSettingsV1(this.state, identity, initial);
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return readBotSettingsV1(this.state, identity);
  }

  async listAnnouncements(): Promise<SessionEvent[]> {
    const sessionId = await this.state.authority.readConversationSessionId();
    const session = sessionId
      ? await this.state.authority.readSessionEvents(sessionId)
      : [];
    return announcementsFromSession(this.state, session);
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    // Before the authority reads the session log, so a compaction detached
    // from the previous Turn has already handed the log back.
    await yieldCompactionWorkV1(command.sessionId);
    // Before admission, so the pin this Turn takes already carries whatever
    // the User's Applet directory says now.
    await resolveAppletComposition(
      this.state,
      { userId: command.userId, botId: command.botId },
      command,
    );
    return projectClientTurnV1(await this.state.authority.run(command));
  }

  async runPackageUiTool(
    identity: BotIdentity,
    command: PackageIframeToolCommandV1,
  ): Promise<ClientTurnV1> {
    await this.validateIdentity(identity);
    const catalog = await this.listPackageUi(identity);
    const contribution = requirePackageUiToolDeclarationV1(catalog, command);
    return projectClientTurnV1(
      await this.state.authority.run({
        ...identity,
        runId: command.commandId,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: `${contribution.displayName} · ${command.name}`,
        directTool: {
          packageId: command.packageId,
          name: command.name,
          input: command.input,
        },
      }),
    );
  }

  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover.
   *
   * A read of the same instruction root the Turn loader reads, through the
   * same `WorkspaceReadsV1`, so the popover can never offer a Skill a Turn
   * would refuse as an instruction: a refused candidate is not in the catalog
   * here either. Names and descriptions only — never a body.
   *
   * An unbound Workspace surface is an empty catalog, not a failure: the
   * Skills Package is not mounted in that host either, so "no Skills" is the
   * true answer rather than an error the composer has to explain.
   */
  async listSkills(identity: BotIdentity): Promise<ClientSkillCatalogV1> {
    await this.validateIdentity(identity);
    const reads = createBotSkillsReads(this.state.env);
    if (!reads) return { schemaVersion: 1, skills: [] };
    const catalog = await loadFullSkillCatalogV1(reads, {
      userId: identity.userId,
      botId: identity.botId,
    });
    const entries: ClientSkillCatalogEntryV1[] = [];
    for (const skill of catalog.skills) {
      const ref = skillRefForLoadedSkillV1(skill);
      // A Skill whose directory is not a well-formed slug has no ref, so it
      // cannot be invoked and is not offered. It is still listed to the model
      // in `<agent_skills>` and still loadable by path.
      if (!ref) continue;
      entries.push(
        clientSkillCatalogEntryV1({
          skill: ref,
          name: skill.name,
          description: skill.description,
          path: skill.path,
        }),
      );
    }
    return { schemaVersion: 1, skills: entries };
  }

  /** The first-party page registry, as inert iframe metadata for one Bot. */
  async listPackageUi(
    identity: BotIdentity,
  ): Promise<PackageIframeCompositionV1> {
    await this.validateIdentity(identity);
    return projectFirstPartyPackageIframeV1(identity.botId);
  }

  /**
   * Write one Skill into this Bot's own instruction root as its **User**.
   *
   * The importing User authored the recipe by choosing to materialize it, and
   * no Turn of the new Bot has run yet, so there is no Bot writer to record.
   * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
   * instruction root, so an imported Skill is loadable on the Bot's first Turn
   * and its provenance says who put it there. The write goes through the same
   * `writeSkillDocumentV1` the Bot's own `skill_write` uses, quota included.
   */
  /**
   * One file written into one of the User's durable roots, as the User.
   *
   * This is the stand-in for the Computer's sync in an environment that has
   * no Computer: an end-to-end run lands the bytes `applet build` would have
   * written, at the path the sync would have mirrored them to, through the
   * same store and with the same generation record. The writer is the User —
   * the authority the sync's `unattributed` mirror is *narrower* than — so
   * nothing here is a write the User could not have made from their own
   * Computer. A root belonging to another User is refused by the store.
   */
  async writeUserWorkspaceFile(
    identity: BotIdentity,
    request: {
      root: WorkspaceRootV1;
      path: string;
      bytes: Uint8Array;
      mediaType?: string;
    },
  ): Promise<
    | { status: "written"; generationId: string }
    | { status: "refused"; reason: string }
  > {
    await this.validateIdentity(identity);
    const files = (this.state.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
      .WORKSPACE_FILES;
    if (!files) {
      return { status: "refused", reason: "this Bot has no Workspace store" };
    }
    if (request.root.userId !== identity.userId) {
      return { status: "refused", reason: "the root belongs to another User" };
    }
    const path = { root: request.root, path: request.path };
    const existing = await files.stat(path);
    const outcome = await files.write({
      path,
      bytes: request.bytes,
      writer: { kind: "user", userId: identity.userId },
      expectedGenerationId:
        existing.status === "ok"
          ? existing.entry.generation.generationId
          : null,
      ...(request.mediaType ? { mediaType: request.mediaType } : {}),
    });
    if (outcome.status === "ok") {
      return {
        status: "written",
        generationId: outcome.generation.generationId,
      };
    }
    return { status: "refused", reason: outcome.reason };
  }

  async writeUserSkill(
    identity: BotIdentity,
    draft: { slug: string; name: string; description: string; body: string },
  ): Promise<
    | { status: "written"; generationId: string }
    | { status: "refused"; reason: string }
  > {
    await this.validateIdentity(identity);
    // The same binding `createBotSkillsHost` hands the Skills Package for a
    // Turn. Absent, and there is no writable instruction root to import into.
    const files = (this.state.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
      .WORKSPACE_FILES;
    if (!files) {
      return {
        status: "refused",
        reason: "this Bot has no writable instruction root",
      };
    }
    const outcome = await writeSkillDocumentV1(
      files,
      { userId: identity.userId, botId: identity.botId },
      { kind: "user", userId: identity.userId },
      draft,
    );
    return outcome.status === "written"
      ? { status: "written", generationId: outcome.generationId }
      : outcome;
  }

  /**
   * The Bot's own instruction root, bodies included.
   *
   * `listSkills` above is deliberately body-free: the composer's popover needs
   * names, and a body it does not need is a body it should not carry. This is
   * the other read — the one an export needs — and it is narrower in exactly
   * the way that matters: it calls `loadSkillCatalogV1`, which walks *only*
   * the Bot's own instruction root, so the managed set and the plugin-borne
   * index are not merely filtered out afterwards, they are never loaded. A
   * candidate the authority predicate refuses is not here either, and a Skill
   * whose body could not be read is absent rather than half-present.
   *
   * A Skill with no well-formed slug is dropped: the importing Bot needs a
   * directory name to write it under, and inventing one from a path that means
   * something only in this deployment would be a fallback, which the register
   * forbids.
   */
  async listOwnSkillDocuments(identity: BotIdentity): Promise<
    {
      slug: string;
      name: string;
      description?: string;
      body: string;
    }[]
  > {
    await this.validateIdentity(identity);
    const reads = createBotSkillsReads(this.state.env);
    if (!reads) return [];
    const catalog = await loadSkillCatalogV1(reads, {
      userId: identity.userId,
      botId: identity.botId,
    });
    return catalog.skills.flatMap((skill) =>
      skill.ref
        ? [
            {
              slug: skill.ref.slug,
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
              body: skill.body,
            },
          ]
        : [],
    );
  }

  /**
   * Durably records Stop intent and an idempotency receipt before signalling
   * the resident Agent. The acknowledged projection reports the run's current
   * durable state and never claims terminal cancellation.
   */
  async stopRun(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunStopReceiptV1> {
    const command = decodeClientRunStopCommandV1(input);
    await this.validateIdentity(identity);
    const commandFingerprint = botStopCommandFingerprintV1({
      userId: identity.userId,
      botId: identity.botId,
      commandId: command.commandId,
      runId: command.runId,
    });
    const key = `${RUN_PREFIX}${command.runId}`;
    const receiptKey = `${STOP_RECEIPT_PREFIX}${command.commandId}`;
    const admitted = await this.state.ctx.storage.transaction(
      async (transaction) => {
        const durableIdentity =
          await transaction.get<BotIdentity>(IDENTITY_KEY);
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
        await this.state.authority.refreshRecoveryAlarm(transaction);
        return stopped;
      },
    );
    // The Agent signal is advisory and always follows the durable intent.
    this.state.turn.cancel({
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
      (await this.state.authority.readStoredRunForDisplay(command.runId)) ??
      admitted;
    return createClientRunStopReceiptV1(command, projectClientRunV1(current));
  }

  private async executeTurn(
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
    const runtime = await this.agentRuntime(
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
    const appletInstances = this.state.env.APPLET_STATES
      ? createAppletInstanceBindingV1(
          this.state.env.APPLET_STATES,
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
        const isolate = await isolateMountOptions(this.state, input.identity, {
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
            this.admitRunEffect(
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
        read: (generationId) =>
          this.state.authority.composition.read(generationId),
        lastKnownGood: () => this.state.authority.composition.lastKnownGood(),
        commit: (generationId) =>
          this.state.authority.composition.commit(generationId),
        fail: (generationId, options) =>
          this.state.authority.composition.fail(generationId, options),
      },
      failures: this.state.authority.compositionFailures,
      host,
      signal: controller.signal,
      onFailure: (failure, fallback) =>
        this.recordCompositionFailureNotification(
          settings,
          input.command.runId,
          failure,
          fallback,
        ),
    });
    if (activation.status === "failed-closed") {
      // The durable record names what the Turn actually ran under.
      await this.state.authority.repinRun(
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
    this.state.turn.set(active);
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
            this.admitRunEffect(
              input.identity,
              input.command.runId,
              input.command.sessionId,
              effect,
            ),
          signal: controller.signal,
        });
      }
      const ordinaryInput = await this.turnInputTextV1(input.command);
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
      this.state.turn.clear(active);
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
  private async turnInputTextV1(command: {
    runId: string;
    text: string;
    turnType?: TurnTypeV1;
  }): Promise<string> {
    if ((command.turnType ?? "chat") !== "chat") return command.text;
    const drained = await this.state.routineInbox.drainInto(command.runId);
    const preamble = pendingBotInputPreambleV1(drained);
    return preamble.length === 0
      ? command.text
      : `${preamble}\n${command.text}`;
  }

  /** The visible half of failing closed, through the Bot's notifications. */
  private async recordCompositionFailureNotification(
    settings: BotSettingsViewV1,
    runId: string,
    failure: CompositionFailureV1,
    fallback: CompositionGenerationV1,
  ): Promise<void> {
    await this.state.authority.recordNotification({
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

  private async resolveAdmissionSnapshot(
    command: OwnedBotTurnCommand,
  ): Promise<BotSettingsViewV1> {
    return (await resolveExecutionContextV1(this.state, command)).settings;
  }

  /** Narrow RPC for the User-wide agent-lane concurrency lease. */
  private agentTurnSlots(identity: BotIdentity) {
    const id = this.state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    const rpc = this.state.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveAgentTurnSlot(input: unknown): Promise<unknown>;
      releaseAgentTurnSlot(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request: unknown) =>
        decodeAgentTurnSlotReceiptV1(await rpc.reserveAgentTurnSlot(request)),
      release: async (request: unknown) => {
        await rpc.releaseAgentTurnSlot(request);
      },
    };
  }

  /**
   * Public because an isolate's `ai` grant streams through the same mounted
   * Composition a Turn does; `app/isolates/bot.ts` is handed this resolver.
   */
  async agentRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    admittedRequest?: NormalizedModelRequest,
    turn?: {
      runId: string;
      turnId: string;
      sessionId: string;
      fromBotName: string;
      /**
       * The generation this Turn pinned, and the type it was admitted as. A
       * dispatched subagent runs on the generation its parent pinned, and the
       * models it may be given are narrowed by the turn type — so both travel
       * with the Turn rather than being resolved a second time.
       */
      compositionGenerationId?: string;
      turnType?: TurnTypeV1;
      /** The subagent role, on a `subagent` Turn that was admitted with one. */
      subagentRole?: string;
      /** The task a child Turn is running, in a Subagent Durable Object. */
      subagentTaskId?: string;
    },
  ): Promise<{
    agentPackages: FoundationAgentPackage[];
    capabilities: EnabledCapabilityV1[];
    modelSelection: RuntimeModelSelection;
  }> {
    const userConfiguration = userConfigurationV1(this.state, identity);
    const user = await userConfiguration.readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const packageDefinitions = executionPackagesV1(this.state.application);
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    // The durable roots this User's enabled Packages declare, read from the
    // same installations the Composition is resolved from. Handed to the
    // Computer sync below; nothing else reads it.
    const packageRoots = declaredPackageRootsV1({
      installations: user.packages,
      packages: this.state.application.packages,
    });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.state.env as unknown as Record<string, unknown>)[
        name
      ];
      return typeof value === "string" ? value : undefined;
    };
    const authorizeEnabledConnection = (
      capability: EnabledCapabilityV1,
    ): Promise<ConnectionView> => {
      const enabled = plan.capabilities.some(
        (candidate) =>
          candidate.packageId === capability.packageId &&
          candidate.capabilityId === capability.capabilityId &&
          candidate.connectionId === capability.connectionId,
      );
      const connection = user.connections.find(
        (candidate) =>
          candidate.connectionId === capability.connectionId &&
          candidate.packageId === capability.packageId &&
          candidate.state === "ready",
      );
      if (!enabled || !connection) {
        return Promise.reject(
          new Error("Enabled effect is no longer authorized"),
        );
      }
      return Promise.resolve(structuredClone(connection));
    };
    // The Package-level settings this User holds, resolved against the manifest
    // of the Composition this Turn is pinned to. They come from the same `user`
    // read the rest of this Composition uses, so a value the User changed is
    // picked up when the next Turn resolves its Composition and never inside
    // one already running.
    const packageSettings = (
      packageId: string,
    ): Record<string, PackageSettingValueV1> => {
      const installation = user.packages.find(
        (candidate) => candidate.packageId === packageId,
      );
      const declared = this.state.application.packages.find(
        (definition) => definition.id === packageId,
      );
      return resolvePackageSettingValuesV1(
        [...(declared?.settings ?? [])],
        installation?.values,
      );
    };
    const primitivePackageSettings = (
      packageId: string,
    ): Record<string, string | number | boolean> =>
      Object.fromEntries(
        Object.entries(packageSettings(packageId)).filter(
          (entry): entry is [string, string | number | boolean] =>
            typeof entry[1] !== "object",
        ),
      );
    // The `image.model` Package setting, already checked against the enum the
    // Image Package's definition declares.
    const configuredImageModel = packageSettings("image").model;
    // Row 57g. Resolved before the Composition is built, because the answer
    // decides whether a Package is mounted at all: a feature gate that let the
    // tools exist and refuse would still have told the model they were there.
    // The registry is read only when the setting is on.
    const machines = turn ? machineSeam(this.state, identity) : undefined;
    const messagesGate = machines
      ? await resolveBotMachineMessagesGateV1(
          primitivePackageSettings("machine-messages"),
          () => machines.list(),
        )
      : ({ status: "off" } as const);
    // Filled in once this Turn's model binding is resolved, below. The tool
    // and the prompt section both read it lazily, from inside the Turn.
    const subagentModels: SubagentModelOptionV1[] = [];
    const resolvedAgentPackages: FoundationAgentPackage[] = [
      ...this.state.application.runtime.hosted({
        userId: identity.userId,
        readSecret,
        ...(turn
          ? {
              skills: createBotSkillsHost(identity, turn, this.state.env),
            }
          : {}),
        ...(turn
          ? { memory: createBotMemoryHost(identity, turn, this.state.env) }
          : {}),
        // A Bot generates an image only inside an admitted Turn, whose Session
        // and Turn the Workspace write names as its writer.
        ...(turn
          ? {
              image: createBotImageHost(
                identity,
                turn,
                this.state.env,
                typeof configuredImageModel === "string"
                  ? configuredImageModel
                  : undefined,
              ),
            }
          : {}),
        // A Bot builds an Applet only inside an admitted Turn: the publish is
        // a durable effect whose intent record has to name the Session and Turn
        // that asked for it, and the scaffold write names the same writer.
        ...(turn
          ? (() => {
              const applets = appletsRuntimeHost(this.state, identity, turn);
              return applets ? { applets } : {};
            })()
          : {}),
        // A Bot changes its own identity, or adds a Bot to its User's flock,
        // only inside an admitted Turn whose Session and Turn the write names.
        ...(turn
          ? {
              botSelfManagement: createBotSelfManagementHost(identity, turn, {
                readSettings: (target) => readBotSettingsV1(this.state, target),
                executeConfiguration: (target, command) =>
                  executeConfigurationCommand(this.state, target, command),
                listBots: (userId) =>
                  userConfigurationV1(this.state, identity).listBots(userId),
                createBot: (userId, command) =>
                  userConfigurationV1(this.state, identity).createBot(
                    userId,
                    command,
                  ),
                reserveAgentTurn: (request) =>
                  this.agentTurnSlots(identity).reserve(request),
                releaseAgentTurn: (request) =>
                  this.agentTurnSlots(identity).release(request),
                runAgent: async (request) => {
                  if (!this.state.env.BOT_STATES) {
                    throw new Error("Bot-to-Bot messaging is unavailable");
                  }
                  const id = this.state.env.BOT_STATES.idFromName(
                    `${request.userId}:${request.botId}`,
                  );
                  const rpc = this.state.env.BOT_STATES.get(id) as unknown as {
                    runAgent(input: unknown): Promise<unknown>;
                  };
                  const completed = decodeClientTurnV1(
                    structuredClone(await rpc.runAgent(request)),
                  );
                  let sentText: string | undefined;
                  for (const event of completed.events) {
                    if (event.type !== "send/to-user") continue;
                    const payload = decodeSendToUserPayloadV1(
                      event.payload,
                      "agent send/to-user payload",
                    );
                    if (payload.type === "text") {
                      sentText = payload.text;
                      break;
                    }
                  }
                  return {
                    text: sentText ?? completed.text,
                  };
                },
              }),
            }
          : {}),
        // A Bot packs itself into a template only inside an admitted Turn, and
        // only through its User's own staging command: the seam it is handed
        // has no way to publish, so the Bot cannot.
        ...(turn
          ? {
              botTemplate: {
                owner: {
                  userId: identity.userId,
                  botId: identity.botId,
                },
                stageTemplate: (input: { commandId: string; botId: string }) =>
                  userConfigurationV1(
                    this.state,
                    identity,
                  ).executeTemplateCommand(identity.userId, {
                    schemaVersion: 1,
                    type: "template/stage",
                    commandId: input.commandId,
                    botId: input.botId,
                  }),
              },
            }
          : {}),
        // A Bot writes a Routine only inside a Turn, so the record's writer can
        // name the Session and Turn that produced it.
        ...(turn
          ? {
              routines: {
                ...createBotRoutinesHost(identity, turn, this.state.routines),
                list: () => listRoutines(this.state, identity),
                execute: (command, writer) =>
                  executeRoutineCommand(this.state, identity, command, writer),
              },
            }
          : {}),
        // A Bot dispatches a subagent only inside an admitted Turn, whose run
        // the task record names, and only where a Subagent Durable Object can
        // actually be addressed.
        ...(turn && turn.compositionGenerationId && this.state.subagentBinding
          ? {
              subagents: subagentsRuntimeHost(
                this.state,
                identity,
                turn,
                turn.compositionGenerationId,
                turn.turnType ?? "chat",
                () => subagentModels,
                turn.subagentTaskId,
              ),
            }
          : {}),
        // The registered machine (rows 48, 49). The control tools mount only
        // inside a Turn, because the intent record they write has to name the
        // Session and Turn that asked — and because the approval that gates
        // them is a send onto that Turn's own durable log.
        ...(turn
          ? {
              machines: createBotMachineHost(
                identity,
                turn,
                this.state.ctx.storage,
                machineSeam(this.state, identity),
              ),
            }
          : {}),
        // Row 57g, mounted only behind its whole gate: the User setting on, and
        // a connected macOS machine that reports the `messages` capability.
        ...(turn && machines && messagesGate.status === "ready"
          ? {
              machineMessages: createBotMachineMessagesHost(
                {
                  ...createBotMachineHost(
                    identity,
                    turn,
                    this.state.ctx.storage,
                    machines,
                  ),
                  writer: {
                    sessionId: turn.sessionId,
                    turnId: turn.turnId,
                    runId: turn.runId,
                  },
                },
                machines,
              ),
            }
          : {}),
        // The durable-root sync runs only inside a Turn that uses the
        // Computer. It attributes nothing: a file a shell wrote there reaches
        // object storage with an unattributed writer.
        ...(turn
          ? {
              computerSync: createBotComputerSyncHost(
                this.state.env,
                packageRoots,
              ),
              // The same Turn, as the writer a durable Computer write records.
              computerWriter: {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                runId: turn.runId,
              },
              // A background process is Bot-scoped durable state, so its
              // record lives in this Bot's own Durable Object storage.
              computerProcesses: this.state.ctx.storage,
              // Prompt assembly reads the Bot DO's Step 1 lease record
              // directly; passing storage wakes no Computer.
              computerControlRecords: this.state.ctx.storage,
              ...(this.state.invalidateComputerProjectionFile
                ? {
                    computerProjectionFiles: {
                      invalidate: (
                        botId: string,
                        kind: "screenshots" | "doctor",
                      ) =>
                        this.state.invalidateComputerProjectionFile?.(
                          identity.userId,
                          botId,
                          kind,
                        ),
                    },
                  }
                : {}),
              // A computerUse child is the holder of the User-wide lease its
              // parent acquired. Its guarded commands must name that same
              // durable task owner or the shared fence would refuse itself.
              ...(turn.subagentRole === "computerUse" && turn.subagentTaskId
                ? {
                    computerAgentControlOwnerId: taskDesktopLeaseOwnerV1(
                      identity.botId,
                      turn.subagentTaskId,
                    ),
                  }
                : {}),
            }
          : {}),
        // The Computer host, when this deployment has one. Both halves or
        // neither: a binding with no token reaches a host that refuses.
        ...(this.state.env.COMPUTER_HOST && this.state.env.COMPUTER_HOST_TOKEN
          ? {
              computerHostBinding: {
                fetcher: this.state.env.COMPUTER_HOST,
                hostToken: this.state.env.COMPUTER_HOST_TOKEN,
              },
            }
          : {}),
      }),
      ...(await this.state.application.runtime.enabled(plan, {
        userId: identity.userId,
        readSecret,
        authorizeConnection: authorizeEnabledConnection,
        ...(turn
          ? {
              pinToolCatalog: turnToolCatalogPin(
                this.state.ctx.storage,
                turn.turnId,
              ),
            }
          : {}),
        packageSettings,
        // Enabled Contributions reach the network through the same
        // outbound seam the model provider uses, so a deployment that stubs
        // it stubs every one of them.
        ...(this.state.outboundFetch
          ? { fetch: this.state.outboundFetch }
          : {}),
        leaseCredential: async (
          capability: EnabledCapabilityV1,
          effectId: string,
          expectedGeneration?: string,
        ): Promise<CredentialLeaseV1> => {
          if (!capability.connectionId || !expectedGeneration) {
            throw new Error("Enabled Connection generation is unavailable");
          }
          return userConfiguration.leaseToolCredential(
            identity.userId,
            capability.connectionId,
            effectId,
            expectedGeneration,
          );
        },
        settleCredential: async (
          capability: EnabledCapabilityV1,
          effectId: string,
        ): Promise<void> => {
          if (!capability.connectionId) return;
          await userConfiguration.settleToolCredential(
            identity.userId,
            capability.connectionId,
            effectId,
          );
        },
      })),
    ];
    const agentPackages: FoundationAgentPackage[] = resolvedAgentPackages;
    // One generic resolver owns precedence: enabled Bot-scoped Package value,
    // enabled User-scoped Package value, then the platform model. The kernel
    // names no Package (AGENTS.md Configuration shape).
    const effective = resolveEffectiveBotModelV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    const effectiveModel = effective.model;
    if (!effectiveModel) {
      throw new Error(
        effective.binding?.failure ??
          "No model is set up yet. Choose one in Models.",
      );
    }
    const binding: ResolvedModelBindingV1 = effective.binding ?? {
      model: structuredClone(effectiveModel),
      state: "unavailable",
      failure: "This Bot's model isn't available. Pick one in Models.",
    };
    if (
      binding.state === "unavailable" ||
      !binding.connection ||
      !binding.providerType ||
      !binding.packageId
    ) {
      throw new Error(
        binding.failure ??
          "This Bot's model isn't available. Pick one in Models.",
      );
    }
    if (
      admittedRequest &&
      (admittedRequest.provider !== binding.providerType ||
        admittedRequest.model !== effectiveModel.providerModelId ||
        admittedRequest.modelBinding?.connectionId !==
          binding.connection.connectionId ||
        !admittedRequest.modelBinding.connectionGeneration ||
        admittedRequest.modelBinding.connectionGeneration !==
          binding.connection.generation)
    ) {
      throw new Error(
        "This Bot's model changed mid-reply. Send your message again.",
      );
    }
    const bindingPackageId = binding.packageId;
    agentPackages.push(
      this.state.application.runtime.model(binding, {
        accountId: identity.userId,
        connectionId: binding.connection.connectionId,
        leaseCredential: (
          effectId,
          expectedGeneration,
        ): Promise<CredentialLeaseV1> => {
          if (!expectedGeneration) {
            throw new Error(
              "Model request Connection generation is unavailable",
            );
          }
          return userConfiguration.leaseModelCredential(
            identity.userId,
            binding.connection!.connectionId,
            effectiveModel.providerModelId,
            effectId,
            expectedGeneration,
          );
        },
        settleCredential: (effectId) =>
          userConfiguration.settleModelCredential(
            identity.userId,
            binding.connection!.connectionId,
            bindingPackageId,
            effectId,
          ),
        ...(this.state.env.FROCK_AI
          ? {
              frockAiAutoRoute: this.state.env.FROCK_AI.autoRoute,
              runFrockAiChatCompletion: (gatewayModel, body) =>
                this.state.env.FROCK_AI!.runChatCompletion(gatewayModel, body),
            }
          : {}),
        fetch: this.state.outboundFetch,
      }),
    );
    // The slugs `<available_subagent_models>` renders, and the only ones a
    // `Task` call may name. They come from User enablement as resolved for this
    // Turn — never anything the Bot claimed about a model.
    const modelCapability = plan.capabilities.find(
      (candidate) =>
        candidate.kind === "model" &&
        candidate.connectionId === binding.connection!.connectionId,
    );
    if (modelCapability) {
      const subagentBinding = {
        packageId: modelCapability.packageId,
        capabilityId: modelCapability.capabilityId,
        connectionId: binding.connection.connectionId,
        provider: binding.providerType,
        providerModelId: effectiveModel.providerModelId,
        ...(binding.connection.generation
          ? { connectionGeneration: binding.connection.generation }
          : {}),
      };
      subagentModels.push(
        ...subagentModelCatalogV1({
          bindings: [subagentBinding],
          defaultBinding: subagentBinding,
          turnType: turn?.turnType ?? "chat",
        }),
      );
    }
    // Last, so every provider an earlier Package registered is already there.
    agentPackages.push(...this.state.application.runtime.base());
    return {
      agentPackages,
      capabilities: structuredClone(plan.capabilities),
      modelSelection: {
        provider: binding.providerType,
        model: effectiveModel.providerModelId,
        connectionId: binding.connection.connectionId,
        ...(binding.connection.generation
          ? { connectionGeneration: binding.connection.generation }
          : {}),
        ...((admittedRequest?.modelBinding?.catalogGeneration ??
        binding.connection.modelCatalog?.generation)
          ? {
              catalogGeneration:
                admittedRequest?.modelBinding?.catalogGeneration ??
                binding.connection.modelCatalog!.generation,
            }
          : {}),
      },
    };
  }

  /** @see listNotifications — the recovery integration test reads it here. */
  async listNotifications(): Promise<BotNotificationIntent[]> {
    return listNotifications(this.state);
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    return acknowledgeNotification(this.state, notificationId);
  }

  async readDurableIdentity(): Promise<BotIdentity | undefined> {
    return this.state.authority.readDurableIdentity();
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return this.state.authority.validateIdentity(identity);
  }

  /** Recompute the Bot authority's one alarm inside a Package write transaction. */
  async refreshScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.state.authority.refreshRecoveryAlarm(transaction);
  }

  async alarm(): Promise<void> {
    // One alarm: the kernel defers while work is in flight, settles Package
    // scheduled work, and recovers the active run. Recovery re-issues whatever
    // the interrupted Turn had dispatched, under the keys the log already
    // carries.
    await this.state.authority.alarm();
  }
  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    return listRuns(this.state, input);
  }
  async listConversations(): Promise<ClientConversationListV1> {
    return listConversations(this.state);
  }

  async startConversation(
    identity: BotIdentity,
  ): Promise<ClientConversationOutcomeV1> {
    return startConversation(this.state, identity);
  }

  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    return lookupRun(this.state, input);
  }

  async listRunEventPage(cursor?: string): ReturnType<typeof listRunEventPage> {
    return listRunEventPage(this.state, cursor);
  }

  /** @see debugSnapshot in `debug.ts`. */
  async debugSnapshot(
    identity: BotIdentity,
    input: unknown = { schemaVersion: 1 },
  ): Promise<BotDebugSnapshotV1> {
    return debugSnapshot(
      this.state,
      identity,
      () => readBotSettingsV1(this.state, identity),
      input,
    );
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(
      await this.state.authority.fenceRunAdmission(identity, query.runId),
    );
  }
  async archiveEligible(storage: {
    get<T>(key: string): Promise<T | undefined>;
  }): Promise<boolean> {
    return (await storage.get<string>(ACTIVE_RUN_KEY)) === undefined;
  }

  async assertLifecycleActive(botId: string): Promise<void> {
    return assertLifecycleActiveV1(this.state, botId);
  }

  /**
   * Linearizes one new external effect against durable Stop. The Agent has
   * already journaled intent; this transaction atomically persists the exact
   * admitted/fenced outcome used before the provider/tool invocation.
   *
   * Public because the `schedule` grant reaches the Bot's own tools through
   * `app/isolates/bot.ts`, which is handed this fence rather than the object.
   */
  async admitRunEffect(
    identity: BotIdentity,
    runId: string,
    sessionId: string,
    effect: AgentEffectAdmission,
  ): Promise<boolean> {
    return this.state.ctx.storage.transaction(async (transaction) => {
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
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

/**
 * What an application hands this Contribution: the conversation surface and the Bot's Composition, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface ShellBotApplicationHostV1 {
  shell: ShellBotBackendHost;
}

/**
 * The manifest's `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineBotBackendContribution<
  ShellBotApplicationHostV1,
  ShellBotBackendContribution
>({
  specifier: "@frockbot/app/shell/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createShellBotBackendContribution(host.shell)),
});
