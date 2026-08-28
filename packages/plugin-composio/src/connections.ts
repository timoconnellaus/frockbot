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
  finishConnectionAuthorization(
    userId: string,
    connectionId: string,
    update: {
      state: "ready" | "failed";
      safeMetadata?: ConnectionView["safeMetadata"];
      failure?: string;
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
  assignBot?: (
    userId: string,
    botId: string,
    connectionId: string,
    leaseId: string,
  ) => Promise<void>;
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

export class ComposioConnectionCoordinator {
  constructor(private readonly config: ComposioConnectionCoordinatorConfig) {}

  async start(
    userId: string,
    input: {
      commandId: string;
      connectionTypeId: string;
      botId: string;
      alias?: string;
      returnTarget?: "browser" | "desktop";
      callbackState?: string;
      authorizationStateId?: string;
      authorizationStateExpiresAt?: number;
      nativeReturnNonce?: string;
    },
  ): Promise<StartConnectionResult> {
    const type = this.config.connectionTypes[input.connectionTypeId];
    if (!type) throw new Error("Unknown Composio Connection Type");
    if (!(await this.config.store.isPackageInstalled(userId, "composio"))) {
      throw new Error("Composio Package is not installed");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId)) {
      throw new Error("Connection commandId is invalid");
    }
    const connectionId = input.commandId;
    const claimed = await this.config.store.startConnection(userId, {
      connectionId,
      packageId: "composio",
      connectionTypeId: input.connectionTypeId,
      displayName: input.alias?.trim() || type.displayName,
      safeMetadata: {
        targetBotId: input.botId,
        toolkitSlug: type.toolkitSlug,
        providerAlias: connectionId,
        returnTarget: input.returnTarget ?? "browser",
        authorizationStateId: input.authorizationStateId ?? connectionId,
        authorizationStateExpiresAt:
          input.authorizationStateExpiresAt ?? Date.now() + 10 * 60_000,
        ...(input.nativeReturnNonce
          ? { nativeReturnNonce: input.nativeReturnNonce }
          : {}),
      },
    });
    if (!claimed) {
      const existing = await this.config.store.getConnection(
        userId,
        connectionId,
      );
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
      if (
        existing?.state === "failed" ||
        existing?.state === "revoked" ||
        authorizationStateExpired ||
        persistedLinkExpired
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
        const account = (
          await this.config.client.listConnectedAccounts(userId)
        ).find(
          (candidate) =>
            candidate.alias === connectionId &&
            candidate.toolkitSlug === type.toolkitSlug,
        );
        if (account?.status === "ACTIVE") {
          await this.config.store.recordConnectLinkResult(
            userId,
            connectionId,
            {
              ...existing.safeMetadata,
              connectedAccountId: account.id,
              toolkitSlug: account.toolkitSlug,
              authorizationStateId: input.authorizationStateId ?? connectionId,
              authorizationStateExpiresAt:
                input.authorizationStateExpiresAt ?? Date.now() + 10 * 60_000,
              authorizationStateConsumed: false,
              ...(input.nativeReturnNonce
                ? { nativeReturnNonce: input.nativeReturnNonce }
                : {}),
            },
          );
          const callbackUrl = new URL(
            "/api/plugins/composio/callback",
            this.config.callbackBaseUrl,
          );
          callbackUrl.searchParams.set(
            "state",
            input.callbackState ?? connectionId,
          );
          callbackUrl.searchParams.set("connected_account_id", account.id);
          return {
            connectionId,
            redirectUrl: callbackUrl.toString(),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            nativeReturnNonce: input.nativeReturnNonce,
          };
        }
      }
      throw new Error("Connection authorization requires reconciliation");
    }
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
        returnTarget: input.returnTarget ?? "browser",
        providerAlias: connectionId,
        connectedAccountId: link.connectedAccountId,
        redirectUrl: link.redirectUrl,
        toolkitSlug: type.toolkitSlug,
        targetBotId: input.botId,
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
    const stateClaim = await this.config.store.consumeAuthorizationState(
      userId,
      connectionId,
      authorizationStateId ??
        (connection?.safeMetadata.authorizationStateId as string),
    );
    if (stateClaim === "duplicate") {
      const current = await this.config.store.getConnection(
        userId,
        connectionId,
      );
      const durable = current ? durableCompletionResult(current) : undefined;
      if (durable) return durable;
    }
    if (stateClaim !== "claimed") {
      throw new Error(
        stateClaim === "duplicate"
          ? "Composio authorization state was already consumed"
          : "Composio authorization state is invalid or expired",
      );
    }
    const finished = await this.config.store.finishConnectionAuthorization(
      userId,
      connectionId,
      {
        state: "failed",
        failure: message.slice(0, 500),
      },
    );
    if (finished)
      return {
        returnTarget:
          connection?.safeMetadata.returnTarget === "desktop"
            ? "desktop"
            : "browser",
        status: "failed",
        nativeReturnNonce:
          typeof connection?.safeMetadata.nativeReturnNonce === "string"
            ? connection.safeMetadata.nativeReturnNonce
            : undefined,
      };
    const current = await this.config.store.getConnection(userId, connectionId);
    if (current?.state !== "ready" && current?.state !== "failed") {
      throw new Error("Connection state changed during failed callback");
    }
    return {
      returnTarget:
        current.safeMetadata.returnTarget === "desktop" ? "desktop" : "browser",
      status: current.state,
      nativeReturnNonce:
        typeof current.safeMetadata.nativeReturnNonce === "string"
          ? current.safeMetadata.nativeReturnNonce
          : undefined,
    };
  }

  async revoke(
    userId: string,
    connectionId: string,
  ): Promise<RevokeConnectionResult> {
    const claim = await this.config.store.claimConnectionRevocation(
      userId,
      connectionId,
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
      const account = (
        await this.config.client.listConnectedAccounts(userId)
      ).find((candidate) => candidate.id === connectedAccountId);
      if (!account || account.status !== "ACTIVE") {
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
        if (result !== "applied") continue;
        await this.config.store.recordAssignmentCompensated(
          userId,
          connectionId,
          compensation.id,
        );
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
    let connection = await this.config.store.getConnection(
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
      const accounts = await this.config.client.listConnectedAccounts(userId);
      const account = accounts.find(
        (candidate) => candidate.id === input.connectedAccountId,
      );
      if (!account || account.status !== "ACTIVE") {
        throw new Error("Composio connected account is not active");
      }
      verifiedMetadata = {
        ...connection.safeMetadata,
        toolkitSlug: account.toolkitSlug,
        ...(account.alias ? { providerAlias: account.alias } : {}),
      };
    }

    const claim = await this.config.store.admitConnectionCallback(
      userId,
      input.connectionId,
      {
        authorizationStateId,
        connectedAccountId: input.connectedAccountId,
        leaseId: crypto.randomUUID(),
        verifiedMetadata,
      },
    );
    if (claim.phase === "done") {
      return (
        durableCompletionResult(claim.connection) ?? {
          returnTarget,
          status: "ready",
          nativeReturnNonce,
        }
      );
    }
    if (claim.phase === "pending") {
      return { returnTarget, status: "pending", nativeReturnNonce };
    }
    if (claim.phase === "invalid" || !claim.leaseId) {
      throw new Error("Connection state changed during callback verification");
    }
    connection = claim.connection;
    const leaseId = claim.leaseId;
    const targetBotId = connection.safeMetadata.targetBotId;
    if (typeof targetBotId === "string" && this.config.assignBot) {
      try {
        await this.config.assignBot(
          userId,
          targetBotId,
          input.connectionId,
          leaseId,
        );
      } catch (error) {
        await this.compensateAssignment(
          userId,
          input.connectionId,
          targetBotId,
          leaseId,
        );
        throw error;
      }
    }
    const finished = await this.config.store.finishConnectionAssignment(
      userId,
      input.connectionId,
      leaseId,
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
    if (typeof targetBotId === "string") {
      await this.compensateAssignment(
        userId,
        input.connectionId,
        targetBotId,
        leaseId,
      );
    }
    throw new Error("Connection state changed during Bot assignment");
  }

  private async compensateAssignment(
    userId: string,
    connectionId: string,
    botId: string,
    leaseId: string,
  ): Promise<void> {
    const compensationClaimed =
      await this.config.store.requireAssignmentCompensation(
        userId,
        connectionId,
        leaseId,
      );
    if (!compensationClaimed || !this.config.markBotUnavailable) return;
    const result = await this.config.markBotUnavailable(
      userId,
      botId,
      connectionId,
      { id: leaseId, expectedGeneration: leaseId },
    );
    if (result === "applied") {
      await this.config.store.recordAssignmentCompensated(
        userId,
        connectionId,
        leaseId,
      );
    }
  }
}
