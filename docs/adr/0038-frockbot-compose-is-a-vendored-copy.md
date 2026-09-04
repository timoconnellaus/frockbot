---
status: accepted
---

# FrockBot Compose is a vendored copy behind one FrockBot adapter

On 2026-09-05 Tim decided that FrockBot should copy Compose into this
repository and rename it, rather than depend on the separate
`tanstack-compose` repository while that project has not become an official
TanStack project. This records the source boundary, the intentional FrockBot
differences, and what may use the copy.

## Decision

**FrockBot vendors the framework-neutral Compose code at reviewed upstream
commit `69163be`, copied on 2026-09-05.** The packages are:

- `packages/compose-core`, from upstream `packages/compose`, published inside
  the workspace as `@frockbot/compose-core`;
- `packages/compose-cloudflare`, `packages/compose-tools`, and
  `packages/compose-typescript`, retaining their suffixes under the
  `@frockbot` scope; and
- `packages/compose-agent`, containing the framework-neutral agent adapter
  found at that commit under `examples/shared/agent`. Despite the source brief
  naming an upstream `compose-agent` package, commit `69163be` contains no such
  package; its provider-independent implementation is in that shared example.

Every copied package README carries the source commit and copy date. Package
imports and public prefixes change from `@tanstack/compose*` to
`@frockbot/compose*`; otherwise the source stays close to upstream so a future
diff or migration is mechanical. Only repository tooling changes: Bun tests,
`tsc --noEmit`, and this repository's Prettier replace upstream Nx, pnpm,
Vitest, knip, eslint, and build configuration.

`react-compose`, `start-compose`, `compose-devtools`,
`compose-agent-openai`, and the examples are not copied. The React and Start
adapters are not an implementation of FrockBot's hosted WebUI or Flutter
shells, and model-provider integration already belongs behind FrockBot's model
interface. Bringing in Compose is neither a Flutter migration nor a wholesale
rewrite of the existing Cordis runtime.

**No running product path uses Compose in this change.**
`@frockbot/compose-frockbot` is the only intended seam between Compose's named
extension vocabulary and FrockBot contracts. Its pure functions first use the
existing exact decoders, then project:

- hosted client outlets and mounts to slot declarations and fills;
- Package tools, loop hooks, and declarative client entries to named actions;
- the generated Bot-isolate context contract to readonly context keys;
- the exact per-Turn capability list to named, credential-free grants; and
- immutable Composition members and Applet generations to their Cloudflare
  execution hosts and lifecycle facts.

The projection grants nothing, mounts nothing, stores nothing, schedules
nothing, and mutates no Composition. TypeScript runtime composition stays in
the backend. Compilation remains outside Durable Objects and activation starts
at the next admitted Turn on immutable artifacts. A later vertical slice must
qualify one real extension through this adapter before wider adoption.

**FrockBot does not adopt Compose's ambient storage or timer semantics.** A
storage grant exists only when the decoded manifest declares an Instance
Contribution, and it maps to that Applet facet's storage under the kernel-owned
Applet Durable Object. Scheduling maps to a command through the Bot Durable
Object, which owns the durable Routine operation. A composition plugin receives
neither arbitrary state nor an ambient timer.

## Security corrections to the vendored host

The reviewed source had two unsafe defaults which FrockBot changes before any
consumer can use it.

The HTTP grant now accepts only a small decoded request shape: method, string
headers, and a string or `ArrayBuffer` body. It resolves the URL under the
service's granted origin, attaches the server-held credential, sends with
`redirect: "manual"`, and refuses the redirect statuses 301, 302, 303, 307 and
308, so a cross-origin redirect cannot carry the credential in an automatically
followed request. A non-redirect 3xx such as `304 Not Modified` is not a
redirect and stays observable to the caller. A wall-clock deadline bounds the
request and a streaming byte limit bounds the response before it is decoded as
text; the defaults are five seconds and one mebibyte.

This boundary lives once, in `packages/compose-core/src/grants/http.ts`, and
both the Cloudflare host and the in-process reference grants execute through
it, so neither host can quietly regain the unsafe defaults.

A hosted source entry must also name its host. Omitting `host` is a visible
refusal, including for legacy or untyped input. In-process execution remains
available only through the explicit `host: "in-process"` choice; an absent host
never silently receives first-party process authority.

These are intentional security deltas from commit `69163be` and must be
preserved when refreshing the vendored copy unless upstream has adopted an
equivalent or stronger boundary.

## Constitutional fit

This is extension-framework groundwork beyond the GrokBot parity register,
not a shipped capability.

- Durable authority does not move. Bot and User Durable Objects remain the
  authorities named in the constitution; the adapter only describes their
  already-decoded contracts. Applet contents remain facet state under the
  Applet Durable Object.
- This slice introduces no durable state, commands, events, side effects, or
  controls. Client disconnect, Durable Object eviction, Computer hibernation,
  retry, cancellation, and reconciliation behavior are therefore unchanged.
- No credential crosses the adapter. Connection projections contain identity
  and generation only; actual use still requires an opaque lease through the
  Bot's capability binding.
- Non-first-party code without an immutable content-addressed artifact fails
  closed. The adapter records Cloudflare Dynamic Workers for Package artifacts
  and Applet facets for Instance Contributions; it exposes no alternate
  production runtime.
- Decoder, authority, generation, storage-owner, scheduling-owner, redirect,
  deadline, response-bound, and omitted-host behavior are covered by automated
  tests. Failures are returned or thrown at the seam rather than producing a
  partial grant.

## Consequences

FrockBot can evaluate Compose's small typed extension surface without making a
remote repository part of its supply chain or committing the product to its UI
adapters and providers. The cost is ownership of a fork. Refreshes must start
from the recorded upstream commit, preserve provenance in every README, keep
the security deltas above, and be reviewed as vendored-code changes rather than
ordinary dependency bumps.

The adapter is intentionally descriptive today. Until a real extension is
qualified, it proves contract fit and policy boundaries but does not prove a
production mount. That limitation is preferable to coupling framework adoption
to a UI migration or replacing an existing runtime wholesale.
