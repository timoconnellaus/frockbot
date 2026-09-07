/**
 * The foundation application's backend Contribution list.
 *
 * Ordinary imports, mounted in the order they are listed. A Contribution that
 * needs an earlier one names the table entry it imported, never a specifier
 * string.
 *
 * The client half lives in `./client-contributions.ts`, which this module
 * deliberately does not import: a client Contribution is React in the browser
 * bundle, and the backend table is server code in the Worker bundle.
 * Importing either from the other would put each in the other's bundle.
 */
import type {
  BackendContributionDescriptorV1,
  ContributionLifecycleV1,
} from "@frockbot/core/contracts/contributions";
import type { RuntimeCleanupV1 } from "@frockbot/core/contracts";

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
  backendContribution as routinesGatewayContribution,
  type RoutinesGatewayHost,
} from "@frockbot/plugin-routines/backend";
import {
  backendContribution as searchGatewayContribution,
  type SearchGatewayHost,
} from "@frockbot/plugin-search/backend";
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
} from "@frockbot/providers/ollama-cloud/user";
import {
  userContribution as frockAiUserContribution,
  type FrockAiUserApplicationHostV1,
} from "@frockbot/providers/frock-ai/user";
import {
  userContribution as botTemplateUserContribution,
  type BotTemplateUserApplicationHostV1,
} from "@frockbot/plugin-bot-template/user";
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
  routinesGatewayContribution,
  searchGatewayContribution,
  settingsGatewayContribution,
  subagentsGatewayContribution,
  machineGatewayContribution,
  settingsUserContribution,
  credentialsUserContribution,
  ollamaCloudUserContribution,
  frockAiUserContribution,
  botTemplateUserContribution,
  machineUserContribution,
  searchUserContribution,
  auditUserContribution,
  flockUserContribution,
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
  ): void | RuntimeCleanupV1 | Promise<void | RuntimeCleanupV1>;
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
  SettingsGatewayHost &
  RoutinesGatewayHost &
  SubagentsGatewayHost &
  MachineGatewayHostV1 &
  SearchGatewayHost &
  AuditGatewayHost;

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
  BotTemplateUserApplicationHostV1 &
  MachineUserApplicationHostV1 &
  SearchUserApplicationHostV1 &
  AuditUserApplicationHostV1 &
  FlockUserApplicationHostV1;

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

/** Every backend Contribution this application composes, in mount order. */
export const backendDescriptorsV1: readonly AnyBackendDescriptor[] = [
  adminGatewayContribution,
  auditGatewayContribution,
  botTemplateGatewayContribution,
  computerGatewayContribution,
  flockGatewayContribution,
  routinesGatewayContribution,
  searchGatewayContribution,
  settingsGatewayContribution,
  subagentsGatewayContribution,
  machineGatewayContribution,
  settingsUserContribution,
  credentialsUserContribution,
  ollamaCloudUserContribution,
  frockAiUserContribution,
  botTemplateUserContribution,
  machineUserContribution,
  searchUserContribution,
  auditUserContribution,
  flockUserContribution,
  shellBotContribution,
  flockBotContribution,
  computerBotContribution,
] as AnyBackendDescriptor[];

/** Mount every backend Contribution for one host, in table order. */
export async function createFoundationBackendContributions(
  host: FoundationGatewayHost,
): Promise<MountedFoundationBackend<BackendRouteContribution>>;
export async function createFoundationBackendContributions<T>(
  host: FoundationBackendPluginHost<T>,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  host: FoundationUserBackendHostV1,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  host: FoundationBotBackendHostV1,
): Promise<MountedFoundationBackend<T>>;
export async function createFoundationBackendContributions<T>(
  host:
    | FoundationGatewayHost
    | FoundationBackendPluginHost<T>
    | FoundationUserBackendHostV1
    | FoundationBotBackendHostV1,
): Promise<MountedFoundationBackend<BackendRouteContribution | T>> {
  const cleanups: RuntimeCleanupV1[] = [];
  const contributions: Array<BackendRouteContribution | T> = [];
  const mountedByDescriptor =
    ("mountedContributions" in host && host.mountedContributions) ||
    createFoundationMountedContributionsV1();
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
  const unwind = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    for (const descriptor of backendDescriptorsV1) {
      if (descriptor.host !== host.backendHost) continue;
      let cleanup: void | RuntimeCleanupV1;
      if ("resolve" in host) {
        cleanup = await host.resolve(descriptor.specifier, lifecycle);
      } else {
        cleanup = await descriptor.mount(host as never, {
          mount(contribution: unknown) {
            mountedByDescriptor.record(descriptor, contribution);
            return lifecycle.mount(
              contribution as BackendRouteContribution | T,
            );
          },
        });
      }
      if (cleanup) cleanups.push(cleanup);
    }
  } catch (error) {
    await unwind();
    throw error;
  }
  let disposed = false;
  return {
    contributions,
    get: mountedByDescriptor.get,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await unwind();
    },
  };
}
