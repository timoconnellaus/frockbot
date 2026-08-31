import {
  type BotCapabilitiesStub,
  type IsolateModelInvocationV1,
  type IsolatePendingDecisionV1,
  type NormalizedModelRequest,
  type PackageBundlerBinding,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  BotDurableAuthority,
  IDENTITY_KEY,
  type BotIdentity,
  type BotDurableAuthorityOptions,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "@frockbot/kernel-do";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/agent-runtime/runtime";
import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import {
  compileFoundationApplication,
  createFoundationModelRuntimePackage,
} from "@frockbot/application-foundation/runtime";
import {
  capabilityAssignmentFailureV1,
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeCompositionCommandReceiptV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionCommandReceiptV1,
  type CompositionGenerationListViewV1,
  type CompositionGenerationViewV1,
  type RevertCompositionCommandV1,
  type ConnectionDependencyRequirementV1,
  type BotExecutionPlanV1,
  type BotSettingsViewV1,
  type CapabilityAssignmentView,
  type ConnectionView,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  type ResolvedModelBindingV1,
  initializeBotSettingsV1,
  resolveBotExecutionPlanV1,
  resolveBotModelBindingV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { createFoundationAssignedRuntimePackages } from "@frockbot/application-foundation/runtime";
import { createFoundationHostedRuntimePackages } from "@frockbot/application-foundation/runtime";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import {
  settleAssignmentSaga,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";
import {
  bootstrapCompositionGeneration,
  createShellCompositionHost,
  type ShellIsolateMountOptions,
  type ShellMountedComposition,
} from "./backend-composition.js";
import {
  activateCompositionV1,
  type CompositionFailureV1,
  type CompositionMountHost,
  type CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import {
  createPackageAuthoringHost,
  createR2AuthoringArtifactStore,
} from "./backend-authoring.js";
import {
  decodeAuthoringQuotaReceiptV1,
  type AuthoringQuotaBinding,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createIsolateCapabilityHost,
  createR2PackageArtifactStore,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateAssignmentV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
  type IsolateModelRequestRecordV1,
  type IsolatePendingAuthorityDecisionV1,
} from "./backend-isolate.js";
import type { BotIsolateLoader } from "@frockbot/kernel-composition/isolate";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import { projectCompositionGenerationV1 } from "./composition-views.js";
import { executeBotTurn } from "./backend-runner.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  clientRunListWireBytes,
  createClientRunListV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunListQueryV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunListV1,
  type ClientRunV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import {
  storedRunCodecV1,
  type BotNotificationIntent,
  type BotTurnCompletion,
} from "./backend-contracts.js";

/** The Bot Durable Object key holding this Bot's durable configuration. */
export const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
const ASSIGNMENT_TOMBSTONE_PREFIX = "assignment-tombstone:";
const ASSIGNMENT_SAGA_PREFIX = "assignment-saga:";
const ASSIGNMENT_SAGA_DEADLINE_MS = 60_000;
/** Idempotency records for Composition commands this Package admits. */
const COMPOSITION_COMMAND_PREFIX = "composition-command:";

function assignmentGenerationKey(assignmentId: string): string {
  return `${ASSIGNMENT_GENERATION_PREFIX}${assignmentId}`;
}

function capabilityKey(packageId: string, capabilityId: string): string {
  return `${packageId}:${capabilityId}`;
}

interface StoredConfigurationReceipt {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

interface AssignmentActivity {
  commandFingerprint: string;
  promise: Promise<OperationReceiptV1>;
}

function requireMatchingConfigurationReceipt(
  stored: StoredConfigurationReceipt,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}

export type { BotIdentity, OwnedBotTurnCommand };

export interface BotStateEnv {
  MEMORY_FILES: R2Bucket;
  /**
   * The Bot Package Worker Loader (plan Step 4). Optional so a host without
   * Bot-authored Packages — tests, the Electron shell — still compiles; a
   * generation with an isolate member fails verification without it.
   */
  BOT_PACKAGES?: BotIsolateLoader;
  /** Immutable, content-addressed Package artifacts, read hash-verified. */
  APPLICATION_ARTIFACTS?: R2Bucket;
  /**
   * The Package bundler service (plan Step 3/D4). Optional so a host without
   * Bot authoring still compiles; `package_author` then refuses visibly.
   */
  PACKAGE_BUNDLER?: PackageBundlerBinding;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  SPRITES_TOKEN?: string;
  CREDENTIAL_KEYRING?: string;
}

/** Constructs the kernel Bot Durable Object authority this Package runs under. */
export type CreateBotDurableAuthority = <Snapshot>(
  options: BotDurableAuthorityOptions<Snapshot>,
) => BotDurableAuthority<Snapshot>;

export interface ShellBotBackendHost {
  state: DurableObjectState;
  env: BotStateEnv;
  compileApplication?: typeof compileFoundationApplication;
  outboundFetch?: typeof fetch;
  /** Supplied by the Durable Object; defaults to the kernel implementation. */
  createAuthority?: CreateBotDurableAuthority;
}

function parseStoredJson<T>(body: string): Promise<T> {
  try {
    return Promise.resolve(JSON.parse(body) as T);
  } catch (error) {
    return Promise.reject(error);
  }
}

function memoryPluginConfig(
  env: BotStateEnv,
  identity: BotIdentity,
): MemoryPluginConfig {
  return {
    ownerId: identity.userId,
    agentId: identity.botId,
    bucket: {
      get: async (key) => {
        const object = await env.MEMORY_FILES.get(key);
        if (!object) return null;
        const body = await object.text();
        return {
          text: () => Promise.resolve(body),
          json: <T>() => parseStoredJson<T>(body),
        };
      },
      put: (key, value, options) =>
        env.MEMORY_FILES.put(key, value, {
          httpMetadata: options?.httpMetadata?.contentType
            ? { contentType: options.httpMetadata.contentType }
            : undefined,
        }),
      delete: (key) => env.MEMORY_FILES.delete(key),
      list: async ({ prefix, cursor }) => {
        const page = await env.MEMORY_FILES.list({ prefix, cursor });
        return {
          objects: page.objects.map((object) => ({ key: object.key })),
          truncated: page.truncated,
          cursor: page.truncated ? page.cursor : undefined,
        };
      },
    },
    vectorize: {
      upsert: (vectors) => env.MEMORY_INDEX.upsert(vectors),
      query: async (vector, options) => {
        const result = await env.MEMORY_INDEX.query(vector, options);
        return {
          matches: result.matches.map((match) => ({
            id: match.id,
            score: match.score,
            metadata: match.metadata,
          })),
        };
      },
      deleteByIds: (ids) => env.MEMORY_INDEX.deleteByIds(ids),
    },
    ai: {
      run: (model, input) =>
        env.AI.run(model as keyof AiModels, {
          text: input.text,
        }) as Promise<{ data: number[][] }>,
    },
  };
}

export class ShellBotBackendContribution {
  readonly ctx: DurableObjectState;
  readonly env: BotStateEnv;
  private readonly compileApplication: typeof compileFoundationApplication;
  private readonly outboundFetch?: typeof fetch;
  private readonly assignmentActivities = new Map<string, AssignmentActivity>();
  /**
   * Admission, the event log, the cursor, idempotency, cancellation, and
   * durable scheduling are kernel authority; this Package supplies only the
   * configuration, Composition, and notification policy it needs.
   */
  private readonly authority: BotDurableAuthority<BotSettingsViewV1>;

  constructor(host: ShellBotBackendHost) {
    this.ctx = host.state;
    this.env = host.env;
    this.compileApplication =
      host.compileApplication ?? compileFoundationApplication;
    this.outboundFetch = host.outboundFetch;
    const createAuthority: CreateBotDurableAuthority =
      host.createAuthority ?? ((options) => new BotDurableAuthority(options));
    this.authority = createAuthority<BotSettingsViewV1>({
      state: host.state,
      codec: storedRunCodecV1,
      hooks: {
        resolveAdmissionSnapshot: (command) =>
          this.resolveAdmissionSnapshot(command),
        bootstrapComposition: () => this.bootstrapComposition(),
        admittedSnapshot: (transaction, resolved) =>
          this.admittedSnapshot(transaction, resolved),
        executeTurn: (input) => this.executeTurn(input),
        notification: (snapshot, result) =>
          this.createNotification(snapshot, result),
        scheduledDeadlines: (transaction) =>
          this.scheduledDeadlines(transaction),
        scheduledWorkInFlight: () => this.assignmentActivities.size > 0,
        deferScheduledWork: (transaction) =>
          this.deferScheduledWork(transaction),
        settleScheduledWork: () => this.settleScheduledWork(),
      },
    });
  }

  async materializeSettings(
    identity: BotIdentity,
    initial: {
      name: string;
      model?: BotSettingsViewV1["model"];
      modelBinding?: {
        assignment: BotSettingsViewV1["assignments"][number];
        generation: string;
      };
    },
  ): Promise<BotSettingsViewV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const existing = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (existing) return existing;
      const settings = {
        ...this.initialBotSettings(identity.botId, initial.model),
        profile: { name: initial.name },
        assignments: initial.modelBinding
          ? [structuredClone(initial.modelBinding.assignment)]
          : [],
      } satisfies BotSettingsViewV1;
      await transaction.put({
        [IDENTITY_KEY]: durableIdentity ?? identity,
        [BOT_CONFIGURATION_KEY]: settings,
        ...(initial.modelBinding
          ? {
              [assignmentGenerationKey(
                initial.modelBinding.assignment.assignmentId,
              )]: initial.modelBinding.generation,
            }
          : {}),
      });
      return settings;
    });
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return this.ensureBotSettings(identity);
  }

  async readConfiguration(input: unknown): Promise<BotSettingsViewV1> {
    const request = decodeBotConfigurationReadRpcV1(input);
    return this.getSettings({ userId: request.userId, botId: request.botId });
  }

  async executeConfiguration(input: unknown): Promise<OperationReceiptV1> {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    return this.executeConfigurationCommand(
      { userId: request.userId, botId: request.botId },
      request.command,
    );
  }

  private async executeConfigurationCommand(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
  ): Promise<OperationReceiptV1> {
    const commandFingerprint = configurationCommandFingerprintV1(command);
    const active = this.assignmentActivities.get(command.commandId);
    if (active) {
      if (active.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      return active.promise;
    }
    const activity: Promise<OperationReceiptV1> =
      this.executeConfigurationDurably(
        identity,
        command,
        commandFingerprint,
      ).finally(() => {
        if (
          this.assignmentActivities.get(command.commandId)?.promise === activity
        ) {
          this.assignmentActivities.delete(command.commandId);
        }
      });
    this.assignmentActivities.set(command.commandId, {
      commandFingerprint,
      promise: activity,
    });
    return activity;
  }

  private async executeConfigurationDurably(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model"
          | "bot/assign-capability"
          | "bot/unbind-model";
      }
    >,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    const settings = await this.ensureBotSettings(identity);
    const existing = await this.ctx.storage.get<StoredConfigurationReceipt>(
      `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`,
    );
    if (existing) {
      const receipt = requireMatchingConfigurationReceipt(
        existing,
        commandFingerprint,
        command.commandId,
      );
      if (receipt.status === "applied") {
        await this.reconcileStoredAssignmentSaga(
          identity,
          command.commandId,
          commandFingerprint,
        );
      }
      return receipt;
    }
    if (command.expectedRevision !== settings.revision) {
      throw new ConfigurationConflictError(settings.revision);
    }
    let dependencyRequirement: ConnectionDependencyRequirementV1 | undefined;
    let modelCapabilities = new Set<string>();
    if (command.type === "bot/select-model") {
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        this.compileApplication(),
      ]);
      modelCapabilities = new Set(
        application.packages.flatMap((pkg) =>
          (pkg.manifest.configuration?.capabilities ?? []).flatMap(
            (capability) =>
              capability.kind === "model"
                ? [capabilityKey(pkg.id, capability.id)]
                : [],
          ),
        ),
      );
      const binding = resolveBotModelBindingV1({
        model: command.model,
        assignments: settings.assignments,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      if (binding.state === "unavailable") {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          binding.failure ?? "Bot model binding is unavailable",
        );
      }
    }
    if (command.type === "bot/assign-capability") {
      const existingAssignment = settings.assignments.find(
        (assignment) =>
          assignment.assignmentId === command.assignment.assignmentId,
      );
      if (
        existingAssignment &&
        (existingAssignment.packageId !== command.assignment.packageId ||
          existingAssignment.capabilityId !== command.assignment.capabilityId)
      ) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Assignment ID cannot change Package Capability authority",
        );
      }
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        this.compileApplication(),
      ]);
      modelCapabilities = new Set(
        application.packages.flatMap((pkg) =>
          (pkg.manifest.configuration?.capabilities ?? []).flatMap(
            (capability) =>
              capability.kind === "model"
                ? [capabilityKey(pkg.id, capability.id)]
                : [],
          ),
        ),
      );
      const failure = capabilityAssignmentFailureV1({
        assignment: command.assignment,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      if (failure) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          failure,
        );
      }
      if (command.assignment.connectionId) {
        const installation = user.packages.find(
          (pkg) =>
            pkg.packageId === command.assignment.packageId &&
            pkg.state === "installed",
        );
        const pkg = application.packages.find(
          (candidate) =>
            candidate.id === command.assignment.packageId &&
            candidate.version === installation?.version,
        );
        const capability = pkg?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === command.assignment.capabilityId,
        );
        if (!installation || !pkg || !capability) {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            "Capability assignment policy changed during validation",
          );
        }
        dependencyRequirement = {
          schemaVersion: 1,
          packageId: pkg.id,
          packageVersion: pkg.version,
          capabilityId: capability.id,
          connectionTypeIds: [...capability.connectionTypes],
        };
      }
      if (command.model) {
        if (command.model.connectionId !== command.assignment.connectionId) {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            "Model binding must use the assigned Connection",
          );
        }
        const binding = resolveBotModelBindingV1({
          model: command.model,
          assignments: [
            ...settings.assignments,
            { ...command.assignment, state: "enabled" },
          ],
          user,
          packages: application.packages.map((pkg) => ({
            packageId: pkg.id,
            version: pkg.version,
            capabilities: pkg.manifest.configuration?.capabilities ?? [],
            connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
          })),
        });
        if (binding.state === "unavailable") {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            binding.failure ?? "Bot model binding is unavailable",
          );
        }
      }
    }
    if (
      command.type === "bot/select-model" &&
      settings.model?.connectionId &&
      settings.model.connectionId !== command.model.connectionId
    ) {
      const superseded = settings.assignments.find(
        (assignment) =>
          assignment.state === "enabled" &&
          assignment.connectionId === settings.model?.connectionId &&
          modelCapabilities.has(
            capabilityKey(assignment.packageId, assignment.capabilityId),
          ),
      );
      if (!superseded?.connectionId) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Superseded model assignment is unavailable",
        );
      }
      const generation = await this.ctx.storage.get<string>(
        assignmentGenerationKey(superseded.assignmentId),
      );
      if (!generation) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Superseded model assignment generation is unavailable",
        );
      }
      const saga: StoredAssignmentSaga = {
        schemaVersion: 1,
        commandId: command.commandId,
        commandFingerprint,
        userId: identity.userId,
        botId: identity.botId,
        assignmentId: superseded.assignmentId,
        connectionId: superseded.connectionId,
        generation,
        mode: "release",
        phase: "committed",
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      };
      const receipt = await this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
        saga,
      );
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
      return receipt;
    }
    if (command.type === "bot/unbind-model") {
      const assignment = settings.assignments.find(
        (candidate) =>
          candidate.assignmentId === command.assignmentId &&
          (candidate.state === "enabled" ||
            candidate.state === "unavailable") &&
          candidate.connectionId === settings.model?.connectionId,
      );
      const application = await this.compileApplication();
      const capability = application.packages
        .find((pkg) => pkg.id === assignment?.packageId)
        ?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === assignment?.capabilityId,
        );
      if (!assignment?.connectionId || capability?.kind !== "model") {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Bot model assignment is unavailable",
        );
      }
      const generation = await this.ctx.storage.get<string>(
        assignmentGenerationKey(assignment.assignmentId),
      );
      if (!generation) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Bot model assignment generation is unavailable",
        );
      }
      const saga: StoredAssignmentSaga = {
        schemaVersion: 1,
        commandId: command.commandId,
        commandFingerprint,
        userId: identity.userId,
        botId: identity.botId,
        assignmentId: assignment.assignmentId,
        connectionId: assignment.connectionId,
        generation,
        mode: "release",
        phase: "committed",
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      };
      const receipt = await this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
        saga,
      );
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
      return receipt;
    }
    if (
      command.type !== "bot/assign-capability" ||
      !command.assignment.connectionId ||
      !dependencyRequirement
    ) {
      return this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
      );
    }
    const connectionAssignment = {
      connectionId: command.assignment.connectionId,
      generation: command.commandId,
      requirement: dependencyRequirement,
    };
    const userConfiguration = this.userConfiguration(identity);

    await this.reconcileStoredAssignmentSaga(
      identity,
      command.commandId,
      commandFingerprint,
    );
    const admission = await this.ctx.storage.transaction(
      async (transaction) => {
        const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
        const existing =
          await transaction.get<StoredConfigurationReceipt>(receiptKey);
        if (existing) {
          return {
            receipt: requireMatchingConfigurationReceipt(
              existing,
              commandFingerprint,
              command.commandId,
            ),
          };
        }
        const current =
          (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
          this.initialBotSettings(identity.botId);
        if (command.expectedRevision !== current.revision) {
          throw new ConfigurationConflictError(current.revision);
        }
        if (
          await transaction.get(
            `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionAssignment.connectionId}:${connectionAssignment.generation}`,
          )
        ) {
          throw new Error("Connection assignment was revoked before admission");
        }
        let supersededAssignmentId: string | undefined;
        let supersededConnectionId: string | undefined;
        let supersededGeneration: string | undefined;
        const previousConnectionId = current.model?.connectionId;
        const superseded = current.assignments.find(
          (assignment) =>
            assignment.state === "enabled" &&
            command.model &&
            previousConnectionId &&
            previousConnectionId !== connectionAssignment.connectionId &&
            assignment.connectionId === previousConnectionId &&
            modelCapabilities.has(
              capabilityKey(assignment.packageId, assignment.capabilityId),
            ),
        );
        if (
          command.model &&
          previousConnectionId &&
          previousConnectionId !== connectionAssignment.connectionId &&
          !superseded
        ) {
          throw new Error("Superseded model assignment is unavailable");
        }
        if (superseded?.connectionId) {
          supersededGeneration = await transaction.get<string>(
            assignmentGenerationKey(superseded.assignmentId),
          );
          if (!supersededGeneration) {
            throw new Error(
              "Superseded model assignment generation is unavailable",
            );
          }
          supersededAssignmentId = superseded.assignmentId;
          supersededConnectionId = superseded.connectionId;
        }
        const saga: StoredAssignmentSaga = {
          schemaVersion: 1,
          commandId: command.commandId,
          commandFingerprint,
          userId: identity.userId,
          botId: identity.botId,
          assignmentId: command.assignment.assignmentId,
          connectionId: connectionAssignment.connectionId,
          generation: connectionAssignment.generation,
          ...(supersededAssignmentId &&
          supersededConnectionId &&
          supersededGeneration
            ? {
                supersededAssignmentId,
                supersededConnectionId,
                supersededGeneration,
              }
            : {}),
          phase: "claiming",
          deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
        };
        await transaction.put(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
          saga,
        );
        await this.refreshRecoveryAlarm(transaction);
        return { saga };
      },
    );
    if (admission.receipt) return admission.receipt;
    const saga = admission.saga;
    try {
      if (
        !(await userConfiguration.claimConnectionDependency(
          identity.userId,
          saga.connectionId,
          identity.botId,
          saga.generation,
          connectionAssignment.requirement,
        ))
      ) {
        return await this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Connection assignment is no longer authorized",
          saga,
        );
      }
      const receipt = await this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
        saga,
      );
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
      return receipt;
    } catch (error) {
      try {
        await this.reconcileStoredAssignmentSaga(
          identity,
          command.commandId,
          commandFingerprint,
        );
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          "Connection assignment admission and reconciliation failed",
        );
      }
      throw error;
    }
  }

  private async rejectConfigurationCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model"
          | "bot/assign-capability"
          | "bot/unbind-model";
      }
    >,
    commandFingerprint: string,
    failure: string,
    saga?: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing =
        await transaction.get<StoredConfigurationReceipt>(receiptKey);
      if (existing) {
        return requireMatchingConfigurationReceipt(
          existing,
          commandFingerprint,
          command.commandId,
        );
      }
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure,
      };
      await transaction.put(receiptKey, { commandFingerprint, receipt });
      if (saga) {
        await transaction.delete(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`);
        await this.refreshRecoveryAlarm(transaction);
      }
      return receipt;
    });
  }

  private async applyConfigurationCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model"
          | "bot/assign-capability"
          | "bot/unbind-model";
      }
    >,
    commandFingerprint: string,
    saga?: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing =
        await transaction.get<StoredConfigurationReceipt>(receiptKey);
      if (existing) {
        return requireMatchingConfigurationReceipt(
          existing,
          commandFingerprint,
          command.commandId,
        );
      }
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      if (
        saga &&
        saga.mode !== "release" &&
        (await transaction.get(
          `${ASSIGNMENT_TOMBSTONE_PREFIX}${saga.connectionId}:${saga.generation}`,
        ))
      ) {
        throw new Error("Connection assignment was revoked before admission");
      }
      const revision = current.revision + 1;
      const next: BotSettingsViewV1 =
        command.type === "bot/update-profile"
          ? { ...current, revision, profile: command.profile }
          : command.type === "bot/update-notifications"
            ? { ...current, revision, notifications: command.notifications }
            : command.type === "bot/select-model"
              ? {
                  ...current,
                  revision,
                  model: command.model,
                  ...(saga?.mode === "release"
                    ? {
                        assignments: current.assignments.filter(
                          (assignment) =>
                            assignment.assignmentId !== saga.assignmentId,
                        ),
                      }
                    : {}),
                }
              : command.type === "bot/unbind-model"
                ? {
                    ...current,
                    revision,
                    model: undefined,
                    assignments: current.assignments.filter(
                      (assignment) =>
                        assignment.assignmentId !== command.assignmentId,
                    ),
                  }
                : {
                    ...current,
                    revision,
                    ...(command.model ? { model: command.model } : {}),
                    assignments: [
                      ...current.assignments.filter(
                        (assignment) =>
                          assignment.assignmentId !==
                            command.assignment.assignmentId &&
                          assignment.assignmentId !==
                            saga?.supersededAssignmentId &&
                          (assignment.packageId !==
                            command.assignment.packageId ||
                            assignment.capabilityId !==
                              command.assignment.capabilityId),
                      ),
                      { ...command.assignment, state: "enabled" },
                    ],
                  };
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision,
        status: "applied",
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: next,
        [receiptKey]: { commandFingerprint, receipt },
      });
      const retainedAssignmentIds = new Set(
        next.assignments.map((assignment) => assignment.assignmentId),
      );
      for (const assignment of current.assignments) {
        if (!retainedAssignmentIds.has(assignment.assignmentId)) {
          await transaction.delete(
            assignmentGenerationKey(assignment.assignmentId),
          );
        }
      }
      if (
        command.type === "bot/assign-capability" &&
        command.assignment.connectionId
      ) {
        await transaction.put(
          assignmentGenerationKey(command.assignment.assignmentId),
          command.commandId,
        );
      }
      if (saga) {
        await transaction.put(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`, {
          ...saga,
          phase: "committed",
          deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          receipt,
        } satisfies StoredAssignmentSaga);
        await this.refreshRecoveryAlarm(transaction);
      }
      return receipt;
    });
  }

  private async reconcileStoredAssignmentSaga(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint?: string,
  ): Promise<void> {
    const key = `${ASSIGNMENT_SAGA_PREFIX}${commandId}`;
    const saga = await this.ctx.storage.get<StoredAssignmentSaga>(key);
    if (!saga) return;
    if (saga.userId !== identity.userId || saga.botId !== identity.botId) {
      throw new Error("Assignment saga does not match its durable identity");
    }
    if (
      new Set([
        Boolean(saga.supersededAssignmentId),
        Boolean(saga.supersededConnectionId),
        Boolean(saga.supersededGeneration),
      ]).size !== 1
    ) {
      throw new Error("Assignment saga superseded dependency is invalid");
    }
    if (
      commandFingerprint !== undefined &&
      saga.commandFingerprint !== commandFingerprint
    ) {
      throw new Error(
        `Configuration command idempotency key "${commandId}" was reused for a different command`,
      );
    }
    const userConfiguration = this.userConfiguration(identity);
    let releasedSuperseded = false;
    try {
      if (saga.mode === "release") {
        if (
          !(await userConfiguration.releaseConnectionDependency(
            saga.userId,
            saga.connectionId,
            saga.botId,
            saga.generation,
          ))
        ) {
          throw new Error(
            "Acknowledged Connection dependency was not released",
          );
        }
      } else {
        const settlement = await settleAssignmentSaga(saga, {
          acknowledge: (stored) =>
            userConfiguration.acknowledgeConnectionDependency(
              stored.userId,
              stored.connectionId,
              stored.botId,
              stored.generation,
            ),
          compensate: async (stored) => {
            await userConfiguration.compensateConnectionDependency(
              stored.userId,
              stored.connectionId,
              stored.botId,
              stored.generation,
            );
          },
          release: (stored) =>
            userConfiguration.releaseConnectionDependency(
              stored.userId,
              stored.connectionId,
              stored.botId,
              stored.generation,
            ),
          rejectCommitted: async (stored) => {
            await this.markConnectionUnavailable(
              { userId: stored.userId, botId: stored.botId },
              stored.connectionId,
              {
                id: `assignment-rejected:${stored.generation}`,
                expectedGeneration: stored.generation,
              },
            );
          },
        });
        if (
          settlement !== "compensated" &&
          saga.supersededAssignmentId &&
          saga.supersededConnectionId &&
          saga.supersededGeneration
        ) {
          if (
            !(await userConfiguration.releaseConnectionDependency(
              saga.userId,
              saga.supersededConnectionId,
              saga.botId,
              saga.supersededGeneration,
            ))
          ) {
            throw new Error(
              "Superseded Connection dependency was not released",
            );
          }
          releasedSuperseded = true;
        }
      }
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAssignmentSaga>(key);
        if (
          current?.generation === saga.generation &&
          current.phase === saga.phase
        ) {
          await transaction.delete(key);
          if (
            saga.mode === "release" &&
            (await transaction.get(
              assignmentGenerationKey(saga.assignmentId),
            )) === saga.generation
          ) {
            await transaction.delete(
              assignmentGenerationKey(saga.assignmentId),
            );
          }
          if (
            releasedSuperseded &&
            saga.supersededAssignmentId &&
            saga.supersededGeneration &&
            (await transaction.get(
              assignmentGenerationKey(saga.supersededAssignmentId),
            )) === saga.supersededGeneration
          ) {
            await transaction.delete(
              assignmentGenerationKey(saga.supersededAssignmentId),
            );
          }
        }
        await this.refreshRecoveryAlarm(transaction);
      });
    } catch (error) {
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAssignmentSaga>(key);
        if (current?.generation === saga.generation) {
          await transaction.put(key, {
            ...current,
            deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          } satisfies StoredAssignmentSaga);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
      throw error;
    }
  }

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.authority.refreshRecoveryAlarm(transaction);
  }
  async markConnectionUnavailable(
    identity: BotIdentity,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale"> {
    await this.ensureBotSettings(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${ASSIGNMENT_COMPENSATION_PREFIX}${compensation.id}`;
      const existing = await transaction.get<"applied" | "stale">(receiptKey);
      if (existing) return existing;
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      const enabled = current.assignments.filter(
        (assignment) =>
          assignment.connectionId === connectionId &&
          assignment.state === "enabled",
      );
      await transaction.put(
        `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionId}:${compensation.expectedGeneration}`,
        compensation.id,
      );
      let generationMatches = false;
      for (const assignment of enabled) {
        if (
          (await transaction.get<string>(
            assignmentGenerationKey(assignment.assignmentId),
          )) === compensation.expectedGeneration
        ) {
          generationMatches = true;
          break;
        }
      }
      if (enabled.length > 0 && !generationMatches) {
        await transaction.put(receiptKey, "stale");
        return "stale";
      }
      if (enabled.length > 0) {
        await transaction.put(BOT_CONFIGURATION_KEY, {
          ...current,
          revision: current.revision + 1,
          assignments: current.assignments.map((assignment) =>
            assignment.connectionId === connectionId
              ? { ...assignment, state: "unavailable" }
              : assignment,
          ),
        } satisfies BotSettingsViewV1);
      }
      await transaction.put(receiptKey, "applied");
      return "applied";
    });
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    return projectClientTurnV1(await this.authority.run(command));
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<ClientTurnV1> {
    return projectClientTurnV1(
      await this.authority.reconcileRun(identity, runId),
    );
  }
  private async executeTurn(
    input: BotTurnExecutionInput<BotSettingsViewV1>,
  ): Promise<BotTurnCompletion> {
    const settings = input.configurationSnapshot;
    const turn = {
      runId: input.command.runId,
      // One admitted Turn is one run; the Turn ordinal lives in the session log.
      turnId: input.command.runId,
      sessionId: input.command.sessionId,
    };
    const runtime = await this.agentRuntime(
      input.identity,
      settings,
      input.admittedRequest,
      turn,
    );
    const promptParts = [
      `You are ${settings.profile.name}.`,
      settings.profile.label,
      settings.profile.description,
    ].filter((part): part is string => Boolean(part?.trim()));
    // The pin, never the current generation: activation takes effect at the
    // next admitted Turn, and an in-flight Turn completes on what it pinned.
    // The isolate bindings follow the generation actually being mounted, so a
    // fail-closed fallback loads the last known good's members, not the
    // pinned generation's.
    const host: CompositionMountHost<ShellMountedComposition> = {
      mount: async (mounting, signal) => {
        const isolate = await this.isolateMountOptions(input.identity, {
          runId: input.command.runId,
          sessionId: input.command.sessionId,
          generationId: mounting.generationId,
          assignments: settings.assignments,
        });
        return createShellCompositionHost({
          botId: input.identity.botId,
          sessionId: input.command.sessionId,
          sessionEvents: input.previousEvents,
          memory: memoryPluginConfig(this.env, input.identity),
          persistSessionEvents: input.persistSessionEvents,
          agentPackages: runtime.agentPackages,
          modelSelection: runtime.modelSelection,
          systemPromptSection: promptParts.join("\n\n"),
          ...(isolate ? { isolate } : {}),
        }).mount(mounting, signal);
      },
    };
    const controller = new AbortController();
    // Composition fails closed: a generation that does not resolve, mount, or
    // pass `health()` leaves the last known good resident, records a durable
    // failure, raises a visible one, and the Turn is admitted anyway.
    const activation = await activateCompositionV1({
      generationId: input.compositionGenerationId,
      store: {
        read: (generationId) => this.authority.composition.read(generationId),
        lastKnownGood: () => this.authority.composition.lastKnownGood(),
        commit: (generationId) =>
          this.authority.composition.commit(generationId),
        fail: (generationId, options) =>
          this.authority.composition.fail(generationId, options),
      },
      failures: this.authority.compositionFailures,
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
      await this.authority.repinRun(
        input.command.runId,
        activation.fallback.generationId,
      );
    }
    return executeBotTurn({
      command: input.command,
      previousEvents: input.previousEvents,
      composition: activation.mounted,
      resume: input.resume,
    });
  }

  /** The visible half of failing closed, on the Bot's existing channel. */
  private async recordCompositionFailureNotification(
    settings: BotSettingsViewV1,
    runId: string,
    failure: CompositionFailureV1,
    fallback: CompositionGenerationV1,
  ): Promise<void> {
    await this.authority.recordNotification({
      notificationId: `composition-failure:${failure.generationId}:${failure.attempt}`,
      runId,
      createdAt: failure.at,
      title: `${settings.profile.name} kept its last working Packages`,
      body: `Composition generation "${failure.generationId}" failed to activate at ${failure.phase} (attempt ${failure.attempt}); running "${fallback.generationId}" instead: ${failure.message}`.slice(
        0,
        240,
      ),
    });
  }

  /**
   * Everything a Bot isolate member needs. Returns `undefined` when this host
   * has no Package loader, in which case an isolate member fails verification
   * rather than silently running nowhere.
   */
  private async isolateMountOptions(
    identity: BotIdentity,
    turn: {
      runId: string;
      sessionId: string;
      generationId: string;
      assignments: readonly CapabilityAssignmentView[];
    },
  ): Promise<ShellIsolateMountOptions | undefined> {
    const loader = this.env.BOT_PACKAGES;
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    const exports = (
      this.ctx as unknown as {
        exports?: {
          BotCapabilities?: (options: {
            props: BotCapabilitiesPropsV1;
          }) => BotCapabilitiesStub;
        };
      }
    ).exports;
    if (!loader || !artifacts || !exports?.BotCapabilities) return undefined;
    const mintCapabilities = exports.BotCapabilities;
    const assignments = await this.isolateAssignments(turn.assignments);
    return {
      userId: identity.userId,
      runId: turn.runId,
      // One admitted Turn is one run; the Turn ordinal lives in the session log.
      turnId: turn.runId,
      loader,
      artifacts: createR2PackageArtifactStore(artifacts),
      capabilitiesFor: (member) =>
        mintCapabilities({
          props: {
            userId: identity.userId,
            botId: identity.botId,
            generationId: turn.generationId,
            packageId: member.packageId,
            assignments: structuredClone(assignments),
          },
        }),
      bindingDigest: await isolateBindingDigestV1(
        assignments,
        turn.generationId,
      ),
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    };
  }

  /**
   * The Bot Durable Object side of `CAPABILITIES.requestAuthority`. Never a
   * grant: it records a durable pending decision for the User.
   */
  async isolateRequestAuthority(input: {
    botId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolatePendingDecisionV1> {
    return await this.isolateCapabilities(input, []).requestAuthority(
      input.request,
    );
  }

  /**
   * The Bot Durable Object side of `CAPABILITIES.invokeModel`. Refuses with a
   * pending decision unless an enabled model Assignment matches; otherwise
   * records the normalized request and streams through the provider path,
   * which takes the credential lease on the way.
   */
  async isolateInvokeModel(
    identity: BotIdentity,
    input: {
      packageId: string;
      generationId: string;
      request: NormalizedModelRequest;
    },
  ): Promise<IsolateModelInvocationV1> {
    // The Bot Durable Object's own durable configuration is what decides
    // whether the Assignment exists at all, and its durable model binding is
    // what the Assignment authorizes. Nothing the Bot supplied is read.
    const settings = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    const projected = await this.isolateAssignments(
      settings?.assignments ?? [],
    );
    const bound = await this.isolateModelBinding(identity, settings, projected);
    const assignments = bound
      ? projected.map((assignment) =>
          assignment.assignmentId === bound.binding.assignmentId
            ? {
                ...assignment,
                connectionId: bound.binding.connectionId,
                providerModelId: bound.binding.providerModelId,
              }
            : assignment,
        )
      : projected;
    const host = this.isolateCapabilities(
      {
        botId: identity.botId,
        packageId: input.packageId,
        generationId: input.generationId,
      },
      assignments,
      bound
        ? {
            binding: bound.binding,
            path: this.isolateModelPath(
              identity,
              bound.runtime,
              input.generationId,
            ),
          }
        : undefined,
    );
    return await host.invokeModel(input.request);
  }

  /**
   * The Bot's one durable model binding, projected onto the isolate view. It
   * resolves the Bot's durable `model` through the User's Connection exactly
   * as an admitted Turn does, so an isolate model request is authorized
   * against the same Package, Connection, and provider model a Turn would use.
   * An unresolvable binding is no binding: the request becomes a pending
   * decision rather than an error thrown into Bot code.
   */
  private async isolateModelBinding(
    identity: BotIdentity,
    settings: BotSettingsViewV1 | undefined,
    assignments: readonly IsolateAssignmentV1[],
  ): Promise<
    | {
        binding: IsolateModelBindingV1;
        runtime: {
          agentPackages: FoundationAgentPackage[];
          modelSelection: RuntimeModelSelection;
        };
      }
    | undefined
  > {
    if (!settings?.model) return undefined;
    let runtime: {
      agentPackages: FoundationAgentPackage[];
      modelSelection: RuntimeModelSelection;
    };
    try {
      runtime = await this.agentRuntime(identity, settings);
    } catch {
      return undefined;
    }
    const selection = runtime.modelSelection;
    const connectionId = selection.connectionId;
    if (!connectionId) return undefined;
    const assignment = assignments.find(
      (candidate) =>
        candidate.kind === "model" && candidate.connectionId === connectionId,
    );
    if (!assignment) return undefined;
    return {
      runtime,
      binding: {
        assignmentId: assignment.assignmentId,
        packageId: assignment.packageId,
        capabilityId: assignment.capabilityId,
        connectionId,
        provider: selection.provider,
        providerModelId: selection.model,
        ...(selection.connectionGeneration
          ? { connectionGeneration: selection.connectionGeneration }
          : {}),
        ...(selection.catalogGeneration
          ? { catalogGeneration: selection.catalogGeneration }
          : {}),
      },
    };
  }

  private isolateCapabilities(
    scope: {
      botId: string;
      packageId: string;
      generationId: string;
      request?: unknown;
    },
    assignments: readonly IsolateAssignmentV1[],
    model?: { binding: IsolateModelBindingV1; path: IsolateModelPath },
  ): IsolateCapabilityHost {
    return createIsolateCapabilityHost({
      storage: {
        put: (key, value) => this.ctx.storage.put(key, value),
        get: (key) => this.ctx.storage.get(key),
        list: (options) => this.ctx.storage.list(options),
      },
      botId: scope.botId,
      packageId: scope.packageId,
      generationId: scope.generationId,
      assignments,
      ...(model ? { modelBinding: model.binding, modelPath: model.path } : {}),
    });
  }

  /** The Bot's enabled Assignments, projected onto the isolate capability DTO. */
  private async isolateAssignments(
    assignments: readonly CapabilityAssignmentView[],
  ): Promise<IsolateAssignmentV1[]> {
    const application = await this.compileApplication();
    const projected: IsolateAssignmentV1[] = [];
    for (const assignment of assignments) {
      if (assignment.state !== "enabled") continue;
      const capability = application.packages
        .find((candidate) => candidate.id === assignment.packageId)
        ?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === assignment.capabilityId,
        );
      if (!capability) continue;
      projected.push({
        assignmentId: assignment.assignmentId,
        packageId: assignment.packageId,
        capabilityId: assignment.capabilityId,
        kind: capability.kind,
        ...(assignment.connectionId
          ? { connectionId: assignment.connectionId }
          : {}),
      });
    }
    return projected;
  }

  /**
   * Streams through the pinned Composition's mounted `ctx.llm` — the same
   * provider path a Turn uses, so whichever provider Plugin serves the request
   * is the one that takes the credential lease. The runtime is the one the
   * durable model binding resolved to, so the Package that streams is the
   * Package the Assignment names.
   */
  private isolateModelPath(
    identity: BotIdentity,
    runtime: {
      agentPackages: FoundationAgentPackage[];
      modelSelection: RuntimeModelSelection;
    },
    generationId: string,
  ): IsolateModelPath {
    const contribution = this;
    return {
      async *stream(request, signal) {
        const generation =
          await contribution.authority.composition.read(generationId);
        if (!generation) {
          throw new Error(
            `isolate model invocation pins unknown Composition generation "${generationId}"`,
          );
        }
        const composition = await createShellCompositionHost({
          botId: identity.botId,
          sessionId: `isolate-model:${request.requestId}`,
          sessionEvents: [],
          agentPackages: runtime.agentPackages,
          modelSelection: runtime.modelSelection,
        }).mount(generation, signal);
        try {
          yield* composition.root.llm.stream(request, signal);
        } finally {
          await composition.dispose();
        }
      },
    };
  }

  /** The first-party generation this Bot starts on, from the compiled application. */
  private async bootstrapComposition() {
    return bootstrapCompositionGeneration(
      await this.compileApplication(),
      new Date().toISOString(),
    );
  }

  private async resolveAdmissionSnapshot(
    command: OwnedBotTurnCommand,
  ): Promise<BotSettingsViewV1> {
    const context = await this.resolveExecutionContext(command);
    return {
      ...context.settings,
      assignments: context.plan.assignments,
    } satisfies BotSettingsViewV1;
  }

  private async admittedSnapshot(
    transaction: DurableObjectTransaction,
    resolved: BotSettingsViewV1,
  ): Promise<BotSettingsViewV1> {
    return (
      (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
      resolved
    );
  }

  private async scheduledDeadlines(
    transaction: DurableObjectTransaction,
  ): Promise<number[]> {
    const sagas = await transaction.list<StoredAssignmentSaga>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    return [...sagas.values()].map((saga) => saga.deadlineAt);
  }

  private async deferScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const sagas = await transaction.list<StoredAssignmentSaga>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const [key, saga] of sagas) {
      await transaction.put(key, {
        ...saga,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      } satisfies StoredAssignmentSaga);
    }
  }

  private async settleScheduledWork(): Promise<void> {
    const sagas = await this.ctx.storage.list<StoredAssignmentSaga>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const saga of sagas.values()) {
      try {
        await this.reconcileStoredAssignmentSaga(
          { userId: saga.userId, botId: saga.botId },
          saga.commandId,
        );
      } catch (error) {
        console.error(
          "Assignment saga remains durably scheduled after reconciliation failure",
          error instanceof Error ? error.message : "unknown failure",
        );
      }
    }
  }
  /**
   * The narrow User Durable Object RPC the Bot uses to reserve one authored
   * generation against the durable per-User quota (D7).
   */
  private authoringQuota(identity: BotIdentity): AuthoringQuotaBinding {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker
    // types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveAuthoringQuota(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request) =>
        decodeAuthoringQuotaReceiptV1(await rpc.reserveAuthoringQuota(request)),
    };
  }

  /** The authoring seam one admitted Turn runs under. */
  private authoringHost(
    identity: BotIdentity,
    turn: { runId: string; turnId: string },
  ): PackageAuthoringHost {
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    return createPackageAuthoringHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
      },
      composition: this.authority.composition,
      ...(this.env.PACKAGE_BUNDLER
        ? { bundler: this.env.PACKAGE_BUNDLER }
        : {}),
      ...(artifacts
        ? { artifacts: createR2AuthoringArtifactStore(artifacts) }
        : {}),
      quota: this.authoringQuota(identity),
      userId: identity.userId,
      botId: identity.botId,
      runId: turn.runId,
      turnId: turn.turnId,
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    });
  }

  private async agentRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    admittedRequest?: NormalizedModelRequest,
    turn?: { runId: string; turnId: string; sessionId: string },
  ): Promise<{
    agentPackages: FoundationAgentPackage[];
    modelSelection: RuntimeModelSelection;
  }> {
    const userConfiguration = this.userConfiguration(identity);
    const user = await userConfiguration.readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const packageDefinitions = application.packages.map((pkg) => ({
      packageId: pkg.id,
      version: pkg.version,
      capabilities: pkg.manifest.configuration?.capabilities ?? [],
      connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
    }));
    const plan = admittedRequest
      ? {
          schemaVersion: 1 as const,
          botId: settings.botId,
          revision: settings.revision,
          model: settings.model ? structuredClone(settings.model) : undefined,
          assignments: structuredClone(settings.assignments),
        }
      : resolveBotExecutionPlanV1({
          bot: settings,
          user,
          packages: packageDefinitions,
        });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    };
    const authorizeAssignedConnection = admittedRequest
      ? (assignment: BotSettingsViewV1["assignments"][number]) =>
          this.authorizeAdmittedAssignedEffect(identity, assignment)
      : (assignment: BotSettingsViewV1["assignments"][number]) =>
          this.authorizeAssignedEffect(identity, assignment);
    const agentPackages: FoundationAgentPackage[] = [
      ...createFoundationHostedRuntimePackages(application, {
        userId: identity.userId,
        readSecret,
        // A Bot authors a Package only inside an admitted Turn, whose run and
        // session the artifact provenance names.
        ...(turn ? { authoring: this.authoringHost(identity, turn) } : {}),
      }),
      ...(await createFoundationAssignedRuntimePackages(
        application,
        settings,
        plan,
        {
          userId: identity.userId,
          readSecret,
          authorizeConnection: authorizeAssignedConnection,
        },
      )),
    ];
    if (!settings.model) {
      throw new Error("Bot model Connection is not configured");
    }

    let binding: ResolvedModelBindingV1;
    if (admittedRequest) {
      const admittedBinding = admittedRequest.modelBinding;
      const assignment = settings.assignments.find(
        (candidate) =>
          candidate.connectionId === admittedBinding?.connectionId &&
          candidate.state === "enabled",
      );
      const pkg = application.packages.find(
        (candidate) => candidate.id === assignment?.packageId,
      );
      const capability = pkg?.manifest.configuration?.capabilities.find(
        (candidate) => candidate.id === assignment?.capabilityId,
      );
      const connectionTypeId = capability?.connectionTypes[0];
      if (
        !admittedBinding?.connectionGeneration ||
        !assignment?.connectionId ||
        !pkg ||
        !connectionTypeId ||
        settings.model.connectionId !== admittedBinding.connectionId ||
        settings.model.providerModelId !== admittedRequest.model
      ) {
        throw new Error("Admitted model binding is unavailable");
      }
      binding = {
        state: "ready",
        assignment: structuredClone(settings.model),
        packageId: pkg.id,
        providerType: admittedRequest.provider,
        connection: {
          connectionId: admittedBinding.connectionId,
          packageId: pkg.id,
          connectionTypeId,
          displayName: "Admitted model Connection",
          state: "ready",
          providerType: admittedRequest.provider,
          generation: admittedBinding.connectionGeneration,
          safeMetadata: {},
        },
      };
    } else {
      binding = resolveBotModelBindingV1({
        model: settings.model,
        assignments: settings.assignments,
        user,
        packages: packageDefinitions,
      });
    }
    if (
      binding.state === "unavailable" ||
      !binding.connection ||
      !binding.providerType ||
      !binding.packageId
    ) {
      throw new Error(binding.failure ?? "Bot model Connection is unavailable");
    }
    const bindingPackageId = binding.packageId;
    agentPackages.push(
      createFoundationModelRuntimePackage(application, binding, {
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
            settings.model!.providerModelId,
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
        fetch: this.outboundFetch,
      }),
    );
    return {
      agentPackages,
      modelSelection: {
        provider: binding.providerType,
        model: settings.model.providerModelId,
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

  private async authorizeAdmittedAssignedEffect(
    identity: BotIdentity,
    assignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === assignment.connectionId &&
        candidate.packageId === assignment.packageId &&
        candidate.state === "ready",
    );
    const pkg = application.packages.find(
      (candidate) => candidate.id === assignment.packageId,
    );
    const capability = pkg?.manifest.configuration?.capabilities.find(
      (candidate) =>
        candidate.id === assignment.capabilityId &&
        connection !== undefined &&
        candidate.connectionTypes.includes(connection.connectionTypeId),
    );
    if (assignment.state !== "enabled" || !connection || !capability) {
      throw new Error("Admitted assigned effect is unavailable");
    }
    return structuredClone(connection);
  }

  private async authorizeAssignedEffect(
    identity: BotIdentity,
    admittedAssignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const admittedBot = {
      ...this.initialBotSettings(identity.botId),
      assignments: [admittedAssignment],
    } satisfies BotSettingsViewV1;
    const plan = resolveBotExecutionPlanV1({
      bot: admittedBot,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const assignment = plan.assignments.find(
      (candidate) =>
        candidate.assignmentId === admittedAssignment.assignmentId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.capabilityId === admittedAssignment.capabilityId &&
        candidate.connectionId === admittedAssignment.connectionId &&
        candidate.state === "enabled",
    );
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === assignment?.connectionId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.state === "ready",
    );
    if (!connection) throw new Error("Assigned effect is no longer authorized");
    return connection;
  }

  async readDurableIdentity(): Promise<BotIdentity | undefined> {
    return this.authority.readDurableIdentity();
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return this.authority.validateIdentity(identity);
  }

  async listNotifications(): Promise<BotNotificationIntent[]> {
    return this.authority.listNotifications();
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    return this.authority.acknowledgeNotification(notificationId);
  }
  /**
   * The Bot's durable Composition generations, newest first. Bot-scoped: the
   * caller proves directory membership before this runs.
   */
  async listCompositionGenerations(
    identity: BotIdentity,
    query: { limit: number; cursor?: string },
  ): Promise<CompositionGenerationListViewV1> {
    const current = await this.authority.composition.current();
    const page = await this.authority.composition.list({
      limit: Math.min(query.limit, MAX_COMPOSITION_GENERATION_PAGE_V1),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return {
      schemaVersion: 1,
      botId: identity.botId,
      currentGenerationId: current.generationId,
      generations: await Promise.all(
        page.generations.map(async (generation) =>
          projectCompositionGenerationV1({
            botId: identity.botId,
            generation,
            currentGenerationId: current.generationId,
            failures: await this.authority.compositionFailures.list(
              generation.generationId,
            ),
            ...(await this.compositionQuarantineView(generation.generationId)),
          }),
        ),
      ),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  /** One generation, with the recorded source of each isolate member. */
  async getCompositionGeneration(
    identity: BotIdentity,
    generationId: string,
  ): Promise<CompositionGenerationViewV1 | undefined> {
    const generation = await this.authority.composition.read(generationId);
    if (!generation) return undefined;
    const current = await this.authority.composition.current();
    return projectCompositionGenerationV1({
      botId: identity.botId,
      generation,
      currentGenerationId: current.generationId,
      readMemberSource: (member) => this.readCompositionMemberSource(member),
      failures: await this.authority.compositionFailures.list(generationId),
      ...(await this.compositionQuarantineView(generationId)),
    });
  }

  /** Spread into a projection: absent unless the generation is quarantined. */
  private async compositionQuarantineView(
    generationId: string,
  ): Promise<{ quarantine?: CompositionQuarantineV1 }> {
    const quarantine =
      await this.authority.compositionFailures.quarantine(generationId);
    return quarantine === undefined ? {} : { quarantine };
  }

  /**
   * SEAM — plan Step 5 (authoring) owns `authorship:intent:<effectId>` and
   * `artifact:<contentHash>`. Those records do not exist yet, so an isolate
   * member has no recorded source to show and the view carries members only.
   */
  private readCompositionMemberSource(
    _member: CompositionMemberV1,
  ): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  /**
   * Reverting is a recorded generation, not a mutation: it proposes a new
   * pending generation carrying the target's members, which the next admitted
   * Turn activates. The command is idempotent on its `commandId`, and its
   * `expectedGenerationId` is the optimistic check that the User acted on the
   * Composition they were looking at.
   */
  async revertComposition(
    identity: BotIdentity,
    command: RevertCompositionCommandV1,
  ): Promise<CompositionCommandReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new Error("Composition revert command does not match its Bot");
    }
    const receiptKey = `${COMPOSITION_COMMAND_PREFIX}${command.commandId}`;
    const recorded =
      await this.ctx.storage.get<CompositionCommandReceiptV1>(receiptKey);
    if (recorded) return decodeCompositionCommandReceiptV1(recorded);
    const current = await this.authority.composition.current();
    const reject = async (
      failure: string,
    ): Promise<CompositionCommandReceiptV1> => {
      const receipt = decodeCompositionCommandReceiptV1({
        schemaVersion: 1,
        commandId: command.commandId,
        status: "rejected",
        failure,
        currentGenerationId: current.generationId,
      });
      await this.ctx.storage.put(receiptKey, receipt);
      return receipt;
    };
    if (current.generationId !== command.expectedGenerationId) {
      return reject(`composition generation is ${current.generationId}`);
    }
    let generationId: string;
    try {
      const reverted = await this.authority.composition.revert(
        command.toGenerationId,
        {
          kind: "revert",
          revertsTo: command.toGenerationId,
          userId: identity.userId,
        },
      );
      generationId = reverted.generationId;
    } catch (error) {
      return reject(
        error instanceof Error ? error.message : "Composition revert failed",
      );
    }
    const receipt = decodeCompositionCommandReceiptV1({
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      generationId,
      currentGenerationId: current.generationId,
    });
    await this.ctx.storage.put(receiptKey, receipt);
    return receipt;
  }

  private createNotification(
    settings: BotSettingsViewV1,
    result: BotTurnCompletion,
  ): BotNotificationIntent | undefined {
    if (!settings.notifications.enabled) return undefined;
    return {
      notificationId: result.runId,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} replied`,
      body: result.text.slice(0, 240),
    };
  }

  async alarm(): Promise<void> {
    await this.authority.alarm();
  }
  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    const query = decodeClientRunListQueryV1(input);
    await this.authority.recoverActiveRun();
    const activeRunId = query.before
      ? undefined
      : await this.authority.readActiveRunId();
    const candidates = await this.authority.listRunIndex({
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
      ...(query.before ? { before: query.before } : {}),
    });

    const selected = new Map<string, { cursor?: string; run: ClientRunV1 }>();
    if (activeRunId) {
      const active = await this.authority.readStoredRun(activeRunId);
      if (active)
        selected.set(active.runId, { run: projectClientRunV1(active) });
    }
    const available = candidates.slice(0, CLIENT_RUN_PAGE_LIMIT);
    let stoppedEarly = false;
    for (const candidate of available) {
      if (selected.has(candidate.runId)) {
        const current = selected.get(candidate.runId)!;
        selected.set(candidate.runId, { ...current, cursor: candidate.cursor });
        continue;
      }
      const stored = await this.authority.readStoredRun(candidate.runId);
      if (!stored) continue;
      const projected = projectClientRunV1(stored);
      const tentative = [
        ...selected.values(),
        { cursor: candidate.cursor, run: projected },
      ];
      const ordered = tentative
        .map((entry) => entry.run)
        .sort(
          (left, right) =>
            left.admittedAt.localeCompare(right.admittedAt) ||
            left.runId.localeCompare(right.runId),
        );
      const tentativePage = createClientRunListV1(ordered, {
        truncated: true,
        nextCursor: candidate.cursor,
      });
      const isNewestTerminal =
        ![...selected.values()].some(
          (entry) =>
            entry.run.status === "completed" || entry.run.status === "failed",
        ) &&
        (projected.status === "completed" || projected.status === "failed");
      if (
        selected.size >= CLIENT_RUN_PAGE_LIMIT ||
        (!isNewestTerminal &&
          clientRunListWireBytes(tentativePage) > CLIENT_RUN_LIST_MAX_BYTES)
      ) {
        stoppedEarly = true;
        break;
      }
      selected.set(stored.runId, { cursor: candidate.cursor, run: projected });
    }
    const orderedEntries = [...selected.values()].sort(
      (left, right) =>
        left.run.admittedAt.localeCompare(right.run.admittedAt) ||
        left.run.runId.localeCompare(right.run.runId),
    );
    const oldestCursor = orderedEntries.find((entry) => entry.cursor)?.cursor;
    const truncated = stoppedEarly || candidates.length > CLIENT_RUN_PAGE_LIMIT;
    const page = createClientRunListV1(
      orderedEntries.map((entry) => entry.run),
      truncated && oldestCursor
        ? { truncated: true, nextCursor: oldestCursor }
        : { truncated: false },
    );
    if (clientRunListWireBytes(page) > CLIENT_RUN_LIST_MAX_BYTES) {
      throw new Error("required run projections exceed the wire byte limit");
    }
    return page;
  }
  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(await this.authority.readRun(query.runId));
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(
      await this.authority.fenceRunAdmission(identity, query.runId),
    );
  }
  private initialBotSettings(
    botId: string,
    model?: BotSettingsViewV1["model"],
  ): BotSettingsViewV1 {
    return initializeBotSettingsV1(botId, model);
  }

  private userConfiguration(identity: BotIdentity): {
    readConfiguration(input: {
      schemaVersion: 1;
      userId: string;
    }): Promise<UserSettingsViewV1>;
    getConnection(
      userId: string,
      connectionId: string,
    ): Promise<ConnectionView | undefined>;
    claimConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
      requirement: ConnectionDependencyRequirementV1,
    ): Promise<boolean>;
    acknowledgeConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    releaseConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    compensateConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    leaseModelCredential(
      userId: string,
      connectionId: string,
      providerModelId: string,
      effectId: string,
      connectionGeneration: string,
    ): Promise<CredentialLeaseV1>;
    settleModelCredential(
      userId: string,
      connectionId: string,
      packageId: string,
      effectId: string,
    ): Promise<void>;
  } {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      getConnection(input: unknown): Promise<ConnectionView | undefined>;
      claimConnectionDependency(input: unknown): Promise<boolean>;
      acknowledgeConnectionDependency(input: unknown): Promise<boolean>;
      releaseConnectionDependency(input: unknown): Promise<boolean>;
      compensateConnectionDependency(input: unknown): Promise<boolean>;
      leaseModelCredential(input: unknown): Promise<unknown>;
      settleModelCredential(input: unknown): Promise<void>;
    };
    return {
      readConfiguration: (input) => rpc.readConfiguration(input),
      getConnection: (userId, connectionId) =>
        rpc.getConnection({ schemaVersion: 1, userId, connectionId }),
      claimConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
        requirement,
      ) =>
        rpc.claimConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
          requirement,
        }),
      acknowledgeConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.acknowledgeConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      releaseConnectionDependency: (userId, connectionId, botId, generation) =>
        rpc.releaseConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      compensateConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.compensateConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      leaseModelCredential: async (
        userId,
        connectionId,
        providerModelId,
        effectId,
        connectionGeneration,
      ) =>
        decodeCredentialLeaseV1(
          await rpc.leaseModelCredential({
            schemaVersion: 1,
            userId,
            connectionId,
            providerModelId,
            effectId,
            connectionGeneration,
          }),
        ),
      settleModelCredential: (userId, connectionId, packageId, effectId) =>
        rpc.settleModelCredential({
          schemaVersion: 1,
          userId,
          connectionId,
          packageId,
          effectId,
        }),
    };
  }

  private async ensureBotSettings(
    identity: BotIdentity,
  ): Promise<BotSettingsViewV1> {
    await this.validateIdentity(identity);
    const existing = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    if (!existing)
      throw new Error(`Bot "${identity.botId}" is not materialized`);
    return existing;
  }

  private async resolveExecutionContext(identity: BotIdentity): Promise<{
    settings: BotSettingsViewV1;
    user: UserSettingsViewV1;
    plan: BotExecutionPlanV1;
  }> {
    let settings = await this.ensureBotSettings(identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    let plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const changed = settings.assignments.some(
      (assignment, index) =>
        assignment.state !== plan.assignments[index]?.state,
    );
    if (changed) {
      settings = await this.ctx.storage.transaction(async (transaction) => {
        const current =
          (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
          settings;
        if (current.revision !== settings.revision) return current;
        const next = {
          ...current,
          revision: current.revision + 1,
          assignments: plan.assignments,
        } satisfies BotSettingsViewV1;
        await transaction.put(BOT_CONFIGURATION_KEY, next);
        return next;
      });
      plan = {
        ...plan,
        revision: settings.revision,
        assignments: settings.assignments,
      };
    }
    return { settings, user, plan };
  }
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

export function createShellBotBackendPlugin(
  host: ShellBotBackendHost,
  lifecycle: { mount(value: ShellBotBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createShellBotBackendContribution(host));
}
