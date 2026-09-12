// The Composition mount for one Turn: which Packages this Bot runs, which
// model binding they run against, and the host seams each of them is handed.
//
// It is the one place that turns a Bot's settings and its User's configuration
// into a mounted runtime, so both an admitted Turn (`app/shell/turn.ts`) and an
// isolate's `ai` grant (`app/isolates/bot.ts`) resolve the same way.

import {
  decodeSendToUserPayloadV1,
  type NormalizedModelRequest,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import {
  resolveBotExecutionPlanV1,
  resolveEffectiveBotModelV1,
  resolvePackageSettingValuesV1,
  userTimezoneV1,
  type BotSettingsViewV1,
  type ConnectionView,
  type EnabledCapabilityV1,
  type PackageSettingValueV1,
  type ResolvedModelBindingV1,
} from "@frockbot/core/configuration";
import {
  firstPartyFeatureOnForBotV1,
  maskPlanForBotV1,
} from "@frockbot/app/plugins/catalog";
import { readPluginEnablementV1 } from "@frockbot/app/plugins/enablement";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import { appletsRuntimeHost } from "@frockbot/app/applets-host/bot";
import { pluginAuthoringRuntimeHost } from "@frockbot/app/plugins/authoring-bot";
import { decodeAgentTurnSlotReceiptV1 } from "@frockbot/app/flock/quota";
import {
  createBotMachineHost,
  createBotMachineMessagesHost,
  machineSeam,
  resolveBotMachineMessagesGateV1,
} from "@frockbot/app/machine/bot";
import {
  createBotRoutinesHost,
  executeRoutineCommand,
  listRoutines,
  projectRoutineAccountTimezoneV1,
} from "@frockbot/app/routines/bot";
import {
  executeConfigurationCommand,
  readBotSettingsV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import { createBotSkillsHost } from "@frockbot/app/skills/bot";
import { subagentsRuntimeHost } from "@frockbot/app/subagents/bot";
import {
  subagentModelCatalogV1,
  type SubagentModelOptionV1,
} from "@frockbot/app/subagents/models";
import { taskDesktopLeaseOwnerV1 } from "@frockbot/app/subagents/records";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.js";
import { createBotSelfManagementHost } from "./backend-flock.js";
import { createBotImageHost } from "./backend-image.js";
import { createBotMemoryHost } from "./backend-memory.js";
import { executionPackagesV1, type ShellBotStateV1 } from "./backend-state.js";
import { decodeClientTurnV1 } from "./run-protocol.js";
import { turnToolCatalogPin } from "./tool-catalog-pin.js";

/** Narrow RPC for the User-wide agent-lane concurrency lease. */
function agentTurnSlots(state: ShellBotStateV1, identity: BotIdentity) {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  const rpc = state.env.USER_CONFIGURATIONS.get(id) as unknown as {
    reserveAgentTurnSlot(input: unknown): Promise<unknown>;
    releaseAgentTurnSlot(input: unknown): Promise<unknown>;
  };
  return {
    reserve: async (request: unknown) =>
      decodeAgentTurnSlotReceiptV1(await rpc.reserveAgentTurnSlot(request)),
    release: async (request: unknown) => {
      await rpc.releaseAgentTurnSlot(request);
    },
  };
}

/**
 * Public because an isolate's `ai` grant streams through the same mounted
 * Composition a Turn does; `app/isolates/bot.ts` is handed this resolver.
 */
export async function agentRuntime(
  state: ShellBotStateV1,
  identity: BotIdentity,
  settings: BotSettingsViewV1,
  admittedRequest?: NormalizedModelRequest,
  turn?: {
    runId: string;
    turnId: string;
    sessionId: string;
    fromBotName: string;
    /**
     * The generation this Turn pinned, and the type it was admitted as. A
     * dispatched subagent runs on the generation its parent pinned, and the
     * models it may be given are narrowed by the turn type — so both travel
     * with the Turn rather than being resolved a second time.
     */
    compositionGenerationId?: string;
    turnType?: TurnTypeV1;
    /** The subagent role, on a `subagent` Turn that was admitted with one. */
    subagentRole?: string;
    /** The task a child Turn is running, in a Subagent Durable Object. */
    subagentTaskId?: string;
  },
): Promise<{
  agentPackages: FoundationAgentPackage[];
  capabilities: EnabledCapabilityV1[];
  modelSelection: RuntimeModelSelection;
}> {
  const userConfiguration = userConfigurationV1(state, identity);
  const user = await userConfiguration.readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  await projectRoutineAccountTimezoneV1(
    state,
    userTimezoneV1(user.profile),
    user.revision,
  );
  const packageDefinitions = executionPackagesV1(state.application);
  // The account installed the set; which first-party features this Bot runs
  // is its own map, read here so a feature switched off for one Bot
  // contributes nothing to its Turn (ADR 0026). Two things read it: the plan,
  // for the features that mount as enabled Contributions, and the hosted
  // seams below, which never see a plan — a switch that only masked the plan
  // would leave image, routines, subagents and machine messages registering
  // their tools on a Turn the Plugins page reports as off.
  const enablement = await readPluginEnablementV1(state.ctx.storage);
  const featureOn = (packageId: string): boolean =>
    firstPartyFeatureOnForBotV1(packageId, enablement);
  const plan = maskPlanForBotV1(
    resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    }),
    enablement,
  );
  // The durable roots this User's enabled Packages declare, read from the
  // same installations the Composition is resolved from. Handed to the
  // Computer sync below; nothing else reads it.
  const packageRoots = declaredPackageRootsV1({
    installations: user.packages,
    packages: state.application.packages,
  });
  const readSecret = (name: string) => {
    // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
    const value = (state.env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  const authorizeEnabledConnection = (
    capability: EnabledCapabilityV1,
  ): Promise<ConnectionView> => {
    const enabled = plan.capabilities.some(
      (candidate) =>
        candidate.packageId === capability.packageId &&
        candidate.capabilityId === capability.capabilityId &&
        candidate.connectionId === capability.connectionId,
    );
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === capability.connectionId &&
        candidate.packageId === capability.packageId &&
        candidate.state === "ready",
    );
    if (!enabled || !connection) {
      return Promise.reject(
        new Error("Enabled effect is no longer authorized"),
      );
    }
    return Promise.resolve(structuredClone(connection));
  };
  // The Package-level settings this User holds, resolved against the manifest
  // of the Composition this Turn is pinned to. They come from the same `user`
  // read the rest of this Composition uses, so a value the User changed is
  // picked up when the next Turn resolves its Composition and never inside
  // one already running.
  const packageSettings = (
    packageId: string,
  ): Record<string, PackageSettingValueV1> => {
    const installation = user.packages.find(
      (candidate) => candidate.packageId === packageId,
    );
    const declared = state.application.packages.find(
      (definition) => definition.id === packageId,
    );
    return resolvePackageSettingValuesV1(
      [...(declared?.settings ?? [])],
      installation?.values,
    );
  };
  const primitivePackageSettings = (
    packageId: string,
  ): Record<string, string | number | boolean> =>
    Object.fromEntries(
      Object.entries(packageSettings(packageId)).filter(
        (entry): entry is [string, string | number | boolean] =>
          typeof entry[1] !== "object",
      ),
    );
  // The `image.model` Package setting, already checked against the enum the
  // Image Package's definition declares.
  const configuredImageModel = packageSettings("image").model;
  // Row 57g. Resolved before the Composition is built, because the answer
  // decides whether a Package is mounted at all: a feature gate that let the
  // tools exist and refuse would still have told the model they were there.
  // The registry is read only when the setting is on.
  const machines = turn ? machineSeam(state, identity) : undefined;
  const messagesGate =
    machines && featureOn("machine-messages")
      ? await resolveBotMachineMessagesGateV1(
          primitivePackageSettings("machine-messages"),
          () => machines.list(),
        )
      : ({ status: "off" } as const);
  // A Bot builds an Applet only inside an admitted Turn: the publish is a
  // durable effect whose intent record has to name the Session and Turn that
  // asked for it, and the scaffold write names the same writer. Resolved
  // before the Composition is built for the same reason the machine gate is:
  // the answer decides whether the Package is mounted at all.
  const applets = turn
    ? await appletsRuntimeHost(state, identity, turn)
    : undefined;
  // A Bot writes a Plugin only inside an admitted Turn, for the same reason,
  // and only behind the account's Plugin-authoring switch (ADR 0026).
  const plugins = turn
    ? await pluginAuthoringRuntimeHost(state, identity, turn)
    : undefined;
  // Filled in once this Turn's model binding is resolved, below. The tool
  // and the prompt section both read it lazily, from inside the Turn.
  const subagentModels: SubagentModelOptionV1[] = [];
  const resolvedAgentPackages: FoundationAgentPackage[] = [
    ...state.application.runtime.hosted({
      userId: identity.userId,
      readSecret,
      ...(turn
        ? {
            skills: await createBotSkillsHost(state, identity, turn),
          }
        : {}),
      ...(turn
        ? { memory: createBotMemoryHost(identity, turn, state.env) }
        : {}),
      // A Bot generates an image only inside an admitted Turn, whose Session
      // and Turn the Workspace write names as its writer.
      ...(turn && featureOn("image")
        ? {
            image: createBotImageHost(
              identity,
              turn,
              state.env,
              typeof configuredImageModel === "string"
                ? configuredImageModel
                : undefined,
            ),
          }
        : {}),
      ...(applets ? { applets } : {}),
      ...(plugins ? { plugins } : {}),
      // A Bot changes its own identity, or adds a Bot to its User's flock,
      // only inside an admitted Turn whose Session and Turn the write names.
      ...(turn
        ? {
            botSelfManagement: createBotSelfManagementHost(identity, turn, {
              readSettings: (target) => readBotSettingsV1(state, target),
              executeConfiguration: (target, command) =>
                executeConfigurationCommand(state, target, command),
              listBots: (userId) =>
                userConfigurationV1(state, identity).listBots(userId),
              createBot: (userId, command) =>
                userConfigurationV1(state, identity).createBot(userId, command),
              reserveAgentTurn: (request) =>
                agentTurnSlots(state, identity).reserve(request),
              releaseAgentTurn: (request) =>
                agentTurnSlots(state, identity).release(request),
              runAgent: async (request) => {
                if (!state.env.BOT_STATES) {
                  throw new Error("Bot-to-Bot messaging is unavailable");
                }
                const id = state.env.BOT_STATES.idFromName(
                  `${request.userId}:${request.botId}`,
                );
                const rpc = state.env.BOT_STATES.get(id) as unknown as {
                  runAgent(input: unknown): Promise<unknown>;
                };
                const completed = decodeClientTurnV1(
                  structuredClone(await rpc.runAgent(request)),
                );
                let sentText: string | undefined;
                for (const event of completed.events) {
                  if (event.type !== "send/to-user") continue;
                  const payload = decodeSendToUserPayloadV1(
                    event.payload,
                    "agent send/to-user payload",
                  );
                  if (payload.type === "text") {
                    sentText = payload.text;
                    break;
                  }
                }
                return {
                  text: sentText ?? completed.text,
                };
              },
            }),
          }
        : {}),
      // A Bot packs itself into a template only inside an admitted Turn, and
      // only through its User's own staging command: the seam it is handed
      // has no way to publish, so the Bot cannot.
      ...(turn
        ? {
            botTemplate: {
              owner: {
                userId: identity.userId,
                botId: identity.botId,
              },
              stageTemplate: (input: { commandId: string; botId: string }) =>
                userConfigurationV1(state, identity).executeTemplateCommand(
                  identity.userId,
                  {
                    schemaVersion: 1,
                    type: "template/stage",
                    commandId: input.commandId,
                    botId: input.botId,
                  },
                ),
            },
          }
        : {}),
      // A Bot writes a Routine only inside a Turn, so the record's writer can
      // name the Session and Turn that produced it.
      ...(turn && featureOn("routines")
        ? {
            routines: {
              ...createBotRoutinesHost(identity, turn),
              list: () => listRoutines(state, identity),
              execute: (command, writer) =>
                executeRoutineCommand(state, identity, command, writer),
            },
          }
        : {}),
      // A Bot dispatches a subagent only inside an admitted Turn, whose run
      // the task record names, and only where a Subagent Durable Object can
      // actually be addressed.
      ...(turn &&
      turn.compositionGenerationId &&
      state.subagentBinding &&
      featureOn("subagents")
        ? {
            subagents: subagentsRuntimeHost(
              state,
              identity,
              turn,
              turn.compositionGenerationId,
              turn.turnType ?? "chat",
              () => subagentModels,
              turn.subagentTaskId,
            ),
          }
        : {}),
      // The registered machine (rows 48, 49). The control tools mount only
      // inside a Turn, because the intent record they write has to name the
      // Session and Turn that asked — and because the approval that gates
      // them is a send onto that Turn's own durable log.
      ...(turn
        ? {
            machines: createBotMachineHost(
              identity,
              turn,
              state.ctx.storage,
              machineSeam(state, identity),
            ),
          }
        : {}),
      // Row 57g, mounted only behind its whole gate: the User setting on, and
      // a connected macOS machine that reports the `messages` capability.
      ...(turn && machines && messagesGate.status === "ready"
        ? {
            machineMessages: createBotMachineMessagesHost(
              {
                ...createBotMachineHost(
                  identity,
                  turn,
                  state.ctx.storage,
                  machines,
                ),
                writer: {
                  sessionId: turn.sessionId,
                  turnId: turn.turnId,
                  runId: turn.runId,
                },
              },
              machines,
            ),
          }
        : {}),
      // The durable-root sync runs only inside a Turn that uses the
      // Computer. It attributes nothing: a file a shell wrote there reaches
      // object storage with an unattributed writer.
      ...(turn
        ? {
            computerSync: createBotComputerSyncHost(state.env, packageRoots),
            // The same Turn, as the writer a durable Computer write records.
            computerWriter: {
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              runId: turn.runId,
            },
            // A background process is Bot-scoped durable state, so its
            // record lives in this Bot's own Durable Object storage.
            computerProcesses: state.ctx.storage,
            // Prompt assembly reads the Bot DO's Step 1 lease record
            // directly; passing storage wakes no Computer.
            computerControlRecords: state.ctx.storage,
            ...(state.invalidateComputerProjectionFile
              ? {
                  computerProjectionFiles: {
                    invalidate: (
                      botId: string,
                      kind: "screenshots" | "doctor",
                    ) =>
                      state.invalidateComputerProjectionFile?.(
                        identity.userId,
                        botId,
                        kind,
                      ),
                  },
                }
              : {}),
            // A computerUse child is the holder of the User-wide lease its
            // parent acquired. Its guarded commands must name that same
            // durable task owner or the shared fence would refuse itself.
            ...(turn.subagentRole === "computerUse" && turn.subagentTaskId
              ? {
                  computerAgentControlOwnerId: taskDesktopLeaseOwnerV1(
                    identity.botId,
                    turn.subagentTaskId,
                  ),
                }
              : {}),
          }
        : {}),
      // The Computer host this deployment runs, when it has one. Which host
      // that is was chosen by the shell that holds the bindings.
      ...(state.computerHost ? { computerHost: state.computerHost } : {}),
    }),
    ...(await state.application.runtime.enabled(plan, {
      userId: identity.userId,
      readSecret,
      authorizeConnection: authorizeEnabledConnection,
      ...(turn
        ? {
            pinToolCatalog: turnToolCatalogPin(state.ctx.storage, turn.turnId),
          }
        : {}),
      packageSettings,
      // Enabled Contributions reach the network through the same
      // outbound seam the model provider uses, so a deployment that stubs
      // it stubs every one of them.
      ...(state.outboundFetch ? { fetch: state.outboundFetch } : {}),
      leaseCredential: async (
        capability: EnabledCapabilityV1,
        effectId: string,
        expectedGeneration?: string,
      ): Promise<CredentialLeaseV1> => {
        if (!capability.connectionId || !expectedGeneration) {
          throw new Error("Enabled Connection generation is unavailable");
        }
        return userConfiguration.leaseToolCredential(
          identity.userId,
          capability.connectionId,
          effectId,
          expectedGeneration,
        );
      },
      settleCredential: async (
        capability: EnabledCapabilityV1,
        effectId: string,
      ): Promise<void> => {
        if (!capability.connectionId) return;
        await userConfiguration.settleToolCredential(
          identity.userId,
          capability.connectionId,
          effectId,
        );
      },
    })),
  ];
  const agentPackages: FoundationAgentPackage[] = resolvedAgentPackages;
  // One generic resolver owns precedence: enabled Bot-scoped Package value,
  // enabled User-scoped Package value, then the platform model. The kernel
  // names no Package (AGENTS.md Configuration shape).
  const effective = resolveEffectiveBotModelV1({
    bot: settings,
    user,
    packages: packageDefinitions,
  });
  const effectiveModel = effective.model;
  if (!effectiveModel) {
    throw new Error(
      effective.binding?.failure ??
        "No model is set up yet. Choose one in Models.",
    );
  }
  const binding: ResolvedModelBindingV1 = effective.binding ?? {
    model: structuredClone(effectiveModel),
    state: "unavailable",
    failure: "This Bot's model isn't available. Pick one in Models.",
  };
  if (
    binding.state === "unavailable" ||
    !binding.connection ||
    !binding.providerType ||
    !binding.packageId
  ) {
    throw new Error(
      binding.failure ??
        "This Bot's model isn't available. Pick one in Models.",
    );
  }
  if (
    admittedRequest &&
    (admittedRequest.provider !== binding.providerType ||
      admittedRequest.model !== effectiveModel.providerModelId ||
      admittedRequest.modelBinding?.connectionId !==
        binding.connection.connectionId ||
      !admittedRequest.modelBinding.connectionGeneration ||
      admittedRequest.modelBinding.connectionGeneration !==
        binding.connection.generation)
  ) {
    throw new Error(
      "This Bot's model changed mid-reply. Send your message again.",
    );
  }
  const bindingPackageId = binding.packageId;
  agentPackages.push(
    state.application.runtime.model(binding, {
      accountId: identity.userId,
      connectionId: binding.connection.connectionId,
      leaseCredential: (
        effectId,
        expectedGeneration,
      ): Promise<CredentialLeaseV1> => {
        if (!expectedGeneration) {
          throw new Error("Model request Connection generation is unavailable");
        }
        return userConfiguration.leaseModelCredential(
          identity.userId,
          binding.connection!.connectionId,
          effectiveModel.providerModelId,
          effectId,
          expectedGeneration,
        );
      },
      settleCredential: (effectId) =>
        userConfiguration.settleModelCredential(
          identity.userId,
          binding.connection!.connectionId,
          bindingPackageId,
          effectId,
        ),
      ...(state.env.FROCK_AI
        ? {
            frockAiAutoRoute: state.env.FROCK_AI.autoRoute,
            runFrockAiChatCompletion: (gatewayModel, body) =>
              state.env.FROCK_AI!.runChatCompletion(gatewayModel, body),
          }
        : {}),
      fetch: state.outboundFetch,
    }),
  );
  // The slugs `<available_subagent_models>` renders, and the only ones a
  // `Task` call may name. They come from User enablement as resolved for this
  // Turn — never anything the Bot claimed about a model.
  const modelCapability = plan.capabilities.find(
    (candidate) =>
      candidate.kind === "model" &&
      candidate.connectionId === binding.connection!.connectionId,
  );
  if (modelCapability) {
    const subagentBinding = {
      packageId: modelCapability.packageId,
      capabilityId: modelCapability.capabilityId,
      connectionId: binding.connection.connectionId,
      provider: binding.providerType,
      providerModelId: effectiveModel.providerModelId,
      ...(binding.connection.generation
        ? { connectionGeneration: binding.connection.generation }
        : {}),
    };
    subagentModels.push(
      ...subagentModelCatalogV1({
        bindings: [subagentBinding],
        defaultBinding: subagentBinding,
        turnType: turn?.turnType ?? "chat",
      }),
    );
  }
  // Last, so every provider an earlier Package registered is already there.
  agentPackages.push(...state.application.runtime.base());
  return {
    agentPackages,
    capabilities: structuredClone(plan.capabilities),
    modelSelection: {
      provider: binding.providerType,
      model: effectiveModel.providerModelId,
      connectionId: binding.connection.connectionId,
      ...(binding.connection.generation
        ? { connectionGeneration: binding.connection.generation }
        : {}),
      ...((admittedRequest?.modelBinding?.catalogGeneration ??
      binding.connection.modelCatalog?.generation)
        ? {
            catalogGeneration:
              admittedRequest?.modelBinding?.catalogGeneration ??
              binding.connection.modelCatalog!.generation,
          }
        : {}),
    },
  };
}
