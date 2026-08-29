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
import { createComposioUserBackendPlugin } from "@frockbot/plugin-composio/user-configuration";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
} from "@frockbot/plugin-flock/user";
import { decodeCreateBotCommandV1 } from "@frockbot/plugin-flock/shared";
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
  private mounted:
    | Promise<{
        composio: ComposioUserBackendContribution;
        flock: FlockUserBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  private contributions(): Promise<{
    composio: ComposioUserBackendContribution;
    flock: FlockUserBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let composio: ComposioUserBackendContribution | undefined;
        let flock: FlockUserBackendContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          ComposioUserBackendContribution | FlockUserBackendContribution
        >(plan, {
          backendHost: "user",
          resolve: (specifier, lifecycle) => {
            if (specifier === "@frockbot/plugin-composio/user-configuration") {
              const client = () => {
                const apiKey = this.env.COMPOSIO_API_KEY;
                if (!apiKey)
                  throw new Error("Composio API key is not configured");
                return new ComposioClient({ apiKey });
              };
              return createComposioUserBackendPlugin(
                {
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
                },
                {
                  mount(value) {
                    composio = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-flock/user") {
              return createFlockUserBackendPlugin(
                {
                  storage: this.ctx.storage,
                  readUserSettings: (storage) => {
                    if (!composio)
                      throw new Error(
                        "User configuration Contribution is unavailable",
                      );
                    return composio.readSnapshot(storage);
                  },
                },
                {
                  mount(value) {
                    flock = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            throw new Error(`Unsupported User Contribution: ${specifier}`);
          },
        });
        if (!composio || !flock || mounted.contributions.length !== 2) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Composio and Flock User backend Contributions",
          );
        }
        return { composio, flock, dispose: mounted.dispose };
      });
    }
    return this.mounted;
  }

  private async contribution(): Promise<ComposioUserBackendContribution> {
    return (await this.contributions()).composio;
  }

  private async flockContribution(): Promise<FlockUserBackendContribution> {
    return (await this.contributions()).flock;
  }

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    return (await this.contribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    return (await this.contribution()).executeConfiguration(request);
  }

  async listBots(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).listBots();
  }

  async createBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeCreateBotCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).createBot(
      request.userId as string,
      request.command as ReturnType<typeof decodeCreateBotCommandV1>,
    );
  }

  async getBotRegistration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).registration(
      request.botId as string,
    );
  }

  async hasBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).hasBot(request.botId as string);
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    const settings = await (
      await this.contribution()
    ).readConfiguration({ schemaVersion: 1, userId });
    if (!settings) throw new Error("User authority is unavailable");
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
