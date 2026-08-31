---
status: accepted
---

# Minimal kernel with Bot self-modification in loaded isolates

FrockBot will reduce its non-Package code to a three-part kernel — Durable Object authority, the Agent loop, and Package composition — and let a Bot author, activate, revise, and revert its own Packages, instructions, and Routines. Every Package whose provenance is not first-party, including all Bot-authored code, executes in a Dynamic Worker isolate the Bot's Durable Object loads through Worker Loader, with `globalOutbound` disabled and only the capability bindings the Bot's Assignments grant. Durable Object facets are not used: a facet owns its own storage, which would make loaded code a second durable authority. Activation is immediate and fails closed to the last known-good Composition; the User can inspect, diff, disable, and revert every generation.

## Considered options

- **Bot-authored code runs on the Computer:** keeps untrusted code in the Sprite, but every Turn that uses a Bot-authored tool must wake the Computer, and the Agent loop becomes dependent on Computer availability.
- **Bot-authored code runs in the kernel isolate:** simplest to compose, but gives untrusted code the kernel's bindings, secrets, and other Bots' state.
- **Approval before every activation:** safest, but removes the autonomy that makes self-modification useful; DeepSeek Harness activates host-side dynamic Packages immediately and pi reloads on request, and neither is worse for it.
- **Loaded isolate with capability bindings, immediate activation, fail-closed composition, User revert:** chosen. It matches the platform's own security seam (`globalOutbound: null`, RPC capabilities), keeps the Agent loop independent of the Computer, and gives the User a durable audit and undo rather than a gate.

## Status

Implemented, which is why this ADR is `accepted` rather than `proposed`. The plan that carries it,
[`docs/plans/kernel-and-isolate.md`](../plans/kernel-and-isolate.md), records itself as implemented, and the decision's
load-bearing claims each have a named check in [`docs/architecture-checks.md`](../architecture-checks.md):

- the three-part kernel exists as `packages/kernel-contracts`, `packages/kernel-agent-loop`, `packages/kernel-composition`
  and `packages/kernel-do`, and the tool and model registries left it as the `plugin-tools` and `plugin-models` Packages;
  `scripts/check-kernel-imports.ts` is a standalone linter as well as a test, so `bun run typecheck` fails on a kernel that
  imports a Package;
- a non-first-party Package loads through Worker Loader with `globalOutbound` disabled and only Assignment-derived bindings
  (`apps/cloudflare/test/bot-isolate.workerd.ts`), and an authority-widening request becomes a durable pending User decision
  rather than a widening;
- activation fails closed and quarantines a generation that fails three consecutive times
  (`packages/kernel-composition/src/activation.ts`), and a revert records a new generation the next admitted Turn activates
  (`apps/cloudflare/test/composition.workerd.ts`);
- authoring is bounded by durable per-User quota, and a breach is a visible failure rather than a throw
  (`apps/cloudflare/test/authoring.workerd.ts`).

## Consequences

The tool registry and model interface leave the kernel and become Packages the kernel consumes through declared interfaces. Every admitted Turn records its Composition generation, so the session log remains sufficient to reconstruct each model request. A Composition generation is keyed by its resolved artifact set, so identical artifacts share one Worker Loader identity and Bot-driven generation churn is bounded by per-User quota; isolates are caches, never authority. Bundling happens outside Durable Objects because in-object bundling exceeds the 128 MB isolate limit. An in-flight Turn completes on its pinned Composition; a new generation takes effect at the next admitted Turn. Bot-authored Packages carry provenance and the same manifest as first-party Packages, so they can later be published and installed by other Bots and Users. Authority never widens by self-modification; a request for more authority becomes a durable pending User decision.
