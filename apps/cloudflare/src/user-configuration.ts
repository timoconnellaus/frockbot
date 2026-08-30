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
  ConnectionDependencyRouter,
  decodeConnectionDependencyCommandV1,
} from "@frockbot/connection-core";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
} from "@frockbot/plugin-flock/user";
import { decodeCreateBotCommandV1 } from "@frockbot/plugin-flock/shared";
import {
  createUserSettingsBackendPlugin,
  type UserSettingsBackendContribution,
} from "@frockbot/plugin-settings/user";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
} from "./durable-rpc.js";
import { executeUserConnectionDependency } from "./connection-dependency-router.js";

export class UserConfiguration extends DurableObject {
  private readonly connectionDependencies = new ConnectionDependencyRouter();
  private mounted:
    | Promise<{
        settings: UserSettingsBackendContribution;
        flock: FlockUserBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  private contributions(): Promise<{
    settings: UserSettingsBackendContribution;
    flock: FlockUserBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let settings: UserSettingsBackendContribution | undefined;
        let flock: FlockUserBackendContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          UserSettingsBackendContribution | FlockUserBackendContribution
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
        if (!settings || !flock || mounted.contributions.length !== 2) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Settings and Flock User backend Contributions",
          );
        }
        return { settings, flock, dispose: mounted.dispose };
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

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    return (await this.settingsContribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    return (await this.settingsContribution()).executeConfiguration(request);
  }

  async getConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    const settings = await (
      await this.settingsContribution()
    ).readConfiguration({
      schemaVersion: 1,
      userId: request.userId as string,
    });
    return settings.connections.find(
      (connection) => connection.connectionId === request.connectionId,
    );
  }

  async executeConnectionDependency(input: unknown) {
    const command = decodeConnectionDependencyCommandV1(input);
    const settings = await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId: command.userId });
    return executeUserConnectionDependency(
      settings,
      this.connectionDependencies,
      command,
    );
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
