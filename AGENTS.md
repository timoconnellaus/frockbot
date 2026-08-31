# FrockBot Project Constitution

These rules govern production features and architecture. Treat them as invariants. Record temporary migration work in plans and consequential trade-offs in ADRs rather than weakening these rules.

## Product intent

- FrockBot reaches capability parity with GrokBot, and every parity capability is delivered as a Package on a minimal kernel. The parity register is the checklist in `docs/research/grokbot-computer.md`.
- Users extend FrockBot beyond parity with installable Packages.
- A Bot extends itself: it may author, activate, revise, and revert its own Packages, Skills, and Routines within the authority its User has granted. Self-modification is a product feature with the same durability, provenance, and trust rules as everything else.

## Constitutional gate

- Evaluate every requested change against this constitution before implementation begins.
- When a request conflicts with a rule, or compliance is uncertain, stop and identify the exact conflict. Discussion and investigation may continue; implementation waits.
- Resolve a conflict by changing the request or explicitly amending this constitution. Complete and obtain human acceptance of the amendment before feature implementation resumes.
- Instructions do not override this constitution by implication. A rule changes only through an explicit edit to `AGENTS.md` accepted by a human. A Bot cannot amend this constitution, the kernel, or its own authority.
- If work in progress reveals a conflict, stop implementation immediately and return to constitutional review.
- Before creating a feature PR, perform a final rule-by-rule compliance review backed by relevant automated checks. A violation or unresolved uncertainty blocks the PR.

## Authorities

- The cloud backend is authoritative for durable state, product policy, orchestration, and external integrations.
- The Bot's Durable Object is the authority for everything Bot-scoped: command admission, the append-only event log, the resumable execution cursor, idempotency records, cancellation, serialization, durable scheduling, Routines, Assignments, and the pinned Composition of every admitted Turn.
- The User's Durable Object is the authority for everything User-scoped: Package availability, Connections, credentials, the Computer assignment, User settings, quotas, and the generation records of User Memory roots.
- The Workspace and its object-storage twin are the only durable state outside a Durable Object. They hold files, never authority: a Durable Object records every intent, effect, and generation that concerns them, and the rules under Computer and Workspace and Memory govern their reconciliation. Immutable content-addressed Package artifacts are durable content, not state: addressed by hash, never mutated, and holding no authority.
- Each Bot's Agent loop runs in that Bot's Durable Object. When resident, the Durable Object constructs one application root from the Bot's durable Composition. The root and its Plugins are ephemeral projections of durable state, not authorities that must remain resident.
- Gateways, application Workers, and Dynamic Workers route commands, serve immutable artifacts, or execute Package code loaded for a Bot. They own no Agent loop and no durable state.
- Admit input durably before acknowledging it.
- Client disconnect, refresh, or shutdown detaches an observer; only an explicit authenticated command cancels work.
- Persist enough state to resume safely after Durable Object eviction. Use durable scheduling to continue work instead of relying on an object remaining resident.
- The durable session event log reconstructs user-visible history and every exact normalized model request, given the Composition generation and Memory generations it records.

## One production path

- Browser, desktop, and mobile clients use the same backend protocols and Agent runtime.
- The hosted WebUI is the product UI. Electron and mobile containers are thin platform shells around it.
- Development and test adapters exercise the production architecture rather than introducing alternate product runtimes.
- Platform capabilities such as notifications, clipboard access, file selection, authentication handoff, and deep links are progressive enhancements. Core workflows remain available without a native client process.

## Minimal kernel

- The kernel is the only production code that is not a Package. It has exactly three parts: Durable Object authority (admission, event log, cursor, idempotency, cancellation, scheduling, and storage), the Agent loop (claim input, call the model, run the tools, record events, repeat), and Package composition (resolve durable desired state into a pinned generation set, mount it, verify it, commit or roll back, and bootstrap and dispose the host that does so).
- The kernel declares the narrow interfaces it consumes, including model invocation, tool execution, and Memory access, and owns no implementation of them. Model providers, the tool registry, Memory, Computers, Skills, Routines, Channels, notifications, credentials, settings, and every UI surface are Packages.
- The kernel imports no Package and contains no product policy.
- The kernel treats every Workspace file as data. Only Skills under the Bot's own instruction root, written under the Bot's own authority or its User's, are loaded as instructions.

## Package composition

- Every production capability beyond the kernel is implemented as a Plugin mounted from a declared Package Contribution.
- Built-in, User-installed, and Bot-authored Packages follow the same manifest, authority, lifecycle, provenance, and test requirements; only the execution host differs, and it follows provenance as stated below. A Package records its provenance as first-party, User, or Bot.
- Package availability is User-level. A Bot receives authority solely through an explicit, durable Assignment and, when required, a Connection.
- A Composition is the durable, versioned set of Package generations a Bot mounts. Every admitted Turn records the Composition generation it ran under. Changing a Composition creates a new generation; it never mutates a recorded one. Activation takes effect at the next admitted Turn; an in-flight Turn completes on its pinned Composition.
- Composition fails closed. A generation that fails to resolve, mount, or pass its declared checks leaves the last known-good generation resident and records a durable, visible, repairable failure. A generation that fails to activate three consecutive times is quarantined until a User acts.
- Compilation and bundling happen outside Durable Objects. Composition consumes immutable, content-addressed artifacts and never builds them.
- A Composition generation is keyed by its resolved artifact set. An isolate's loader identity is derived only from that artifact set and the digest of the bindings it was granted, so identical artifacts under identical authority share one isolate and a changed Assignment never reaches a cached isolate. Generation creation rate, artifact size, retained generations, Workspace disk, and Bot isolate CPU, subrequests, and model spend are bounded by durable per-User quotas; exceeding a quota refuses the operation and records a visible failure.
- Every Package whose recorded provenance is not first-party executes in a Dynamic Worker isolate the Bot's Durable Object loads for it, with `globalOutbound` disabled, only the capability bindings the Bot's Assignments grant, and no access to secrets, the keyring, or any Durable Object state other than the bindings expose. Network access exists only through those bindings. First-party Packages may run in the kernel's isolate only when reviewed and shipped with FrockBot.

## Self-modification

- A Bot may author or change anything above the kernel for itself: Packages, tools, model and integration adapters, Skills, UI Contributions, Routines, and settings it is permitted to edit. A Bot-authored model or integration adapter is a translation layer over a kernel-declared binding, never a network client.
- A Bot-authored change is a durable effect: the Bot records intent, the resulting artifact is immutable and content-addressed, and its provenance names the Bot, Session, and Turn that produced it. Artifacts are superseded, never edited in place.
- Activation is immediate and needs no human approval, subject to composition failing closed. The User can inspect, diff, disable, and revert any Bot-authored change; reverting is itself a recorded generation.
- Self-modification never widens authority. Bot-authored code runs with the capabilities the Bot already holds; a request for more becomes a durable pending decision for the User, never a grant.
- Skills are files under the Bot's instruction root. An edit is visible to the Bot on its next admitted Turn; the exact Skill generation each Turn used is reconstructable.
- Bot-authored Packages are shareable: they are publishable and installable by other Bots and Users through the same catalog and manifest as first-party Packages. Publication beyond the authoring User is a User action.

## Computer and Workspace

- A Computer is the User's working environment: a persistent Workspace with compute attached on demand. One Computer serves all of a User's Bots; each Bot receives its own directories and desktop on it, and all Bots share the User's browser profile. Separation between Bots on a Computer is organizational, not a security boundary; the User's Computer is the trust boundary. Bots of one User may read each other's Workspace files; a Bot's instruction root and Bot Memory root are writable only by that Bot or its User, and every write to a durable root records its writer.
- The Computer host is non-authoritative. The Workspace is durable User and Bot state with its own durability model: durable roots, declared by the Computer Package's Workspace layout and by Package manifests, survive hibernation, cold start, host migration, and image rebuild; everything else on the Computer may be lost.
- The Agent loop, Memory, Skills, Package composition, and Routines function correctly while the Computer is hibernated and do not wake it. The Computer wakes only when a Bot uses it.
- Bots invoke Computers only through the provider-neutral Computer interface. Provider SDKs, the human-takeover lease, and viewer transport stay inside the provider Package. Human takeover uses an authenticated backend protocol and a durable, expiring lease.
- Computer effects are reconcilable. A mutation or process launch records intent and an effect identifier in the Bot's Durable Object and in the Workspace before it runs, so recovery can read its outcome or classify it as unknown without repeating it. Only Computer-provider-declared services may be reattached; other processes are assumed dead after a cold pause.
- Connections to the Computer are expected to drop on every pause; every Computer client reconnects and resumes rather than treating a dropped connection as failure.
- No secret lives on the Workspace except the User's browser profile, whose cookie and login stores are Workspace-resident by necessity and are treated as User-scoped secrets. Code running on the Computer receives every other credential only as an opaque, expiring lease through the Computer interface.

## Memory

- Memory is Markdown files under durable roots of the Workspace in three tiers: a Bot Memory root per Bot, a User Memory root shared by the User's Bots, and a Project Memory root per Project that a Bot has joined. Shared tiers are sharded per writing Bot on disk so every Memory file has exactly one writer; readers merge shards, newest fact wins on conflict, and every shared fact records which Bot learned it. On conflict between tiers the most specific wins: Bot, then Project, then User. A Bot reads Memory with ordinary file tools on the Computer or through the Memory Package; it changes Memory only through the Memory Package, which functions while the Computer is hibernated.
- The Memory Package is the single writer of Memory roots, and within a shared root each Bot's shard is written only on that Bot's behalf: it writes object storage, every write produces a generation recorded in the owning Durable Object, and the Workspace presents Memory roots read-only through the durable-root sync.
- Every other durable root synchronizes bidirectionally between the Workspace and object storage. Writes are segregated by writer; every write produces a generation; a write that would overwrite a generation its writer has not seen is preserved as a conflicting generation and surfaced, never merged or dropped. The mechanism is named in ADR 0013 and proven before it ships.
- Indexes, embeddings, and summaries are derived from Memory files and are always rebuildable from them.
- What Memory enters a model request, and when, is Package policy, and the session event log records exactly what was injected, so an injection gap is visible in durable state rather than silently changing the Bot's behavior.
- Memory contains no secrets and no credential references.

## Plugin-owned integrations

- Models, Computers, Memory, Channels, and other external systems are backend capabilities exposed through narrow interfaces.
- Every model provider is a runtime Plugin behind the shared model interface. Provider-specific authentication, request translation, streaming normalization, usage reporting, and errors stay inside that Plugin.
- Provider and model settings are durable cloud state scoped to their User or Bot.
- Secrets remain server-side and cross interfaces only as opaque references when necessary.
- A Routine executes as its Bot, with exactly that Bot's authority. Every firing is an admitted child Turn of that Bot: it may use the Bot's tools and record its own Session events, but it does not write to the User-visible conversation; its outcome is delivered to the Bot's next conversational Turn as durable input, and only an explicit hand-off surfaces it to the User immediately.
- The Agent loop contains product-neutral orchestration and does not branch on individual providers, Packages, or client platforms.

## Explicit seams

- Cross-runtime communication uses narrow, versioned DTOs, and every inbound value is decoded at its seam.
- Electron, Cloudflare, provider SDK, and Computer implementation types remain inside their adapters.
- Core and runtime modules are independent of Electron and client-framework authority.
- Backend runtime Contributions execute within Durable Object constraints; Bot isolate Contributions execute in a loaded Dynamic Worker; any other host must be declared in the manifest and remains non-authoritative.
- Prefer deep modules: substantial behavior behind a small interface that is also the module's test surface.

## Package contributions

- A Package declares each Contribution by runtime: backend runtime, Bot isolate, hosted client, desktop shell, or mobile shell.
- Canonical state and orchestration live in backend runtime Contributions.
- Desktop and mobile Contributions provide optional platform adapters; their absence does not stop Agent execution.
- The hosted client renders backend state and submits commands. It does not become an alternate authority.

## Durable effects

- Record durable execution intent before invoking an external side effect. Only effects an interface declares read-only are exempt.
- Give retried effects an idempotency key or an explicit reconciliation policy.
- Recovery never silently duplicates input, model calls, tool calls, Computer effects, or other effects.
- Every admitted Turn reaches a durable terminal or resumable state.
- Failures are observable through durable state rather than existing only in process logs or client memory.

## Feature rule

Before implementing a production feature, define and verify:

1. its authoritative owner;
2. its durable state, commands, and events;
3. behavior during client disconnect, Durable Object eviction, and Computer hibernation;
4. cancellation, retry, idempotency, and reconciliation behavior;
5. required authority, credentials, and trust boundaries;
6. its hosted UI projection and optional platform enhancements;
7. observable failure states and recovery tests;
8. the parity-register item it matches, or its explicit label as beyond parity.

Ship complete vertical slices. Production controls represent implemented backend behavior; unfinished experiences remain behind an explicit prototype or feature flag.

## Architecture checks

Add automated checks for constitutional rules whenever they can be enforced mechanically. Important paths prove that:

- admitted work survives client shutdown and Durable Object restart;
- a reconstructed Bot Durable Object remounts its pinned Composition and resumes from its durable cursor;
- duplicate delivery does not duplicate effects;
- cancellation is explicit and durable;
- browser and native shells use the same backend execution path;
- two provider Packages satisfy the model interface with no kernel diff;
- the kernel imports no Package;
- a Turn that does not use the Computer makes no Computer interface call;
- Memory is readable and writable with no Computer interface call, a Workspace write into a Memory root is rejected, and conflicting Workspace and object-storage writes to any other durable root both survive as generations and are surfaced;
- a non-first-party Package loads with `globalOutbound` disabled, its bindings derive only from Assignments, and an authority-widening request produces a pending decision record rather than a grant;
- a broken Bot-authored generation leaves the last known-good Composition running and records a visible failure;
- reverting a Bot-authored change restores the prior generation;
- a Skill written outside the Bot's own authority is not loaded as an instruction;
- an operation exceeding a durable per-User quota is refused and records a visible failure;
- Computer tools operate without a desktop client;
- client bundles and protocols contain no secrets;
- core runtime code has no Electron dependency.

## Documentation roles

- `AGENTS.md` contains enduring project invariants.
- `CONTEXT.md` contains domain language only.
- `docs/architecture.md` describes the current system shape.
- `docs/adr/` records hard-to-reverse decisions whose trade-offs would otherwise be surprising.
- `docs/research/` records primary-source findings about external systems FrockBot copies or depends on.
- Plans and issues contain migration steps and temporary constraints.
