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
import type { ComputerSyncHostV1 } from "@frockbot/computer-core";
// Flock contributes lifecycle routes and durable User/Bot state.
import flockManifest from "@frockbot/plugin-flock/manifest";
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
import memoryManifest from "@frockbot/plugin-memory/manifest";
import mobileClipboardManifest from "@frockbot/plugin-mobile-clipboard/manifest";
import mobileNotificationsManifest from "@frockbot/plugin-mobile-notifications/manifest";
import foundationProviderManifest from "@frockbot/plugin-provider-foundation/manifest";
import foundationProviderPlugin, {
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/plugin-provider-foundation/runtime";
import ollamaCloudManifest from "@frockbot/plugin-provider-ollama-cloud/manifest";
import { createOllamaCloudRuntimePlugin } from "@frockbot/plugin-provider-ollama-cloud/runtime";
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
  ["@frockbot/plugin-provider-ollama-cloud", ollamaCloudManifest],
  ["@frockbot/plugin-echo", echoManifest],
  ["@frockbot/plugin-fly-sprite", flySpriteManifest],
  ["@frockbot/plugin-flock", flockManifest],
  ["@frockbot/plugin-memory", memoryManifest],
  ["@frockbot/plugin-mobile-clipboard", mobileClipboardManifest],
  ["@frockbot/plugin-mobile-notifications", mobileNotificationsManifest],
  ["@frockbot/plugin-clock", clockManifest],
  ["@frockbot/plugin-computer", computerManifest],
  ["@frockbot/plugin-desktop-clipboard", clipboardManifest],
  ["@frockbot/plugin-desktop-directory-picker", directoryPickerManifest],
  ["@frockbot/plugin-desktop-notifications", notificationsManifest],
  ["@frockbot/plugin-shell", shellManifest],
  ["@frockbot/plugin-skills", skillsManifest],
  ["@frockbot/plugin-settings", settingsManifest],
]);

const runtimeContributions = new Map([
  ["@frockbot/plugin-identity/agent", identityRuntimePlugin],
  ["@frockbot/plugin-provider-foundation/runtime", foundationProviderPlugin],
  ["@frockbot/plugin-echo/agent", echoRuntimePlugin],
  ["@frockbot/plugin-clock/agent", clockRuntimePlugin],
]);

type AssignedRuntimeContributionFactory = (config: {
  assignment: BotExecutionPlanV1["assignments"][number];
  userId: string;
  readSecret(name: string): string | undefined;
  authorizeConnection(): Promise<ConnectionView>;
}) => Plugin | undefined;

const assignedRuntimeContributionFactories = new Map<
  string,
  AssignedRuntimeContributionFactory
>();

interface ModelRuntimeContributionConfig {
  accountId: string;
  connectionId: string;
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  fetch?: typeof fetch;
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
      create: (config) =>
        createOllamaCloudRuntimePlugin({
          ...config,
          packageId: "provider-ollama-cloud",
        } as Parameters<typeof createOllamaCloudRuntimePlugin>[0]),
    },
  ],
]);

const applicationSource: ApplicationSource = {
  schemaVersion: 1,
  packages: applicationJson.packages,
};

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
  SettingsGatewayHost;

export async function createFoundationBackendContributions(
  plan: ApplicationPlan,
  host: FoundationGatewayHost,
): Promise<MountedFoundationBackend<BackendRouteContribution>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationBackendPluginHost<T>,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationGatewayHost | FoundationBackendPluginHost<T>,
): Promise<MountedFoundationBackend<BackendRouteContribution | T>> {
  const root = new Context();
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
          specifier === "@frockbot/plugin-settings/backend"
        ) {
          plugin = createSettingsGatewayPlugin(host, lifecycle);
        } else if (host.backendHost === "gateway") {
          throw new Error(
            `unknown foundation backend contribution: ${specifier}`,
          );
        } else {
          plugin = host.resolve(specifier, lifecycle);
        }
        await root.plugin(plugin);
      }
    }
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
  let disposed = false;
  return {
    contributions,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await root.fiber.dispose();
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

export function createFoundationHostedRuntimePackages(
  plan: ApplicationPlan,
  host: {
    userId: string;
    readSecret(name: string): string | undefined;
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
     * The Computer sync seam (ADR 0013), supplied by the Bot Durable Object
     * for one admitted Turn. Absent outside a Turn, and outside one whose
     * durable roots are reachable in object storage — the Computer provider
     * then offers no sync at all, and a Computer's durable roots live on the
     * Computer alone rather than reconciling against a store no authority
     * backs.
     */
    computerSync?: ComputerSyncHostV1;
  },
): FoundationAssignedRuntimePackage[] {
  return [
    ...(host.skills
      ? [runtimePackage(plan, "skills", createSkillsRuntimePlugin(host.skills))]
      : []),
    ...(host.memory
      ? [runtimePackage(plan, "memory", createMemoryRuntimePlugin(host.memory))]
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
      "fly-sprite",
      createFlySpriteProviderPlugin(undefined, {
        token: host.readSecret("SPRITES_TOKEN"),
        ...(host.computerSync ? { sync: host.computerSync } : {}),
      }),
    ),
    runtimePackage(
      plan,
      "computer",
      createComputerAgentPlugin({
        userId: host.userId,
        defaultProviderId: "fly-sprite",
      }),
    ),
  ];
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
  },
): Promise<FoundationAssignedRuntimePackage[]> {
  const result: FoundationAssignedRuntimePackage[] = [];
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
    await host.authorizeConnection(admittedAssignment);
    const plugin = factory({
      assignment,
      userId: host.userId,
      readSecret: host.readSecret,
      authorizeConnection: () => host.authorizeConnection(admittedAssignment),
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
    }),
  };
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
  runtimeIds.delete("computer");
  runtimeIds.delete("credentials");
  runtimeIds.delete("fly-sprite");
  // Assigned provider Packages mount only after durable Connections resolve.
  runtimeIds.delete("composio");
  runtimeIds.delete("provider-ollama-cloud");
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
