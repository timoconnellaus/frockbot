import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import { decodeConnectionCommandV1 } from "@frockbot/connection-core";
import {
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
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

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted:
    | Promise<{
        settings: UserSettingsBackendContribution;
        credentials: CredentialUserBackendContribution;
        ollama: OllamaCloudUserBackendContribution;
        flock: FlockUserBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  private contributions(): Promise<{
    settings: UserSettingsBackendContribution;
    credentials: CredentialUserBackendContribution;
    ollama: OllamaCloudUserBackendContribution;
    flock: FlockUserBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let settings: UserSettingsBackendContribution | undefined;
        let credentials: CredentialUserBackendContribution | undefined;
        let ollama: OllamaCloudUserBackendContribution | undefined;
        let flock: FlockUserBackendContribution | undefined;
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
          ollama,
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

  private async ollamaContribution(): Promise<OllamaCloudUserBackendContribution> {
    return (await this.contributions()).ollama;
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
    return (await this.ollamaContribution()).executeConnection(
      request.userId as string,
      request.command,
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
    });
    return (await this.ollamaContribution()).leaseModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      providerModelId: request.providerModelId as string,
      effectId: request.effectId as string,
    });
  }

  async settleModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    await (await this.settingsContribution()).read(request.userId as string);
    await (
      await this.credentialContribution()
    ).settle(request.effectId as string);
  }

  async alarm() {
    await (await this.ollamaContribution()).alarm();
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
