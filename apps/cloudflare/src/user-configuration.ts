import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import {
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
} from "@frockbot/configuration-core";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
} from "@frockbot/plugin-flock/user";
import { decodeCreateBotCommandV1 } from "@frockbot/plugin-flock/shared";
import {
  createPackagePublisherUserPlugin,
  type PackagePublisherUserContribution,
} from "@frockbot/plugin-package-publisher/user";
import {
  decodePublishPackageCommandV1,
  decodeRollbackPackageCommandV1,
} from "@frockbot/plugin-package-publisher/shared";
import {
  createUserSettingsBackendPlugin,
  type UserSettingsBackendContribution,
} from "@frockbot/plugin-settings/user";
import type { WorkerLoader } from "./contracts.js";
import { createPackagePublicationHost } from "./package-publication.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
} from "./durable-rpc.js";

interface UserConfigurationEnv {
  APPLICATION_ARTIFACTS: R2Bucket;
  USER_APPLICATIONS: WorkerLoader;
}

interface UserContributions {
  settings: UserSettingsBackendContribution;
  flock: FlockUserBackendContribution;
  publisher: PackagePublisherUserContribution;
  dispose(): Promise<void>;
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<UserContributions> | undefined;

  private contributions(): Promise<UserContributions> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let settings: UserSettingsBackendContribution | undefined;
        let flock: FlockUserBackendContribution | undefined;
        let publisher: PackagePublisherUserContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          | UserSettingsBackendContribution
          | FlockUserBackendContribution
          | PackagePublisherUserContribution
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
            if (specifier === "@frockbot/plugin-package-publisher/user") {
              return createPackagePublisherUserPlugin(
                createPackagePublicationHost(this.env, this.ctx.storage),
                {
                  mount(value: PackagePublisherUserContribution) {
                    publisher = value;
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
          !flock ||
          !publisher ||
          mounted.contributions.length !== 3
        ) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Settings, Flock, and Package Publisher User backend Contributions",
          );
        }
        return { settings, flock, publisher, dispose: mounted.dispose };
      });
    }
    return this.mounted;
  }

  private async settingsContribution(): Promise<UserSettingsBackendContribution> {
    return (await this.contributions()).settings;
  }

  private async flockContribution(): Promise<FlockUserBackendContribution> {
    return (await this.contributions()).flock;
  }

  private async publisherContribution(): Promise<PackagePublisherUserContribution> {
    return (await this.contributions()).publisher;
  }

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    return (await this.settingsContribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    return (await this.settingsContribution()).executeConfiguration(request);
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

  async readPackageRevisions(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).read();
  }

  async publishPackage(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodePublishPackageCommandV1),
    });
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    return (await this.publisherContribution()).publish(
      userId,
      request.command as ReturnType<typeof decodePublishPackageCommandV1>,
    );
  }

  async rollbackPackage(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeRollbackPackageCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).rollback(
      request.command as ReturnType<typeof decodeRollbackPackageCommandV1>,
    );
  }

  async activeApplicationHash(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).activeApplicationHash();
  }

  async alarm(): Promise<void> {
    await (await this.publisherContribution()).recover();
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }
}
