import { DurableObject } from "cloudflare:workers";
import {
  ConfigurationConflictError,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  acknowledgeDependentAssignment,
  claimDependentAssignment,
} from "./dependency-coordination.js";

const STATE_KEY = "user-configuration";
const IDENTITY_KEY = "user-id";
const RECEIPT_PREFIX = "configuration-receipt:";
const CONNECTION_EFFECT_ALARM_MS = 60_000;
const LEGACY_ASSIGNMENT_GENERATION = "legacy:any";

function revocationCompensations(
  connection: UserSettingsViewV1["connections"][number],
  activeGeneration?: string,
): Array<{ botId: string; id: string; expectedGeneration: string }> {
  const dependencies = Array.isArray(
    connection.safeMetadata.dependentAssignments,
  )
    ? connection.safeMetadata.dependentAssignments
    : [];
  const byBot = new Map<string, string>();
  for (const candidate of dependencies) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const dependency = candidate as Record<string, unknown>;
    if (
      typeof dependency.botId === "string" &&
      typeof dependency.generation === "string"
    ) {
      byBot.set(dependency.botId, dependency.generation);
    }
  }
  const targetBotId = connection.safeMetadata.targetBotId;
  if (typeof targetBotId === "string" && !byBot.has(targetBotId)) {
    byBot.set(
      targetBotId,
      activeGeneration ??
        (typeof connection.safeMetadata.assignmentGeneration === "string"
          ? connection.safeMetadata.assignmentGeneration
          : LEGACY_ASSIGNMENT_GENERATION),
    );
  }
  return [...byBot].map(([botId, expectedGeneration]) => ({
    botId,
    id: `revoke:${connection.connectionId}:${botId}:${expectedGeneration}`,
    expectedGeneration,
  }));
}

interface UserConfigurationEnv {
  BOT_STATES: DurableObjectNamespace;
}

export interface StartConnectionInput {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  safeMetadata?: UserSettingsViewV1["connections"][number]["safeMetadata"];
}

function nextConnectionAlarm(settings: UserSettingsViewV1): number | undefined {
  const deadlines = settings.connections.flatMap((connection) => {
    const values: number[] = [];
    const metadata = connection.safeMetadata;
    if (
      ((connection.state === "authorizing" &&
        typeof metadata.connectedAccountId !== "string") ||
        connection.state === "revoking") &&
      typeof metadata.effectDeadlineAt === "number"
    ) {
      values.push(metadata.effectDeadlineAt);
    }
    if (
      connection.state === "reconciliation-required" &&
      metadata.reconciliationOperation === "assignment" &&
      typeof metadata.assignmentLeaseExpiresAt === "number"
    ) {
      values.push(metadata.assignmentLeaseExpiresAt);
    }
    if (
      metadata.assignmentCompensationPending === true &&
      typeof metadata.compensationRetryAt === "number"
    ) {
      values.push(metadata.compensationRetryAt);
    }
    return values;
  });
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

const initialState = (): UserSettingsViewV1 => ({
  schemaVersion: 1,
  revision: 0,
  profile: { name: "FrockBot user" },
  packages: [],
  connections: [],
});

type UserConfigurationCommand = Extract<
  ConfigurationCommandV1,
  {
    type:
      | "user/update-profile"
      | "user/set-new-bot-model"
      | "user/install-package"
      | "user/set-package-enabled";
  }
>;

function userCommand(
  command: ConfigurationCommandV1,
): UserConfigurationCommand {
  if (!command.type.startsWith("user/")) {
    throw new Error("User configuration cannot execute a Bot command");
  }
  return command as UserConfigurationCommand;
}

function applyUserCommand(
  current: UserSettingsViewV1,
  command: UserConfigurationCommand,
): UserSettingsViewV1 {
  const revision = current.revision + 1;
  switch (command.type) {
    case "user/update-profile":
      return { ...current, revision, profile: command.profile };
    case "user/set-new-bot-model":
      return { ...current, revision, newBotModelTemplate: command.model };
    case "user/install-package": {
      const existing = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      return {
        ...current,
        revision,
        packages: [
          ...current.packages.filter(
            (pkg) => pkg.packageId !== command.packageId,
          ),
          {
            packageId: command.packageId,
            version: command.version,
            state: existing?.state === "failed" ? "failed" : "installed",
            failure: existing?.failure,
          },
        ],
      };
    }
    case "user/set-package-enabled": {
      const installed = current.packages.some(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (!installed) {
        throw new Error(`Package "${command.packageId}" is not installed`);
      }
      return {
        ...current,
        revision,
        packages: current.packages.map((pkg) =>
          pkg.packageId === command.packageId
            ? {
                ...pkg,
                state: command.enabled ? "installed" : "disabled",
                failure: undefined,
              }
            : pkg,
        ),
      };
    }
  }
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  async read(userId: string): Promise<UserSettingsViewV1> {
    await this.assertIdentity(userId);
    return (
      (await this.ctx.storage.get<UserSettingsViewV1>(STATE_KEY)) ??
      initialState()
    );
  }

  async execute(
    userId: string,
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1> {
    const decodedCommand = userCommand(command);
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
      const existing = await transaction.get<OperationReceiptV1>(receiptKey);
      if (existing) return existing;
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const next = applyUserCommand(current, decodedCommand);
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: next.revision,
        status: "applied",
      };
      await transaction.put({ [STATE_KEY]: next, [receiptKey]: receipt });
      return receipt;
    });
  }

  async isPackageInstalled(
    userId: string,
    packageId: string,
  ): Promise<boolean> {
    const settings = await this.read(userId);
    return settings.packages.some(
      (pkg) => pkg.packageId === packageId && pkg.state === "installed",
    );
  }

  async getConnection(
    userId: string,
    connectionId: string,
  ): Promise<UserSettingsViewV1["connections"][number] | undefined> {
    const settings = await this.read(userId);
    return settings.connections.find(
      (connection) => connection.connectionId === connectionId,
    );
  }

  async startConnection(
    userId: string,
    input: StartConnectionInput,
  ): Promise<boolean> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const existing = current.connections.find(
        (connection) => connection.connectionId === input.connectionId,
      );
      if (existing) return false;
      const effectDeadlineAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: [
          ...current.connections,
          {
            ...input,
            state: "authorizing" as const,
            safeMetadata: {
              ...(input.safeMetadata ?? {}),
              effectDeadlineAt,
            },
          },
        ],
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      await transaction.setAlarm(nextConnectionAlarm(next) ?? effectDeadlineAt);
      return true;
    });
  }

  async recordConnectLinkResult(
    userId: string,
    connectionId: string,
    safeMetadata: UserSettingsViewV1["connections"][number]["safeMetadata"],
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      const operation = connection.safeMetadata.reconciliationOperation;
      if (
        connection.state !== "authorizing" &&
        !(
          connection.state === "reconciliation-required" && operation === "link"
        )
      ) {
        return undefined;
      }
      return {
        ...connection,
        state: "authorizing",
        safeMetadata: {
          ...safeMetadata,
          ...(connection.safeMetadata.revocationRequested === true
            ? { revocationRequested: true }
            : {}),
        },
        failure: undefined,
      };
    });
  }

  async finishConnectionAuthorization(
    userId: string,
    connectionId: string,
    update: {
      state: "ready" | "failed";
      safeMetadata?: UserSettingsViewV1["connections"][number]["safeMetadata"];
      failure?: string;
    },
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      const operation = connection.safeMetadata.reconciliationOperation;
      if (
        connection.safeMetadata.revocationRequested === true ||
        (connection.state !== "authorizing" &&
          !(
            connection.state === "reconciliation-required" &&
            operation === "link"
          ))
      ) {
        return undefined;
      }
      return {
        ...connection,
        state: update.state,
        safeMetadata: update.safeMetadata ?? connection.safeMetadata,
        failure: update.failure,
      };
    });
  }

  async consumeAuthorizationState(
    userId: string,
    connectionId: string,
    authorizationStateId: string,
  ): Promise<"claimed" | "duplicate" | "invalid"> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const connection = current.connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (
        !connection ||
        connection.safeMetadata.authorizationStateId !== authorizationStateId ||
        typeof connection.safeMetadata.authorizationStateExpiresAt !==
          "number" ||
        connection.safeMetadata.authorizationStateExpiresAt <= Date.now()
      ) {
        return "invalid";
      }
      if (connection.safeMetadata.authorizationStateConsumed === true) {
        return "duplicate";
      }
      const nextConnection = {
        ...connection,
        safeMetadata: {
          ...connection.safeMetadata,
          authorizationStateConsumed: true,
        },
      };
      await transaction.put(STATE_KEY, {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((item) =>
          item.connectionId === connectionId ? nextConnection : item,
        ),
      } satisfies UserSettingsViewV1);
      return "claimed";
    });
  }

  async claimConnectionAssignment(
    userId: string,
    connectionId: string,
    leaseId: string,
    verifiedMetadata?: UserSettingsViewV1["connections"][number]["safeMetadata"],
  ): Promise<{
    phase: "acquired" | "pending" | "done";
    connection: UserSettingsViewV1["connections"][number];
  }> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const connection = current.connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (!connection) {
        throw new Error(`Connection "${connectionId}" was not admitted`);
      }
      if (connection.state === "ready") {
        return { phase: "done" as const, connection };
      }
      if (connection.safeMetadata.assignmentCompensationPending === true) {
        return { phase: "pending" as const, connection };
      }
      if (connection.safeMetadata.revocationRequested === true) {
        return { phase: "pending" as const, connection };
      }
      const operation = connection.safeMetadata.reconciliationOperation;
      const isAssignment =
        connection.state === "reconciliation-required" &&
        operation === "assignment";
      const isVerifiedAuthorization =
        connection.state === "authorizing" ||
        (connection.state === "reconciliation-required" &&
          operation === "link");
      if (!isAssignment && !isVerifiedAuthorization) {
        return { phase: "pending" as const, connection };
      }
      const leaseExpiresAt = connection.safeMetadata.assignmentLeaseExpiresAt;
      if (
        isAssignment &&
        typeof leaseExpiresAt === "number" &&
        leaseExpiresAt > Date.now()
      ) {
        return { phase: "pending" as const, connection };
      }
      const expiresAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
      const claimed = {
        ...connection,
        state: "reconciliation-required" as const,
        safeMetadata: {
          ...(verifiedMetadata ?? connection.safeMetadata),
          reconciliationOperation: "assignment",
          assignmentLeaseId: leaseId,
          assignmentLeaseExpiresAt: expiresAt,
        },
        failure: "Bot assignment is pending",
      };
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((item) =>
          item.connectionId === connectionId ? claimed : item,
        ),
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      await transaction.setAlarm(nextConnectionAlarm(next) ?? expiresAt);
      return { phase: "acquired" as const, connection: claimed };
    });
  }

  async finishConnectionAssignment(
    userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        connection.state !== "reconciliation-required" ||
        connection.safeMetadata.reconciliationOperation !== "assignment" ||
        connection.safeMetadata.assignmentLeaseId !== leaseId ||
        typeof connection.safeMetadata.assignmentLeaseExpiresAt !== "number" ||
        connection.safeMetadata.assignmentLeaseExpiresAt <= Date.now()
      ) {
        return undefined;
      }
      const {
        reconciliationOperation: _,
        assignmentLeaseId: __,
        assignmentLeaseExpiresAt: ___,
        assignmentCompensationPending: ____,
        compensationRetryAt: _____,
        ...safeMetadata
      } = connection.safeMetadata;
      return {
        ...connection,
        state: "ready",
        safeMetadata: { ...safeMetadata, assignmentGeneration: leaseId },
        failure: undefined,
      };
    });
  }

  async requireAssignmentCompensation(
    userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        connection.state === "ready" ||
        connection.safeMetadata.assignmentLeaseId !== leaseId
      ) {
        return undefined;
      }
      return {
        ...connection,
        safeMetadata: {
          ...connection.safeMetadata,
          assignmentCompensationPending: true,
          assignmentCompensationId: leaseId,
          assignmentCompensationGeneration: leaseId,
          compensationRetryAt: Date.now() + CONNECTION_EFFECT_ALARM_MS,
        },
      };
    });
  }

  async recordAssignmentCompensated(
    userId: string,
    connectionId: string,
    compensationId: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (Array.isArray(connection.safeMetadata.assignmentCompensations)) {
        const remaining =
          connection.safeMetadata.assignmentCompensations.filter(
            (candidate) =>
              !candidate ||
              typeof candidate !== "object" ||
              Array.isArray(candidate) ||
              (candidate as Record<string, unknown>).id !== compensationId,
          );
        if (
          remaining.length ===
          connection.safeMetadata.assignmentCompensations.length
        ) {
          return undefined;
        }
        const {
          compensationRetryAt,
          assignmentCompensationPending: _,
          ...safeMetadata
        } = connection.safeMetadata;
        return {
          ...connection,
          safeMetadata: {
            ...safeMetadata,
            assignmentCompensations: remaining,
            ...(remaining.length > 0
              ? {
                  assignmentCompensationPending: true,
                  compensationRetryAt:
                    typeof compensationRetryAt === "number"
                      ? compensationRetryAt
                      : Date.now() + CONNECTION_EFFECT_ALARM_MS,
                }
              : {}),
          },
        };
      }
      if (
        connection.safeMetadata.assignmentCompensationPending !== true ||
        connection.safeMetadata.assignmentCompensationId !== compensationId
      ) {
        return undefined;
      }
      const {
        assignmentCompensationPending: _,
        assignmentCompensationId: __,
        assignmentCompensationGeneration: ___,
        compensationRetryAt: ____,
        ...safeMetadata
      } = connection.safeMetadata;
      return { ...connection, safeMetadata };
    });
  }

  async claimConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) =>
      claimDependentAssignment(connection, botId, generation),
    );
  }

  async acknowledgeConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) =>
      acknowledgeDependentAssignment(connection, botId, generation),
    );
  }

  async recordConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.claimConnectionDependency(
      userId,
      connectionId,
      botId,
      generation,
    );
  }

  async requireConnectionReconciliation(
    userId: string,
    connectionId: string,
    operation: "link" | "revoke",
    failure: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        operation === "link" &&
        connection.state !== "authorizing" &&
        !(
          connection.state === "reconciliation-required" &&
          connection.safeMetadata.reconciliationOperation === "link"
        )
      ) {
        return undefined;
      }
      if (
        operation === "revoke" &&
        connection.state !== "revoking" &&
        !(
          connection.state === "reconciliation-required" &&
          connection.safeMetadata.reconciliationOperation === "revoke"
        )
      ) {
        return undefined;
      }
      return {
        ...connection,
        state: "reconciliation-required",
        safeMetadata: {
          ...connection.safeMetadata,
          reconciliationOperation: operation,
        },
        failure,
      };
    });
  }

  async claimConnectionRevocation(
    userId: string,
    connectionId: string,
  ): Promise<{
    phase: "provider" | "finalize" | "pending" | "done";
    connection: UserSettingsViewV1["connections"][number];
  }> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const connection = current.connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (!connection) {
        throw new Error(`Connection "${connectionId}" was not admitted`);
      }
      if (connection.state === "revoked") {
        return { phase: "done" as const, connection };
      }
      const assignmentLeaseExpiresAt =
        connection.safeMetadata.assignmentLeaseExpiresAt;
      if (
        connection.state === "reconciliation-required" &&
        connection.safeMetadata.reconciliationOperation === "assignment" &&
        typeof assignmentLeaseExpiresAt === "number" &&
        assignmentLeaseExpiresAt > Date.now()
      ) {
        const connectedAccountId = connection.safeMetadata.connectedAccountId;
        if (typeof connectedAccountId !== "string") {
          const pending = {
            ...connection,
            safeMetadata: {
              ...connection.safeMetadata,
              revocationRequested: true,
            },
            failure: "Revocation is waiting for Connection reconciliation",
          };
          await transaction.put(STATE_KEY, {
            ...current,
            revision: current.revision + 1,
            connections: current.connections.map((item) =>
              item.connectionId === connectionId ? pending : item,
            ),
          } satisfies UserSettingsViewV1);
          return { phase: "pending" as const, connection: pending };
        }
        const effectDeadlineAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
        const leaseId = connection.safeMetadata.assignmentLeaseId;
        const assignmentCompensations = revocationCompensations(
          connection,
          typeof leaseId === "string" ? leaseId : undefined,
        );
        const claimed = {
          ...connection,
          state: "revoking" as const,
          safeMetadata: {
            ...connection.safeMetadata,
            reconciliationOperation: "revoke",
            revocationRequested: true,
            revocationProviderCompleted: false,
            effectDeadlineAt,
            assignmentCompensationPending: true,
            assignmentCompensations,
            assignmentCompensationId: `revoke:${connectionId}`,
            assignmentCompensationGeneration:
              typeof leaseId === "string"
                ? leaseId
                : LEGACY_ASSIGNMENT_GENERATION,
            compensationRetryAt: effectDeadlineAt,
          },
          failure: undefined,
        };
        const next = {
          ...current,
          revision: current.revision + 1,
          connections: current.connections.map((item) =>
            item.connectionId === connectionId ? claimed : item,
          ),
        } satisfies UserSettingsViewV1;
        await transaction.put(STATE_KEY, next);
        await transaction.setAlarm(
          nextConnectionAlarm(next) ?? effectDeadlineAt,
        );
        return { phase: "provider" as const, connection: claimed };
      }
      const providerCompleted =
        connection.safeMetadata.revocationProviderCompleted === true;
      if (
        connection.state === "revoking" ||
        (connection.state === "reconciliation-required" &&
          connection.safeMetadata.reconciliationOperation === "revoke")
      ) {
        return {
          phase: providerCompleted
            ? ("finalize" as const)
            : ("pending" as const),
          connection,
        };
      }
      const connectedAccountId = connection.safeMetadata.connectedAccountId;
      if (typeof connectedAccountId !== "string") {
        const pending = {
          ...connection,
          state: "reconciliation-required" as const,
          safeMetadata: {
            ...connection.safeMetadata,
            reconciliationOperation: "link",
            revocationRequested: true,
          },
          failure:
            "Connection identity requires reconciliation before revocation",
        };
        await transaction.put(STATE_KEY, {
          ...current,
          revision: current.revision + 1,
          connections: current.connections.map((item) =>
            item.connectionId === connectionId ? pending : item,
          ),
        } satisfies UserSettingsViewV1);
        return { phase: "pending" as const, connection: pending };
      }
      const effectDeadlineAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
      const assignmentCompensations = revocationCompensations(connection);
      const claimed = {
        ...connection,
        state: "revoking" as const,
        safeMetadata: {
          ...connection.safeMetadata,
          reconciliationOperation: "revoke",
          revocationProviderCompleted: false,
          effectDeadlineAt,
          assignmentCompensationPending: assignmentCompensations.length > 0,
          assignmentCompensations,
          ...(assignmentCompensations.length > 0
            ? { compensationRetryAt: effectDeadlineAt }
            : {}),
          ...(typeof connection.safeMetadata.targetBotId === "string"
            ? {
                assignmentCompensationPending: true,
                assignmentCompensationId: `revoke:${connectionId}`,
                assignmentCompensationGeneration:
                  typeof connection.safeMetadata.assignmentGeneration ===
                  "string"
                    ? connection.safeMetadata.assignmentGeneration
                    : LEGACY_ASSIGNMENT_GENERATION,
                compensationRetryAt: effectDeadlineAt,
              }
            : {}),
        },
        failure: undefined,
      };
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((item) =>
          item.connectionId === connectionId ? claimed : item,
        ),
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      await transaction.setAlarm(nextConnectionAlarm(next) ?? effectDeadlineAt);
      return { phase: "provider" as const, connection: claimed };
    });
  }

  async recordRevocationProviderCompleted(
    userId: string,
    connectionId: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        connection.state !== "revoking" &&
        !(
          connection.state === "reconciliation-required" &&
          connection.safeMetadata.reconciliationOperation === "revoke"
        )
      ) {
        return undefined;
      }
      return {
        ...connection,
        state: "revoking",
        safeMetadata: {
          ...connection.safeMetadata,
          reconciliationOperation: "revoke",
          revocationProviderCompleted: true,
        },
        failure: undefined,
      };
    });
  }

  async finishConnectionRevocation(
    userId: string,
    connectionId: string,
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        connection.safeMetadata.revocationProviderCompleted !== true ||
        (Array.isArray(connection.safeMetadata.assignmentCompensations) &&
          connection.safeMetadata.assignmentCompensations.length > 0) ||
        (connection.state !== "revoking" &&
          !(
            connection.state === "reconciliation-required" &&
            connection.safeMetadata.reconciliationOperation === "revoke"
          ))
      ) {
        return undefined;
      }
      return { ...connection, state: "revoked", failure: undefined };
    });
  }

  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<string>(IDENTITY_KEY);
    if (!userId) return;
    const compensations = await this.ctx.storage.transaction(
      async (transaction) => {
        const current =
          (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
          initialState();
        const now = Date.now();
        let changed = false;
        const pending: Array<{
          connectionId: string;
          botId: string;
          compensationId: string;
          expectedGeneration: string;
        }> = [];
        const connections = current.connections.map((connection) => {
          let next = connection;
          const metadata = connection.safeMetadata;
          const assignmentLeaseExpired =
            connection.state === "reconciliation-required" &&
            metadata.reconciliationOperation === "assignment" &&
            typeof metadata.assignmentLeaseExpiresAt === "number" &&
            metadata.assignmentLeaseExpiresAt <= now;
          if (assignmentLeaseExpired) {
            const expiredLeaseId = metadata.assignmentLeaseId;
            const {
              assignmentLeaseId: _,
              assignmentLeaseExpiresAt: __,
              ...safeMetadata
            } = metadata;
            next = {
              ...connection,
              safeMetadata: {
                ...safeMetadata,
                assignmentCompensationPending: true,
                ...(typeof expiredLeaseId === "string"
                  ? {
                      assignmentCompensationId: expiredLeaseId,
                      assignmentCompensationGeneration: expiredLeaseId,
                    }
                  : {}),
                compensationRetryAt: now,
              },
              failure: "Bot assignment was interrupted and can be retried",
            };
            changed = true;
          }

          const effectExpired =
            ((next.state === "authorizing" &&
              typeof next.safeMetadata.connectedAccountId !== "string") ||
              next.state === "revoking") &&
            typeof next.safeMetadata.effectDeadlineAt === "number" &&
            next.safeMetadata.effectDeadlineAt <= now;
          if (effectExpired) {
            const { effectDeadlineAt: _, ...safeMetadata } = next.safeMetadata;
            const operation = next.state === "authorizing" ? "link" : "revoke";
            next = {
              ...next,
              state: "reconciliation-required",
              safeMetadata: {
                ...safeMetadata,
                reconciliationOperation: operation,
              },
              failure: `${operation === "link" ? "Connect Link" : "Revocation"} outcome requires reconciliation`,
            };
            changed = true;
          }

          if (
            next.safeMetadata.assignmentCompensationPending === true &&
            typeof next.safeMetadata.compensationRetryAt === "number" &&
            next.safeMetadata.compensationRetryAt <= now
          ) {
            const stored = Array.isArray(
              next.safeMetadata.assignmentCompensations,
            )
              ? next.safeMetadata.assignmentCompensations
              : typeof next.safeMetadata.targetBotId === "string" &&
                  typeof next.safeMetadata.assignmentCompensationId ===
                    "string" &&
                  typeof next.safeMetadata.assignmentCompensationGeneration ===
                    "string"
                ? [
                    {
                      botId: next.safeMetadata.targetBotId,
                      id: next.safeMetadata.assignmentCompensationId,
                      expectedGeneration:
                        next.safeMetadata.assignmentCompensationGeneration,
                    },
                  ]
                : [];
            for (const candidate of stored) {
              if (
                !candidate ||
                typeof candidate !== "object" ||
                Array.isArray(candidate)
              ) {
                continue;
              }
              const compensation = candidate as Record<string, unknown>;
              if (
                typeof compensation.botId === "string" &&
                typeof compensation.id === "string" &&
                typeof compensation.expectedGeneration === "string"
              ) {
                pending.push({
                  connectionId: next.connectionId,
                  botId: compensation.botId,
                  compensationId: compensation.id,
                  expectedGeneration: compensation.expectedGeneration,
                });
              }
            }
            if (stored.length > 0) {
              next = {
                ...next,
                safeMetadata: {
                  ...next.safeMetadata,
                  compensationRetryAt: now + CONNECTION_EFFECT_ALARM_MS,
                },
              };
              changed = true;
            }
          }
          return next;
        });
        const next = {
          ...current,
          revision: changed ? current.revision + 1 : current.revision,
          connections,
        } satisfies UserSettingsViewV1;
        if (changed) await transaction.put(STATE_KEY, next);
        const alarmAt = nextConnectionAlarm(next);
        if (alarmAt === undefined) {
          await transaction.deleteAlarm();
        } else {
          await transaction.setAlarm(Math.max(Date.now(), alarmAt));
        }
        return pending;
      },
    );

    for (const compensation of compensations) {
      try {
        const id = this.env.BOT_STATES.idFromName(
          `${userId}:${compensation.botId}`,
        );
        // SAFETY: BOT_STATES binds BotState, whose public RPC method below is
        // stable; workers-types cannot infer the generated Durable Object stub.
        const bot = this.env.BOT_STATES.get(id) as unknown as {
          markConnectionUnavailable(
            identity: { userId: string; botId: string },
            connectionId: string,
            compensation: { id: string; expectedGeneration: string },
          ): Promise<"applied" | "stale">;
        };
        const result = await bot.markConnectionUnavailable(
          { userId, botId: compensation.botId },
          compensation.connectionId,
          {
            id: compensation.compensationId,
            expectedGeneration: compensation.expectedGeneration,
          },
        );
        if (result !== "applied") continue;
        const cleared = await this.recordAssignmentCompensated(
          userId,
          compensation.connectionId,
          compensation.compensationId,
        );
        if (cleared) {
          await this.finishConnectionRevocation(
            userId,
            compensation.connectionId,
          );
        }
      } catch {
        // Durable compensation intent and its retry deadline remain stored.
      }
    }
  }

  private async transitionConnection(
    userId: string,
    connectionId: string,
    transition: (
      connection: UserSettingsViewV1["connections"][number],
    ) => UserSettingsViewV1["connections"][number] | undefined,
  ): Promise<boolean> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const connection = current.connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (!connection) {
        throw new Error(`Connection "${connectionId}" was not admitted`);
      }
      const nextConnection = transition(connection);
      if (!nextConnection) return false;
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((item) =>
          item.connectionId === connectionId ? nextConnection : item,
        ),
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      const alarmAt = nextConnectionAlarm(next);
      if (alarmAt === undefined) {
        await transaction.deleteAlarm();
      } else {
        await transaction.setAlarm(Math.max(Date.now(), alarmAt));
      }
      return true;
    });
  }

  private async assertIdentity(userId: string): Promise<void> {
    const existing = await this.ctx.storage.get<string>(IDENTITY_KEY);
    if (existing && existing !== userId) {
      throw new Error("User authority does not match durable identity");
    }
    if (!existing) await this.ctx.storage.put(IDENTITY_KEY, userId);
  }
}
