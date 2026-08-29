import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import {
  decodeConnectionDependencyRequirementV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
} from "@frockbot/configuration-core";
import { reconcileComposioProviderConnection } from "@frockbot/plugin-composio";
import { ComposioClient } from "@frockbot/plugin-composio/client";
import type {
  ComposioUserBackendContribution,
  StartConnectionInput,
  UserConfigurationEnv,
} from "@frockbot/plugin-composio/user-configuration";
import { createComposioUserBackendContribution } from "@frockbot/plugin-composio/user-configuration";
import {
  decodeRpcEnvelopeV1,
  decodeStartConnectionRpcV1,
  rpcDecoded,
  rpcEnum,
  rpcIdentifier,
  rpcJsonRecord,
  rpcObject,
  rpcString,
} from "./durable-rpc.js";

export type { StartConnectionInput };

function decodeConnectionRequest(input: unknown): {
  userId: string;
  connectionId: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    connectionId: rpcIdentifier,
  });
  return {
    userId: request.userId as string,
    connectionId: request.connectionId as string,
  };
}

function decodeConnectionMetadataRequest(input: unknown): {
  userId: string;
  connectionId: string;
  safeMetadata: Parameters<
    ComposioUserBackendContribution["recordConnectLinkResult"]
  >[2];
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    connectionId: rpcIdentifier,
    safeMetadata: rpcJsonRecord,
  });
  return {
    userId: request.userId as string,
    connectionId: request.connectionId as string,
    safeMetadata: request.safeMetadata as Parameters<
      ComposioUserBackendContribution["recordConnectLinkResult"]
    >[2],
  };
}

function decodeLeaseRequest(input: unknown): {
  userId: string;
  connectionId: string;
  leaseId: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    connectionId: rpcIdentifier,
    leaseId: rpcIdentifier,
  });
  return {
    userId: request.userId as string,
    connectionId: request.connectionId as string,
    leaseId: request.leaseId as string,
  };
}

function decodeDependencyRequest(input: unknown): {
  userId: string;
  connectionId: string;
  botId: string;
  generation: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    connectionId: rpcIdentifier,
    botId: rpcIdentifier,
    generation: rpcIdentifier,
  });
  return {
    userId: request.userId as string,
    connectionId: request.connectionId as string,
    botId: request.botId as string,
    generation: request.generation as string,
  };
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<ComposioUserBackendContribution> | undefined;

  private contribution(): Promise<ComposioUserBackendContribution> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) => {
        const contributions = createFoundationBackendContributions(plan, {
          backendHost: "user",
          mount: (specifier) => {
            if (specifier !== "@frockbot/plugin-composio/user-configuration") {
              throw new Error(`Unsupported User Contribution: ${specifier}`);
            }
            const client = () => {
              const apiKey = this.env.COMPOSIO_API_KEY;
              if (!apiKey) {
                throw new Error("Composio API key is not configured");
              }
              return new ComposioClient({ apiKey });
            };
            return createComposioUserBackendContribution({
              state: this.ctx,
              env: this.env,
              reconcileProviderConnection: (request) =>
                reconcileComposioProviderConnection(client(), request),
              revokeConnectedAccount: (connectedAccountId) =>
                client().revokeConnectedAccount(connectedAccountId),
              availablePackages: plan.packages.map((pkg) => ({
                packageId: pkg.id,
                version: pkg.version,
              })),
            });
          },
        });
        if (contributions.length !== 1) {
          throw new Error("Foundation requires one User backend Contribution");
        }
        return contributions[0]!;
      });
    }
    return this.mounted;
  }

  async readConfiguration(input: unknown) {
    return (await this.contribution()).readConfiguration(
      decodeUserConfigurationReadRpcV1(input),
    );
  }

  async executeConfiguration(input: unknown) {
    return (await this.contribution()).executeConfiguration(
      decodeUserConfigurationExecuteRpcV1(input),
    );
  }

  async isPackageInstalled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
    });
    return (await this.contribution()).isPackageInstalled(
      request.userId as string,
      request.packageId as string,
    );
  }

  async getConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    return (await this.contribution()).getConnection(
      request.userId as string,
      request.connectionId as string,
    );
  }

  async startConnection(input: unknown) {
    const request = decodeStartConnectionRpcV1(input);
    return (await this.contribution()).startConnection(
      request.userId,
      request.connection as StartConnectionInput,
    );
  }

  async recordConnectLinkResult(input: unknown) {
    const request = decodeConnectionMetadataRequest(input);
    return (await this.contribution()).recordConnectLinkResult(
      request.userId,
      request.connectionId,
      request.safeMetadata,
    );
  }

  async recordLinkReconciliationIdentity(input: unknown) {
    const request = decodeConnectionMetadataRequest(input);
    return (await this.contribution()).recordLinkReconciliationIdentity(
      request.userId,
      request.connectionId,
      request.safeMetadata,
    );
  }

  async claimLostLinkCleanup(input: unknown) {
    const request = decodeConnectionMetadataRequest(input);
    return (await this.contribution()).claimLostLinkCleanup(
      request.userId,
      request.connectionId,
      request.safeMetadata,
    );
  }

  async finishConnectionAuthorization(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      update: rpcObject(
        { state: rpcEnum(["ready", "failed"] as const) },
        {
          safeMetadata: rpcJsonRecord,
          failure: rpcString(),
          authorizationStateId: rpcIdentifier,
        },
      ),
    });
    return (await this.contribution()).finishConnectionAuthorization(
      request.userId as string,
      request.connectionId as string,
      request.update as Parameters<
        ComposioUserBackendContribution["finishConnectionAuthorization"]
      >[2],
    );
  }

  async consumeAuthorizationState(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      authorizationStateId: rpcIdentifier,
    });
    return (await this.contribution()).consumeAuthorizationState(
      request.userId as string,
      request.connectionId as string,
      request.authorizationStateId as string,
    );
  }

  async admitConnectionCallback(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      callback: rpcObject(
        {
          authorizationStateId: rpcIdentifier,
          connectedAccountId: rpcIdentifier,
          leaseId: rpcIdentifier,
        },
        { verifiedMetadata: rpcJsonRecord },
      ),
    });
    return (await this.contribution()).admitConnectionCallback(
      request.userId as string,
      request.connectionId as string,
      request.callback as Parameters<
        ComposioUserBackendContribution["admitConnectionCallback"]
      >[2],
    );
  }

  async claimConnectionAssignment(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        connectionId: rpcIdentifier,
        leaseId: rpcIdentifier,
      },
      { verifiedMetadata: rpcJsonRecord },
    );
    return (await this.contribution()).claimConnectionAssignment(
      request.userId as string,
      request.connectionId as string,
      request.leaseId as string,
      request.verifiedMetadata as Parameters<
        ComposioUserBackendContribution["claimConnectionAssignment"]
      >[3],
    );
  }

  async finishConnectionAssignment(input: unknown) {
    const request = decodeLeaseRequest(input);
    return (await this.contribution()).finishConnectionAssignment(
      request.userId,
      request.connectionId,
      request.leaseId,
    );
  }

  async requireAssignmentCompensation(input: unknown) {
    const request = decodeLeaseRequest(input);
    return (await this.contribution()).requireAssignmentCompensation(
      request.userId,
      request.connectionId,
      request.leaseId,
    );
  }

  async recordAssignmentCompensated(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      compensationId: rpcIdentifier,
    });
    return (await this.contribution()).recordAssignmentCompensated(
      request.userId as string,
      request.connectionId as string,
      request.compensationId as string,
    );
  }

  async claimConnectionDependency(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcIdentifier,
      generation: rpcIdentifier,
      requirement: rpcDecoded(decodeConnectionDependencyRequirementV1),
    });
    return (await this.contribution()).claimConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
      request.requirement as Parameters<
        ComposioUserBackendContribution["claimConnectionDependency"]
      >[4],
    );
  }

  async acknowledgeConnectionDependency(input: unknown) {
    const request = decodeDependencyRequest(input);
    return (await this.contribution()).acknowledgeConnectionDependency(
      request.userId,
      request.connectionId,
      request.botId,
      request.generation,
    );
  }

  async compensateConnectionDependency(input: unknown) {
    const request = decodeDependencyRequest(input);
    return (await this.contribution()).compensateConnectionDependency(
      request.userId,
      request.connectionId,
      request.botId,
      request.generation,
    );
  }

  async recordConnectionDependency(input: unknown) {
    const request = decodeDependencyRequest(input);
    return (await this.contribution()).recordConnectionDependency(
      request.userId,
      request.connectionId,
      request.botId,
      request.generation,
    );
  }

  async requireConnectionReconciliation(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      operation: rpcEnum(["link", "revoke"] as const),
      failure: rpcString(),
    });
    return (await this.contribution()).requireConnectionReconciliation(
      request.userId as string,
      request.connectionId as string,
      request.operation as "link" | "revoke",
      request.failure as string,
    );
  }

  async claimConnectionRevocation(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, connectionId: rpcIdentifier },
      { recoveredSafeMetadata: rpcJsonRecord },
    );
    return (await this.contribution()).claimConnectionRevocation(
      request.userId as string,
      request.connectionId as string,
      request.recoveredSafeMetadata as Parameters<
        ComposioUserBackendContribution["claimConnectionRevocation"]
      >[2],
    );
  }

  async recordRevocationProviderCompleted(input: unknown) {
    const request = decodeConnectionRequest(input);
    return (await this.contribution()).recordRevocationProviderCompleted(
      request.userId,
      request.connectionId,
    );
  }

  async finishConnectionRevocation(input: unknown) {
    const request = decodeConnectionRequest(input);
    return (await this.contribution()).finishConnectionRevocation(
      request.userId,
      request.connectionId,
    );
  }

  async alarm(): Promise<void> {
    await (await this.contribution()).alarm();
  }
}
