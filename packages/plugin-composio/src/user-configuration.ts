import {
  USER_PROFILE_PLACEHOLDER_NAME_V1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createUserSettingsBackendContribution,
  type UserSettingsBackendContribution,
  type UserSettingsTransaction,
  // pi-lens-ignore: ts:2307
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  linkReconciliationDisposition,
  type ComposioProviderReconciliationRequest,
  type ComposioProviderReconciliationResult,
} from "./provider-reconciliation.js";

const STATE_KEY = "user-configuration";
const IDENTITY_KEY = "user-id";
const CONNECTION_EFFECT_ALARM_MS = 60_000;

function readyAuthorizationMetadata(
  connection: UserSettingsViewV1["connections"][number],
  safeMetadata: UserSettingsViewV1["connections"][number]["safeMetadata"],
): UserSettingsViewV1["connections"][number]["safeMetadata"] | undefined {
  const commandFingerprint = connection.safeMetadata.startCommandFingerprint;
  if (typeof commandFingerprint !== "string") {
    return { ...safeMetadata, authorizationStateConsumed: true };
  }
  const connectedAccountId = safeMetadata.connectedAccountId;
  const admittedConnectedAccountId = connection.safeMetadata.connectedAccountId;
  if (
    typeof connectedAccountId !== "string" ||
    (typeof admittedConnectedAccountId === "string" &&
      admittedConnectedAccountId !== connectedAccountId)
  ) {
    return undefined;
  }
  const nativeReturnNonce = connection.safeMetadata.nativeReturnNonce;
  return {
    ...safeMetadata,
    authorizationStateConsumed: true,
    connectionStartReplay: {
      schemaVersion: 1,
      commandFingerprint,
      connectionId: connection.connectionId,
      status: "ready",
      ...(typeof nativeReturnNonce === "string" ? { nativeReturnNonce } : {}),
    },
  };
}

export interface ComposioUserBackendHost {
  state: DurableObjectState;
  availablePackages: readonly { packageId: string; version: string }[];
  reconcileProviderConnection(
    request: ComposioProviderReconciliationRequest,
  ): Promise<ComposioProviderReconciliationResult>;
  revokeConnectedAccount(connectedAccountId: string): Promise<unknown>;
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
      metadata.revocationRequested !== true &&
      connection.state === "authorizing"
    ) {
      if (typeof metadata.authorizationStateExpiresAt === "number") {
        values.push(metadata.authorizationStateExpiresAt);
      }
      if (typeof metadata.expiresAt === "string") {
        const expiresAt = Date.parse(metadata.expiresAt);
        values.push(Number.isFinite(expiresAt) ? expiresAt : 0);
      }
    }
    if (
      connection.state === "reconciliation-required" &&
      (metadata.reconciliationOperation === "link" ||
        metadata.reconciliationOperation === "revoke") &&
      typeof metadata.reconciliationRetryAt === "number"
    ) {
      values.push(metadata.reconciliationRetryAt);
    }
    return values;
  });
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

function connectionAuthorizationExpired(
  connection: UserSettingsViewV1["connections"][number],
  now: number,
): boolean {
  const metadata = connection.safeMetadata;
  if (metadata.revocationRequested === true) return false;
  if (
    connection.state !== "authorizing" &&
    !(
      connection.state === "reconciliation-required" &&
      metadata.reconciliationOperation === "link"
    )
  ) {
    return false;
  }
  const stateExpired =
    typeof metadata.authorizationStateExpiresAt === "number" &&
    metadata.authorizationStateExpiresAt <= now;
  const linkExpiry =
    typeof metadata.expiresAt === "string"
      ? Date.parse(metadata.expiresAt)
      : undefined;
  const linkExpired =
    linkExpiry !== undefined &&
    (!Number.isFinite(linkExpiry) || linkExpiry <= now);
  return stateExpired || linkExpired;
}

function hasUnresolvedLinkEffect(
  connection: UserSettingsViewV1["connections"][number],
): boolean {
  const metadata = connection.safeMetadata;
  if (
    connection.state === "authorizing" &&
    typeof metadata.connectedAccountId !== "string"
  ) {
    return true;
  }
  if (
    connection.state === "reconciliation-required" &&
    metadata.reconciliationOperation === "link"
  ) {
    return true;
  }
  return (
    metadata.lostLinkCleanup === true &&
    (connection.state === "revoking" ||
      (connection.state === "reconciliation-required" &&
        metadata.reconciliationOperation === "revoke"))
  );
}

const initialState = (): UserSettingsViewV1 => ({
  schemaVersion: 1,
  revision: 0,
  profile: { name: USER_PROFILE_PLACEHOLDER_NAME_V1 },
  packages: [],
  connections: [],
});

export class ComposioUserBackendContribution {
  readonly ctx: DurableObjectState;
  private readonly settings: UserSettingsBackendContribution;
  private readonly availablePackages: ReadonlySet<string>;
  private readonly reconcileProviderConnection: ComposioUserBackendHost["reconcileProviderConnection"];
  private readonly revokeConnectedAccount: ComposioUserBackendHost["revokeConnectedAccount"];

  constructor(host: ComposioUserBackendHost) {
    this.ctx = host.state;
    this.settings = createUserSettingsBackendContribution({
      storage: host.state.storage,
      availablePackages: host.availablePackages,
    });
    this.availablePackages = new Set(
      host.availablePackages.map(
        ({ packageId, version }) => `${packageId}\u0000${version}`,
      ),
    );
    this.reconcileProviderConnection = host.reconcileProviderConnection;
    this.revokeConnectedAccount = host.revokeConnectedAccount;
  }

  readConfiguration(input: unknown): Promise<UserSettingsViewV1> {
    return this.settings.readConfiguration(input);
  }

  executeConfiguration(
    input: unknown,
  ): ReturnType<UserSettingsBackendContribution["executeConfiguration"]> {
    return this.settings.executeConfiguration(input);
  }

  readSnapshot(storage: UserSettingsTransaction): Promise<UserSettingsViewV1> {
    return this.settings.readSnapshot(storage);
  }

  read(userId: string): Promise<UserSettingsViewV1> {
    return this.settings.read(userId);
  }

  isPackageInstalled(userId: string, packageId: string): Promise<boolean> {
    return this.settings.isPackageInstalled(userId, packageId);
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
      const installed = current.packages.find(
        (installedPackage) =>
          installedPackage.packageId === input.packageId &&
          installedPackage.state === "installed",
      );
      if (!installed) {
        throw new Error(`Package "${input.packageId}" is not installed`);
      }
      if (
        !this.availablePackages.has(
          `${installed.packageId}\u0000${installed.version}`,
        )
      ) {
        throw new Error(`Package "${input.packageId}" is not available`);
      }
      const existing = current.connections.find(
        (connection) => connection.connectionId === input.connectionId,
      );
      if (existing) return false;
      const unresolved = current.connections.find(
        (connection) =>
          connection.packageId === input.packageId &&
          connection.connectionTypeId === input.connectionTypeId &&
          hasUnresolvedLinkEffect(connection),
      );
      if (unresolved) {
        throw new Error(
          "Previous Connection authorization requires reconciliation",
        );
      }
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
      if (connection.state === "failed") {
        return {
          ...connection,
          state: "reconciliation-required",
          safeMetadata: {
            ...safeMetadata,
            authorizationStateConsumed: true,
            revocationRequested: true,
            reconciliationOperation: "link",
            reconciliationRetryAt: Date.now() + CONNECTION_EFFECT_ALARM_MS,
          },
          failure: "Late Connect Link requires cleanup",
        };
      }
      const operation = connection.safeMetadata.reconciliationOperation;
      if (
        connection.state !== "authorizing" &&
        !(
          connection.state === "reconciliation-required" && operation === "link"
        )
      ) {
        return undefined;
      }
      if (connection.safeMetadata.revocationRequested === true) {
        return {
          ...connection,
          state: "reconciliation-required",
          safeMetadata: {
            ...safeMetadata,
            revocationRequested: true,
            reconciliationOperation: "link",
            reconciliationRetryAt:
              typeof connection.safeMetadata.reconciliationRetryAt === "number"
                ? connection.safeMetadata.reconciliationRetryAt
                : Date.now() + CONNECTION_EFFECT_ALARM_MS,
          },
          failure:
            "Connection identity requires reconciliation before revocation",
        };
      }
      return {
        ...connection,
        state: "authorizing",
        safeMetadata,
        failure: undefined,
      };
    });
  }

  async recordLinkReconciliationIdentity(
    userId: string,
    connectionId: string,
    safeMetadata: UserSettingsViewV1["connections"][number]["safeMetadata"],
  ): Promise<boolean> {
    return this.transitionConnection(userId, connectionId, (connection) => {
      if (
        connection.state !== "reconciliation-required" ||
        connection.safeMetadata.reconciliationOperation !== "link"
      ) {
        return undefined;
      }
      return {
        ...connection,
        safeMetadata: {
          ...connection.safeMetadata,
          ...safeMetadata,
          reconciliationOperation: "link",
          reconciliationRetryAt:
            typeof connection.safeMetadata.reconciliationRetryAt === "number"
              ? connection.safeMetadata.reconciliationRetryAt
              : Date.now() + CONNECTION_EFFECT_ALARM_MS,
        },
      };
    });
  }

  async claimLostLinkCleanup(
    userId: string,
    connectionId: string,
    safeMetadata: UserSettingsViewV1["connections"][number]["safeMetadata"],
  ): Promise<{
    phase: "provider" | "pending" | "done";
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
      if (
        connection.safeMetadata.lostLinkCleanup === true &&
        (connection.state === "revoking" ||
          (connection.state === "reconciliation-required" &&
            connection.safeMetadata.reconciliationOperation === "revoke"))
      ) {
        return { phase: "pending" as const, connection };
      }
      const connectedAccountId = safeMetadata.connectedAccountId;
      if (
        connection.state !== "reconciliation-required" ||
        connection.safeMetadata.reconciliationOperation !== "link" ||
        connection.safeMetadata.revocationRequested === true ||
        typeof connectedAccountId !== "string" ||
        (typeof connection.safeMetadata.connectedAccountId === "string" &&
          connection.safeMetadata.connectedAccountId !== connectedAccountId)
      ) {
        throw new Error("Pending Link cannot enter cleanup");
      }
      const effectDeadlineAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
      const claimed = {
        ...connection,
        state: "revoking" as const,
        safeMetadata: {
          ...connection.safeMetadata,
          ...safeMetadata,
          authorizationStateConsumed: true,
          lostLinkCleanup: true,
          revocationRequested: true,
          reconciliationOperation: "revoke",
          revocationProviderCompleted: false,
          effectDeadlineAt,
        },
        failure: "Lost Connect Link cleanup requires provider reconciliation",
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

  async finishConnectionAuthorization(
    userId: string,
    connectionId: string,
    update: {
      state: "ready" | "failed";
      safeMetadata?: UserSettingsViewV1["connections"][number]["safeMetadata"];
      failure?: string;
      authorizationStateId?: string;
    },
  ): Promise<boolean> {
    if (update.authorizationStateId !== undefined) {
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
          connection.safeMetadata.authorizationStateId !==
            update.authorizationStateId
        ) {
          return false;
        }
        if (
          connection.state === "ready" ||
          connection.state === "failed" ||
          connection.safeMetadata.revocationRequested === true
        ) {
          return false;
        }
        const operation = connection.safeMetadata.reconciliationOperation;
        if (
          connection.state !== "authorizing" &&
          !(
            connection.state === "reconciliation-required" &&
            operation === "link"
          )
        ) {
          return false;
        }
        if (
          connection.safeMetadata.authorizationStateConsumed !== true &&
          (typeof connection.safeMetadata.authorizationStateExpiresAt !==
            "number" ||
            connection.safeMetadata.authorizationStateExpiresAt <= Date.now())
        ) {
          return false;
        }
        const safeMetadata =
          update.state === "ready"
            ? readyAuthorizationMetadata(
                connection,
                update.safeMetadata ?? connection.safeMetadata,
              )
            : {
                ...(update.safeMetadata ?? connection.safeMetadata),
                authorizationStateConsumed: true,
              };
        if (!safeMetadata) return false;
        const nextConnection = {
          ...connection,
          state: update.state,
          safeMetadata,
          failure: update.failure,
        };
        const next = {
          ...current,
          revision: current.revision + 1,
          connections: current.connections.map((item) =>
            item.connectionId === connectionId ? nextConnection : item,
          ),
        } satisfies UserSettingsViewV1;
        await transaction.put(STATE_KEY, next);
        const alarmAt = nextConnectionAlarm(next);
        if (alarmAt === undefined) await transaction.deleteAlarm();
        else await transaction.setAlarm(alarmAt);
        return true;
      });
    }
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
      const safeMetadata =
        update.state === "ready"
          ? readyAuthorizationMetadata(
              connection,
              update.safeMetadata ?? connection.safeMetadata,
            )
          : {
              ...(update.safeMetadata ?? connection.safeMetadata),
              authorizationStateConsumed: true,
            };
      if (!safeMetadata) return undefined;
      return {
        ...connection,
        state: update.state,
        safeMetadata,
        failure: update.failure,
      };
    });
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
          reconciliationRetryAt: Date.now() + CONNECTION_EFFECT_ALARM_MS,
        },
        failure,
      };
    });
  }

  async claimConnectionRevocation(
    userId: string,
    connectionId: string,
    recoveredSafeMetadata?: UserSettingsViewV1["connections"][number]["safeMetadata"],
  ): Promise<{
    phase: "provider" | "finalize" | "pending" | "done";
    connection: UserSettingsViewV1["connections"][number];
  }> {
    await this.assertIdentity(userId);
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      let connection = current.connections.find(
        (item) => item.connectionId === connectionId,
      );
      if (!connection) {
        throw new Error(`Connection "${connectionId}" was not admitted`);
      }
      if (connection.state === "revoked") {
        return { phase: "done" as const, connection };
      }
      if (recoveredSafeMetadata) {
        if (
          connection.safeMetadata.revocationRequested !== true ||
          typeof recoveredSafeMetadata.connectedAccountId !== "string" ||
          (connection.state !== "authorizing" &&
            !(
              connection.state === "reconciliation-required" &&
              connection.safeMetadata.reconciliationOperation === "link"
            ))
        ) {
          throw new Error(
            "Recovered Connection identity cannot enter revocation",
          );
        }
        connection = {
          ...connection,
          safeMetadata: {
            ...connection.safeMetadata,
            ...recoveredSafeMetadata,
            revocationRequested: true,
          },
        };
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
        const reconciliationRetryAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
        const pending = {
          ...connection,
          state: "reconciliation-required" as const,
          safeMetadata: {
            ...connection.safeMetadata,
            reconciliationOperation: "link",
            revocationRequested: true,
            reconciliationRetryAt,
          },
          failure:
            "Connection identity requires reconciliation before revocation",
        };
        const next = {
          ...current,
          revision: current.revision + 1,
          connections: current.connections.map((item) =>
            item.connectionId === connectionId ? pending : item,
          ),
        } satisfies UserSettingsViewV1;
        await transaction.put(STATE_KEY, next);
        await transaction.setAlarm(
          Math.max(
            Date.now(),
            nextConnectionAlarm(next) ?? reconciliationRetryAt,
          ),
        );
        return { phase: "pending" as const, connection: pending };
      }
      const effectDeadlineAt = Date.now() + CONNECTION_EFFECT_ALARM_MS;
      const claimed = {
        ...connection,
        state: "revoking" as const,
        safeMetadata: {
          ...connection.safeMetadata,
          reconciliationOperation: "revoke",
          revocationProviderCompleted: false,
          effectDeadlineAt,
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
          (connection.safeMetadata.reconciliationOperation === "revoke" ||
            (connection.safeMetadata.reconciliationOperation === "link" &&
              connection.safeMetadata.revocationRequested === true))
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
    const pending = await this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<UserSettingsViewV1>(STATE_KEY)) ??
        initialState();
      const now = Date.now();
      let changed = false;
      const reconciliations: Array<{
        connection: UserSettingsViewV1["connections"][number];
        operation: "link" | "revoke";
      }> = [];
      const connections = current.connections.map((connection) => {
        let next = connection;
        if (connectionAuthorizationExpired(next, now)) {
          const providerAlias = next.safeMetadata.providerAlias;
          const toolkitSlug = next.safeMetadata.toolkitSlug;
          if (
            typeof providerAlias === "string" &&
            typeof toolkitSlug === "string"
          ) {
            const { effectDeadlineAt: _, ...safeMetadata } = next.safeMetadata;
            next = {
              ...next,
              state: "reconciliation-required",
              safeMetadata: {
                ...safeMetadata,
                reconciliationOperation: "link",
                reconciliationRetryAt: now,
              },
              failure: "Expired authorization requires provider reconciliation",
            };
          } else {
            const {
              effectDeadlineAt: _,
              reconciliationRetryAt: __,
              ...safeMetadata
            } = next.safeMetadata;
            next = {
              ...next,
              state: "failed",
              safeMetadata: {
                ...safeMetadata,
                authorizationStateConsumed: true,
              },
              failure: "Connection authorization expired",
            };
          }
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
              reconciliationRetryAt: now,
            },
            failure: `${operation === "link" ? "Connect Link" : "Revocation"} outcome requires reconciliation`,
          };
          changed = true;
        }

        const reconciliationOperation =
          next.safeMetadata.reconciliationOperation;
        if (
          next.state === "reconciliation-required" &&
          (reconciliationOperation === "link" ||
            reconciliationOperation === "revoke") &&
          typeof next.safeMetadata.reconciliationRetryAt === "number" &&
          next.safeMetadata.reconciliationRetryAt <= now
        ) {
          reconciliations.push({
            connection: next,
            operation: reconciliationOperation,
          });
          next = {
            ...next,
            safeMetadata: {
              ...next.safeMetadata,
              reconciliationRetryAt: now + CONNECTION_EFFECT_ALARM_MS,
            },
          };
          changed = true;
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
      return reconciliations;
    });

    for (const reconciliation of pending) {
      try {
        const connection = reconciliation.connection;
        if (reconciliation.operation === "link") {
          const providerAlias = connection.safeMetadata.providerAlias;
          const toolkitSlug = connection.safeMetadata.toolkitSlug;
          if (
            typeof providerAlias !== "string" ||
            typeof toolkitSlug !== "string"
          ) {
            continue;
          }
          const result = await this.reconcileProviderConnection({
            operation: "link",
            userId,
            providerAlias,
            toolkitSlug,
          });
          const account =
            result.status === "active"
              ? result.account
              : result.status === "pending" ||
                  result.status === "failed" ||
                  result.status === "revoked"
                ? result.account
                : undefined;
          const safeMetadata = account
            ? {
                ...connection.safeMetadata,
                connectedAccountId: account.id,
                toolkitSlug: account.toolkitSlug,
                ...(account.alias ? { providerAlias: account.alias } : {}),
              }
            : undefined;
          if (
            connection.safeMetadata.revocationRequested === true &&
            result.status === "absent"
          ) {
            const completed = await this.recordRevocationProviderCompleted(
              userId,
              connection.connectionId,
            );
            if (completed) {
              await this.finishConnectionRevocation(
                userId,
                connection.connectionId,
              );
            }
            continue;
          }
          if (
            connection.safeMetadata.revocationRequested === true &&
            account &&
            safeMetadata
          ) {
            const claim = await this.claimConnectionRevocation(
              userId,
              connection.connectionId,
              safeMetadata,
            );
            if (result.status !== "revoked") {
              if (claim.phase !== "provider") continue;
              try {
                await this.revokeConnectedAccount(account.id);
              } catch (error) {
                await this.requireConnectionReconciliation(
                  userId,
                  connection.connectionId,
                  "revoke",
                  "Revocation outcome requires reconciliation",
                );
                throw error;
              }
            }
            if (claim.phase !== "done") {
              const completed = await this.recordRevocationProviderCompleted(
                userId,
                connection.connectionId,
              );
              if (completed) {
                await this.finishConnectionRevocation(
                  userId,
                  connection.connectionId,
                );
              }
            }
            continue;
          }
          const disposition = linkReconciliationDisposition(result);
          if (
            connection.safeMetadata.revocationRequested !== true &&
            disposition === "failed"
          ) {
            await this.finishConnectionAuthorization(
              userId,
              connection.connectionId,
              {
                state: "failed",
                safeMetadata: {
                  ...connection.safeMetadata,
                  authorizationStateConsumed: true,
                },
                failure: "Connection authorization could not be recovered",
              },
            );
            continue;
          }
          if (disposition === "pending") {
            if (safeMetadata) {
              const cleanup = await this.claimLostLinkCleanup(
                userId,
                connection.connectionId,
                safeMetadata,
              );
              if (cleanup.phase === "provider") {
                const connectedAccountId = safeMetadata.connectedAccountId;
                if (typeof connectedAccountId !== "string") continue;
                try {
                  await this.revokeConnectedAccount(connectedAccountId);
                } finally {
                  await this.requireConnectionReconciliation(
                    userId,
                    connection.connectionId,
                    "revoke",
                    "Lost Connect Link cleanup requires provider reconciliation",
                  );
                }
              }
            }
            continue;
          }
          if (!safeMetadata) continue;
          await this.finishConnectionAuthorization(
            userId,
            connection.connectionId,
            {
              state: "ready",
              safeMetadata: {
                ...safeMetadata,
                authorizationStateConsumed: true,
              },
            },
          );
          continue;
        }
        const connectedAccountId = connection.safeMetadata.connectedAccountId;
        if (typeof connectedAccountId !== "string") continue;
        const result = await this.reconcileProviderConnection({
          operation: "revoke",
          userId,
          connectedAccountId,
        });
        if (result.status === "revoked" || result.status === "absent") {
          const completed = await this.recordRevocationProviderCompleted(
            userId,
            connection.connectionId,
          );
          if (completed) {
            await this.finishConnectionRevocation(
              userId,
              connection.connectionId,
            );
          }
        }
      } catch {
        // Durable reconciliation state and its alarm deadline remain stored.
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

export function createComposioUserBackendContribution(
  host: ComposioUserBackendHost,
): ComposioUserBackendContribution {
  return new ComposioUserBackendContribution(host);
}

export function createComposioUserBackendPlugin(
  host: ComposioUserBackendHost,
  lifecycle: { mount(value: ComposioUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createComposioUserBackendContribution(host));
}
