import { catalogProvidersV1 } from "@frockbot/providers/catalog/definition";
import { createCatalogProviderFeatureV1 } from "@frockbot/providers/catalog/runtime";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import { createConfiguredConnectRuntimeContribution } from "@frockbot/app/connect/agent";
import type {
  BotExecutionPlanV1,
  ConnectionView,
  EnabledCapabilityV1,
  PackageSettingValueV1,
  ResolvedModelBindingV1,
} from "@frockbot/core/configuration";
import {
  createBotTemplateFeature,
  type BotTemplateRuntimeHostV1,
} from "@frockbot/app/bot-template/agent";
export type { BotTemplateRuntimeHostV1 } from "@frockbot/app/bot-template/agent";
import clockFeature from "@frockbot/app/clock/agent";
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import type { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";

// pi-lens-ignore: ts:2307
import {
  createComputerAgentFeature,
  type ComputerAgentPluginConfig,
  type ComputerProcessStorageV1,
} from "@frockbot/computer/agent";
import { createCredentialsFeature } from "@frockbot/app/credentials/user";
// pi-lens-ignore: ts:2307
// Runtime implementations are statically bound by the immutable application.
import echoFeature from "@frockbot/app/echo/agent";
import type {
  ShellApplicationV1,
  ShellComputerHostFactoryV1,
  ShellEnabledRuntimeHostV1,
  ShellHostedRuntimeHostV1,
  ShellModelRuntimeHostV1,
} from "@frockbot/app/shell/backend-runtime";
import type {
  ComputerRegistry,
  ComputerSyncHostV1,
} from "@frockbot/computer/core/host";
// Flock contributes lifecycle routes and durable User/Bot state.
import {
  createFlockRuntimeFeature,
  type FlockSelfRuntimeHostV1,
} from "@frockbot/app/flock/agent";
export type { FlockSelfRuntimeHostV1 } from "@frockbot/app/flock/agent";
import identityFeature from "@frockbot/app/identity/agent";
import foundationProviderFeature, {
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/providers/foundation/runtime";
import {
  createOllamaCloudFeature,
  ollamaChatBaseUrl,
} from "@frockbot/providers/ollama-cloud/runtime";
import { createFrockAiFeature } from "@frockbot/providers/frock-ai/runtime";
import {
  createRoutinesRuntimeFeature,
  type RoutinesRuntimeHostV1,
} from "@frockbot/app/routines/agent";
export type { RoutinesRuntimeHostV1 } from "@frockbot/app/routines/agent";
import { createMachineMessagesFeature } from "@frockbot/app/machine-messages/agent";
import type { MachineMessagesRuntimeHostV1 } from "@frockbot/app/machine-messages/agent";
export type { MachineMessagesRuntimeHostV1 } from "@frockbot/app/machine-messages/agent";
// The registered machine's six tools. Mounted only for an admitted Turn, whose
// Session and Turn the intent record it writes has to name.
import {
  createMachineRuntimeFeature,
  type MachineRuntimeHostV1,
} from "@frockbot/app/machine/agent";
export type { MachineRuntimeHostV1 } from "@frockbot/app/machine/agent";
import {
  createSubagentsRuntimeFeature,
  type SubagentsRuntimeHostV1,
} from "@frockbot/app/subagents/agent";
export type { SubagentsRuntimeHostV1 } from "@frockbot/app/subagents/agent";
import { createConfiguredOllamaWebSearchRuntimeContribution } from "@frockbot/providers/ollama-cloud/web-search";
// The Web Package contributes `web_fetch`: no Connection, no provider, and no
// Computer — it works while the User's Computer is hibernated.
import { createConfiguredWebFetchRuntimeContribution } from "@frockbot/app/web/agent";
import {
  createMemoryRuntimeFeature,
  type MemoryRuntimeHostV1,
} from "@frockbot/app/memory/agent";
import {
  createImageFeature,
  type ImageRuntimeHostV1,
} from "@frockbot/app/image/agent";
import shellAgentFeature from "@frockbot/app/shell/agent";
import {
  createSkillsRuntimeFeature,
  type SkillsRuntimeHostV1,
} from "@frockbot/app/skills/agent";
import {
  createAppletsFeature,
  type AppletsRuntimeHostV1,
} from "@frockbot/applets/feature";
export type { AppletsRuntimeHostV1 } from "@frockbot/applets/feature";
import { createPluginsFeature } from "@frockbot/app/plugins/feature";

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };
import {
  FOUNDATION_PACKAGES_V1,
  FOUNDATION_PACKAGE_VERSION_V1,
} from "./packages.js";
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
 * The Packages every Turn mounts whatever its host: the Bot's identity, the
 * built-in model, the two demo tools and the Shell's own voice. The host's
 * Packages mount before these, so a provider they need is already registered.
 */
export function foundationBaseRuntimePackagesV1(): FoundationRuntimePackage[] {
  return [
    runtimePackage("identity", identityFeature),
    runtimePackage("provider-foundation", foundationProviderFeature),
    runtimePackage("echo", echoFeature),
    runtimePackage("clock", clockFeature),
    runtimePackage("shell", shellAgentFeature),
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
    "connect",
    ({
      capability,
      userId,
      connection,
      readSecret,
      fetch: outbound,
      pinToolCatalog,
    }) =>
      createConfiguredConnectRuntimeContribution({
        capability,
        userId,
        ...(connection ? { connection } : {}),
        ...(readSecret("COMPOSIO_API_KEY")
          ? { apiKey: readSecret("COMPOSIO_API_KEY") }
          : {}),
        ...(outbound ? { fetch: outbound } : {}),
        ...(pinToolCatalog ? { pinToolCatalog } : {}),
      }),
  ],
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
  settings?: Record<string, unknown>;
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
  ...catalogProvidersV1.map(
    (provider): [string, ModelRuntimeContributionFactory] => [
      `provider-${provider.id}`,
      {
        providerType: provider.id,
        create: (config) => {
          if (!config.leaseCredential || !config.settleCredential)
            throw new Error(`${provider.name} credential host is unavailable`);
          return createCatalogProviderFeatureV1({
            providerId: provider.id,
            accountId: config.accountId,
            connectionId: config.connectionId,
            settings: config.settings,
            leaseCredential: config.leaseCredential,
            settleCredential: config.settleCredential,
          });
        },
      },
    ],
  ),
]);

/**
 * Backend Contribution resolution lives in `./contributions.ts`. Re-exported
 * here so every caller keeps its existing import.
 */
export {
  backendDescriptorsV1,
  createFoundationBackendContributions,
} from "./contributions.js";
export type { MachineGatewayHostV1 } from "@frockbot/app/machine/backend";
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
 * Whether this deployment can reach a Computer.
 *
 * One question, answered once per mount, so the host registration, the tools
 * and the prompt cannot disagree about whether there is a Computer. It is the
 * presence of a host and nothing else: which credential a particular host
 * needs is that host's business and is settled by the shell that built it,
 * which is why no name of one appears here.
 */
function computerConfiguredV1(host: {
  computerHost?: ShellComputerHostFactoryV1;
}): boolean {
  return Boolean(host.computerHost);
}

/**
 * Registers the host the shell handed in, with this Turn's seams on it.
 *
 * A deployment with no host registers none: the Computer Package then mounts
 * unconfigured, which is what every Computer surface already says when it
 * cannot reach one.
 */
function computerProviderFeature(host: {
  computerHost?: ShellComputerHostFactoryV1;
  computerSync?: ComputerSyncHostV1;
  computerAgentControlOwnerId?: string;
}): FoundationFeature {
  const build = host.computerHost;
  return (runtime: { computers: ComputerRegistry }) => {
    if (!build) return;
    return runtime.computers.register(
      build({
        ...(host.computerSync ? { sync: host.computerSync } : {}),
        ...(host.computerAgentControlOwnerId
          ? { agentControlOwnerId: host.computerAgentControlOwnerId }
          : {}),
      }),
    );
  };
}

export function createFoundationHostedRuntimePackages(
  host: ShellHostedRuntimeHostV1,
): FoundationRuntimePackage[] {
  const computerConfigured = computerConfiguredV1(host);
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
    ...(host.plugins
      ? [runtimePackage("plugins", createPluginsFeature(host.plugins))]
      : []),
    runtimePackage(
      "credentials",
      createCredentialsFeature({ readSecret: host.readSecret }),
    ),
    runtimePackage("computer-host", computerProviderFeature(host)),
    runtimePackage(
      "computer",
      createComputerAgentFeature({
        userId: host.userId,
        defaultProviderId: "computer-host",
        configured: computerConfigured,
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
  host: ShellEnabledRuntimeHostV1,
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
  host: ShellModelRuntimeHostV1,
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
      settings: binding.connection.settings,
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

/**
 * What this application hands the Shell's Bot Contribution: its Packages, and
 * the three factories that turn a Package id into a mounted feature. The Shell
 * reads no part of this application directly.
 */
export const foundationShellApplicationV1: ShellApplicationV1 = {
  packages: FOUNDATION_PACKAGES_V1,
  packageVersion: FOUNDATION_PACKAGE_VERSION_V1,
  runtime: {
    base: foundationBaseRuntimePackagesV1,
    hosted: createFoundationHostedRuntimePackages,
    enabled: createFoundationEnabledRuntimePackages,
    model: createFoundationModelRuntimePackage,
  },
};
