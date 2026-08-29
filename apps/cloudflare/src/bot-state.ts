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
import { createShellBotBackendContribution } from "@frockbot/plugin-shell/backend";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
} from "@frockbot/plugin-shell/run-protocol";
import {
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
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
  private mounted: Promise<ShellBotBackendContribution> | undefined;

  private contribution(): Promise<ShellBotBackendContribution> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) => {
        const contributions = createFoundationBackendContributions(plan, {
          backendHost: "bot",
          mount: (specifier) => {
            if (specifier !== "@frockbot/plugin-shell/backend") {
              throw new Error(`Unsupported Bot Contribution: ${specifier}`);
            }
            return createShellBotBackendContribution({
              state: this.ctx,
              env: this.env,
            });
          },
        });
        if (contributions.length !== 1) {
          throw new Error("Foundation requires one Bot backend Contribution");
        }
        return contributions[0]!;
      });
    }
    return this.mounted;
  }

  async readConfiguration(input: unknown) {
    const request = decodeBotConfigurationReadRpcV1(input);
    return (await this.contribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    return (await this.contribution()).executeConfiguration(request);
  }

  async markConnectionUnavailable(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcIdentifier,
        connectionId: rpcIdentifier,
      },
      {
        compensation: rpcObject({
          id: rpcIdentifier,
          expectedGeneration: rpcIdentifier,
        }),
      },
    );
    return (await this.contribution()).markConnectionUnavailable(
      { userId: request.userId as string, botId: request.botId as string },
      request.connectionId as string,
      request.compensation as
        { id: string; expectedGeneration: string } | undefined,
    );
  }

  async resolveConfiguration(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    return (await this.contribution()).resolveConfiguration(identity);
  }

  async run(input: unknown) {
    const request = decodeBotRunRpcV1(input);
    return (await this.contribution()).run({
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
    return (await this.contribution()).reconcileRun(
      { userId: request.userId as string, botId: request.botId as string },
      request.runId as string,
    );
  }

  async listNotifications(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const contribution = await this.contribution();
    await contribution.resolveConfiguration(identity);
    return contribution.listNotifications();
  }

  async acknowledgeNotification(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcIdentifier,
      notificationId: rpcIdentifier,
    });
    const contribution = await this.contribution();
    await contribution.resolveConfiguration({
      userId: request.userId as string,
      botId: request.botId as string,
    });
    return contribution.acknowledgeNotification(
      request.notificationId as string,
    );
  }

  async listRuns(input: unknown) {
    const request = decodeClientRunListQueryV1(input);
    return (await this.contribution()).listRuns(request);
  }

  async lookupRun(input: unknown) {
    const request = decodeClientRunLookupQueryV1(input);
    return (await this.contribution()).lookupRun(request);
  }

  async fenceRunAdmission(input: unknown) {
    const request = decodeClientRunLookupQueryV1(input);
    return (await this.contribution()).fenceRunAdmission(request);
  }

  async alarm(): Promise<void> {
    await (await this.contribution()).alarm();
  }
}
