# FrockBot Project Constitution

These rules govern production features and architecture. Treat them as invariants. Record temporary migration work in plans and consequential trade-offs in ADRs rather than weakening these rules.

## Constitutional gate

- Evaluate every requested change against this constitution before implementation begins.
- When a request conflicts with a rule, or compliance is uncertain, stop and identify the exact conflict. Discussion and investigation may continue; implementation waits.
- Resolve a conflict by changing the request or explicitly amending this constitution. Complete and obtain human acceptance of the amendment before feature implementation resumes.
- Instructions do not override this constitution by implication. A rule changes only through an explicit edit to `AGENTS.md`.
- If work in progress reveals a conflict, stop implementation immediately and return to constitutional review.
- Before creating a feature PR, perform a final rule-by-rule compliance review backed by relevant automated checks. A violation or unresolved uncertainty blocks the PR.

## Backend-owned

- The cloud backend is authoritative for durable state, product policy, orchestration, and external integrations.
- Each Bot's Agent loop runs in that Bot's Durable Object.
- When resident, a Bot's Durable Object constructs one Cordis root from its declared backend Contributions. The root and its Plugins are ephemeral projections of durable state, not authorities that must remain resident.
- The Bot's Durable Object owns command admission, the append-only event log, the resumable execution cursor, idempotency records, cancellation, serialization, and durable scheduling.
- Gateways, application Workers, and Dynamic Workers may route commands or serve immutable artifacts; they do not run or own the Agent loop.
- Admit input durably before acknowledging it.
- Client disconnect, refresh, or shutdown detaches an observer; only an explicit authenticated command cancels work.
- Persist enough state to resume safely after Durable Object eviction. Use durable scheduling to continue work instead of relying on an object remaining resident.
- The durable session event log reconstructs user-visible history and every exact normalized model request.

## One production path

- Browser, desktop, and mobile clients use the same backend protocols and Agent runtime.
- The hosted WebUI is the product UI. Electron and mobile containers are thin platform shells around it.
- Development and test adapters exercise the production architecture rather than introducing alternate product runtimes.
- Platform capabilities such as notifications, clipboard access, file selection, authentication handoff, and deep links are progressive enhancements. Core workflows remain available without a native client process.

## Plugin composition

- Every production capability beyond the minimal host bootstrap is implemented as a Plugin mounted from a declared Package Contribution.
- The host bootstrap only initializes its runtime, mounts root Contributions, reports fatal startup failures, and disposes the runtime.
- Product policy, Bot behavior, session orchestration, model and tool behavior, and feature-specific UI live in Plugins rather than the host bootstrap or transport adapters.
- Built-in Plugins follow the same manifest, authority, lifecycle, and test requirements as installable Packages.
- The Bot runtime composes its Agent loop, session persistence, durable checkpoint policy, model providers, tools, projections, and integrations as Plugins behind narrow interfaces.

## Plugin-owned integrations

- Models, Sprites, memory, and other external systems are backend capabilities exposed through narrow interfaces.
- Every model provider is a runtime Plugin behind the shared LLM interface. Provider-specific authentication, request translation, streaming normalization, usage reporting, and errors stay inside that Plugin.
- Provider and model configuration is durable cloud configuration scoped to its User or Bot.
- Secrets remain server-side and cross interfaces only as opaque references when necessary.
- Durable Object Agent loops invoke Computers only through the provider-neutral Computer interface. A Computer Contribution may execute in a separately declared shared backend host when Durable Object constraints are incompatible; that host remains non-authoritative and holds no canonical Bot state. Human takeover uses an authenticated backend protocol and a durable, expiring lease.
- The Agent loop contains product-neutral orchestration and does not branch on individual providers or client platforms.

## Explicit seams

- Cross-runtime communication uses narrow, versioned DTOs, and every inbound value is decoded at its seam.
- Electron, Cloudflare, provider SDK, and Sprite implementation types remain inside their adapters.
- Core and runtime modules are independent of Electron and client-framework authority.
- Runtime contributions execute within Durable Object constraints unless their manifest explicitly identifies a different backend host.
- Prefer deep modules: substantial behavior behind a small interface that is also the module's test surface.

## Package contributions

- A Package declares each Contribution by runtime: backend runtime, hosted client, desktop shell, or mobile shell.
- Canonical state and orchestration live in backend runtime Contributions.
- Desktop and mobile Contributions provide optional platform adapters; their absence does not stop Agent execution.
- The hosted client renders backend state and submits commands. It does not become an alternate authority.

## Durable effects

- Record durable execution intent before invoking an external side effect.
- Give retried effects an idempotency key or an explicit reconciliation policy.
- Recovery never silently duplicates input, model calls, tool calls, or other effects.
- Every admitted Turn reaches a durable terminal or resumable state.
- Failures are observable through durable state rather than existing only in process logs or client memory.

## Feature rule

Before implementing a production feature, define and verify:

1. its authoritative backend owner;
2. its durable state, commands, and events;
3. behavior during client disconnect and Durable Object eviction;
4. cancellation, retry, idempotency, and reconciliation behavior;
5. required authority, credentials, and trust boundaries;
6. its hosted UI projection and optional platform enhancements;
7. observable failure states and recovery tests.

Ship complete vertical slices. Production controls represent implemented backend behavior; unfinished experiences remain behind an explicit prototype or feature flag.

## Architecture checks

Add automated checks for constitutional rules whenever they can be enforced mechanically. Important paths prove that:

- admitted work survives client shutdown and Durable Object restart;
- a reconstructed Bot Durable Object remounts its Plugin tree from durable configuration and resumes from its durable cursor;
- duplicate delivery does not duplicate effects;
- cancellation is explicit and durable;
- browser and native shells use the same backend execution path;
- provider Plugins are replaceable without Agent-loop changes;
- Computer tools operate without a desktop client;
- client bundles and protocols contain no secrets;
- core runtime code has no Electron dependency.

## Documentation roles

- `AGENTS.md` contains enduring project invariants.
- `CONTEXT.md` contains domain language only.
- `docs/architecture.md` describes the current system shape.
- `docs/adr/` records hard-to-reverse decisions whose trade-offs would otherwise be surprising.
- Plans and issues contain migration steps and temporary constraints.
