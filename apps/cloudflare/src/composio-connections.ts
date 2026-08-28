import type { ConnectionView } from "@frockbot/configuration-core";
import type {
  ComposioClient,
  ConnectLink,
} from "@frockbot/plugin-composio/client";
import type {
  RevokeConnectionResult,
  StartConnectionResult,
} from "./contracts.js";
import type { StartConnectionInput } from "./user-configuration.js";

export interface ComposioConnectionStore {
  isPackageInstalled(userId: string, packageId: string): Promise<boolean>;
  getConnection(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionView | undefined>;
  startConnection(
    userId: string,
    input: StartConnectionInput,
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

export class ComposioConnectionCoordinator {
  constructor(private readonly config: ComposioConnectionCoordinatorConfig) {}

  async start(
    userId: string,
    input: {
      commandId: string;
      connectionTypeId: string;
      botId: string;
      alias?: string;
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
      },
    });
    if (!claimed) {
      const existing = await this.config.store.getConnection(
        userId,
        connectionId,
      );
      const redirectUrl = existing?.safeMetadata.redirectUrl;
      const expiresAt = existing?.safeMetadata.expiresAt;
      if (typeof redirectUrl === "string" && typeof expiresAt === "string") {
        return { connectionId, redirectUrl, expiresAt };
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
            },
          );
          const callbackUrl = new URL(
            "/api/plugins/composio/callback",
            this.config.callbackBaseUrl,
          );
          callbackUrl.searchParams.set("connection", connectionId);
          callbackUrl.searchParams.set("connected_account_id", account.id);
          return {
            connectionId,
            redirectUrl: callbackUrl.toString(),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
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
        callbackUrl: `${this.config.callbackBaseUrl}/api/plugins/composio/callback?connection=${encodeURIComponent(connectionId)}`,
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
        connectedAccountId: link.connectedAccountId,
        redirectUrl: link.redirectUrl,
        toolkitSlug: type.toolkitSlug,
        targetBotId: input.botId,
        expiresAt: link.expiresAt,
      },
    );
    if (!recorded) {
      throw new Error(
        "Connection authorization changed while creating its link",
      );
    }
    return {
      connectionId,
      redirectUrl: link.redirectUrl,
      expiresAt: link.expiresAt,
    };
  }

  async fail(
    userId: string,
    connectionId: string,
    message: string,
  ): Promise<void> {
    await this.config.store.finishConnectionAuthorization(
      userId,
      connectionId,
      {
        state: "failed",
        failure: message.slice(0, 500),
      },
    );
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
    const targetBotId = refreshed.safeMetadata.targetBotId;
    if (typeof targetBotId === "string" && this.config.markBotUnavailable) {
      const compensationId = refreshed.safeMetadata.assignmentCompensationId;
      const expectedGeneration =
        refreshed.safeMetadata.assignmentCompensationGeneration;
      if (
        typeof compensationId !== "string" ||
        typeof expectedGeneration !== "string"
      ) {
        return { status: "reconciliation-required" };
      }
      const result = await this.config.markBotUnavailable(
        userId,
        targetBotId,
        connectionId,
        { id: compensationId, expectedGeneration },
      );
      if (result !== "applied") {
        return { status: "reconciliation-required" };
      }
      await this.config.store.recordAssignmentCompensated(
        userId,
        connectionId,
        compensationId,
      );
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
    input: { connectionId: string; connectedAccountId: string },
  ): Promise<void> {
    let connection = await this.config.store.getConnection(
      userId,
      input.connectionId,
    );
    if (!connection || connection.packageId !== "composio") {
      throw new Error("Composio Connection was not admitted");
    }
    if (connection.state === "ready") return;

    let verifiedMetadata: ConnectionView["safeMetadata"] | undefined;
    if (connection.safeMetadata.reconciliationOperation !== "assignment") {
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
      const expectedAccountId = connection.safeMetadata.connectedAccountId;
      if (expectedAccountId !== input.connectedAccountId) {
        throw new Error(
          "Composio callback does not match the admitted Connection",
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

    const leaseId = crypto.randomUUID();
    const claim = await this.config.store.claimConnectionAssignment(
      userId,
      input.connectionId,
      leaseId,
      verifiedMetadata,
    );
    if (claim.phase === "done") return;
    if (claim.phase === "pending") {
      if (
        claim.connection.safeMetadata.reconciliationOperation === "assignment"
      ) {
        return;
      }
      throw new Error("Connection state changed during callback verification");
    }
    connection = claim.connection;
    const targetBotId = connection.safeMetadata.targetBotId;
    if (typeof targetBotId === "string" && this.config.assignBot) {
      await this.config.assignBot(
        userId,
        targetBotId,
        input.connectionId,
        leaseId,
      );
    }
    const finished = await this.config.store.finishConnectionAssignment(
      userId,
      input.connectionId,
      leaseId,
    );
    if (finished) return;

    const current = await this.config.store.getConnection(
      userId,
      input.connectionId,
    );
    if (current?.state === "ready") return;
    const compensationClaimed =
      await this.config.store.requireAssignmentCompensation(
        userId,
        input.connectionId,
        leaseId,
      );
    if (
      compensationClaimed &&
      typeof targetBotId === "string" &&
      this.config.markBotUnavailable
    ) {
      const result = await this.config.markBotUnavailable(
        userId,
        targetBotId,
        input.connectionId,
        { id: leaseId, expectedGeneration: leaseId },
      );
      if (result === "applied") {
        await this.config.store.recordAssignmentCompensated(
          userId,
          input.connectionId,
          leaseId,
        );
      }
    }
    throw new Error("Connection state changed during Bot assignment");
  }
}
