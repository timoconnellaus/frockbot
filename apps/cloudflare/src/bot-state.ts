import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationAssignedRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationRuntimeApplication,
} from "@frockbot/application-foundation/runtime";
import {
  createFoundationResidentRuntime,
  type FoundationResidentRuntime,
} from "@frockbot/agent-runtime/runtime";
import { Context } from "cordis";
import {
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
} from "@frockbot/configuration-core";
import type {
  BotStateEnv,
  OwnedBotTurnCommand,
  ShellBotBackendContribution,
} from "@frockbot/plugin-shell/backend";
import type {
  BotResidentExecution,
  BotResidentProjection,
} from "@frockbot/plugin-shell/backend-execution";
import { executeResidentBotTurn } from "@frockbot/plugin-shell/backend-runner";
import { createShellBotBackendPlugin } from "@frockbot/plugin-shell/backend";
import {
  createFlockBotBackendPlugin,
  type FlockBotBackendContribution,
} from "@frockbot/plugin-flock/bot";
import {
  decodeBotLifecycleCommandV1,
  decodeBotRegistrationV1,
  decodeUpdateSheepCommandV1,
  type BotLifecycleCommandV1,
  type BotRegistrationV1,
} from "@frockbot/plugin-flock/shared";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  type ClientRunListQueryV1,
  type ClientRunLookupQueryV1,
  type ClientRunStopCommandV1,
} from "@frockbot/plugin-shell/run-protocol";
import {
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
  rpcBotId,
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
    botId: rpcBotId,
  });
  return {
    userId: request.userId as string,
    botId: request.botId as string,
  };
}

export class BotState extends DurableObject<BotStateEnv> {
  private residentRuntime: Promise<FoundationResidentRuntime> | undefined;
  private residentGeneration: number | undefined;

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
      const creating = compileFoundationApplication().then(async (plan) => {
        const root = new Context();
        const readSecret = (name: string) => {
          // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
          const value = (this.env as unknown as Record<string, unknown>)[name];
          return typeof value === "string" ? value : undefined;
        };
        const runtimeFor = (projection: BotResidentProjection) => {
          if (!this.residentRuntime) {
            const creating = Promise.all([
              createFoundationRuntimeApplication(),
              Promise.resolve(
                createFoundationHostedRuntimePackages(plan, {
                  userId: projection.userId,
                  readSecret,
                }),
              ),
            ])
              .then(([application, stableAgentPackages]) =>
                createFoundationResidentRuntime(root, {
                  application,
                  memory: projection.memory,
                  stableAgentPackages,
                }),
              )
              .catch((error) => {
                if (this.residentRuntime === creating) {
                  this.residentRuntime = undefined;
                }
                throw error;
              });
            this.residentRuntime = creating;
          }
          return this.residentRuntime;
        };
        const execution: BotResidentExecution = {
          project: async (projection) => {
            const runtime = await runtimeFor(projection);
            const assigned = await createFoundationAssignedRuntimePackages(
              plan,
              projection.settings,
              projection.executionPlan,
              {
                userId: projection.userId,
                readSecret,
                authorizeConnection: projection.authorizeConnection,
              },
            );
            await runtime.project({
              generation: projection.generation,
              agentPackages: assigned,
              systemPromptSection: projection.systemPromptSection,
            });
            this.residentGeneration = projection.generation;
          },
          execute: async (input) => {
            const runtime = await this.residentRuntime;
            if (!runtime) {
              throw new Error("resident Bot runtime projection is unavailable");
            }
            return executeResidentBotTurn(runtime, input);
          },
          cancel: async (cancellation) => {
            const runtime = await this.residentRuntime?.catch(() => undefined);
            return (
              runtime?.cancel({
                sessionId: cancellation.sessionId,
                runId: cancellation.runId,
                reason: cancellation.reason,
              }) ?? false
            );
          },
          generation: () => this.residentGeneration,
        };
        let shell: ShellBotBackendContribution | undefined;
        let flock: FlockBotBackendContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          ShellBotBackendContribution | FlockBotBackendContribution
        >(
          plan,
          {
            backendHost: "bot",
            resolve: (specifier, lifecycle) => {
              if (specifier === "@frockbot/plugin-shell/backend") {
                return createShellBotBackendPlugin(
                  {
                    state: this.ctx,
                    env: this.env,
                    execution,
                    assertLifecycleActive: (storage, botId) => {
                      if (!flock)
                        throw new Error(
                          "Flock Bot Contribution is unavailable",
                        );
                      return flock.assertActive(storage, botId);
                    },
                  },
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
                        throw new Error(
                          "Shell Bot Contribution is unavailable",
                        );
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
                    archiveEligible: (storage) => {
                      if (!shell)
                        throw new Error(
                          "Shell Bot Contribution is unavailable",
                        );
                      return shell.archiveEligible(storage);
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
          },
          root,
        );
        if (!shell || !flock || mounted.contributions.length !== 2) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Shell and Flock Bot backend Contributions",
          );
        }
        return {
          shell,
          flock,
          async dispose() {
            await Promise.allSettled([mounted.dispose(), root.fiber.dispose()]);
          },
        };
      });
      this.mounted = creating;
      void creating.catch(() => {
        if (this.mounted === creating) this.mounted = undefined;
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
      structuredClone(
        await rpc.getBotRegistration({ schemaVersion: 1, ...identity }),
      ),
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
      botId: rpcBotId,
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

  async readLifecycle(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.readLifecycle(registration, identity.userId);
  }

  async executeLifecycle(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeBotLifecycleCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const command = request.command as BotLifecycleCommandV1;
    if (command.botId !== identity.botId)
      throw new Error("lifecycle command does not match Bot authority");
    const { flock, registration } = await this.materialized(identity);
    return flock.executeLifecycle(registration, identity.userId, command);
  }

  async markConnectionUnavailable(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
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

  async readRuntimeProjection(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.readRuntimeProjection();
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

  async stopRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeClientRunStopCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.stopRun(identity, request.command as ClientRunStopCommandV1);
  }

  async reconcileRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
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
      botId: rpcBotId,
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
      botId: rpcBotId,
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
      botId: rpcBotId,
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
      botId: rpcBotId,
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
    await (await this.contribution()).alarm();
  }
}
