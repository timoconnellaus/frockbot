// The egress loopback a Plugin worker's `globalOutbound` is bound to.
//
// A Plugin's `fetch` never reaches the network directly: `globalOutbound` is
// this service, minted per User with the hosts the enabled Plugins declared
// (or open access, if one asked for it and the User approved). Every Plugin
// in the worker shares a realm, so the policy is the union of what they
// declared and is described to the User that way (ADR 0026). A refused host
// is a thrown error, which is what a Plugin's `fetch` sees as a rejection —
// the same shape the platform gives a worker with no outbound at all.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  pluginEgressAdmitsV1,
  type PluginEgressPropsV1,
} from "@frockbot/app/isolates/capabilities";

export type { PluginEgressPropsV1 };

export class PluginEgress extends WorkerEntrypoint<
  unknown,
  PluginEgressPropsV1
> {
  override async fetch(request: Request): Promise<Response> {
    const verdict = pluginEgressAdmitsV1(this.ctx.props, request.url);
    if (!verdict.admitted) {
      // Thrown, not answered: a 403 would read as the remote's answer, and a
      // Plugin has no contract for telling the two apart.
      throw new Error(verdict.reason);
    }
    return fetch(request);
  }
}
