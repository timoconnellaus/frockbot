import type { ConnectionView } from "@frockbot/configuration-core";
import type {
  ComposioClient,
  ConnectLink,
} from "@frockbot/plugin-composio/client";
import type {
  ConnectionCompletionResult,
  RevokeConnectionResult,
  StartConnectionResult,
} from "./backend-contracts.js";
import { isSettledBotCompensation } from "./connection-recovery.js";
import { reconcileComposioProviderConnection } from "./provider-reconciliation.js";

export interface ComposioConnectionStore {
  isPackageInstalled(userId: string, packageId: string): Promise<boolean>;
  getConnection(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionView | undefined>;
  startConnection(
    userId: string,
    input: {
      connectionId: string;
      packageId: string;
      connectionTypeId: string;
      displayName: string;
      safeMetadata?: ConnectionView["safeMetadata"];
    },
  ): Promise<boolean>;
  recordConnectLinkResult(
    userId: string,
    connectionId: string,
    safeMetadata: ConnectionView["safeMetadata"],
  ): Promise<boolean>;
  recordLinkReconciliationIdentity(
    userId: string,
    connectionId: string,
    safeMetadata: ConnectionView["safeMetadata"],
  ): Promise<boolean>;
  finishConnectionAuthorization(
    userId: string,
    connectionId: string,
    update: {
      state: "ready" | "failed";
      safeMetadata?: ConnectionView["safeMetadata"];
      failure?: string;
      authorizationStateId?: string;
    },
  ): Promise<boolean>;
  consumeAuthorizationState(
    userId: string,
    connectionId: string,
    authorizationStateId: string,
  ): Promise<"claimed" | "duplicate" | "invalid">;
  admitConnectionCallback(
    userId: string,
    connectionId: string,
    input: {
      authorizationStateId: string;
      connectedAccountId: string;
      leaseId: string;
      verifiedMetadata?: ConnectionView["safeMetadata"];
    },
  ): Promise<{
    phase: "acquired" | "resumable" | "pending" | "done" | "invalid";
    connection: ConnectionView;
    leaseId?: string;
  }>;
  claimConnectionAssignment(
    userId: string,
    connectionId: string,
    leaseId: string,
    verifiedMetadata?: ConnectionView["safeMetadata"],
  ): Promise<{
    phase: "acquired" | "pending" | "done";
    connection: ConnectionView;
  }>;
  finishConnectionAssignment(
    userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean>;
  requireAssignmentCompensation(
    userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean>;
  recordAssignmentCompensated(
    userId: string,
    connectionId: string,
    compensationId: string,
  ): Promise<boolean>;
  recordConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean>;
  requireConnectionReconciliation(
    userId: string,
    connectionId: string,
    operation: "link" | "revoke",
    failure: string,
  ): Promise<boolean>;
  claimConnectionRevocation(
    userId: string,
    connectionId: string,
    recoveredSafeMetadata?: ConnectionView["safeMetadata"],
  ): Promise<{
    phase: "provider" | "finalize" | "pending" | "done";
    connection: ConnectionView;
  }>;
  recordRevocationProviderCompleted(
    userId: string,
    connectionId: string,
  ): Promise<boolean>;
  finishConnectionRevocation(
    userId: string,
    connectionId: string,
  ): Promise<boolean>;
}

export interface ComposioConnectionTypeConfig {
  authConfigId: string;
  displayName: string;
  toolkitSlug: string;
}

export interface ComposioConnectionCoordinatorConfig {
  client: ComposioClient;
  store: ComposioConnectionStore;
  callbackBaseUrl: string;
  connectionTypes: Record<string, ComposioConnectionTypeConfig>;
  markBotUnavailable?: (
    userId: string,
    botId: string,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ) => Promise<"applied" | "stale">;
}

export class DefinitiveConnectionOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitiveConnectionOperationError";
  }
}

function durableCompletionResult(
  connection: ConnectionView,
): ConnectionCompletionResult | undefined {
  const returnTarget =
    connection.safeMetadata.returnTarget === "desktop" ? "desktop" : "browser";
  const nativeReturnNonce =
    typeof connection.safeMetadata.nativeReturnNonce === "string"
      ? connection.safeMetadata.nativeReturnNonce
      : undefined;
  if (connection.state === "ready" || connection.state === "failed") {
    return {
      returnTarget,
      status: connection.state,
      nativeReturnNonce,
    };
  }
  if (
    connection.state === "reconciliation-required" &&
    connection.safeMetadata.reconciliationOperation === "assignment"
  ) {
    return { returnTarget, status: "pending", nativeReturnNonce };
  }
  return undefined;
}

function connectionStartCommandFingerprintV1(
  userId: string,
  input: {
    connectionTypeId: string;
    alias?: string;
    returnTarget: "browser" | "desktop";
  },
): string {
  return `connection-start-command-v1:${JSON.stringify({
    userId,
    packageId: "composio",
    connectionTypeId: input.connectionTypeId,
    alias: input.alias ?? null,
    safeMetadata: {
      returnTarget: input.returnTarget,
    },
  })}`;
}

function decodeConnectionStartReplayV1(
  connection: ConnectionView,
  commandFingerprint: string,
): StartConnectionResult | undefined {
  const value = connection.safeMetadata.connectionStartReplay;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (
    value.schemaVersion !== 1 ||
    value.commandFingerprint !== commandFingerprint ||
    value.connectionId !== connection.connectionId ||
    typeof value.redirectUrl !== "string" ||
    typeof value.expiresAt !== "string" ||
    (value.nativeReturnNonce !== undefined &&
      typeof value.nativeReturnNonce !== "string")
  ) {
    return undefined;
  }
  return {
    connectionId: value.connectionId,
    redirectUrl: value.redirectUrl,
    expiresAt: value.expiresAt,
    ...(value.nativeReturnNonce
      ? { nativeReturnNonce: value.nativeReturnNonce }
      : {}),
  };
}

export class ComposioConnectionCoordinator {
  constructor(private readonly config: ComposioConnectionCoordinatorConfig) {}

  async start(
    userId: string,
    input: {
      commandId: string;
      connectionTypeId: string;
      alias?: string;
      returnTarget?: "browser" | "desktop";
      callbackState?: string;
      authorizationStateId?: string;
      authorizationStateExpiresAt?: number;
      nativeReturnNonce?: string;
    },
  ): Promise<StartConnectionResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId)) {
      throw new Error("Connection commandId is invalid");
    }
    const connectionId = input.commandId;
    const alias = input.alias?.trim() || undefined;
    const returnTarget = input.returnTarget ?? "browser";
    const commandFingerprint = connectionStartCommandFingerprintV1(userId, {
      connectionTypeId: input.connectionTypeId,
      alias,
      returnTarget,
    });
    const stored = await this.config.store.getConnection(userId, connectionId);
    let type: ComposioConnectionTypeConfig | undefined;
    let claimed = false;
    if (!stored) {
      if (!(await this.config.store.isPackageInstalled(userId, "composio"))) {
        throw new Error("Composio Package is not installed");
      }
      type = this.config.connectionTypes[input.connectionTypeId];
      if (!type) throw new Error("Unknown Composio Connection Type");
      claimed = await this.config.store.startConnection(userId, {
        connectionId,
        packageId: "composio",
        connectionTypeId: input.connectionTypeId,
        displayName: alias ?? type.displayName,
        safeMetadata: {
          toolkitSlug: type.toolkitSlug,
          providerAlias: connectionId,
          returnTarget,
          startCommandFingerprint: commandFingerprint,
          authorizationStateId: input.authorizationStateId ?? connectionId,
          authorizationStateExpiresAt:
            input.authorizationStateExpiresAt ?? Date.now() + 10 * 60_000,
          ...(input.nativeReturnNonce
            ? { nativeReturnNonce: input.nativeReturnNonce }
            : {}),
        },
      });
    }
    if (!claimed) {
      const existing =
        stored ?? (await this.config.store.getConnection(userId, connectionId));
      if (
        existing?.safeMetadata.startCommandFingerprint !== commandFingerprint
      ) {
        throw new Error(
          `Connection command idempotency key "${input.commandId}" was reused for a different command`,
        );
      }
      const admittedToolkitSlug = existing.safeMetadata.toolkitSlug;
      if (typeof admittedToolkitSlug !== "string") {
        throw new Error("Connection command snapshot is invalid");
      }
      if (existing.state === "ready") {
        const replay = decodeConnectionStartReplayV1(
          existing,
          commandFingerprint,
        );
        if (!replay) {
          throw new Error("Connection command replay snapshot is invalid");
        }
        return replay;
      }
      const redirectUrl = existing?.safeMetadata.redirectUrl;
      const expiresAt = existing?.safeMetadata.expiresAt;
      const expiry =
        typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
      const authorizationStateExpiresAt =
        existing?.safeMetadata.authorizationStateExpiresAt;
      const authorizationStateExpiry =
        typeof authorizationStateExpiresAt === "number"
          ? authorizationStateExpiresAt
          : Number.NaN;
      const now = Date.now();
      const authorizationStateExpired =
        !Number.isFinite(authorizationStateExpiry) ||
        authorizationStateExpiry <= now;
      const persistedLinkExpired =
        typeof redirectUrl === "string" &&
        (!Number.isFinite(expiry) || expiry <= now);
      const revocationRequested =
        existing.safeMetadata.revocationRequested === true;
      if (
        existing?.state === "failed" ||
        existing?.state === "revoked" ||
        (!revocationRequested &&
          (authorizationStateExpired || persistedLinkExpired))
      ) {
        if (
          existing?.state === "authorizing" ||
          (existing?.state === "reconciliation-required" &&
            existing.safeMetadata.reconciliationOperation === "link")
        ) {
          await this.config.store.finishConnectionAuthorization(
            userId,
            connectionId,
            {
              state: "failed",
              failure: "Connection authorization expired",
            },
          );
        }
        throw new DefinitiveConnectionOperationError(
          "Connection authorization expired; retry with a new operation",
        );
      }
      if (
        existing?.state === "authorizing" &&
        typeof redirectUrl === "string" &&
        typeof expiresAt === "string" &&
        Number.isFinite(expiry) &&
        expiry > now
      ) {
        return {
          connectionId,
          redirectUrl,
          expiresAt,
          nativeReturnNonce:
            typeof existing?.safeMetadata.nativeReturnNonce === "string"
              ? existing.safeMetadata.nativeReturnNonce
              : undefined,
        };
      }
      if (
        existing?.state === "reconciliation-required" &&
        existing.safeMetadata.reconciliationOperation === "link"
      ) {
        const reconciliation = await reconcileComposioProviderConnection(
          this.config.client,
          {
            operation: "link",
            userId,
            providerAlias: connectionId,
            toolkitSlug: admittedToolkitSlug,
          },
        );
        const account =
          reconciliation.status === "active"
            ? reconciliation.account
            : reconciliation.status === "pending" ||
                reconciliation.status === "failed" ||
                reconciliation.status === "revoked"
              ? reconciliation.account
              : undefined;
        const safeMetadata = account
          ? {
              ...existing.safeMetadata,
              connectedAccountId: account.id,
              toolkitSlug: account.toolkitSlug,
              authorizationStateConsumed: false,
            }
          : undefined;
        if (revocationRequested && reconciliation.status === "absent") {
          const completed =
            await this.config.store.recordRevocationProviderCompleted(
              userId,
              connectionId,
            );
          if (completed) {
            await this.config.store.finishConnectionRevocation(
              userId,
              connectionId,
            );
          }
          throw new DefinitiveConnectionOperationError(
            "Connection was revoked during authorization",
          );
        }
        if (revocationRequested && safeMetadata) {
          if (reconciliation.status === "revoked") {
            const claim = await this.config.store.claimConnectionRevocation(
              userId,
              connectionId,
              safeMetadata,
            );
            if (claim.phase !== "done") {
              await this.config.store.recordRevocationProviderCompleted(
                userId,
                connectionId,
              );
              await this.config.store.finishConnectionRevocation(
                userId,
                connectionId,
              );
            }
            throw new DefinitiveConnectionOperationError(
              "Connection was revoked during authorization",
            );
          }
          await this.revoke(userId, connectionId, safeMetadata);
          throw new DefinitiveConnectionOperationError(
            "Connection was revoked during authorization",
          );
        }
        if (
          !revocationRequested &&
          (reconciliation.status === "failed" ||
            reconciliation.status === "revoked")
        ) {
          const finished =
            await this.config.store.finishConnectionAuthorization(
              userId,
              connectionId,
              {
                state: "failed",
                failure: "Connection authorization could not be recovered",
              },
            );
          if (!finished) {
            throw new Error(
              "Connection authorization changed during reconciliation",
            );
          }
          throw new DefinitiveConnectionOperationError(
            "Connection authorization failed; retry with a new operation",
          );
        }
        if (reconciliation.status === "pending" && safeMetadata) {
          const recorded =
            await this.config.store.recordLinkReconciliationIdentity(
              userId,
              connectionId,
              safeMetadata,
            );
          if (!recorded) {
            throw new Error(
              "Connection authorization changed during reconciliation",
            );
          }
        }
        if (reconciliation.status === "active" && safeMetadata) {
          const account = reconciliation.account;
          const callbackUrl = new URL(
            "/api/plugins/composio/callback",
            this.config.callbackBaseUrl,
          );
          callbackUrl.searchParams.set(
            "state",
            input.callbackState ?? connectionId,
          );
          callbackUrl.searchParams.set("connected_account_id", account.id);
          const result = {
            connectionId,
            redirectUrl: callbackUrl.toString(),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            ...(input.nativeReturnNonce
              ? { nativeReturnNonce: input.nativeReturnNonce }
              : {}),
          } satisfies StartConnectionResult;
          const finished =
            await this.config.store.finishConnectionAuthorization(
              userId,
              connectionId,
              {
                state: "ready",
                safeMetadata: {
                  ...safeMetadata,
                  authorizationStateConsumed: true,
                  connectionStartReplay: {
                    schemaVersion: 1,
                    commandFingerprint,
                    connectionId: result.connectionId,
                    redirectUrl: result.redirectUrl,
                    expiresAt: result.expiresAt,
                    ...(result.nativeReturnNonce
                      ? { nativeReturnNonce: result.nativeReturnNonce }
                      : {}),
                  },
                },
              },
            );
          if (!finished) {
            throw new Error(
              "Connection authorization changed during reconciliation",
            );
          }
          return result;
        }
      }
      throw new Error("Connection authorization requires reconciliation");
    }
    if (!type) throw new Error("Connection command snapshot is invalid");
    let link: ConnectLink;
    try {
      link = await this.config.client.createConnectLink({
        userId,
        authConfigId: type.authConfigId,
        callbackUrl: `${this.config.callbackBaseUrl}/api/plugins/composio/callback?state=${encodeURIComponent(input.callbackState ?? connectionId)}`,
        alias: connectionId,
      });
    } catch (error) {
      await this.config.store.requireConnectionReconciliation(
        userId,
        connectionId,
        "link",
        "Connect Link outcome requires reconciliation",
      );
      throw error;
    }
    const recorded = await this.config.store.recordConnectLinkResult(
      userId,
      connectionId,
      {
        returnTarget,
        providerAlias: connectionId,
        startCommandFingerprint: commandFingerprint,
        connectedAccountId: link.connectedAccountId,
        redirectUrl: link.redirectUrl,
        toolkitSlug: type.toolkitSlug,
        expiresAt: link.expiresAt,
        authorizationStateId: input.authorizationStateId ?? connectionId,
        authorizationStateExpiresAt:
          input.authorizationStateExpiresAt ?? Date.now() + 10 * 60_000,
        ...(input.nativeReturnNonce
          ? { nativeReturnNonce: input.nativeReturnNonce }
          : {}),
      },
    );
    if (!recorded) {
      throw new Error(
        "Connection authorization changed while creating its link",
      );
    }
    const afterLink = await this.config.store.getConnection(
      userId,
      connectionId,
    );
    if (afterLink?.safeMetadata.revocationRequested === true) {
      await this.revoke(userId, connectionId);
      throw new Error("Connection was revoked while creating its link");
    }
    return {
      connectionId,
      redirectUrl: link.redirectUrl,
      expiresAt: link.expiresAt,
      nativeReturnNonce: input.nativeReturnNonce,
    };
  }

  async fail(
    userId: string,
    connectionId: string,
    message: string,
    authorizationStateId?: string,
  ): Promise<ConnectionCompletionResult> {
    const connection = await this.config.store.getConnection(
      userId,
      connectionId,
    );
    const callbackStateId =
      authorizationStateId ?? connection?.safeMetadata.authorizationStateId;
    if (typeof callbackStateId !== "string") {
      throw new Error("Composio authorization state is invalid or expired");
    }
    if (connection?.safeMetadata.authorizationStateId !== callbackStateId) {
      throw new Error("Composio authorization state is invalid or expired");
    }
    await this.config.store.finishConnectionAuthorization(
      userId,
      connectionId,
      {
        state: "failed",
        failure: message.slice(0, 500),
        authorizationStateId: callbackStateId,
      },
    );
    const current = await this.config.store.getConnection(userId, connectionId);
    const durable = current ? durableCompletionResult(current) : undefined;
    if (durable) return durable;
    throw new Error("Composio authorization state is invalid or expired");
  }

  async revoke(
    userId: string,
    connectionId: string,
    recoveredSafeMetadata?: ConnectionView["safeMetadata"],
  ): Promise<RevokeConnectionResult> {
    const claim = await this.config.store.claimConnectionRevocation(
      userId,
      connectionId,
      recoveredSafeMetadata,
    );
    const connection = claim.connection;
    if (connection.packageId !== "composio") {
      throw new Error("Composio Connection was not admitted");
    }
    if (claim.phase === "done") return { status: "revoked" };
    const connectedAccountId = connection.safeMetadata.connectedAccountId;
    if (typeof connectedAccountId !== "string") {
      return { status: "reconciliation-required" };
    }

    const shouldInvokeProvider = claim.phase === "provider";
    if (
      claim.phase === "pending" &&
      connection.safeMetadata.reconciliationOperation === "revoke"
    ) {
      const reconciliation = await reconcileComposioProviderConnection(
        this.config.client,
        { operation: "revoke", userId, connectedAccountId },
      );
      if (
        reconciliation.status === "revoked" ||
        reconciliation.status === "absent"
      ) {
        await this.config.store.recordRevocationProviderCompleted(
          userId,
          connectionId,
        );
      }
    }
    if (shouldInvokeProvider) {
      try {
        await this.config.client.revokeConnectedAccount(connectedAccountId);
        await this.config.store.recordRevocationProviderCompleted(
          userId,
          connectionId,
        );
      } catch (error) {
        await this.config.store.requireConnectionReconciliation(
          userId,
          connectionId,
          "revoke",
          "Revocation outcome requires reconciliation",
        );
        throw error;
      }
    }

    const refreshed = await this.config.store.getConnection(
      userId,
      connectionId,
    );
    if (refreshed?.safeMetadata.revocationProviderCompleted !== true) {
      return { status: "reconciliation-required" };
    }
    const compensations = Array.isArray(
      refreshed.safeMetadata.assignmentCompensations,
    )
      ? refreshed.safeMetadata.assignmentCompensations
      : typeof refreshed.safeMetadata.targetBotId === "string" &&
          typeof refreshed.safeMetadata.assignmentCompensationId === "string" &&
          typeof refreshed.safeMetadata.assignmentCompensationGeneration ===
            "string"
        ? [
            {
              botId: refreshed.safeMetadata.targetBotId,
              id: refreshed.safeMetadata.assignmentCompensationId,
              expectedGeneration:
                refreshed.safeMetadata.assignmentCompensationGeneration,
            },
          ]
        : [];
    if (this.config.markBotUnavailable) {
      for (const candidate of compensations) {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          return { status: "reconciliation-required" };
        }
        const compensation = candidate as Record<string, unknown>;
        if (
          typeof compensation.botId !== "string" ||
          typeof compensation.id !== "string" ||
          typeof compensation.expectedGeneration !== "string"
        ) {
          return { status: "reconciliation-required" };
        }
        const result = await this.config.markBotUnavailable(
          userId,
          compensation.botId,
          connectionId,
          {
            id: compensation.id,
            expectedGeneration: compensation.expectedGeneration,
          },
        );
        if (isSettledBotCompensation(result)) {
          await this.config.store.recordAssignmentCompensated(
            userId,
            connectionId,
            compensation.id,
          );
        }
      }
    }
    const finished = await this.config.store.finishConnectionRevocation(
      userId,
      connectionId,
    );
    return {
      status: finished ? "revoked" : "reconciliation-required",
    };
  }

  async complete(
    userId: string,
    input: {
      connectionId: string;
      connectedAccountId: string;
      authorizationStateId?: string;
    },
  ): Promise<ConnectionCompletionResult> {
    const connection = await this.config.store.getConnection(
      userId,
      input.connectionId,
    );
    if (!connection || connection.packageId !== "composio") {
      throw new Error("Composio Connection was not admitted");
    }
    const returnTarget =
      connection.safeMetadata.returnTarget === "desktop"
        ? "desktop"
        : "browser";
    const nativeReturnNonce =
      typeof connection.safeMetadata.nativeReturnNonce === "string"
        ? connection.safeMetadata.nativeReturnNonce
        : undefined;
    const authorizationStateId =
      input.authorizationStateId ??
      (connection.safeMetadata.authorizationStateId as string);
    if (connection.safeMetadata.authorizationStateConsumed === true) {
      const durable = durableCompletionResult(connection);
      if (durable) return durable;
    }
    const expectedAccountId = connection.safeMetadata.connectedAccountId;
    if (expectedAccountId !== input.connectedAccountId) {
      throw new Error(
        "Composio callback does not match the admitted Connection",
      );
    }
    let verifiedMetadata: ConnectionView["safeMetadata"] | undefined;
    if (connection.safeMetadata.authorizationStateConsumed !== true) {
      if (
        connection.state !== "authorizing" &&
        !(
          connection.state === "reconciliation-required" &&
          connection.safeMetadata.reconciliationOperation === "link"
        )
      ) {
        throw new Error(
          "Composio Connection cannot complete from its current state",
        );
      }
      const account = await this.config.client.getConnectedAccount(
        input.connectedAccountId,
      );
      if (account.userId !== userId || account.status !== "ACTIVE") {
        throw new Error("Composio connected account is not active");
      }
      verifiedMetadata = {
        ...connection.safeMetadata,
        toolkitSlug: account.toolkitSlug,
        ...(account.alias ? { providerAlias: account.alias } : {}),
      };
    }

    const finished = await this.config.store.finishConnectionAuthorization(
      userId,
      input.connectionId,
      {
        state: "ready",
        safeMetadata: verifiedMetadata,
        authorizationStateId,
      },
    );
    if (finished) {
      return { returnTarget, status: "ready", nativeReturnNonce };
    }

    const current = await this.config.store.getConnection(
      userId,
      input.connectionId,
    );
    if (current?.state === "ready") {
      return { returnTarget, status: "ready", nativeReturnNonce };
    }
    throw new Error("Connection state changed during authorization completion");
  }
}
