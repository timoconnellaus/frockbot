/**
 * The one place this deployment chooses its Computer host.
 *
 * `ComputerHostV1` is the interface everything above the Computer speaks
 * (`computer/core/host.ts`); Fly is one implementation of it and the in-memory
 * host in `computer/fake` is another. Which one this Worker runs is a
 * deployment decision, not an application one, so it is made here — beside the
 * bindings the choice depends on — and handed to the app as a factory.
 *
 * `scripts/check-computer-host-imports.ts` rule 2 admits `@frockbot/computer/fly`
 * into this file, `computer/fly/**`, `apps/computer-host/**` and the two test
 * rigs that prove the implementation. Substituting a k8s host is this file and
 * nothing else.
 */
import type { ShellComputerHostOptionsV1 } from "@frockbot/app/shell/backend-runtime";
import type {
  ComputerHostCapabilitiesV1,
  ComputerHostV1,
} from "@frockbot/computer/core/host";
import { FlyHostTransportV1 } from "@frockbot/computer/fly/host-client";
import {
  FLY_HOST_CAPABILITIES_V1,
  FlyComputerHostV1,
} from "@frockbot/computer/fly/provider";

/**
 * What this deployment's Computer host is, for the surfaces that must know
 * before a Bot is running — the app's `frame-src` above all, which is built
 * from `viewerFrameOrigins` while no Computer is open.
 */
export const COMPUTER_HOST_CAPABILITIES_V1: ComputerHostCapabilitiesV1 =
  FLY_HOST_CAPABILITIES_V1;

/**
 * The `COMPUTER_HOST` service binding and the secret presented on it.
 *
 * Both or neither: a binding with no token reaches a host that refuses every
 * call, which would surface as a 401 on each Turn rather than as a Computer
 * that is not configured.
 */
export interface ComputerHostBindingV1 {
  fetcher: { fetch(request: Request): Promise<Response> };
  hostToken: string;
}

/** What this deployment's Worker needs before it has a Computer at all. */
export interface ComputerHostEnvV1 {
  COMPUTER_HOST?: { fetch(request: Request): Promise<Response> };
  COMPUTER_HOST_TOKEN?: string;
}

/**
 * The binding this deployment reaches its Computer host on, when it has one.
 *
 * This is the whole of "is a Computer configured", and it is derived here so
 * that the app above can answer the question by the presence of a host and
 * never by the name of a credential. The vendor's own token is the host app's:
 * it reaches `apps/computer-host` and never this Worker, which could not use
 * one if it had it.
 */
export function computerHostBindingV1(
  env: ComputerHostEnvV1,
): ComputerHostBindingV1 | undefined {
  const fetcher = env.COMPUTER_HOST;
  const hostToken = env.COMPUTER_HOST_TOKEN?.trim();
  return fetcher && hostToken ? { fetcher, hostToken } : undefined;
}

/**
 * The Computer host, over one binding.
 *
 * The Fly implementation holds no credential of its own — the Computer host
 * app holds the only copy — so the whole of what a caller supplies here is the
 * binding to send a call over and the seams the Turn owns.
 */
export function createComputerHostV1(
  binding: ComputerHostBindingV1,
  options: ShellComputerHostOptionsV1 = {},
): ComputerHostV1 {
  return new FlyComputerHostV1(
    undefined,
    (identity, tenant) =>
      new FlyHostTransportV1({
        fetcher: binding.fetcher,
        hostToken: binding.hostToken,
        identity,
        tenant,
      }),
    options.sync,
    options.agentControlOwnerId,
  );
}
