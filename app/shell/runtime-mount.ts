// The Composition mount for one Turn: which Packages this Bot runs, which
// model binding they run against, and the host seams each of them is handed.
//
// It is the one place that turns a Bot's settings and its User's configuration
// into a mounted runtime, so both an admitted Turn (`app/shell/turn.ts`) and an
// isolate's `ai` grant (`app/isolates/bot.ts`) resolve the same way.

import type { StoredRunCauseV1 } from "@frockbot/core/durable";
import { createBotGroupChatsHost } from "./backend-groups.js";
import {
  PLUGIN_MODEL_PROVIDER_UNAVAILABLE_REASON_V1,
  type NormalizedModelRequest,
  type TurnInputOriginV1,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import {
  pluginServedProviderV1,
  PLUGIN_SERVED_PROVIDER_IDS_V1,
} from "@frockbot/providers/catalog/definition";
import {
  createPluginModelHostV1,
  pluginModelOutputBoundV1,
  type ShellPluginModelHostV1,
} from "@frockbot/app/isolates/model-transport";
import { readPinnedCompositionGenerationV1 } from "@frockbot/app/composition/bot";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "@frockbot/app/plugins/catalog";
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
import {
  readPluginEnablementV1,
  type PluginEnablementV1,
} from "@frockbot/app/plugins/enablement";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import { admitTurnV1 } from "@frockbot/app/composition/bot";
import { pluginAuthoringRuntimeHost } from "@frockbot/app/plugins/authoring-bot";
import {
  applyPanelFocusV1,
  panelBagFromRosterV1,
} from "@frockbot/app/plugins/panels-bot";
import { readBotPluginRosterV1 } from "@frockbot/app/plugins/worker-bot";
import type { PanelFocusRuntimeHostV1 } from "@frockbot/app/plugins/panel-focus";
import { decodeAgentTurnSlotReceiptV1 } from "@frockbot/app/flock/quota";
import { createBotMachineHost, machineSeam } from "@frockbot/app/machine/bot";
import {
  connectionTriggersFromUserV1,
  pluginTriggerIndexFromUserV1,
  createBotRoutinesHost,
  executeRoutineCommand,
  listRoutines,
  projectRoutineAccountTimezoneV1,
} from "@frockbot/app/routines/bot";
import {
  connectionStillPermittedV1,
  executeConfigurationCommand,
  readBotSettingsV1,
  userAccountFeaturesReaderV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import type { PreparedTurnInputsV1 } from "./prepared-inputs.js";
import type { PluginSkillContributionV1 } from "@frockbot/app/skills/plugin";
import { createBotSkillsHost } from "@frockbot/app/skills/bot";
import { subagentsRuntimeHost } from "@frockbot/app/subagents/bot";
import {
  subagentModelCatalogV1,
  type SubagentModelOptionV1,
  type SubagentSpecialtyV1,
} from "@frockbot/app/subagents/models";
import {
  taskDesktopLeaseOwnerV1,
  type TaskModelBindingV1,
} from "@frockbot/app/subagents/records";
import { decodeSubagentTaskContextV1 } from "@frockbot/app/subagents/durable-binding";
import { taskContextKeyV1 } from "@frockbot/app/subagents/storage-keys";
import {
  routeRateV1,
  type HostedModelRatesV1,
} from "@frockbot/app/billing/rates";
import {
  FROCK_AI_PACKAGE_ID,
  FROCK_AI_SPECIALTIES_V1,
} from "@frockbot/providers/frock-ai/catalog";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.js";
import { createBotSelfManagementHost } from "./backend-flock.js";
import { createBotImageHost } from "./backend-image.js";
import { createBotMemoryHost } from "./backend-memory.js";
import { executionPackagesV1, type ShellBotStateV1 } from "./backend-state.js";
import type { ShellModelRuntimeHostV1 } from "./backend-runtime.js";
import { decodeClientTurnV1 } from "./run-protocol.js";
import {
  computerFrameSinkV1,
  type StoredComputerFrameV1,
} from "@frockbot/computer/frame";
import { createComputerLoginVaultV1 } from "./computer-logins.js";
import { turnToolCatalogPin } from "./tool-catalog-pin.js";
import { createBotSecretFillSeamV1 } from "@frockbot/app/secrets/fill";
import { userSecretsV1 } from "@frockbot/app/secrets/bot";

/**
 * The model provider Plugin host for one mount (ADR 0032), or the reason a
 * person reads instead.
 *
 * A provider this deployment serves only through a Plugin cannot be served
 * without one: there is no compiled adapter to fall back to, by design. The
 * account's pinned Composition — the mirror the admission has just adopted —
 * is what says whether one is installed. Absent, the Turn fails here with the
 * sentence that names the missing Plugin; present, the mount registers the
 * contribution and the transport carries the credential.
 */
async function pluginModelHostV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: {
    provider: string;
    connectionId: string;
    connectionGeneration: string;
    model: string;
    /** The selected model's own output ceiling, when its catalog states one. */
    modelMaxOutputTokens?: number;
    generationId?: string;
  },
): Promise<ShellPluginModelHostV1> {
  const served = pluginServedProviderV1(input.provider);
  if (!served) {
    throw new Error(PLUGIN_MODEL_PROVIDER_UNAVAILABLE_REASON_V1);
  }
  const generation =
    input.generationId === undefined
      ? await state.authority.composition.current()
      : await readPinnedCompositionGenerationV1(
          state,
          identity,
          input.generationId,
        );
  // Installed means the account's own installation of the deployment's Plugin
  // at the deployment's artifact: the id and the content hash both have to be
  // the catalog's, so a Plugin a Bot wrote cannot stand in for it.
  const catalog = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
    (plugin) => plugin.pluginId === served.pluginId,
  );
  const installed = (generation?.members ?? []).some(
    (member) =>
      member.packageId === served.pluginId &&
      member.artifact.contentHash === catalog?.artifact.contentHash &&
      (member.descriptor.modelProviders ?? []).some(
        (contribution) => contribution.id === served.provider,
      ),
  );
  if (!installed || !state.env.BOT_PACKAGES) {
    throw new Error(PLUGIN_MODEL_PROVIDER_UNAVAILABLE_REASON_V1);
  }
  return createPluginModelHostV1(state, identity, {
    provider: served,
    connectionId: input.connectionId,
    connectionGeneration: input.connectionGeneration,
    model: input.model,
    maxOutputTokens: pluginModelOutputBoundV1(
      served.maxOutputTokens,
      input.modelMaxOutputTokens,
    ),
  });
}

/** Hands a subagent Turn's frame to the Bot object the card reads. */
async function putBotComputerFrameV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  frame: StoredComputerFrameV1,
): Promise<void> {
  if (!state.env.BOT_STATES) return;
  const rpc = state.env.BOT_STATES.get(
    state.env.BOT_STATES.idFromName(`${identity.userId}:${identity.botId}`),
  );
  await rpc.putComputerFrame({
    schemaVersion: 1,
    userId: identity.userId,
    botId: identity.botId,
    frame,
  });
}

/** Narrow RPC for the User-wide agent-lane concurrency lease. */
function agentTurnSlots(state: ShellBotStateV1, identity: BotIdentity) {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  const rpc = state.env.USER_CONFIGURATIONS.get(id);
  return {
    reserve: async (request: {
      schemaVersion: 1;
      userId: string;
      requesterId: string;
      runId: string;
      reservedAt: string;
    }) => decodeAgentTurnSlotReceiptV1(await rpc.reserveAgentTurnSlot(request)),
    release: async (request: {
      schemaVersion: 1;
      userId: string;
      requesterId: string;
      runId: string;
    }) => {
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
    /** What this Turn's spending is charged to. */
    cause?: StoredRunCauseV1;
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
    /** How many `subagent` hand-offs deep this Turn is; absent means none. */
    handoffDepth?: number;
    /** Where this Turn's input came from, for Turn supervision. */
    inputOrigin?: TurnInputOriginV1;
    /** Clears a withheld send's reply draft; absent where none is drawn. */
    clearReplyDraft?(ordinal: number): void;
  },
  prepared?: PreparedTurnInputsV1,
): Promise<{
  agentPackages: FoundationAgentPackage[];
  capabilities: EnabledCapabilityV1[];
  modelSelection: RuntimeModelSelection;
  /** One Turn's exact enablement read, shared with Composition mounting. */
  pluginEnablement: PluginEnablementV1;
  /**
   * The model provider Plugin host for this mount, present exactly when the
   * Bot's model names a provider this deployment serves only through a Plugin
   * (ADR 0032). The Composition mount registers the Plugin's contribution
   * into the Turn's `llm` registry through it.
   */
  pluginModel?: ShellPluginModelHostV1;
  /**
   * Filled by the mount with the generation actually being mounted, before
   * Skill features run. Empty when this runtime was not given prepared inputs.
   */
  pluginSkills: PluginSkillContributionV1[];
}> {
  const userConfiguration = userConfigurationV1(state, identity);
  // One admitted Turn reuses the account preparation it stored. A caller
  // without one — an isolate's `ai` grant — still reads the live account.
  const accountFeatures = prepared
    ? async () => structuredClone(prepared.account.features)
    : userAccountFeaturesReaderV1(state, identity);
  const pluginSkills: PluginSkillContributionV1[] = [];
  const [user, enablement] = prepared
    ? [
        structuredClone(prepared.account.settings),
        structuredClone(prepared.bot.enablement),
      ]
    : await Promise.all([
        userConfiguration.readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        readPluginEnablementV1(state.ctx.storage),
      ]);
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
  // The `image.model` Package setting, already checked against the enum the
  // Image Package's definition declares.
  const configuredImageModel = packageSettings("image").model;
  // A Bot writes a Plugin only inside an admitted Turn, for the same reason,
  // and only behind the account's Plugin-authoring switch (ADR 0026).
  const pluginsPromise = turn
    ? pluginAuthoringRuntimeHost(state, identity, turn, accountFeatures)
    : Promise.resolve(undefined);
  const skillsPromise = turn
    ? createBotSkillsHost(
        state,
        identity,
        turn,
        accountFeatures,
        prepared ? pluginSkills : undefined,
        prepared
          ? {
              botRevision:
                prepared.skills.indexes.find((index) => index.source === "bot")
                  ?.revision ?? "",
              userRevision:
                prepared.skills.indexes.find((index) => index.source === "user")
                  ?.revision ?? "",
            }
          : undefined,
      )
    : Promise.resolve(undefined);
  const panelsPromise = (async (): Promise<
    PanelFocusRuntimeHostV1 | undefined
  > => {
    if (!turn) return undefined;
    const roster = await readBotPluginRosterV1(state, identity);
    const bag = panelBagFromRosterV1(roster);
    if (bag.tabs.length === 0) return undefined;
    return {
      panels: {
        bag: bag.tabs,
        async focus(request) {
          const result = await applyPanelFocusV1(state, identity, request);
          if (result.status === "error") return result;
          return {
            status: "applied",
            pluginId: result.focus.pluginId,
            ...(result.focus.surfaceId
              ? { surfaceId: result.focus.surfaceId }
              : {}),
          };
        },
      },
    };
  })();
  // These gates share the account-feature read above but otherwise touch
  // independent authorities. Resolve them as one preparation stage.
  const [plugins, skills, panels] = await Promise.all([
    pluginsPromise,
    skillsPromise,
    panelsPromise,
  ]);
  // Filled in once this Turn's model binding is resolved, below. The tool
  // and the prompt section both read it lazily, from inside the Turn.
  const subagentModels: SubagentModelOptionV1[] = [];
  // A Bot dispatches a subagent only inside an admitted Turn, whose run
  // the task record names, and only where a Subagent Durable Object can
  // actually be addressed.
  const subagentGenerationId =
    turn && state.subagentBinding && featureOn("subagents")
      ? turn.compositionGenerationId
      : undefined;
  const resolvedAgentPackages: FoundationAgentPackage[] = [
    ...state.application.runtime.hosted({
      userId: identity.userId,
      readSecret,
      ...(turn
        ? {
            supervision: {
              supervisor: state.turnSupervisor,
              origin: turn.inputOrigin ?? "user",
              ...(turn.clearReplyDraft
                ? { clearReplyDraft: turn.clearReplyDraft }
                : {}),
              // Filled once the Turn's model is resolved, below.
              specialists: () =>
                subagentModels.flatMap((option) =>
                  option.specialty
                    ? [{ name: option.specialty.name, slug: option.slug }]
                    : [],
                ),
            },
          }
        : {}),
      ...(turn ? { skills } : {}),
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
      ...(plugins ? { plugins } : {}),
      ...(panels ? { panels } : {}),
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
              readBotVoice: (userId, botId) =>
                userConfigurationV1(state, identity).readBotVoice(
                  userId,
                  botId,
                ),
              updateBotVoice: (userId, botId, command) =>
                userConfigurationV1(state, identity).updateBotVoice(
                  userId,
                  botId,
                  command,
                ),
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
                const rpc = state.env.BOT_STATES.get(id);
                const completed = decodeClientTurnV1(
                  structuredClone(await rpc.runAgent(request)),
                );
                // The settled text is the Turn's last send or caller reply, so
                // a note the target sent its own User before answering is not
                // what the asking Bot is handed.
                return { text: completed.text };
              },
              // The same admission `runAgent` makes, without the hop: the
              // target is the object this Turn is already running in, so a
              // Durable Object stub aimed at ourselves would be a loopback
              // with nothing to gain and a deadlock to lose.
              //
              // Nothing awaits the Turn. It is admitted on the agent lane,
              // queues behind the Turn that asked for it, and starts when that
              // one settles; `waitUntil` is what keeps the object alive long
              // enough to promote it, and the recovery alarm is what promotes
              // it if this isolate goes away first.
              spawnSubagent: async (request) => {
                const command = {
                  userId: request.userId,
                  botId: request.botId,
                  ...request.command,
                };
                // A replay of the same tool call asks for the same run id, and
                // finding it already admitted is the whole of the fence.
                const existing = await state.authority
                  .readStoredRun(command.runId)
                  .catch(() => undefined);
                if (existing) return { status: "already-started" as const };
                state.ctx.waitUntil(
                  admitTurnV1(state, command).then(
                    () => undefined,
                    () => undefined,
                  ),
                );
                return { status: "started" as const };
              },
            }),
          }
        : {}),
      // Command ids fold in the run, so the seam exists only inside a Turn.
      ...(turn
        ? (() => {
            const groupChats = createBotGroupChatsHost(state, identity, turn);
            return groupChats ? { groupChats } : {};
          })()
        : {}),
      // A Bot writes a Routine only inside a Turn, so the record's writer can
      // name the Session and Turn that produced it.
      ...(turn && featureOn("routines")
        ? {
            routines: {
              ...createBotRoutinesHost(identity, turn),
              list: () => listRoutines(state, identity),
              execute: (command, writer) =>
                executeRoutineCommand(
                  state,
                  identity,
                  command,
                  writer,
                  connectionTriggersFromUserV1(
                    userConfigurationV1(state, identity),
                  ),
                  pluginTriggerIndexFromUserV1(
                    userConfigurationV1(state, identity),
                  ),
                ),
              listTriggers: () =>
                connectionTriggersFromUserV1(
                  userConfigurationV1(state, identity),
                ).list(),
            },
          }
        : {}),
      ...(turn && subagentGenerationId
        ? {
            subagents: subagentsRuntimeHost(
              state,
              identity,
              turn,
              subagentGenerationId,
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
            // The card's newest frame is Bot state, not a Workspace file. A
            // subagent's Turn runs in its task's own object, and the card
            // reads the Bot's, so its frame goes there.
            computerFrames: turn.subagentRole
              ? {
                  put: (frame) => putBotComputerFrameV1(state, identity, frame),
                }
              : computerFrameSinkV1(state.ctx.storage),
            // A saved secret is filled only inside a Turn: its Approval's
            // intent names the run that asked, and its lease the call.
            // A page the browser lands on is named when it is not the page:
            // a sign-in wall, a CAPTCHA, an error, one still loading.
            ...(state.pageJudge ? { computerPageJudge: state.pageJudge } : {}),
            computerSecrets: createBotSecretFillSeamV1({
              identity,
              runId: turn.runId,
              storage: state.ctx.storage,
              vault: userSecretsV1(state, identity),
              readSecret: (name) => readSecret(name),
            }),
            // The sign-ins are the User's, so the vault is the User's object;
            // when this object last kept them, and the checkpoint it knows
            // of, are this object's own.
            computerUpkeep: (() => {
              const vault = createComputerLoginVaultV1({
                userId: identity.userId,
                keyring: readSecret("CREDENTIAL_KEYRING"),
                user: state.env.USER_CONFIGURATIONS.get(
                  state.env.USER_CONFIGURATIONS.idFromName(identity.userId),
                ),
              });
              return {
                records: state.ctx.storage,
                ...(vault ? { vault } : {}),
              };
            })(),
            ...(state.invalidateComputerProjectionFile
              ? {
                  computerProjectionFiles: {
                    invalidate: (botId: string, kind: "frame" | "doctor") =>
                      state.invalidateComputerProjectionFile?.(
                        identity.userId,
                        botId,
                        kind,
                      ),
                  },
                }
              : {}),
            // The demonstrations the person sent live in this Bot's own
            // object, and deciding what happens to one is the conversation's:
            // a subagent's Turn runs in its task's object and gets none.
            ...(state.deleteComputerDemonstration && !turn.subagentRole
              ? {
                  computerDemonstrations: {
                    delete: (demonstrationId: string) =>
                      state.deleteComputerDemonstration!(demonstrationId),
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
      permitConnection: (connection) =>
        connectionStillPermittedV1(state, identity, connection),
      ...(turn
        ? {
            pinToolCatalog: turnToolCatalogPin(state.ctx.storage, turn.turnId),
            readConnectToolCatalog: (connection, toolName) =>
              userConfigurationReadConnectToolCatalogV1(
                state,
                identity.userId,
                connection,
                toolName,
              ),
          }
        : {}),
      packageSettings,
      // Only the account is taken from it: a platform-paid tool names the
      // Bot and Session from its own call when it charges, and the account
      // records the Turn and its cause beside each charge.
      ...(state.env.BILLING
        ? {
            billing: state.env.BILLING(
              identity.userId,
              identity.botId,
              turn?.sessionId ?? "",
              turn
                ? {
                    runId: turn.runId,
                    ...(turn.cause ? { cause: turn.cause } : {}),
                  }
                : undefined,
            ).account,
          }
        : {}),
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
  const resolvedModel = effective.model;
  if (!resolvedModel) {
    throw new Error(
      effective.binding?.failure ??
        "No model is set up yet. Choose one in Models.",
    );
  }
  // A child runs on the model its task pinned, when that model is on the
  // Bot's own connection — a specialist is. The Bot's settings name only the
  // Bot's model; the task record is the one place the parent's choice lives.
  const pinned = turn?.subagentTaskId
    ? await pinnedSubagentModelV1(state, turn.subagentTaskId)
    : undefined;
  const effectiveModel = subagentEffectiveModelV1(
    resolvedModel,
    effective.binding?.connection?.connectionId,
    pinned,
  );
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
  // A provider this deployment serves only through a Plugin has no compiled
  // adapter, so the one thing that can serve this Turn's model is an installed
  // Plugin. Missing it is answered here, before the Turn mounts and before
  // anything could be sent: the sentence is the one a person reads.
  // The selected model's own output ceiling, when the Connection's catalog —
  // the provider's own list, as the account discovered it — states one. The
  // deployment's bound for the provider is the other half of the same limit.
  const selectedModelLimit = binding.connection.modelCatalog?.models.find(
    (candidate) => candidate.providerModelId === effectiveModel.providerModelId,
  )?.maxOutputTokens;
  const pluginModel = PLUGIN_SERVED_PROVIDER_IDS_V1.includes(
    binding.providerType,
  )
    ? await pluginModelHostV1(state, identity, {
        provider: binding.providerType,
        connectionId: binding.connection.connectionId,
        connectionGeneration: binding.connection.generation ?? "",
        model: effectiveModel.providerModelId,
        ...(selectedModelLimit === undefined
          ? {}
          : { modelMaxOutputTokens: selectedModelLimit }),
        generationId: turn?.compositionGenerationId,
      })
    : undefined;
  const frockAiHost: Pick<
    ShellModelRuntimeHostV1,
    "frockAiAutoRoute" | "runFrockAiChatCompletion"
  > = state.env.FROCK_AI
    ? {
        frockAiAutoRoute: state.env.FROCK_AI.autoRoute,
        runFrockAiChatCompletion: (gatewayModel, body, signal, served) =>
          state.env.FROCK_AI!.runChatCompletion(
            gatewayModel,
            body,
            signal,
            served,
          ),
      }
    : {};
  if (!pluginModel) {
    agentPackages.push(
      state.application.runtime.model(binding, {
        accountId: identity.userId,
        connectionId: binding.connection.connectionId,
        leaseCredential: (
          effectId,
          expectedGeneration,
        ): Promise<CredentialLeaseV1> => {
          if (!expectedGeneration) {
            throw new Error(
              "Model request Connection generation is unavailable",
            );
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
        ...frockAiHost,
        fetch: state.outboundFetch,
      }),
    );
  }
  const summariser = state.application.runtime.summariser?.({
    accountId: identity.userId,
    connectionId: binding.connection.connectionId,
    ...frockAiHost,
  });
  if (summariser) agentPackages.push(summariser);
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
        specialists:
          modelCapability.packageId === FROCK_AI_PACKAGE_ID &&
          turn &&
          subagentGenerationId
            ? await pricedFrockSpecialistsV1(state, identity, turn.sessionId, {
                ...subagentBinding,
              })
            : [],
        turnType: turn?.turnType ?? "chat",
      }),
    );
  }
  // Last, so every provider an earlier Package registered is already there.
  agentPackages.push(...state.application.runtime.base());
  return {
    agentPackages,
    capabilities: structuredClone(plan.capabilities),
    pluginEnablement: structuredClone(enablement),
    pluginSkills,
    ...(pluginModel ? { pluginModel } : {}),
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

async function userConfigurationReadConnectToolCatalogV1(
  state: ShellBotStateV1,
  userId: string,
  connection: { connectionId: string; generation?: string },
  toolName: string | undefined,
): Promise<unknown> {
  if (!connection.generation) {
    return {
      kind: "stale-contract",
      message:
        "stale-contract: Access to this app was revoked. Connect it again.",
    };
  }
  const rpc = state.env.USER_CONFIGURATIONS.get(
    state.env.USER_CONFIGURATIONS.idFromName(userId),
  );
  return rpc.readConnectToolCatalog({
    schemaVersion: 1,
    userId,
    connectionId: connection.connectionId,
    generation: connection.generation ?? "",
    ...(toolName === undefined ? {} : { toolName }),
  });
}

/**
 * The model a Turn runs on: the Bot's own, or the one its task pinned when
 * that model is on the same connection. A pin on another connection is not
 * one this Turn's binding can reach, so the Bot's own model runs.
 */
export function subagentEffectiveModelV1<
  Model extends { providerModelId: string },
>(
  resolved: Model,
  connectionId: string | undefined,
  pinned: { connectionId: string; providerModelId: string } | undefined,
): Model {
  return pinned && pinned.connectionId === connectionId
    ? { ...resolved, providerModelId: pinned.providerModelId }
    : resolved;
}

/** The model a child's task pinned, off the task record this object holds. */
export async function pinnedSubagentModelV1(
  state: ShellBotStateV1,
  taskId: string,
): Promise<{ connectionId: string; providerModelId: string } | undefined> {
  const stored = await state.ctx.storage.get<unknown>(taskContextKeyV1(taskId));
  if (stored === undefined) return undefined;
  try {
    const binding = decodeSubagentTaskContextV1(stored).model?.binding;
    return binding
      ? {
          connectionId: binding.connectionId,
          providerModelId: binding.providerModelId,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Frock AI specialists this deployment prices. An unpriced route would be
 * refused at dispatch, so it is never offered; a table this object cannot read
 * offers none.
 */
async function pricedFrockSpecialistsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  sessionId: string,
  binding: TaskModelBindingV1,
): Promise<{ binding: TaskModelBindingV1; specialty: SubagentSpecialtyV1 }[]> {
  const billing = state.env.BILLING?.(
    identity.userId,
    identity.botId,
    sessionId,
  );
  if (!billing) return [];
  let table: HostedModelRatesV1;
  try {
    table = await billing.rates();
  } catch {
    return [];
  }
  return FROCK_AI_SPECIALTIES_V1.filter(
    (specialty) => routeRateV1(table, specialty.model) !== undefined,
  ).map((specialty) => ({
    binding: { ...binding, providerModelId: specialty.model },
    specialty: { name: specialty.name, summary: specialty.summary },
  }));
}
