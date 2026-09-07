import type { CredentialLeaseV1 } from "@frockbot/connection-core";
import type {
  BotExecutionPlanV1,
  ConnectionView,
  EnabledCapabilityV1,
  PackageSettingValueV1,
  ResolvedModelBindingV1,
} from "@frockbot/configuration-core";
import {
  createBotTemplateFeature,
  type BotTemplateRuntimeHostV1,
} from "@frockbot/plugin-bot-template/agent";
export type { BotTemplateRuntimeHostV1 } from "@frockbot/plugin-bot-template/agent";
import clockFeature from "@frockbot/plugin-clock/agent";
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/kernel-contracts";
import type { CredentialLeaseRuntime } from "@frockbot/plugin-credentials/user";

// pi-lens-ignore: ts:2307
import {
  createComputerAgentFeature,
  type ComputerAgentPluginConfig,
  type ComputerProcessStorageV1,
} from "@frockbot/plugin-computer/agent";
import {
  createSharedComputerProviderFeature,
  type SharedComputerHostClient,
} from "@frockbot/plugin-computer/shared-provider";
import { createCredentialsFeature } from "@frockbot/plugin-credentials/user";
// pi-lens-ignore: ts:2307
// Runtime implementations are statically bound by the immutable application.
import echoFeature from "@frockbot/plugin-echo/agent";
import { createFlySpriteProviderFeature } from "@frockbot/plugin-fly-sprite/agent";
import {
  ComputerHostClient,
  type ComputerHostFetcherV1,
} from "@frockbot/plugin-fly-sprite/host-client";
import type {
  ComputerRegistry,
  ComputerSyncHostV1,
} from "@frockbot/computer-core";
// Flock contributes lifecycle routes and durable User/Bot state.
import {
  createFlockRuntimeFeature,
  type FlockSelfRuntimeHostV1,
} from "@frockbot/plugin-flock/agent";
export type { FlockSelfRuntimeHostV1 } from "@frockbot/plugin-flock/agent";
import identityFeature from "@frockbot/plugin-identity/agent";
import foundationProviderFeature, {
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/plugin-provider-foundation/runtime";
import {
  createOllamaCloudFeature,
  ollamaChatBaseUrl,
} from "@frockbot/plugin-provider-ollama-cloud/runtime";
import { createFrockAiFeature } from "@frockbot/plugin-provider-frock-ai/runtime";
import { createAnthropicFeature } from "@frockbot/plugin-provider-anthropic/runtime";
import {
  createRoutinesRuntimeFeature,
  type RoutinesRuntimeHostV1,
} from "@frockbot/plugin-routines/agent";
export type { RoutinesRuntimeHostV1 } from "@frockbot/plugin-routines/agent";
import { createMachineMessagesFeature } from "@frockbot/plugin-machine-messages/agent";
import type { MachineMessagesRuntimeHostV1 } from "@frockbot/plugin-machine-messages/agent";
export type { MachineMessagesRuntimeHostV1 } from "@frockbot/plugin-machine-messages/agent";
// The registered machine's six tools. Mounted only for an admitted Turn, whose
// Session and Turn the intent record it writes has to name.
import {
  createMachineRuntimeFeature,
  type MachineRuntimeHostV1,
} from "@frockbot/plugin-user-machine/agent";
export type { MachineRuntimeHostV1 } from "@frockbot/plugin-user-machine/agent";
import {
  createSubagentsRuntimeFeature,
  type SubagentsRuntimeHostV1,
} from "@frockbot/plugin-subagents/agent";
export type { SubagentsRuntimeHostV1 } from "@frockbot/plugin-subagents/agent";
import { createConfiguredOllamaWebSearchRuntimeContribution } from "@frockbot/plugin-provider-ollama-cloud/web-search";
// The Web Package contributes `web_fetch`: no Connection, no provider, and no
// Computer — it works while the User's Computer is hibernated.
import { createConfiguredWebFetchRuntimeContribution } from "@frockbot/plugin-web/agent";
import {
  createMemoryRuntimeFeature,
  type MemoryRuntimeHostV1,
} from "@frockbot/plugin-memory/agent";
import {
  createImageFeature,
  type ImageRuntimeHostV1,
} from "@frockbot/plugin-image/agent";
import shellAgentFeature from "@frockbot/plugin-shell/agent";
import {
  createSkillsRuntimeFeature,
  type SkillsRuntimeHostV1,
} from "@frockbot/plugin-skills/agent";
import {
  createAppletsFeature,
  type AppletsRuntimeHostV1,
} from "@frockbot/plugin-applets/feature";
export type { AppletsRuntimeHostV1 } from "@frockbot/plugin-applets/feature";

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };
export {
  FOUNDATION_PACKAGES_V1,
  FOUNDATION_PACKAGE_VERSION_V1,
  foundationPackageV1,
} from "./packages.js";

/** Everything a feature may register into, for one Turn. */
export interface FoundationRuntimeServicesV1 extends AgentRuntimeV1 {
  readonly computers: ComputerRegistry;
  /** Set by the credentials feature; read by every feature mounted after it. */
  credentials?: CredentialLeaseRuntime;
}

export type FoundationFeature = RuntimeFeatureV1<FoundationRuntimeServicesV1>;

/** One feature the host hands a Turn, named so a plan can be read back. */
export interface FoundationRuntimePackage {
  id: string;
  feature: FoundationFeature;
}

/**
 * The features every Turn mounts whatever its host: the Bot's identity, the
 * built-in model, the two demo tools and the Shell's own voice. The host's
 * features mount before these, so a provider they need is already registered.
 */
export function foundationBaseRuntimeFeatures(): FoundationFeature[] {
  return [
    identityFeature,
    foundationProviderFeature,
    echoFeature,
    clockFeature,
    shellAgentFeature,
  ];
}

/**
 * What the host gives one enabled runtime Contribution. The Connection-bound
 * fields are present only when the Capability names a
 * Connection, so a Capability with `connectionTypes: []` receives an
 * account-wide grant and nothing else.
 */
type EnabledRuntimeContributionFactory = (config: {
  capability: EnabledCapabilityV1;
  /** This Capability's ordinal among the enabled ones from its Package. */
  capabilityIndex: number;
  userId: string;
  /**
   * The Package-level setting values this User holds for the Package the
   * Capability names, already resolved against the manifest the pinned
   * Composition carries. Empty when the User has set none, so a Contribution
   * reads its own default exactly as before.
   *
   * They are read from durable User state when the Turn's Composition is
   * resolved, which is what makes a changed value take effect at the next
   * admitted Turn and never inside one already running.
   */
  packageSettings: Readonly<Record<string, PackageSettingValueV1>>;
  readSecret(name: string): string | undefined;
  authorizeConnection(): Promise<ConnectionView>;
  pinToolCatalog?(
    connectionId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown>;
  /** The Package's own outbound seam, when the host owns one. */
  fetch?: typeof fetch;
  /**
   * The already-authorized Connection, when the Capability binds one. A
   * Capability with `connectionTypes: []` receives no
   * Connection, so this is absent rather than empty.
   */
  connection?: ConnectionView;
  /**
   * An expiring lease over the Capability's Connection credential. Supplied
   * only by a host that carries the User's authority; a Contribution that
   * needs no credential never calls it.
   */
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
}) => FoundationFeature | undefined | Promise<FoundationFeature | undefined>;

const enabledRuntimeContributionFactories = new Map<
  string,
  EnabledRuntimeContributionFactory
>([
  [
    "web",
    ({ capability, fetch: outbound }) =>
      createConfiguredWebFetchRuntimeContribution({
        capability,
        ...(outbound ? { fetch: outbound } : {}),
      }),
  ],
  [
    "provider-ollama-cloud",
    ({
      capability,
      userId,
      connection,
      leaseCredential,
      settleCredential,
      fetch: outbound,
      packageSettings,
    }) => {
      // `web_search` is authorized by its own enabled Capability and its own
      // Connection generation; a Bot whose model runs elsewhere still holds it.
      if (
        !connection?.generation ||
        !capability.connectionId ||
        !leaseCredential ||
        !settleCredential
      ) {
        return undefined;
      }
      return createConfiguredOllamaWebSearchRuntimeContribution({
        capability,
        accountId: userId,
        connectionId: capability.connectionId,
        connectionGeneration: connection.generation,
        // Every inbound value is decoded at its seam: the provider Package
        // validates the endpoint root before it composes a request URL.
        ...(typeof connection.settings?.apiBaseUrl === "string"
          ? { apiBaseUrl: connection.settings.apiBaseUrl }
          : {}),
        // The Package-level ceiling this User set on `web_search`. Already
        // schema-checked against the manifest, so it is a number in range or
        // it is absent.
        ...(typeof packageSettings["web-search-max-results"] === "number"
          ? { maxResults: packageSettings["web-search-max-results"] }
          : {}),
        leaseCredential,
        settleCredential,
        ...(outbound ? { fetch: outbound } : {}),
      });
    },
  ],
]);

interface ModelRuntimeContributionConfig {
  accountId: string;
  connectionId: string;
  connectionGeneration?: string;
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
  frockAiAutoRoute?: string;
  runFrockAiChatCompletion?: (
    gatewayModel: string,
    body: Record<string, unknown>,
  ) => Promise<ReadableStream<Uint8Array>>;
  fetch?: typeof fetch;
  /**
   * Endpoint root carried on the Connection's settings bag, when its User
   * pointed the Connection at something other than the Package default.
   */
  apiBaseUrl?: string;
}

interface ModelRuntimeContributionFactory {
  providerType: string;
  create(config: ModelRuntimeContributionConfig): FoundationFeature;
}

const modelRuntimeContributionFactories = new Map<
  string,
  ModelRuntimeContributionFactory
>([
  [
    "provider-ollama-cloud",
    {
      providerType: "ollama-cloud",
      create: ({
        apiBaseUrl,
        leaseCredential,
        settleCredential,
        ...config
      }) => {
        if (!leaseCredential || !settleCredential) {
          throw new Error("Ollama Cloud credential host is unavailable");
        }
        return createOllamaCloudFeature({
          ...config,
          packageId: "provider-ollama-cloud",
          leaseCredential,
          settleCredential,
          chatBaseUrl: ollamaChatBaseUrl(apiBaseUrl),
        });
      },
    },
  ],
  [
    "provider-flock-ai",
    {
      providerType: "flock-ai",
      create: ({
        connectionId,
        connectionGeneration,
        frockAiAutoRoute,
        runFrockAiChatCompletion,
      }) => {
        if (
          !connectionGeneration ||
          !frockAiAutoRoute ||
          !runFrockAiChatCompletion
        ) {
          throw new Error("Frock AI gateway host is unavailable");
        }
        return createFrockAiFeature({
          connectionId,
          connectionGeneration,
          autoRoute: frockAiAutoRoute,
          runChatCompletion: runFrockAiChatCompletion,
        });
      },
    },
  ],
  [
    "provider-anthropic",
    {
      providerType: "anthropic",
      create: ({
        apiBaseUrl,
        leaseCredential,
        settleCredential,
        accountId,
        connectionId,
      }) => {
        if (!leaseCredential || !settleCredential) {
          throw new Error("Anthropic credential host is unavailable");
        }
        return createAnthropicFeature({
          accountId,
          connectionId,
          packageId: "provider-anthropic",
          leaseCredential,
          settleCredential,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
        });
      },
    },
  ],
]);

/**
 * Backend Contribution resolution lives in `./contributions.ts`. Re-exported
 * here so every caller keeps its existing import.
 */
export {
  backendDescriptorsV1,
  createFoundationBackendContributions,
} from "./contributions.js";
export type { MachineGatewayHostV1 } from "@frockbot/plugin-user-machine/backend";
export type {
  BackendRouteContribution,
  BackendContributionLifecycle,
  FoundationBackendPluginHost,
  FoundationBotBackendHostV1,
  FoundationGatewayHost,
  FoundationUserBackendHostV1,
  MountedFoundationBackend,
} from "./contributions.js";

function runtimePackage(
  id: string,
  feature: FoundationFeature,
): FoundationRuntimePackage {
  return { id, feature };
}

/**
 * The Computer providers this application registers. The in-worker Fly Sprites
 * provider is the default: it is the one that carries a Computer's per-User
 * identity, its Workspace file surface, and the durable-root sync.
 * When the host also supplies the shared Computer host, its effect-journaling
 * proxy is registered beside it so an identified effect can be replayed rather
 * than repeated across Durable Object eviction.
 */
/**
 * Whether this deployment can reach a Computer.
 *
 * `SPRITES_TOKEN` is not a credential in this Worker — the Computer host holds
 * the only copy — but it is still the one durable answer to "has this
 * deployment a Computer at all", and without the host binding there is nothing
 * to send the call to.
 */
function computerConfiguredV1(host: {
  readSecret(name: string): string | undefined;
  computerHost?: SharedComputerHostClient;
  computerHostBinding?: ComputerHostBinding;
}): boolean {
  if (host.computerHost) return true;
  return Boolean(
    host.readSecret("SPRITES_TOKEN")?.trim() && host.computerHostBinding,
  );
}

function computerProviderFeature(host: {
  readSecret(name: string): string | undefined;
  computerSync?: ComputerSyncHostV1;
  computerHost?: SharedComputerHostClient;
  computerHostBinding?: ComputerHostBinding;
  computerAgentControlOwnerId?: string;
}): FoundationFeature {
  // `SPRITES_TOKEN` is no longer a credential here — the Computer host holds
  // the only copy, and this Worker could not use one if it had it. It survives
  // as the answer to one question: has this deployment a Computer at all? With
  // it unset every Computer surface reads as unconfigured, which is the truth:
  // no host of ours has a Sprites account.
  const configured = Boolean(host.readSecret("SPRITES_TOKEN")?.trim());
  const binding = host.computerHostBinding;
  const fly = createFlySpriteProviderFeature(undefined, {
    ...(configured && binding
      ? {
          host: (identity, tenant) =>
            new ComputerHostClient({
              fetcher: binding.fetcher,
              hostToken: binding.hostToken,
              identity,
              tenant,
            }),
        }
      : {}),
    ...(host.computerSync ? { sync: host.computerSync } : {}),
    ...(host.computerAgentControlOwnerId
      ? { agentControlOwnerId: host.computerAgentControlOwnerId }
      : {}),
  });
  const shared = host.computerHost
    ? createSharedComputerProviderFeature(host.computerHost)
    : undefined;
  if (!shared) return fly;
  return async (runtime) => {
    const cleanups = [await fly(runtime), await shared(runtime)];
    return () => {
      for (const cleanup of cleanups.toReversed()) {
        if (typeof cleanup === "function") cleanup();
        else for (const fn of cleanup ?? []) fn();
      }
    };
  };
}

/**
 * The `COMPUTER_HOST` service binding and the secret presented on it.
 *
 * Both or neither: a binding with no token reaches a host that refuses every
 * call, which would surface as a 401 on each Turn rather than as a Computer
 * that is not configured.
 */
export interface ComputerHostBinding {
  fetcher: ComputerHostFetcherV1;
  hostToken: string;
}

export function createFoundationHostedRuntimePackages(host: {
  userId: string;
  readSecret(name: string): string | undefined;
  /**
   * The shared Computer host seam: a non-authoritative backend host that
   * journals each identified Computer effect so a retried effect replays its
   * recorded outcome instead of executing twice. Supplied, the
   * `shared-computer` provider is registered beside the in-worker provider.
   */
  computerHost?: SharedComputerHostClient;
  /**
   * The shared Computer host: the service binding the Bot
   * Durable Object reaches a Computer through, and the secret it presents.
   * Absent, and the Fly provider registers unconfigured — this Worker holds
   * no Sprites SDK and no way to reach a Computer without it.
   */
  computerHostBinding?: ComputerHostBinding;
  /**
   * The Skills seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside one whose Workspace reads are
   * available, and the Skills Package is then not mounted: a Turn with no
   * readable instruction root loads no instructions rather than guessing.
   */
  skills?: SkillsRuntimeHostV1;
  /**
   * The Memory seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside one whose Memory roots are
   * reachable, and the Memory Package is then not mounted: a Turn with no
   * readable Memory root injects no Memory rather than guessing.
   */
  memory?: MemoryRuntimeHostV1;
  /**
   * The image-generation seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and outside one whose Workspace is
   * reachable, and the Image Package is then not mounted: a Bot generates an
   * image only inside a Turn whose Session and Turn the write can name, and
   * only where the file it produces has somewhere durable to land.
   */
  image?: ImageRuntimeHostV1;
  /**
   * The Routines seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and the Routines Package is then not
   * mounted: a Bot writes a Routine only inside a Turn whose Session and Turn
   * its provenance can name.
   */
  routines?: RoutinesRuntimeHostV1;
  /**
   * The Subagents seam, supplied by the parent Bot Durable Object
   * for one admitted Turn. Absent outside a Turn, and outside a deployment
   * that can address a Subagent Durable Object, and the Package is then not
   * mounted at all: a Bot dispatches a subagent only inside a Turn whose run
   * the task record can name.
   */
  subagents?: SubagentsRuntimeHostV1;
  /**
   * The Computer sync seam, supplied by the Bot Durable Object
   * for one admitted Turn. Absent outside a Turn, and outside one whose
   * durable roots are reachable in object storage — the Computer provider
   * then offers no sync at all, and a Computer's durable roots live on the
   * Computer alone rather than reconciling against a store no authority
   * backs.
   */
  computerSync?: ComputerSyncHostV1;
  /**
   * The Session and Turn a Computer write records as its writer, supplied by
   * the Bot Durable Object for one admitted Turn. Absent outside a Turn, and
   * `computer_screenshot` is then not offered: a durable-root write with no
   * Turn to name is a write with no writer.
   */
  computerWriter?: { sessionId: string; turnId: string; runId: string };
  /**
   * The Bot Durable Object storage a background process's record is written
   * to, supplied for one admitted Turn. Absent, and `computer_exec` offers
   * no `background` and the three process tools are not mounted: intent is
   * recorded before an effect, and with nowhere to record it there is no
   * honest way to launch a process that outlives its Turn.
   */
  computerProcesses?: ComputerProcessStorageV1;
  /** Wake-free access to the Bot DO's durable human-control record. */
  computerControlRecords?: NonNullable<
    ComputerAgentPluginConfig["controlRecords"]
  >;
  /** Resident projection caches invalidated after a known Computer write. */
  computerProjectionFiles?: NonNullable<
    ComputerAgentPluginConfig["projectionFiles"]
  >;
  /** The `computerUse` task owner whose User-wide lease this child holds. */
  computerAgentControlOwnerId?: string;
  /**
   * The Bot self-management seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the Flock runtime Contribution
   * is then not mounted: a Bot changes its own identity, or adds a Bot to
   * its User's flock, only inside a Turn whose Session and Turn the write
   * can name.
   */
  botSelfManagement?: FlockSelfRuntimeHostV1;
  /**
   * The Bot Template seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the export tool is then not
   * registered at all: staging a template runs through the User's own
   * command path, and a Turn with no such path cannot reach it.
   */
  botTemplate?: BotTemplateRuntimeHostV1;
  /**
   * The registered machine seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the machine tools are then not
   * mounted at all: an intent record with no Session and Turn is an effect
   * nobody can trace back to a conversation.
   */
  machines?: MachineRuntimeHostV1;
  /**
   * Row 57g's seam, supplied only when all of its gate is open: the User
   * setting is on, and at least one connected macOS machine reports the
   * `messages` capability. Absent, and the seven Messages tools are not
   * mounted at all — absent from the catalog rather than present and
   * refusing, which is what a feature gate is for.
   */
  machineMessages?: MachineMessagesRuntimeHostV1;
  /**
   * The Applets seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside a deployment that can reach the
   * Applet Durable Object, its artifact bucket and the Workspace — and the
   * Applets Package is then not mounted at all: a publish is a durable effect
   * whose intent record has to name the Turn that asked for it.
   */
  applets?: AppletsRuntimeHostV1;
}): FoundationRuntimePackage[] {
  return [
    ...(host.botSelfManagement
      ? [
          runtimePackage(
            "flock",
            createFlockRuntimeFeature(host.botSelfManagement),
          ),
        ]
      : []),
    ...(host.botTemplate
      ? [
          runtimePackage(
            "bot-template",
            createBotTemplateFeature(host.botTemplate),
          ),
        ]
      : []),
    ...(host.skills
      ? [runtimePackage("skills", createSkillsRuntimeFeature(host.skills))]
      : []),
    ...(host.memory
      ? [runtimePackage("memory", createMemoryRuntimeFeature(host.memory))]
      : []),
    ...(host.image
      ? [runtimePackage("image", createImageFeature(host.image))]
      : []),
    ...(host.routines
      ? [
          runtimePackage(
            "routines",
            createRoutinesRuntimeFeature(host.routines),
          ),
        ]
      : []),
    ...(host.subagents
      ? [
          runtimePackage(
            "subagents",
            createSubagentsRuntimeFeature(host.subagents),
          ),
        ]
      : []),
    ...(host.machines
      ? [
          runtimePackage(
            "user-machine",
            createMachineRuntimeFeature(host.machines),
          ),
        ]
      : []),
    ...(host.machineMessages
      ? [
          runtimePackage(
            "machine-messages",
            createMachineMessagesFeature(host.machineMessages),
          ),
        ]
      : []),
    ...(host.applets
      ? [runtimePackage("applets", createAppletsFeature(host.applets))]
      : []),
    runtimePackage(
      "credentials",
      createCredentialsFeature({ readSecret: host.readSecret }),
    ),
    runtimePackage("fly-sprite", computerProviderFeature(host)),
    runtimePackage(
      "computer",
      createComputerAgentFeature({
        userId: host.userId,
        defaultProviderId: "fly-sprite",
        // Exactly the condition `computerProviderPlugin` uses to hand the
        // provider a host. Read here too, so the tools and the prompt agree
        // with the provider about whether there is a Computer at all.
        configured: computerConfiguredV1(host),
        ...(host.computerWriter ? { writer: host.computerWriter } : {}),
        ...(host.computerProcesses
          ? { processes: host.computerProcesses }
          : {}),
        ...(host.computerControlRecords
          ? { controlRecords: host.computerControlRecords }
          : {}),
        ...(host.computerProjectionFiles
          ? { projectionFiles: host.computerProjectionFiles }
          : {}),
      }),
    ),
  ];
}

export async function createFoundationEnabledRuntimePackages(
  execution: BotExecutionPlanV1,
  host: {
    userId: string;
    readSecret(name: string): string | undefined;
    pinToolCatalog?(
      connectionId: string,
      read: () => Promise<unknown>,
    ): Promise<unknown>;
    authorizeConnection(
      capability: EnabledCapabilityV1,
    ): Promise<ConnectionView>;
    /**
     * One Package's durable User-level setting values. Supplied by the host
     * that read the User's settings for this Turn; a host that supplies none
     * leaves every Contribution on its Package defaults.
     */
    packageSettings?(
      packageId: string,
    ): Readonly<Record<string, PackageSettingValueV1>> | undefined;
    /** The Package's own outbound seam, passed through to each Contribution. */
    fetch?: typeof fetch;
    /** The User's credential authority, for Contributions that hold a key. */
    leaseCredential?(
      capability: EnabledCapabilityV1,
      effectId: string,
      expectedGeneration?: string,
    ): Promise<CredentialLeaseV1>;
    settleCredential?(
      capability: EnabledCapabilityV1,
      effectId: string,
    ): Promise<void>;
  },
): Promise<FoundationRuntimePackage[]> {
  const result: FoundationRuntimePackage[] = [];
  const capabilityIndexes = new Map<string, number>();
  for (const capability of execution.capabilities) {
    const packageId = capability.packageId;
    const factory = enabledRuntimeContributionFactories.get(packageId);
    if (!factory) continue;
    // A Capability with no Connection type is authorized by account-wide
    // Package enablement alone, so it never asks the host for a Connection.
    const connection = capability.connectionId
      ? await host.authorizeConnection(capability)
      : undefined;
    const capabilityIndex = capabilityIndexes.get(packageId) ?? 0;
    capabilityIndexes.set(packageId, capabilityIndex + 1);
    const plugin = await factory({
      capability,
      capabilityIndex,
      userId: host.userId,
      packageSettings: host.packageSettings?.(packageId) ?? {},
      readSecret: host.readSecret,
      ...(host.pinToolCatalog ? { pinToolCatalog: host.pinToolCatalog } : {}),
      authorizeConnection: () => host.authorizeConnection(capability),
      ...(connection ? { connection } : {}),
      ...(host.fetch ? { fetch: host.fetch } : {}),
      ...(host.leaseCredential
        ? {
            leaseCredential: (effectId, expectedGeneration) =>
              host.leaseCredential!(capability, effectId, expectedGeneration),
          }
        : {}),
      ...(host.settleCredential
        ? {
            settleCredential: (effectId) =>
              host.settleCredential!(capability, effectId),
          }
        : {}),
    });
    if (!plugin) continue;
    result.push({ id: packageId, feature: plugin });
  }
  return result;
}

export function createFoundationModelRuntimePackage(
  binding: ResolvedModelBindingV1,
  host: ModelRuntimeContributionConfig,
): FoundationRuntimePackage {
  if (
    binding.state === "unavailable" ||
    !binding.connection ||
    !binding.packageId ||
    !binding.providerType
  ) {
    throw new Error(binding.failure ?? "Bot model Connection is unavailable");
  }
  const factory = modelRuntimeContributionFactories.get(binding.packageId);
  if (!factory || factory.providerType !== binding.providerType) {
    throw new Error(
      `Bot model provider "${binding.providerType}" is unavailable`,
    );
  }
  return {
    id: binding.packageId,
    feature: factory.create({
      ...host,
      connectionId: binding.connection.connectionId,
      ...(binding.connection.generation
        ? { connectionGeneration: binding.connection.generation }
        : {}),
      // Every inbound value is decoded at its seam: the provider Package
      // validates the endpoint root before it composes a request URL.
      ...(typeof binding.connection.settings?.["api-base-url"] === "string"
        ? { apiBaseUrl: binding.connection.settings["api-base-url"] }
        : {}),
    }),
  };
}
