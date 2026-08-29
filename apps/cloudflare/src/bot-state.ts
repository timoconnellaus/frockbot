import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import {
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
} from "@frockbot/configuration-core";
import type {
  BotStateEnv,
  OwnedBotTurnCommand,
  ShellBotBackendContribution,
} from "@frockbot/plugin-shell/backend";
import { createShellBotBackendPlugin } from "@frockbot/plugin-shell/backend";
import {
  createFlockBotBackendPlugin,
  type FlockBotBackendContribution,
} from "@frockbot/plugin-flock/bot";
import {
  decodeBotRegistrationV1,
  decodeUpdateSheepCommandV1,
  type BotRegistrationV1,
} from "@frockbot/plugin-flock/shared";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  type ClientRunListQueryV1,
  type ClientRunLookupQueryV1,
} from "@frockbot/plugin-shell/run-protocol";
import {
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
  rpcDecoded,
  rpcIdentifier,
  rpcObject,
} from "./durable-rpc.js";

export type { BotStateEnv, OwnedBotTurnCommand };

function decodeBotIdentityRpcV1(input: unknown): {
  userId: string;
  botId: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcIdentifier,
  });
  return {
    userId: request.userId as string,
    botId: request.botId as string,
  };
}

export class BotState extends DurableObject<BotStateEnv> {
  private mounted:
    | Promise<{
        shell: ShellBotBackendContribution;
        flock: FlockBotBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  private contributions(): Promise<{
    shell: ShellBotBackendContribution;
    flock: FlockBotBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then(async (plan) => {
        let shell: ShellBotBackendContribution | undefined;
        let flock: FlockBotBackendContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          ShellBotBackendContribution | FlockBotBackendContribution
        >(plan, {
          backendHost: "bot",
          resolve: (specifier, lifecycle) => {
            if (specifier === "@frockbot/plugin-shell/backend") {
              return createShellBotBackendPlugin(
                { state: this.ctx, env: this.env },
                {
                  mount(value) {
                    shell = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-flock/bot") {
              return createFlockBotBackendPlugin(
                {
                  storage: this.ctx.storage,
                  materializeSettings: (registration, userId) => {
                    if (!shell)
                      throw new Error("Shell Bot Contribution is unavailable");
                    return shell
                      .materializeSettings(
                        { userId, botId: registration.botId },
                        {
                          name: registration.initialName,
                          model: registration.initialModel,
                        },
                      )
                      .then(() => undefined);
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
            throw new Error(`Unsupported Bot Contribution: ${specifier}`);
          },
        });
        if (!shell || !flock || mounted.contributions.length !== 2) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Shell and Flock Bot backend Contributions",
          );
        }
        return { shell, flock, dispose: mounted.dispose };
      });
    }
    return this.mounted;
  }

  private async registration(identity: {
    userId: string;
    botId: string;
  }): Promise<BotRegistrationV1> {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot infer its generated Flock RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      getBotRegistration(input: unknown): Promise<BotRegistrationV1>;
    };
    return decodeBotRegistrationV1(
      await rpc.getBotRegistration({ schemaVersion: 1, ...identity }),
    );
  }

  private async materialized(identity: { userId: string; botId: string }) {
    const contributions = await this.contributions();
    const registration = await this.registration(identity);
    await contributions.flock.materialize(registration, identity.userId);
    return { ...contributions, registration };
  }

  private async contribution(): Promise<ShellBotBackendContribution> {
    return (await this.contributions()).shell;
  }

  async readConfiguration(input: unknown) {
    const request = decodeBotConfigurationReadRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return shell.readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return shell.executeConfiguration(request);
  }

  async readSheep(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.read(registration, identity.userId);
  }

  async updateSheep(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      command: rpcDecoded(decodeUpdateSheepCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    return flock.update(
      registration,
      identity.userId,
      request.command as ReturnType<typeof decodeUpdateSheepCommandV1>,
    );
  }

  async markConnectionUnavailable(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      connectionId: rpcIdentifier,
      compensation: rpcObject({
        id: rpcIdentifier,
        expectedGeneration: rpcIdentifier,
      }),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.markConnectionUnavailable(
      identity,
      request.connectionId as string,
      request.compensation as { id: string; expectedGeneration: string },
    );
  }

  async resolveConfiguration(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.resolveConfiguration(identity);
  }

  async run(input: unknown) {
    const request = decodeBotRunRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return shell.run({
      userId: request.userId,
      botId: request.botId,
      ...request.command,
    });
  }

  async reconcileRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      runId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.reconcileRun(identity, request.runId as string);
  }

  async listNotifications(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listNotifications();
  }

  async acknowledgeNotification(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      notificationId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.acknowledgeNotification(request.notificationId as string);
  }

  async listRuns(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      query: rpcDecoded(decodeClientRunListQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRuns(request.query as ClientRunListQueryV1);
  }

  async lookupRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.lookupRun(request.query as ClientRunLookupQueryV1);
  }

  async fenceRunAdmission(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.fenceRunAdmission(
      identity,
      request.query as ClientRunLookupQueryV1,
    );
  }

  async alarm(): Promise<void> {
    const shell = await this.contribution();
    const identity = await shell.readDurableIdentity();
    if (!identity) return;
    const materialized = await this.materialized(identity);
    await materialized.shell.alarm();
  }
}
