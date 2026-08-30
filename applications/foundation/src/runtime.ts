import {
  compileApplicationDeclarations,
  compileApplicationPlan,
  type ApplicationDeclarationPlan,
  type ApplicationPlan,
  type ApplicationSource,
} from "@frockbot/application-compiler";
import type {
  ContributionResolver,
  PackageSource,
} from "@frockbot/plugin-catalog";
import type {
  BotExecutionPlanV1,
  BotSettingsViewV1,
  ConnectionView,
} from "@frockbot/configuration-core";
import authManifest from "@frockbot/plugin-auth/manifest";
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
// Desktop and mobile Package manifests remain part of the immutable plan.
import clipboardManifest from "@frockbot/plugin-desktop-clipboard/manifest";
import directoryPickerManifest from "@frockbot/plugin-desktop-directory-picker/manifest";
// pi-lens-ignore: ts:2307
import notificationsManifest from "@frockbot/plugin-desktop-notifications/manifest";
// Runtime implementations are statically bound by the immutable application.
import echoRuntimePlugin from "@frockbot/plugin-echo/agent";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";
import { createFlySpriteProviderPlugin } from "@frockbot/plugin-fly-sprite/agent";
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
import settingsManifest from "@frockbot/plugin-settings/manifest";
import shellManifest from "@frockbot/plugin-shell/manifest";
import uiThemeManifest from "@frockbot/plugin-ui-theme/manifest";
import applicationJson from "../frockbot.application.json" with { type: "json" };

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };

const manifests = new Map<string, unknown>([
  ["@frockbot/plugin-ui-theme", uiThemeManifest],
  ["@frockbot/plugin-auth", authManifest],
  ["@frockbot/plugin-identity", identityManifest],
  ["@frockbot/plugin-provider-foundation", foundationProviderManifest],
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
export async function createFoundationBackendContributions(
  plan: ApplicationPlan,
  host: { backendHost: "gateway" } & FlockGatewayHost,
): Promise<MountedFoundationBackend<BackendRouteContribution>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationBackendPluginHost<T>,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host:
    | ({ backendHost: "gateway" } & FlockGatewayHost)
    | FoundationBackendPluginHost<T>,
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
  },
): FoundationAssignedRuntimePackage[] {
  return [
    runtimePackage(
      plan,
      "fly-sprite",
      createFlySpriteProviderPlugin(undefined, {
        token: host.readSecret("SPRITES_TOKEN"),
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

export async function createFoundationRuntimeApplication(): Promise<FoundationRuntimeApplication> {
  const plan = await compileFoundationApplication();
  const runtimeIds = new Set(plan.contributions.runtime);
  // Computer providers require host authority and are added only by a capable runtime.
  runtimeIds.delete("computer");
  runtimeIds.delete("fly-sprite");
  // Composio mounts only after durable Connections resolve its backend config.
  runtimeIds.delete("composio");
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
