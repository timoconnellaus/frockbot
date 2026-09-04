/**
 * The foundation application's Contribution table.
 *
 * This is the one module in the application that knows which first-party
 * Package implements which Contribution specifier. Every other module —
 * `runtime.ts`, `user.ts`, `client.ts`, and the Bot Durable Object in
 * `apps/cloudflare` — iterates the compiled {@link ApplicationPlan} and looks
 * the specifier the *manifest* declares up in here. Nothing branches on a
 * Package's identity to find its code, which is what `AGENTS.md` requires:
 *
 * > Every Contribution kind is resolved from the manifest and an artifact,
 * > never from a switch over Package identity.
 *
 * A member of the plan that carries an `artifact` is not in this table at all:
 * it loads through `packages/kernel-composition/src/isolate-host.ts` like any
 * Bot-authored Package. That is the seam an artifact-backed first-party
 * Package — the Applets Package of ADR 0022 — arrives through, and
 * {@link assertFoundationBackendContributionsResolvable} is where a member
 * that is neither artifact-backed nor in the table becomes a compile error of
 * the application.
 *
 * The client half of the table lives in `./client-contributions.ts`, which
 * this module deliberately does not import: a client Contribution is React in
 * the browser bundle, and the backend table is server code in the Worker
 * bundle. Importing either from the other would put each in the other's
 * bundle. `packages/architecture-checks` asserts the two halves together
 * cover every Contribution the application declares.
 */
import type {
  ApplicationPlan,
  CompiledPackage,
} from "@frockbot/kernel-composition/compiler";
import type {
  BackendContributionDescriptorV1,
  ContributionLifecycleV1,
} from "@frockbot/kernel-contracts/contributions";
import { Context, type Plugin } from "cordis";

import {
  backendContribution as adminGatewayContribution,
  type AdminGatewayHost,
} from "@frockbot/plugin-admin/backend";
import {
  backendContribution as auditGatewayContribution,
  type AuditGatewayHost,
} from "@frockbot/plugin-audit/backend";
import {
  backendContribution as botTemplateGatewayContribution,
  type BotTemplateGatewayHostV1,
} from "@frockbot/plugin-bot-template/backend";
import {
  backendContribution as computerGatewayContribution,
  type ComputerGatewayHost,
} from "@frockbot/plugin-computer/backend";
import {
  backendContribution as flockGatewayContribution,
  type FlockGatewayHost,
} from "@frockbot/plugin-flock/backend";
import {
  backendContribution as mcpGatewayContribution,
  type McpGatewayHost,
} from "@frockbot/plugin-mcp/backend";
import {
  backendContribution as packagePublisherGatewayContribution,
  type PackagePublisherGatewayHost,
} from "@frockbot/plugin-package-publisher/backend";
import {
  backendContribution as routinesGatewayContribution,
  type RoutinesGatewayHost,
} from "@frockbot/plugin-routines/backend";
import {
  backendContribution as searchGatewayContribution,
  type SearchGatewayHost,
} from "@frockbot/plugin-search/backend";
import {
  backendContribution as voiceGatewayContribution,
  type VoiceGatewayHostV1,
} from "@frockbot/plugin-voice/backend";
import {
  backendContribution as settingsGatewayContribution,
  type SettingsGatewayHost,
} from "@frockbot/plugin-settings/backend";
import {
  backendContribution as subagentsGatewayContribution,
  type SubagentsGatewayHost,
} from "@frockbot/plugin-subagents/backend";
import {
  backendContribution as machineGatewayContribution,
  type MachineGatewayHostV1,
} from "@frockbot/plugin-user-machine/backend";

import {
  userContribution as settingsUserContribution,
  type SettingsUserApplicationHostV1,
} from "@frockbot/plugin-settings/user";
import {
  userContribution as credentialsUserContribution,
  type CredentialsUserApplicationHostV1,
} from "@frockbot/plugin-credentials/user";
import {
  userContribution as ollamaCloudUserContribution,
  type OllamaCloudUserApplicationHostV1,
} from "@frockbot/plugin-provider-ollama-cloud/user";
import {
  userContribution as frockAiUserContribution,
  type FrockAiUserApplicationHostV1,
} from "@frockbot/plugin-provider-frock-ai/user";
import {
  userContribution as mcpUserContribution,
  type McpUserApplicationHostV1,
} from "@frockbot/plugin-mcp/user";
import {
  userContribution as botTemplateUserContribution,
  type BotTemplateUserApplicationHostV1,
} from "@frockbot/plugin-bot-template/user";
import {
  userContribution as packagePublisherUserContribution,
  type PackagePublisherUserApplicationHostV1,
} from "@frockbot/plugin-package-publisher/user";
import {
  userContribution as machineUserContribution,
  type MachineUserApplicationHostV1,
} from "@frockbot/plugin-user-machine/user";
import {
  userContribution as searchUserContribution,
  type SearchUserApplicationHostV1,
} from "@frockbot/plugin-search/user";
import {
  userContribution as auditUserContribution,
  type AuditUserApplicationHostV1,
} from "@frockbot/plugin-audit/user";
import {
  userContribution as flockUserContribution,
  type FlockUserApplicationHostV1,
} from "@frockbot/plugin-flock/user";
import {
  userContribution as voiceUserContribution,
  type VoiceUserApplicationHostV1,
} from "@frockbot/plugin-voice/user";

import {
  backendContribution as shellBotContribution,
  type ShellBotApplicationHostV1,
} from "@frockbot/plugin-shell/backend";
import {
  botContribution as flockBotContribution,
  type FlockBotApplicationHostV1,
} from "@frockbot/plugin-flock/bot";
import {
  botContribution as computerBotContribution,
  type ComputerBotApplicationHostV1,
} from "@frockbot/plugin-computer/bot";

export {
  adminGatewayContribution,
  auditGatewayContribution,
  botTemplateGatewayContribution,
  computerGatewayContribution,
  flockGatewayContribution,
  mcpGatewayContribution,
  packagePublisherGatewayContribution,
  routinesGatewayContribution,
  searchGatewayContribution,
  voiceGatewayContribution,
  settingsGatewayContribution,
  subagentsGatewayContribution,
  machineGatewayContribution,
  settingsUserContribution,
  credentialsUserContribution,
  ollamaCloudUserContribution,
  frockAiUserContribution,
  mcpUserContribution,
  botTemplateUserContribution,
  packagePublisherUserContribution,
  machineUserContribution,
  searchUserContribution,
  auditUserContribution,
  flockUserContribution,
  voiceUserContribution,
  shellBotContribution,
  flockBotContribution,
  computerBotContribution,
};

export interface BackendRouteContribution {
  packageId: string;
  /**
   * A route the gateway dispatches *before* it authenticates anyone.
   *
   * Exactly one Contribution needs it — the `mcp-oauth` callback, which an
   * authorization server reaches by redirecting a browser that carries no
   * FrockBot session. A `publicRoute` takes its identity from a signed
   * artifact it verifies itself; it never reads one from the request.
   */
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client?: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: {
      userId?: string;
      client: "browser" | "desktop";
      isAdmin: boolean;
    },
  ): Promise<Response | undefined>;
}

export type BackendContributionLifecycle<T> = ContributionLifecycleV1<T>;

/**
 * A host that resolves its own Contributions. It exists for a host that is not
 * this application — a test, or a runtime composing a plan of its own — and it
 * is the *only* way past the table.
 */
export interface FoundationBackendPluginHost<T> {
  backendHost: "bot" | "user";
  resolve(
    specifier: string,
    lifecycle: BackendContributionLifecycle<T>,
  ): Plugin;
}

export interface MountedFoundationBackend<T> {
  readonly contributions: readonly T[];
  /**
   * The value one descriptor mounted, or `undefined` when the plan did not
   * carry it. Keyed by the descriptor object rather than by its specifier, so
   * a caller that needs a particular Contribution names the table entry it
   * imported and never a string.
   */
  get<C>(descriptor: BackendContributionDescriptorV1<never, C>): C | undefined;
  dispose(): Promise<void>;
}

/**
 * Every gateway host slice, in one object. The host stays wide on purpose —
 * one gateway serves every Contribution — but the *lookup* is by specifier
 * through the table, never by asking which Package this is.
 */
export type FoundationGatewayHost = {
  backendHost: "gateway";
} & AdminGatewayHost &
  BotTemplateGatewayHostV1 &
  ComputerGatewayHost &
  FlockGatewayHost &
  McpGatewayHost &
  SettingsGatewayHost &
  RoutinesGatewayHost &
  SubagentsGatewayHost &
  MachineGatewayHostV1 &
  SearchGatewayHost &
  AuditGatewayHost &
  PackagePublisherGatewayHost &
  VoiceGatewayHostV1;

/**
 * Every User Durable Object host slice, in one object. Each Package names its
 * own key, so the slices compose without colliding and the application can
 * supply a slice lazily — a getter evaluated when its Contribution mounts,
 * which is what lets a Contribution that needs an earlier one (Ollama Cloud
 * needs Settings and Credentials) still be resolved from a table.
 */
export type FoundationUserBackendHostV1 = {
  backendHost: "user";
  /** Where each descriptor's mounted value is recorded as the mount runs. */
  mountedContributions?: FoundationMountedContributionsV1;
} & SettingsUserApplicationHostV1 &
  CredentialsUserApplicationHostV1 &
  OllamaCloudUserApplicationHostV1 &
  FrockAiUserApplicationHostV1 &
  McpUserApplicationHostV1 &
  BotTemplateUserApplicationHostV1 &
  PackagePublisherUserApplicationHostV1 &
  MachineUserApplicationHostV1 &
  SearchUserApplicationHostV1 &
  AuditUserApplicationHostV1 &
  FlockUserApplicationHostV1 &
  VoiceUserApplicationHostV1;

/** Every Bot Durable Object host slice, in one object. */
export type FoundationBotBackendHostV1 = {
  backendHost: "bot";
  /** Where each descriptor's mounted value is recorded as the mount runs. */
  mountedContributions?: FoundationMountedContributionsV1;
} & ShellBotApplicationHostV1 &
  FlockBotApplicationHostV1 &
  ComputerBotApplicationHostV1;

type AnyBackendDescriptor = BackendContributionDescriptorV1<never, unknown>;

/**
 * What each descriptor mounted, readable *while* the mount is still running.
 *
 * A Contribution that needs an earlier one — Ollama Cloud needs Settings and
 * Credentials, the transcript index needs the Bot directory — asks this
 * registry for the descriptor it imported. That is the whole replacement for
 * the mount-time `if (specifier === …)` the application used to carry: the
 * dependency is named as a table entry, not as a string.
 */
export interface FoundationMountedContributionsV1 {
  get<C>(descriptor: BackendContributionDescriptorV1<never, C>): C | undefined;
  record(descriptor: AnyBackendDescriptor, contribution: unknown): void;
}

export function createFoundationMountedContributionsV1(): FoundationMountedContributionsV1 {
  const values = new Map<AnyBackendDescriptor, unknown>();
  return {
    get<C>(descriptor: BackendContributionDescriptorV1<never, C>) {
      return values.get(descriptor as AnyBackendDescriptor) as C | undefined;
    },
    record(descriptor, contribution) {
      values.set(descriptor, contribution);
    },
  };
}

/**
 * The descriptors, read on first use rather than at module evaluation.
 *
 * `plugin-shell/backend` imports this application's runtime, so the module
 * graph has a cycle. Building the *map* lazily was not enough: this array read
 * every imported binding while those modules were still initializing, and a
 * process that happened to enter the cycle from the shell side got
 * "Cannot access 'shellBotContribution' before initialization". Deferring the
 * read to the first call makes the cycle unobservable from either direction.
 */
function backendDescriptorsV1(): readonly AnyBackendDescriptor[] {
  return [
    adminGatewayContribution,
    auditGatewayContribution,
    botTemplateGatewayContribution,
    computerGatewayContribution,
    flockGatewayContribution,
    mcpGatewayContribution,
    packagePublisherGatewayContribution,
    routinesGatewayContribution,
    searchGatewayContribution,
    voiceGatewayContribution,
    settingsGatewayContribution,
    subagentsGatewayContribution,
    machineGatewayContribution,
    settingsUserContribution,
    credentialsUserContribution,
    ollamaCloudUserContribution,
    frockAiUserContribution,
    mcpUserContribution,
    botTemplateUserContribution,
    packagePublisherUserContribution,
    machineUserContribution,
    searchUserContribution,
    auditUserContribution,
    flockUserContribution,
    voiceUserContribution,
    shellBotContribution,
    flockBotContribution,
    computerBotContribution,
  ] as AnyBackendDescriptor[];
}

let table: ReadonlyMap<string, AnyBackendDescriptor> | undefined;

/**
 * The table: Contribution specifier to the first-party descriptor that
 * implements it.
 *
 * Built on first use rather than at module evaluation. `plugin-shell/backend`
 * imports this application's runtime for the model and Composition seams, so
 * the module graph has a cycle; reading the descriptor bindings when the table
 * is first asked for, instead of while the modules are still initializing,
 * makes the cycle unobservable.
 */
export function foundationBackendContributions(): ReadonlyMap<
  string,
  AnyBackendDescriptor
> {
  if (!table) {
    const built = new Map<string, AnyBackendDescriptor>();
    for (const descriptor of backendDescriptorsV1()) {
      if (built.has(descriptor.specifier)) {
        throw new Error(
          `duplicate foundation Contribution descriptor: ${descriptor.specifier}`,
        );
      }
      built.set(descriptor.specifier, descriptor);
    }
    table = built;
  }
  return table;
}

/** The Contribution specifier a manifest entry names, in package terms. */
export function contributionSpecifierV1(
  specifier: string,
  entry: string,
): string {
  return `${specifier}${entry.slice(1)}`;
}

interface PlannedBackendContribution {
  pkg: CompiledPackage;
  specifier: string;
  host: "gateway" | "bot" | "user";
  /** Present ⇒ the member loads through the isolate host, not the table. */
  artifactBacked: boolean;
}

/** Every backend Contribution the plan declares, in plan order. */
export function plannedFoundationBackendContributions(
  plan: ApplicationPlan,
): PlannedBackendContribution[] {
  const declared = new Set(plan.contributions.backend);
  const planned: PlannedBackendContribution[] = [];
  for (const pkg of plan.packages) {
    if (!declared.has(pkg.id)) continue;
    for (const backend of pkg.manifest.contributions.backend ?? []) {
      planned.push({
        pkg,
        specifier: contributionSpecifierV1(pkg.specifier, backend.entry),
        host: backend.host,
        artifactBacked: pkg.artifact !== undefined,
      });
    }
  }
  return planned;
}

/**
 * Fail the application's compilation when a member reaches neither the table
 * nor an artifact.
 *
 * This is the whole point of the table: a plan that names a Contribution the
 * application cannot resolve is a broken application, and it says so once,
 * where the plan is compiled, rather than at the moment some request happens
 * to reach that Contribution's route.
 */
export function assertFoundationBackendContributionsResolvable(
  plan: ApplicationPlan,
): void {
  const contributions = foundationBackendContributions();
  for (const planned of plannedFoundationBackendContributions(plan)) {
    if (planned.artifactBacked) continue;
    const descriptor = contributions.get(planned.specifier);
    if (!descriptor) {
      throw new Error(
        `foundation Contribution "${planned.specifier}" is neither in the application's Contribution table nor artifact-backed`,
      );
    }
    if (descriptor.host !== planned.host) {
      throw new Error(
        `foundation Contribution "${planned.specifier}" is declared for the ${planned.host} host but its descriptor is a ${descriptor.host} Contribution`,
      );
    }
  }
}

/** Mount every declared backend Contribution into one owned Cordis root. */
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
  host: FoundationUserBackendHostV1,
  root?: Context,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host: FoundationBotBackendHostV1,
  root?: Context,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  plan: ApplicationPlan,
  host:
    | FoundationGatewayHost
    | FoundationBackendPluginHost<T>
    | FoundationUserBackendHostV1
    | FoundationBotBackendHostV1,
  residentRoot?: Context,
): Promise<MountedFoundationBackend<BackendRouteContribution | T>> {
  const ownsRoot = !residentRoot;
  const root = residentRoot ?? new Context();
  const fibers: Array<ReturnType<Context["plugin"]>> = [];
  const contributions: Array<BackendRouteContribution | T> = [];
  const mountedByDescriptor =
    ("mountedContributions" in host && host.mountedContributions) ||
    createFoundationMountedContributionsV1();
  const table = foundationBackendContributions();
  const lifecycle: BackendContributionLifecycle<BackendRouteContribution | T> =
    {
      mount(contribution: BackendRouteContribution | T) {
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
    for (const planned of plannedFoundationBackendContributions(plan)) {
      if (planned.host !== host.backendHost) continue;
      let plugin: Plugin;
      if ("resolve" in host) {
        plugin = host.resolve(planned.specifier, lifecycle);
      } else {
        // An artifact-backed member never reaches the table: it loads through
        // the isolate host, exactly as a Bot-authored Package does.
        if (planned.artifactBacked) continue;
        const descriptor = table.get(planned.specifier);
        if (!descriptor || descriptor.host !== planned.host) {
          throw new Error(
            `foundation Contribution "${planned.specifier}" is neither in the application's Contribution table nor artifact-backed`,
          );
        }
        plugin = descriptor.create(host as never, {
          mount(contribution: unknown) {
            mountedByDescriptor.record(descriptor, contribution);
            return lifecycle.mount(
              contribution as BackendRouteContribution | T,
            );
          },
        });
      }
      const fiber = root.plugin(plugin);
      fibers.push(fiber);
      await fiber;
    }
  } catch (error) {
    await Promise.allSettled(fibers.reverse().map((fiber) => fiber.dispose()));
    if (ownsRoot) await root.fiber.dispose();
    throw error;
  }
  let disposed = false;
  return {
    contributions,
    get: mountedByDescriptor.get,
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
