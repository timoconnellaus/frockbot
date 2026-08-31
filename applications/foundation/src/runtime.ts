import {
  compileApplicationDeclarations,
  compileApplicationPlan,
  type ApplicationDeclarationPlan,
  type ApplicationPlan,
  type ApplicationSource,
} from "@frockbot/kernel-composition/compiler";
import type {
  ContributionResolver,
  PackageSource,
} from "@frockbot/kernel-composition";
import type { CredentialLeaseV1 } from "@frockbot/connection-core";
import type {
  BotExecutionPlanV1,
  BotSettingsViewV1,
  ConnectionView,
  ResolvedModelBindingV1,
} from "@frockbot/configuration-core";
import authManifest from "@frockbot/plugin-auth/manifest";
import authoringManifest from "@frockbot/plugin-authoring/manifest";
import {
  createAuthoringRuntimePlugin,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring/agent";
import clockRuntimePlugin from "@frockbot/plugin-clock/agent";
// Every selected package manifest participates in the compiled application hash.
import clockManifest from "@frockbot/plugin-clock/manifest";
import { Context, type Plugin } from "cordis";

export interface BackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
}
// pi-lens-ignore: ts:2307
import computerManifest from "@frockbot/plugin-computer/manifest";
import { createComputerAgentPlugin } from "@frockbot/plugin-computer/agent";
import {
  createSharedComputerProviderPlugin,
  type SharedComputerHostClient,
} from "@frockbot/plugin-computer/shared-provider";
import credentialsManifest from "@frockbot/plugin-credentials/manifest";
import { createCredentialRuntimePlugin } from "@frockbot/plugin-credentials/user";
// Desktop and mobile Package manifests remain part of the immutable plan.
import clipboardManifest from "@frockbot/plugin-desktop-clipboard/manifest";
import directoryPickerManifest from "@frockbot/plugin-desktop-directory-picker/manifest";
// pi-lens-ignore: ts:2307
import notificationsManifest from "@frockbot/plugin-desktop-notifications/manifest";
// Runtime implementations are statically bound by the immutable application.
import echoRuntimePlugin from "@frockbot/plugin-echo/agent";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";
import { createFlySpriteProviderPlugin } from "@frockbot/plugin-fly-sprite/agent";
import {
  ComputerHostClient,
  type ComputerHostFetcherV1,
} from "@frockbot/plugin-fly-sprite/host-client";
import type { ComputerSyncHostV1 } from "@frockbot/computer-core";
// Flock contributes lifecycle routes and durable User/Bot state.
import flockManifest from "@frockbot/plugin-flock/manifest";
import {
  createFlockRuntimePlugin,
  type FlockSelfRuntimeHostV1,
} from "@frockbot/plugin-flock/agent";
export type { FlockSelfRuntimeHostV1 } from "@frockbot/plugin-flock/agent";
// Gateway Flock behavior is resolved as a lifecycle-owned Plugin.
import {
  createFlockBackendContribution,
  type FlockGatewayHost,
} from "@frockbot/plugin-flock";
const createFlockGatewayPlugin = (
  createFlockBackendContribution as typeof createFlockBackendContribution & {
    plugin(
      host: FlockGatewayHost,
      lifecycle: BackendContributionLifecycle<BackendRouteContribution>,
    ): Plugin;
  }
).plugin;

import echoManifest from "@frockbot/plugin-echo/manifest";
import identityRuntimePlugin from "@frockbot/plugin-identity/agent";
import identityManifest from "@frockbot/plugin-identity/manifest";
import mcpManifest from "@frockbot/plugin-mcp/manifest";
import {
  createConfiguredMcpRuntimeContribution,
  type McpMountOutcomeV1,
} from "@frockbot/plugin-mcp/agent";
import {
  createMcpLifecycleRuntimePlugin,
  type McpLifecycleToolHostV1,
} from "@frockbot/plugin-mcp/lifecycle-tools";
export type { McpLifecycleToolHostV1 } from "@frockbot/plugin-mcp/lifecycle-tools";
// The MCP status and lifecycle routes are the Package's own; the Settings
// gateway Contribution stays provider-neutral.
import {
  createMcpBackendContribution,
  type McpGatewayHost,
} from "@frockbot/plugin-mcp/backend";
const createMcpGatewayPlugin = createMcpBackendContribution.plugin;
import memoryManifest from "@frockbot/plugin-memory/manifest";
import mobileClipboardManifest from "@frockbot/plugin-mobile-clipboard/manifest";
import mobileNotificationsManifest from "@frockbot/plugin-mobile-notifications/manifest";
import packagePublisherManifest from "@frockbot/plugin-package-publisher/manifest";
import {
  createPackagePublisherAgentPlugin,
  type PackagePublisherAgentHost,
} from "@frockbot/plugin-package-publisher/agent";
export type { PackagePublisherAgentHost } from "@frockbot/plugin-package-publisher/agent";
import {
  createPackagePublisherBackendContribution,
  type PackagePublisherGatewayHost,
} from "@frockbot/plugin-package-publisher/backend"; // built-in publication Contribution
const createPackagePublisherGatewayPlugin =
  createPackagePublisherBackendContribution.plugin;
import foundationProviderManifest from "@frockbot/plugin-provider-foundation/manifest";
import foundationProviderPlugin, {
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/plugin-provider-foundation/runtime";
import ollamaCloudManifest from "@frockbot/plugin-provider-ollama-cloud/manifest";
import {
  createOllamaCloudRuntimePlugin,
  ollamaChatBaseUrl,
} from "@frockbot/plugin-provider-ollama-cloud/runtime";
import routinesManifest from "@frockbot/plugin-routines/manifest";
// The Routines gateway Contribution carries the Bot-scoped Routine routes.
import {
  createRoutinesBackendContribution,
  type RoutinesGatewayHost,
} from "@frockbot/plugin-routines/backend";
const createRoutinesGatewayPlugin = (
  createRoutinesBackendContribution as typeof createRoutinesBackendContribution & {
    plugin(
      host: RoutinesGatewayHost,
      lifecycle: BackendContributionLifecycle<BackendRouteContribution>,
    ): Plugin;
  }
).plugin;
import {
  createRoutinesRuntimePlugin,
  type RoutinesRuntimeHostV1,
} from "@frockbot/plugin-routines/agent";
export type { RoutinesRuntimeHostV1 } from "@frockbot/plugin-routines/agent";
import searchManifest from "@frockbot/plugin-search/manifest";
// Gateway Search behavior is resolved as a lifecycle-owned Plugin.
import {
  createSearchBackendContribution,
  type SearchGatewayHost,
} from "@frockbot/plugin-search/backend";
const createSearchGatewayPlugin = (
  createSearchBackendContribution as typeof createSearchBackendContribution & {
    plugin(
      host: SearchGatewayHost,
      lifecycle: BackendContributionLifecycle<BackendRouteContribution>,
    ): Plugin;
  }
).plugin;
import { createConfiguredOllamaWebSearchRuntimeContribution } from "@frockbot/plugin-provider-ollama-cloud/web-search";
// The Web Package contributes `web_fetch`: no Connection, no provider, and no
// Computer — it works while the User's Computer is hibernated.
import webManifest from "@frockbot/plugin-web/manifest";
import { createConfiguredWebFetchRuntimeContribution } from "@frockbot/plugin-web/agent";
import settingsManifest from "@frockbot/plugin-settings/manifest";
// Provider-neutral Connection transport is owned by the Settings gateway Contribution.
import {
  createSettingsBackendContribution,
  type SettingsGatewayHost,
} from "@frockbot/plugin-settings/backend";
const createSettingsGatewayPlugin = (
  createSettingsBackendContribution as typeof createSettingsBackendContribution & {
    plugin(
      host: SettingsGatewayHost,
      lifecycle: BackendContributionLifecycle<BackendRouteContribution>,
    ): Plugin;
  }
).plugin;
import {
  createMemoryRuntimePlugin,
  type MemoryRuntimeHostV1,
} from "@frockbot/plugin-memory/agent";
import imageManifest from "@frockbot/plugin-image/manifest";
import {
  createImageRuntimePlugin,
  type ImageRuntimeHostV1,
} from "@frockbot/plugin-image/agent";
import shellAgentPlugin from "@frockbot/plugin-shell/agent";
import shellManifest from "@frockbot/plugin-shell/manifest";
import skillsManifest from "@frockbot/plugin-skills/manifest";
import {
  createSkillsRuntimePlugin,
  type SkillsRuntimeHostV1,
} from "@frockbot/plugin-skills/agent";
import uiThemeManifest from "@frockbot/plugin-ui-theme/manifest";
import applicationJson from "../frockbot.application.json" with { type: "json" };

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };

const manifests = new Map<string, unknown>([
  ["@frockbot/plugin-ui-theme", uiThemeManifest],
  ["@frockbot/plugin-auth", authManifest],
  ["@frockbot/plugin-authoring", authoringManifest],
  ["@frockbot/plugin-identity", identityManifest],
  ["@frockbot/plugin-provider-foundation", foundationProviderManifest],
  ["@frockbot/plugin-credentials", credentialsManifest],
  ["@frockbot/plugin-web", webManifest],
  ["@frockbot/plugin-provider-ollama-cloud", ollamaCloudManifest],
  ["@frockbot/plugin-echo", echoManifest],
  ["@frockbot/plugin-fly-sprite", flySpriteManifest],
  ["@frockbot/plugin-flock", flockManifest],
  ["@frockbot/plugin-mcp", mcpManifest],
  ["@frockbot/plugin-memory", memoryManifest],
  ["@frockbot/plugin-image", imageManifest],
  ["@frockbot/plugin-mobile-clipboard", mobileClipboardManifest],
  ["@frockbot/plugin-mobile-notifications", mobileNotificationsManifest],
  ["@frockbot/plugin-package-publisher", packagePublisherManifest],
  ["@frockbot/plugin-clock", clockManifest],
  ["@frockbot/plugin-computer", computerManifest],
  ["@frockbot/plugin-desktop-clipboard", clipboardManifest],
  ["@frockbot/plugin-desktop-directory-picker", directoryPickerManifest],
  ["@frockbot/plugin-desktop-notifications", notificationsManifest],
  ["@frockbot/plugin-shell", shellManifest],
  ["@frockbot/plugin-skills", skillsManifest],
  ["@frockbot/plugin-search", searchManifest],
  ["@frockbot/plugin-settings", settingsManifest],
  ["@frockbot/plugin-routines", routinesManifest],
]);

const runtimeContributions = new Map([
  ["@frockbot/plugin-identity/agent", identityRuntimePlugin],
  ["@frockbot/plugin-provider-foundation/runtime", foundationProviderPlugin],
  ["@frockbot/plugin-echo/agent", echoRuntimePlugin],
  ["@frockbot/plugin-clock/agent", clockRuntimePlugin],
  // The Shell's user-facing send tool and parent hand-off; it needs no host.
  ["@frockbot/plugin-shell/agent", shellAgentPlugin],
]);

/**
 * What the host gives one Assignment-derived runtime Contribution. The
 * Connection-bound fields are present only when the Assignment names a
 * Connection, so a Capability with `connectionTypes: []` receives an
 * Assignment and nothing else.
 */
type AssignedRuntimeContributionFactory = (config: {
  assignment: BotExecutionPlanV1["assignments"][number];
  /** This Assignment's ordinal among the enabled Assignments of its Package. */
  assignmentIndex: number;
  userId: string;
  readSecret(name: string): string | undefined;
  authorizeConnection(): Promise<ConnectionView>;
  /** The Package's own outbound seam, when the host owns one. */
  fetch?: typeof fetch;
  /**
   * The already-authorized Connection, when the Assignment binds one. A
   * Capability with `connectionTypes: []` receives an Assignment and no
   * Connection, so this is absent rather than empty.
   */
  connection?: ConnectionView;
  /**
   * An expiring lease over the Assignment's Connection credential. Supplied
   * only by a host that carries the User's authority; a Contribution that
   * needs no credential never calls it.
   */
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
  /**
   * Where a mount outcome goes durably, when the host carries the User's
   * authority. A Contribution whose failure has no durable home simply omits
   * it — and then an unreachable server is invisible, which is what this
   * seam exists to prevent.
   */
  recordOutcome?(outcome: McpMountOutcomeV1): Promise<void>;
}) => Plugin | undefined | Promise<Plugin | undefined>;

const assignedRuntimeContributionFactories = new Map<
  string,
  AssignedRuntimeContributionFactory
>([
  [
    "@frockbot/plugin-mcp/agent",
    (config) =>
      createConfiguredMcpRuntimeContribution({
        ...config,
        ...(config.recordOutcome ? { onOutcome: config.recordOutcome } : {}),
      }),
  ],
  [
    "@frockbot/plugin-web/agent",
    ({ assignment, fetch: outbound }) =>
      createConfiguredWebFetchRuntimeContribution({
        assignment,
        ...(outbound ? { fetch: outbound } : {}),
      }),
  ],
  [
    "@frockbot/plugin-provider-ollama-cloud/runtime",
    ({
      assignment,
      userId,
      connection,
      leaseCredential,
      settleCredential,
      fetch: outbound,
    }) => {
      // `web_search` is authorized by its own Assignment and its own
      // Connection generation; a Bot whose model runs elsewhere still holds it.
      if (
        !connection?.generation ||
        !assignment.connectionId ||
        !leaseCredential ||
        !settleCredential
      ) {
        return undefined;
      }
      return createConfiguredOllamaWebSearchRuntimeContribution({
        assignment,
        accountId: userId,
        connectionId: assignment.connectionId,
        connectionGeneration: connection.generation,
        // Every inbound value is decoded at its seam: the provider Package
        // validates the endpoint root before it composes a request URL.
        ...(typeof connection.settings?.apiBaseUrl === "string"
          ? { apiBaseUrl: connection.settings.apiBaseUrl }
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
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  fetch?: typeof fetch;
  /**
   * Endpoint root carried on the Connection's settings bag, when its User
   * pointed the Connection at something other than the Package default.
   */
  apiBaseUrl?: string;
}

interface ModelRuntimeContributionFactory {
  providerType: string;
  create(config: ModelRuntimeContributionConfig): Plugin;
}

const modelRuntimeContributionFactories = new Map<
  string,
  ModelRuntimeContributionFactory
>([
  [
    "@frockbot/plugin-provider-ollama-cloud/runtime",
    {
      providerType: "ollama-cloud",
      create: ({ apiBaseUrl, ...config }) =>
        createOllamaCloudRuntimePlugin({
          ...config,
          packageId: "provider-ollama-cloud",
          chatBaseUrl: ollamaChatBaseUrl(apiBaseUrl),
        } as Parameters<typeof createOllamaCloudRuntimePlugin>[0]),
    },
  ],
]);

const applicationSource: ApplicationSource = {
  schemaVersion: 1,
  packages: applicationJson.packages,
};

/**
 * The client slot the authenticated application root is mounted into. The
 * Package that mounts it *is* the hosted product UI — every other client
 * Package mounts into a slot that one provides.
 */
export const APPLICATION_ROOT_SLOT_V1 = "authenticated-root";

/**
 * Whether a Package belongs in the catalog a User installs from.
 *
 * The application mounts its own shell unconditionally: the User never chose
 * it, cannot uninstall it, and assigns nothing from it, so listing it beside
 * the Packages they can install would offer a choice that does not exist. The
 * rule is the manifest's own: a Package that mounts
 * {@link APPLICATION_ROOT_SLOT_V1} is the application root itself.
 *
 * Everything else stays installable, including a Package whose only
 * Capabilities are tools that take no Connection — a tool Package a User
 * installs and assigns without any credential is exactly that shape.
 */
export function isUserInstallablePackageV1(manifest: {
  contributions: { client?: { mounts: Array<{ slot: string }> } };
}): boolean {
  return !(manifest.contributions.client?.mounts ?? []).some(
    (mount) => mount.slot === APPLICATION_ROOT_SLOT_V1,
  );
}

export interface FoundationRuntimeApplication {
  plan: ApplicationPlan;
  packages: PackageSource[];
  resolveContribution: ContributionResolver;
}

export async function compileFoundationApplication(): Promise<ApplicationPlan> {
  return await compileApplicationPlan(
    applicationSource,
    (specifier) => {
      const manifest = manifests.get(specifier);
      if (!manifest)
        return Promise.reject(new Error(`unknown package: ${specifier}`));
      return Promise.resolve({ specifier, manifest });
    },
    { frockbotVersion: "0.0.1" },
  );
}

export function compileFoundationApplicationDeclarations(): ApplicationDeclarationPlan {
  return compileApplicationDeclarations(
    applicationSource,
    (specifier) => {
      const manifest = manifests.get(specifier);
      if (!manifest) throw new Error(`unknown package: ${specifier}`);
      return { specifier, manifest };
    },
    { frockbotVersion: "0.0.1" },
  );
}

function contributionSpecifier(specifier: string, entry: string): string {
  return `${specifier}${entry.slice(1)}`;
}

export interface BackendContributionLifecycle<T> {
  mount(contribution: T): () => void;
}

export interface FoundationBackendPluginHost<T> {
  backendHost: "bot" | "user";
  resolve(
    specifier: string,
    lifecycle: BackendContributionLifecycle<T>,
  ): Plugin;
}

export interface MountedFoundationBackend<T> {
  readonly contributions: readonly T[];
  dispose(): Promise<void>;
}

/** Mount every declared backend Contribution into one owned Cordis root. */
export type FoundationGatewayHost = {
  backendHost: "gateway";
} & FlockGatewayHost &
  McpGatewayHost &
  SettingsGatewayHost &
  RoutinesGatewayHost &
  SearchGatewayHost &
  PackagePublisherGatewayHost;

export async function createFoundationBackendContributions(
  plan: ApplicationPlan,
  host: FoundationGatewayHost,
): Promise<MountedFoundationBackend<BackendRouteContribution>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationBackendPluginHost<T>,
  root?: Context,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationGatewayHost | FoundationBackendPluginHost<T>,
  residentRoot?: Context,
): Promise<MountedFoundationBackend<BackendRouteContribution | T>> {
  const ownsRoot = !residentRoot;
  const root = residentRoot ?? new Context();
  const fibers: Array<ReturnType<Context["plugin"]>> = [];
  const contributions: Array<BackendRouteContribution | T> = [];
  const lifecycle: BackendContributionLifecycle<BackendRouteContribution | T> =
    {
      mount(contribution) {
        contributions.push(contribution);
        let mounted = true;
        return () => {
          if (!mounted) return;
          mounted = false;
          const index = contributions.indexOf(contribution);
          if (index >= 0) contributions.splice(index, 1);
        };
      },
    };
  try {
    for (const pkg of plan.packages) {
      if (!plan.contributions.backend.includes(pkg.id)) continue;
      for (const backend of pkg.manifest.contributions.backend ?? []) {
        if (backend.host !== host.backendHost) continue;
        const specifier = contributionSpecifier(pkg.specifier, backend.entry);
        let plugin: Plugin;
        if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-flock/backend"
        ) {
          plugin = createFlockGatewayPlugin(host, lifecycle);
        } else if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-mcp/backend"
        ) {
          plugin = createMcpGatewayPlugin(host, lifecycle);
        } else if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-settings/backend"
        ) {
          plugin = createSettingsGatewayPlugin(host, lifecycle);
        } else if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-routines/backend"
        ) {
          plugin = createRoutinesGatewayPlugin(host, lifecycle);
        } else if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-search/backend"
        ) {
          plugin = createSearchGatewayPlugin(host, lifecycle);
        } else if (
          host.backendHost === "gateway" &&
          specifier === "@frockbot/plugin-package-publisher/backend"
        ) {
          plugin = createPackagePublisherGatewayPlugin(host, lifecycle);
        } else if (host.backendHost === "gateway") {
          throw new Error(
            `unknown foundation backend contribution: ${specifier}`,
          );
        } else {
          plugin = host.resolve(specifier, lifecycle);
        }
        const fiber = root.plugin(plugin);
        fibers.push(fiber);
        await fiber;
      }
    }
  } catch (error) {
    await Promise.allSettled(fibers.reverse().map((fiber) => fiber.dispose()));
    if (ownsRoot) await root.fiber.dispose();
    throw error;
  }
  let disposed = false;
  return {
    contributions,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(
        fibers.reverse().map((fiber) => fiber.dispose()),
      );
      if (ownsRoot) await root.fiber.dispose();
    },
  };
}

export interface FoundationAssignedRuntimePackage {
  specifier: string;
  contributionSpecifier: string;
  manifest: unknown;
  plugin: Plugin;
}

function runtimePackage(
  plan: ApplicationPlan,
  packageId: string,
  plugin: Plugin,
): FoundationAssignedRuntimePackage {
  const pkg = plan.packages.find((candidate) => candidate.id === packageId);
  const runtime = pkg?.manifest.contributions.runtime;
  if (!pkg || !runtime) {
    throw new Error(`foundation runtime package "${packageId}" is unavailable`);
  }
  return {
    specifier: pkg.specifier,
    contributionSpecifier: contributionSpecifier(pkg.specifier, runtime.entry),
    manifest: pkg.manifest,
    plugin,
  };
}

/**
 * The Computer providers this application registers. The in-worker Fly Sprites
 * provider is the default: it is the one that carries a Computer's per-User
 * identity, its Workspace file surface, and the durable-root sync (ADR 0013).
 * When the host also supplies the shared Computer host, its effect-journaling
 * proxy is registered beside it so an identified effect can be replayed rather
 * than repeated across Durable Object eviction.
 */
function computerProviderPlugin(host: {
  readSecret(name: string): string | undefined;
  computerSync?: ComputerSyncHostV1;
  computerHost?: SharedComputerHostClient;
  computerHostBinding?: ComputerHostBinding;
}): Plugin.Function {
  // `SPRITES_TOKEN` is no longer a credential here — the Computer host holds
  // the only copy, and this Worker could not use one if it had it. It survives
  // as the answer to one question: has this deployment a Computer at all? With
  // it unset the Computer card still reads "Set SPRITES_TOKEN to attach a
  // computer", which is the truth: no host of ours has a Sprites account.
  const configured = Boolean(host.readSecret("SPRITES_TOKEN")?.trim());
  const binding = host.computerHostBinding;
  const fly = createFlySpriteProviderPlugin(undefined, {
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
  });
  const shared = host.computerHost
    ? createSharedComputerProviderPlugin(host.computerHost)
    : undefined;
  if (!shared) return fly;
  const plugin: Plugin.Function = (ctx) => {
    ctx.plugin(fly);
    ctx.plugin(shared);
  };
  plugin.inject = ["computers"];
  return plugin;
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

export function createFoundationHostedRuntimePackages(
  plan: ApplicationPlan,
  host: {
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
     * The shared Computer host of ADR 0004: the service binding the Bot
     * Durable Object reaches a Computer through, and the secret it presents.
     * Absent, and the Fly provider registers unconfigured — this Worker holds
     * no Sprites SDK and no way to reach a Computer without it.
     */
    computerHostBinding?: ComputerHostBinding;
    /**
     * The Package authoring seam, supplied by the Bot Durable Object for one
     * admitted Turn. Absent outside a Turn, and the Authoring Package is then
     * not mounted at all: a Bot cannot author a Package except inside a Turn
     * whose run and session its provenance can name.
     */
    authoring?: PackageAuthoringHost;
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
     * The Computer sync seam (ADR 0013), supplied by the Bot Durable Object
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
     * The Bot self-management seam, supplied by the Bot Durable Object for one
     * admitted Turn. Absent outside a Turn, and the Flock runtime Contribution
     * is then not mounted: a Bot changes its own identity, or adds a Bot to
     * its User's flock, only inside a Turn whose Session and Turn the write
     * can name.
     */
    botSelfManagement?: FlockSelfRuntimeHostV1;
    /**
     * The MCP lifecycle seam, supplied by the Bot Durable Object for one
     * admitted Turn. It carries the User's own MCP records, so the lifecycle
     * tools run with exactly the authority the User already holds. Absent
     * outside a Turn, and the tools are then not offered at all.
     */
    mcp?: McpLifecycleToolHostV1;
    packagePublisher: PackagePublisherAgentHost;
  },
): FoundationAssignedRuntimePackage[] {
  return [
    ...(host.mcp
      ? [runtimePackage(plan, "mcp", createMcpLifecycleRuntimePlugin(host.mcp))]
      : []),
    ...(host.botSelfManagement
      ? [
          runtimePackage(
            plan,
            "flock",
            createFlockRuntimePlugin(host.botSelfManagement),
          ),
        ]
      : []),
    ...(host.skills
      ? [runtimePackage(plan, "skills", createSkillsRuntimePlugin(host.skills))]
      : []),
    ...(host.memory
      ? [runtimePackage(plan, "memory", createMemoryRuntimePlugin(host.memory))]
      : []),
    ...(host.image
      ? [runtimePackage(plan, "image", createImageRuntimePlugin(host.image))]
      : []),
    ...(host.routines
      ? [
          runtimePackage(
            plan,
            "routines",
            createRoutinesRuntimePlugin(host.routines),
          ),
        ]
      : []),
    ...(host.authoring
      ? [
          runtimePackage(
            plan,
            "authoring",
            createAuthoringRuntimePlugin(host.authoring),
          ),
        ]
      : []),
    runtimePackage(
      plan,
      "credentials",
      createCredentialRuntimePlugin({ readSecret: host.readSecret }),
    ),
    runtimePackage(
      plan,
      "package-publisher",
      createPackagePublisherAgentPlugin(host.packagePublisher, {
        userId: host.userId,
        defaultProviderId: "fly-sprite",
      }),
    ),
    runtimePackage(plan, "fly-sprite", computerProviderPlugin(host)),
    runtimePackage(
      plan,
      "computer",
      createComputerAgentPlugin({
        userId: host.userId,
        defaultProviderId: "fly-sprite",
        ...(host.computerWriter ? { writer: host.computerWriter } : {}),
      }),
    ),
  ];
}

/**
 * Collapse runtime Contributions that share a contribution specifier into one.
 *
 * The runtime resolves a Package's declared runtime entry to exactly one
 * Plugin — `resolveContribution` takes the first match and `packages.install`
 * dedupes by specifier — so two entries naming the same Contribution silently
 * lose one. `plugin-mcp` produces several on purpose: one lifecycle
 * Contribution for the Turn, and one per assigned server, up to the per-User
 * ceiling. Merging them into a single Plugin that mounts each in order is how
 * all of them reach the Bot; the order is preserved, so the lifecycle tools
 * mount before the servers whose state they report.
 */
export function mergeFoundationRuntimePackages(
  packages: readonly FoundationAssignedRuntimePackage[],
): FoundationAssignedRuntimePackage[] {
  const merged: FoundationAssignedRuntimePackage[] = [];
  const byContribution = new Map<string, Plugin[]>();
  for (const pkg of packages) {
    const existing = byContribution.get(pkg.contributionSpecifier);
    if (existing) {
      existing.push(pkg.plugin);
      continue;
    }
    byContribution.set(pkg.contributionSpecifier, [pkg.plugin]);
    merged.push(pkg);
  }
  return merged.map((pkg) => {
    const plugins = byContribution.get(pkg.contributionSpecifier) ?? [];
    if (plugins.length <= 1) return pkg;
    const composite: Plugin.Function = (ctx) => {
      for (const plugin of plugins) ctx.plugin(plugin);
    };
    return { ...pkg, plugin: composite };
  });
}

export async function createFoundationAssignedRuntimePackages(
  plan: ApplicationPlan,
  settings: BotSettingsViewV1,
  execution: BotExecutionPlanV1,
  host: {
    userId: string;
    readSecret(name: string): string | undefined;
    authorizeConnection(
      assignment: BotSettingsViewV1["assignments"][number],
    ): Promise<ConnectionView>;
    /** The Package's own outbound seam, passed through to each Contribution. */
    fetch?: typeof fetch;
    /** The User's credential authority, for Contributions that hold a key. */
    leaseCredential?(
      assignment: BotSettingsViewV1["assignments"][number],
      effectId: string,
      expectedGeneration?: string,
    ): Promise<CredentialLeaseV1>;
    settleCredential?(
      assignment: BotSettingsViewV1["assignments"][number],
      effectId: string,
    ): Promise<void>;
    /** The durable home of a mount outcome, when the host has one. */
    recordOutcome?(outcome: McpMountOutcomeV1): Promise<void>;
  },
): Promise<FoundationAssignedRuntimePackage[]> {
  const result: FoundationAssignedRuntimePackage[] = [];
  const assignmentIndexes = new Map<string, number>();
  for (const assignment of execution.assignments) {
    if (assignment.state !== "enabled") continue;
    const pkg = plan.packages.find(
      (candidate) => candidate.id === assignment.packageId,
    );
    const runtime = pkg?.manifest.contributions.runtime;
    if (!pkg || !runtime) continue;
    const specifier = contributionSpecifier(pkg.specifier, runtime.entry);
    const factory = assignedRuntimeContributionFactories.get(specifier);
    if (!factory) continue;
    const admittedAssignment = settings.assignments.find(
      (candidate) => candidate.assignmentId === assignment.assignmentId,
    );
    if (!admittedAssignment) continue;
    // A Capability with no Connection type is authorized by its Assignment
    // alone; asking the host to authorize a Connection the Assignment does not
    // name would refuse a Capability the User did grant.
    const connection = admittedAssignment.connectionId
      ? await host.authorizeConnection(admittedAssignment)
      : undefined;
    const assignmentIndex = assignmentIndexes.get(pkg.id) ?? 0;
    assignmentIndexes.set(pkg.id, assignmentIndex + 1);
    const plugin = await factory({
      assignment,
      assignmentIndex,
      userId: host.userId,
      readSecret: host.readSecret,
      authorizeConnection: () => host.authorizeConnection(admittedAssignment),
      ...(connection ? { connection } : {}),
      ...(host.fetch ? { fetch: host.fetch } : {}),
      ...(host.leaseCredential
        ? {
            leaseCredential: (effectId, expectedGeneration) =>
              host.leaseCredential!(
                admittedAssignment,
                effectId,
                expectedGeneration,
              ),
          }
        : {}),
      ...(host.settleCredential
        ? {
            settleCredential: (effectId) =>
              host.settleCredential!(admittedAssignment, effectId),
          }
        : {}),
      ...(host.recordOutcome ? { recordOutcome: host.recordOutcome } : {}),
    });
    if (!plugin) continue;
    result.push({
      specifier: pkg.specifier,
      contributionSpecifier: specifier,
      manifest: pkg.manifest,
      plugin,
    });
  }
  return result;
}

export function createFoundationModelRuntimePackage(
  plan: ApplicationPlan,
  binding: ResolvedModelBindingV1,
  host: ModelRuntimeContributionConfig,
): FoundationAssignedRuntimePackage {
  if (
    binding.state === "unavailable" ||
    !binding.connection ||
    !binding.packageId ||
    !binding.providerType
  ) {
    throw new Error(binding.failure ?? "Bot model Connection is unavailable");
  }
  const pkg = plan.packages.find(
    (candidate) => candidate.id === binding.packageId,
  );
  const runtime = pkg?.manifest.contributions.runtime;
  if (!pkg || !runtime) {
    throw new Error("Bot model Package runtime is unavailable");
  }
  const specifier = contributionSpecifier(pkg.specifier, runtime.entry);
  const factory = modelRuntimeContributionFactories.get(specifier);
  if (!factory || factory.providerType !== binding.providerType) {
    throw new Error(
      `Bot model provider "${binding.providerType}" is unavailable`,
    );
  }
  return {
    specifier: pkg.specifier,
    contributionSpecifier: specifier,
    manifest: pkg.manifest,
    plugin: factory.create({
      ...host,
      connectionId: binding.connection.connectionId,
      // Every inbound value is decoded at its seam: the provider Package
      // validates the endpoint root before it composes a request URL.
      ...(typeof binding.connection.settings?.["api-base-url"] === "string"
        ? { apiBaseUrl: binding.connection.settings["api-base-url"] }
        : {}),
    }),
  };
}

/**
 * Collapse runtime packages that share one Contribution specifier into one.
 *
 * A Package declares exactly one runtime entry, and the runtime host resolves
 * a Contribution specifier to exactly one Plugin, so two packages naming the
 * same entry would silently drop one. `provider-ollama-cloud` is the first
 * Package to reach a Turn twice — once as the Bot's model provider, once as
 * the Connection-backed `web_search` Capability — and both must mount. The
 * merged Plugin mounts each child in order and inherits the union of their
 * injections, so nothing observes the difference.
 */
export function mergeFoundationRuntimePackagesV1(
  packages: readonly FoundationAssignedRuntimePackage[],
): FoundationAssignedRuntimePackage[] {
  const merged: FoundationAssignedRuntimePackage[] = [];
  const byContribution = new Map<string, FoundationAssignedRuntimePackage[]>();
  for (const pkg of packages) {
    const existing = byContribution.get(pkg.contributionSpecifier);
    if (existing) {
      existing.push(pkg);
      continue;
    }
    const group = [pkg];
    byContribution.set(pkg.contributionSpecifier, group);
    merged.push(pkg);
  }
  return merged.map((pkg) => {
    const group = byContribution.get(pkg.contributionSpecifier) ?? [pkg];
    if (group.length === 1) return pkg;
    const children = group.map((member) => member.plugin);
    const composed: Plugin.Function = (ctx) => {
      for (const child of children) ctx.plugin(child);
    };
    const injections = new Set<string>();
    for (const child of children) {
      const declared = (child as { inject?: string[] | undefined }).inject;
      for (const injection of declared ?? []) injections.add(injection);
    }
    if (injections.size > 0) composed.inject = [...injections];
    return { ...pkg, plugin: composed };
  });
}

export async function createFoundationRuntimeApplication(): Promise<FoundationRuntimeApplication> {
  const plan = await compileFoundationApplication();
  const runtimeIds = new Set(plan.contributions.runtime);
  // Computer providers require host authority and are added only by a capable runtime.
  // Authoring mounts only for an admitted Turn, which supplies its host.
  runtimeIds.delete("authoring");
  // Skills mount only for a Turn whose instruction root the host can read.
  runtimeIds.delete("skills");
  // Memory mounts only for a Turn whose Memory roots the host can reach.
  runtimeIds.delete("memory");
  // Image generation mounts only for a Turn whose Workspace the host can
  // write, so a generated image records the Session and Turn that produced it.
  runtimeIds.delete("image");
  // A Bot changes itself only inside an admitted Turn, which supplies the
  // self-management host; the Flock's other Contributions are backend and
  // client, and neither runs here.
  runtimeIds.delete("flock");
  // Routines mount only for a Turn, so a Routine write records the Session and
  // Turn that produced it.
  runtimeIds.delete("routines");
  runtimeIds.delete("computer");
  runtimeIds.delete("credentials");
  runtimeIds.delete("fly-sprite");
  // Package publication is mounted with the current User's durable host.
  runtimeIds.delete("package-publisher");
  // Assigned provider Packages mount only after durable Connections resolve.
  runtimeIds.delete("composio");
  // Remote MCP servers mount per enabled Assignment, after the Connection and
  // its handshake resolve.
  runtimeIds.delete("mcp");
  runtimeIds.delete("provider-ollama-cloud");
  // The Web Package's `web_fetch` mounts only for a Bot whose User assigned
  // the `web-fetch` Capability to it.
  runtimeIds.delete("web");
  return {
    plan,
    packages: plan.packages
      .filter((pkg) => runtimeIds.has(pkg.id))
      .map((pkg) => ({
        specifier: pkg.specifier,
        manifest: {
          ...pkg.manifest,
          contributions: {
            runtime: pkg.manifest.contributions.runtime,
          },
        },
      })),
    resolveContribution: (specifier) => {
      const plugin = runtimeContributions.get(specifier);
      if (plugin) return Promise.resolve({ default: plugin });
      return Promise.reject(
        new Error(`unknown foundation runtime contribution: ${specifier}`),
      );
    },
  };
}
