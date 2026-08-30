import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import { decodeConnectionCommandV1 } from "@frockbot/connection-core";
import {
  decodeConnectionDependencyRequirementV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  type ConnectionDependencyRequirementV1,
} from "@frockbot/configuration-core";
import {
  createCredentialUserBackendPlugin,
  type CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
} from "@frockbot/plugin-flock/user";
import { decodeCreateBotCommandV1 } from "@frockbot/plugin-flock/shared";
import {
  createOllamaCloudUserBackendPlugin,
  type OllamaCloudUserBackendContribution,
} from "@frockbot/plugin-provider-ollama-cloud/user";
import {
  createUserSettingsBackendPlugin,
  type UserSettingsBackendContribution,
} from "@frockbot/plugin-settings/user";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcString,
} from "./durable-rpc.js";

interface UserConfigurationEnv {
  CREDENTIAL_KEYRING?: string;
}

interface ConnectionUserBackendContribution {
  readonly packageId: string;
  executeConnection(accountId: string, input: unknown): Promise<unknown>;
  lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<unknown>;
  leaseModelCredential(input: {
    accountId: string;
    connectionId: string;
    providerModelId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<unknown>;
  alarm?(): Promise<void>;
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted:
    | Promise<{
        settings: UserSettingsBackendContribution;
        credentials: CredentialUserBackendContribution;
        connections: ReadonlyMap<string, ConnectionUserBackendContribution>;
        flock: FlockUserBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  private contributions(): Promise<{
    settings: UserSettingsBackendContribution;
    credentials: CredentialUserBackendContribution;
    connections: ReadonlyMap<string, ConnectionUserBackendContribution>;
    flock: FlockUserBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let settings: UserSettingsBackendContribution | undefined;
        let credentials: CredentialUserBackendContribution | undefined;
        let ollama: OllamaCloudUserBackendContribution | undefined;
        let flock: FlockUserBackendContribution | undefined;
        const connections = new Map<
          string,
          ConnectionUserBackendContribution
        >();
        const mounted = await createFoundationBackendContributions<
          | UserSettingsBackendContribution
          | CredentialUserBackendContribution
          | OllamaCloudUserBackendContribution
          | FlockUserBackendContribution
        >(plan, {
          backendHost: "user",
          resolve: (specifier, lifecycle) => {
            if (specifier === "@frockbot/plugin-settings/user") {
              return createUserSettingsBackendPlugin(
                {
                  storage: this.ctx.storage,
                  availablePackages: plan.packages.map((pkg) => ({
                    packageId: pkg.id,
                    version: pkg.version,
                  })),
                },
                {
                  mount(value: UserSettingsBackendContribution) {
                    settings = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-credentials/user") {
              const keyring = this.env.CREDENTIAL_KEYRING;
              if (!keyring) {
                throw new Error(
                  "Credential Store Contribution is not configured",
                );
              }
              return createCredentialUserBackendPlugin(
                { storage: this.ctx.storage, keyring },
                {
                  mount(value: CredentialUserBackendContribution) {
                    credentials = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-provider-ollama-cloud/user") {
              if (!settings || !credentials) {
                throw new Error(
                  "Ollama Cloud requires Settings and Credential Contributions",
                );
              }
              return createOllamaCloudUserBackendPlugin(
                {
                  storage: this.ctx.storage,
                  settings,
                  credentials,
                },
                {
                  mount(value: OllamaCloudUserBackendContribution) {
                    ollama = value;
                    connections.set(value.packageId, value);
                    const dispose = lifecycle.mount(value);
                    return () => {
                      connections.delete(value.packageId);
                      dispose();
                    };
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-flock/user") {
              return createFlockUserBackendPlugin(
                {
                  storage: this.ctx.storage,
                  readUserSettings: (storage) => {
                    if (!settings) {
                      throw new Error(
                        "User settings Contribution is unavailable",
                      );
                    }
                    return settings.readSnapshot(storage);
                  },
                },
                {
                  mount(value: FlockUserBackendContribution) {
                    flock = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            throw new Error(`Unsupported User Contribution: ${specifier}`);
          },
        });
        if (
          !settings ||
          !credentials ||
          !ollama ||
          !flock ||
          mounted.contributions.length !== 4
        ) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Settings, Credentials, Ollama, and Flock User Contributions",
          );
        }
        return {
          settings,
          credentials,
          connections,
          flock,
          dispose: mounted.dispose,
        };
      });
    }
    return this.mounted;
  }

  private async settingsContribution(): Promise<UserSettingsBackendContribution> {
    return (await this.contributions()).settings;
  }

  private async credentialContribution(): Promise<CredentialUserBackendContribution> {
    return (await this.contributions()).credentials;
  }

  private async connectionContribution(
    packageId: string,
  ): Promise<ConnectionUserBackendContribution> {
    const contribution = (await this.contributions()).connections.get(
      packageId,
    );
    if (!contribution) {
      throw new Error(`Connection Package "${packageId}" is unavailable`);
    }
    return contribution;
  }

  private async flockContribution(): Promise<FlockUserBackendContribution> {
    return (await this.contributions()).flock;
  }

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    return (await this.settingsContribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    return (await this.settingsContribution()).executeConfiguration(request);
  }

  async executeConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeConnectionCommandV1),
    });
    const command = request.command as ReturnType<
      typeof decodeConnectionCommandV1
    >;
    const packageId =
      command.type === "connection/create-api-key"
        ? command.packageId
        : (
            await (
              await this.settingsContribution()
            ).getConnection(request.userId as string, command.connectionId)
          )?.packageId;
    if (!packageId) throw new Error("Connection is unavailable");
    return (await this.connectionContribution(packageId)).executeConnection(
      request.userId as string,
      command,
    );
  }

  async lookupConnectionCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    return (
      await this.connectionContribution(request.packageId as string)
    ).lookupConnectionCommand(
      request.userId as string,
      request.commandId as string,
    );
  }

  async getConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    return (await this.settingsContribution()).getConnection(
      request.userId as string,
      request.connectionId as string,
    );
  }

  async leaseModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      providerModelId: rpcString(256),
      effectId: rpcIdentifier,
      connectionGeneration: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) throw new Error("Connection is unavailable");
    return (
      await this.connectionContribution(connection.packageId)
    ).leaseModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      providerModelId: request.providerModelId as string,
      effectId: request.effectId as string,
      connectionGeneration: request.connectionGeneration as string,
    });
  }

  async claimConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
      requirement: rpcDecoded(decodeConnectionDependencyRequirementV1),
    });
    return (await this.settingsContribution()).claimConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
      request.requirement as ConnectionDependencyRequirementV1,
    );
  }

  async acknowledgeConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).acknowledgeConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async releaseConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).releaseConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async compensateConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).compensateConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async settleModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      packageId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    await (await this.settingsContribution()).read(request.userId as string);
    await (
      await this.credentialContribution()
    ).settle({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      packageId: request.packageId as string,
      effectId: request.effectId as string,
    });
  }

  async alarm() {
    const contributions = await this.contributions();
    await contributions.credentials.expireLeases();
    for (const contribution of contributions.connections.values()) {
      await contribution.alarm?.();
    }
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
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).registration(
      request.botId as string,
    );
  }

  async hasBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    return {
      schemaVersion: 1,
      botId,
      registered: await (await this.flockContribution()).hasBot(botId),
    } as const;
  }

  async isPackageInstalled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
    });
    return (await this.settingsContribution()).isPackageInstalled(
      request.userId as string,
      request.packageId as string,
    );
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }
}
