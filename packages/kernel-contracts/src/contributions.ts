import type { Plugin } from "cordis";

/**
 * How a first-party Contribution names the code that implements it.
 *
 * The constitution's rule is that every Contribution kind is resolved from the
 * manifest and an artifact, never from a switch over Package identity. A
 * non-first-party Package satisfies that by carrying an immutable artifact the
 * loader mounts. A first-party Package that still runs in the kernel's own
 * isolate satisfies it by exporting a **descriptor** beside its factory: the
 * Contribution specifier its manifest declares, the host it belongs in, and
 * the one function that builds it. An application then owns a table keyed by
 * specifier and nothing else — no `if`, no `switch`, no comparison against a
 * Package's name — and a specifier in a plan that reaches neither the table
 * nor an artifact is an error when the application is compiled.
 *
 * These types deliberately know nothing about any Package: a descriptor is a
 * specifier, a host, and a closure whose host object the *application*
 * supplies. That is what lets the kernel declare them while importing no
 * Package.
 */

/** The execution host a backend Contribution's factory is mounted in. */
export type BackendContributionHostV1 = "gateway" | "bot" | "user";

/** What a Contribution's factory is handed to publish the value it mounts. */
export interface ContributionLifecycleV1<Contribution> {
  mount(contribution: Contribution): () => void;
}

/**
 * A first-party backend Contribution: the specifier its manifest declares, the
 * host it belongs in, and the factory that mounts it into a Cordis fiber.
 *
 * `Host` is contravariant, so a descriptor written against the narrow host
 * interface its own Package declares is usable by an application whose wide
 * host object satisfies every Package's slice of it.
 */
export interface BackendContributionDescriptorV1<Host, Contribution> {
  readonly kind: "backend";
  readonly specifier: string;
  readonly host: BackendContributionHostV1;
  create(host: Host, lifecycle: ContributionLifecycleV1<Contribution>): Plugin;
}

/**
 * A first-party client Contribution. A client Plugin takes no host — the
 * client runtime is its host — so the descriptor carries the Plugin itself.
 * The Plugin type stays generic so this module imports no client package.
 */
export interface ClientContributionDescriptorV1<ClientPlugin> {
  readonly kind: "client";
  readonly specifier: string;
  readonly plugin: ClientPlugin;
}

/** Any first-party Contribution descriptor an application table can hold. */
export type ContributionDescriptorV1<ClientPlugin = unknown> =
  | BackendContributionDescriptorV1<never, unknown>
  | ClientContributionDescriptorV1<ClientPlugin>;

export function defineBackendContribution<Host, Contribution>(
  descriptor: Omit<BackendContributionDescriptorV1<Host, Contribution>, "kind">,
): BackendContributionDescriptorV1<Host, Contribution> {
  return { kind: "backend", ...descriptor };
}

/** `defineBackendContribution` with the host fixed to the gateway. */
export function defineGatewayContribution<Host, Contribution>(
  descriptor: Omit<
    BackendContributionDescriptorV1<Host, Contribution>,
    "kind" | "host"
  >,
): BackendContributionDescriptorV1<Host, Contribution> {
  return { kind: "backend", host: "gateway", ...descriptor };
}

/** `defineBackendContribution` with the host fixed to the User Durable Object. */
export function defineUserBackendContribution<Host, Contribution>(
  descriptor: Omit<
    BackendContributionDescriptorV1<Host, Contribution>,
    "kind" | "host"
  >,
): BackendContributionDescriptorV1<Host, Contribution> {
  return { kind: "backend", host: "user", ...descriptor };
}

/** `defineBackendContribution` with the host fixed to the Bot Durable Object. */
export function defineBotBackendContribution<Host, Contribution>(
  descriptor: Omit<
    BackendContributionDescriptorV1<Host, Contribution>,
    "kind" | "host"
  >,
): BackendContributionDescriptorV1<Host, Contribution> {
  return { kind: "backend", host: "bot", ...descriptor };
}

export function defineClientContribution<ClientPlugin>(
  descriptor: Omit<ClientContributionDescriptorV1<ClientPlugin>, "kind">,
): ClientContributionDescriptorV1<ClientPlugin> {
  return { kind: "client", ...descriptor };
}
