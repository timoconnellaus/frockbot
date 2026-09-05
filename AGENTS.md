# FrockBot Project Constitution

These rules govern production features and architecture. Treat them as invariants. Record temporary migration work in plans and consequential trade-offs in ADRs rather than weakening these rules.

## Product intent

- FrockBot reaches capability parity with GrokBot through a minimal kernel, a reviewed base application, and Packages at declared extension seams. Parity describes outcomes, not packaging. The parity register is the checklist in `docs/research/grokbot-computer.md`.
- The parity register is a checklist, not a mandate to ship every row: the owner may decline or defer a register capability. A declined capability is recorded in the register with the date and reason and is removed from the product rather than left half-built; it may be reinstated later by the same route.
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
- The Bot's Durable Object is the authority for everything Bot-scoped: command admission, the append-only event log, the resumable execution cursor, idempotency records, cancellation, serialization, durable scheduling, Routines, and the pinned Composition of every admitted Turn.
- The User's Durable Object is the authority for everything User-scoped: Package availability, Connections, credentials, the Computer assignment, User settings, quotas, and the generation records of User and Project Memory roots.
- The Workspace and its object-storage twin are the only durable state outside a Durable Object. They hold files, never authority: a Durable Object records every intent, effect, and generation that concerns them, and the rules under Computer and Workspace and Memory govern their reconciliation. Immutable content-addressed Package artifacts are durable content, not state: addressed by hash, never mutated, and holding no authority.
- Durable state is migrated forward, never honoured backward. A stored record of an older shape is migrated to the current shape by a versioned, tested migration at the seam that reads it, and the migrated record is written back on the next write; a field that belonged to a removed feature is dropped by that migration, never read as the feature. A feature is never kept for compatibility: removing one removes its surfaces and code, and only the migration of its records remains.
- Stored-state migration and client compatibility are separate seams. Supported wire protocols and compiled widget catalogs have a bounded, tested window and a minimum native version. An unsupported client protocol or native version receives a plain update response before commands are admitted; an unsupported extension catalog leaves that region visibly unavailable without disabling core workflows. Compatibility never revives a removed product feature.
- Runnable generations declare a tested storage-schema compatibility window. Activation and revert check it before mounting. A migration crosses a guarded boundary with quiescence, recovery checkpoints, and validation before promotion; failed candidate code cannot damage the last runnable generation's data. Incompatible reverts are refused visibly. Reverting code never implies undoing data or external effects.
- A Bot's conversational Turns run in its Bot Durable Object; each concurrent child Turn runs in a Subagent Durable Object of the same Bot that holds no authority — the Bot Durable Object admits it, pins its Composition, and records its lifecycle and terminal result. When resident, the Durable Object constructs one application root from the Bot's durable Composition. The root and its Plugins are ephemeral projections of durable state, not authorities that must remain resident.
- Gateways, application Workers, and Dynamic Workers route commands, serve immutable artifacts, or execute Package code loaded for a Bot. They own no Agent loop and no durable state.
- Admit input durably before acknowledging it.
- Client disconnect, refresh, or shutdown detaches an observer; only an explicit authenticated command cancels work.
- Persist enough state to resume safely after Durable Object eviction. Use durable scheduling to continue work instead of relying on an object remaining resident.
- The durable session event log reconstructs user-visible history and every exact normalized model request, given the Composition generation and Memory generations it records.

## One production path

- Browser, desktop, and mobile clients use the same backend protocols and Agent runtime.
- Native and browser renderers are first-class product clients over the same backend commands, projections, and execution semantics. Core workflows have parity across renderers; a shared document or renderer is not required.
- Development and test adapters exercise the production architecture rather than introducing alternate product runtimes.
- Platform capabilities such as notifications, clipboard access, file selection, authentication handoff, and deep links are progressive enhancements. Core workflows remain available without a native client process.

## Configuration shape

- Configuration is account-shaped. A Package, Capability, Connection, or external account a User enables is available to every Bot that User owns, immediately and without a second decision. Uniformity is the feature, not a limitation to be corrected with per-Bot overrides.
- Per-Bot configuration exists only for what must genuinely differ between Bots: identity, instructions, notifications, and what the Bot has authored for itself. Any other per-Bot control ships only with a stated reason the choice cannot be account-level.
- The product works out of the box. The platform chooses the model a Bot runs on, and a User who has configured nothing has a working Bot. Model choice is a platform control on one Models surface: the default reads as the platform provider on Auto, choosing another provider is itself the opt-in and installs what that provider needs, and connecting a provider happens where it is chosen.
- The platform-owned required core is compiled into the reviewed base, always available, and cannot be disabled or uninstalled. It is absent from Package enablement surfaces. Platform-owned provider Packages needed for the working default are repaired on configuration reads and are not offered as enablement choices; that status is derived from manifest facts, never from a list of ids.
- Configuration only some Users need is itself a Package, disabled by default, and this is the exception rather than the routine home for a knob: such a Package ships only with a stated reason the choice cannot be a platform default. The default experience carries no control for it. Enabling the Package adds the control; disabling it makes the values that control captured inert without destroying them, and re-enabling restores them.
- Where such a Package adds a per-Bot override of an account-level value, the override is a Package-scoped Bot setting, so its inertness while the Package is disabled is a property of enablement rather than a special case. Absence of an override means inherit. Exactly one account-level value is authoritative when no override is set, and the product behaves correctly with the override Package disabled.
- A control ships only when a User must make the choice. Otherwise choose a default and ship no control. A Capability that requires no credential and carries no cost or risk to the User is enabled when the User signs up.
- Every control has exactly one home. A thing is enabled in one surface and credentialed in one surface; no other surface repeats that control.
- The product works with zero configuration. Configuration extends reach; it never repairs a broken default.

## Landing work

- Integration and production release are separate acts. A session that opens a pull request or starts a release owns it through its terminal result, including repairing failed checks and verifying the intended landing or deployment.
- When landing or releasing work, read `docs/architecture/delivery.md` for the current mechanism and `docs/plans/native-app.md` for the native rollout gates.

## Minimal kernel

- The kernel has exactly three parts: Durable Object authority (admission, event log, cursor, idempotency, cancellation, scheduling, and storage), the Agent loop (claim input, call the model, run the tools, record events, repeat), and Package composition (resolve durable desired state into a pinned generation set, mount it, verify it, commit or roll back, and bootstrap and dispose the host that does so).
- The kernel declares the narrow interfaces it consumes, including model invocation, tool execution, and Memory access, and owns no implementation of them. Implementations belong to the reviewed base or declared Packages, never to the kernel.
- The kernel imports no Package and contains no product policy.
- The kernel treats every Workspace file as data. Only Skills under a Bot's instruction roots — its own and its User's — written under the Bot's own authority or its User's, are loaded as instructions.

## Package composition

- The reviewed base owns permanent product behavior and explicit application construction. Runtime extensions mount only from declared, narrow Package Contributions: where implementations vary, code is installed after deployment, isolation is required, or independent disablement and revert matter. Fixed product behavior needs no Package lifecycle.
- Built-in, User-installed, and Bot-authored Packages follow the same manifest, authority, lifecycle, provenance, and test requirements; only the execution host differs, and it follows provenance as stated below. A Package records its provenance as first-party, User, or Bot.
- Package availability and Connections are User-level, and enabling them is the grant. Enabling a Package or Connection grants it to every Bot that User owns; disabling or revoking it removes it from every Bot. There is no second, per-Bot grant.
- Account-wide availability does not imply ambient Package authority. Each Package is bound to an inspectable subset of capabilities it needs and is allowed, derived from the User's live enabled set and reviewed binding policy. The subset is uniform across that User's Bots, adds no per-Bot consent, and cannot be widened by a Bot-authored manifest. Connecting is a User act performed out of band on the Connections surface; a Bot never requests, prompts for, or renders a way to make a Connection, and discovers a capability only once its User has connected it. A Package may make a service connectable by shipping its integration and Connection Type; the User still connects it.
- The resolved Package bindings stay durable and inspectable without a repeated User decision: every admitted Turn records the enabled Package and Connection set it ran under as part of its Composition generation, and resolution fails closed when a Connection is missing, disabled, or revoked, recording a visible, repairable failure rather than silently running without it.
- A Composition is the durable, versioned set of Package generations a Bot mounts. Every admitted Turn records the Composition generation it ran under. Changing a Composition creates a new generation; it never mutates a recorded one. Activation takes effect at the next admitted Turn; an in-flight Turn keeps its pinned implementation and schema history. Before each new external effect, including from in-flight code, the durable owner checks live authorization. Revocation fences future use and records an explicit refusal; an already-dispatched effect is reconciled, never assumed cancelled or repeated.
- Composition fails closed. A generation that fails to resolve, mount, or pass its declared checks leaves the last known-good generation resident and records a durable, visible, repairable failure. A generation that fails to activate three consecutive times is quarantined until a User acts. A failure is delivered to the Bot as durable input on its next admitted Turn, so the Bot can repair its own change without being told.
- The platform-owned required core — conversation, authentication, trusted settings, recovery, audit, undo, authoring entry points, and deny-only tool guards — is compiled into the reviewed base. Extensions cannot remove, replace, obscure, or impersonate its trust chrome or the User's way to see and undo what a Bot did.
- Compilation and bundling happen outside Durable Objects. Composition consumes immutable, content-addressed artifacts and never builds them.
- A Composition generation is keyed by its resolved artifact set. An isolate's loader identity is derived only from that artifact set and the digest of the bindings it was granted, so identical artifacts under identical authority share one isolate and a changed grant never reaches a cached isolate. Generation creation rate, artifact size, retained generations, Workspace disk, and Bot isolate CPU, subrequests, and model spend are bounded by durable per-User quotas; exceeding a quota refuses the operation and records a visible failure.
- Every Package whose recorded provenance is not first-party executes in an isolated host the Bot's Durable Object loads for it, with ambient outbound access disabled, only the bindings its inspectable subset permits — its resolved model, enabled tools, Memory, Workspace, and its User's enabled Connections as opaque leases — and no access to secrets, the keyring, or any Durable Object state other than the bindings expose. Network access exists only through those bindings. First-party Packages may run in the kernel's isolate only when reviewed and shipped with FrockBot.
- A Package may declare an Instance Contribution: a server class, a UI page, and tools that run as one durable instance per User — an Applet. The kernel mounts the instance's server artifact in isolated storage under a kernel-owned Applet Durable Object, with ambient outbound access disabled and capability bindings restricted as for any isolate. The facet's storage is User product state, not Composition: it survives every code generation, is migrated forward by the Applet, and is deleted only by the kernel when the User deletes the Applet. The kernel is the authority for the instance — its directory entry, current generation, version history, viewer sessions, tool routing, and deletion — and never for its contents. Composition Packages never own storage; facets exist only under the Applet Durable Object.
- An Applet's declared tools are Composition members of every Bot its User owns, so each admitted Turn records the Applet generation whose tools it ran under, and a published generation activates at the next admitted Turn. A tool call routes through the Applet Durable Object to its facet.
- Every Contribution kind is resolved from the manifest and an artifact, never from a switch over Package identity. A first-party Package that declares only Bot-authorable Contribution kinds ships as an artifact-backed member and loads through the same path as a Bot-authored one.

## Self-modification

- A Bot may author, install from the catalog, or change declared extension points and permitted configuration for itself: Packages, tools, model and integration adapters, Skills, UI Contributions, Routines, and settings it is permitted to edit. Conversation with the Bot is the primary path by which its setup changes. A Bot cannot change reviewed base code, trust chrome, the kernel, this constitution, or its own grants. A Bot-authored model or integration adapter is a translation layer over a kernel-declared binding, never a network client.
- Loop policy — what a Contribution adds to admission, context assembly, tool exposure, tool results, or termination — may execute in a loaded isolate through the loop's declared events. The loop's durable skeleton (claim input, record events, cursor, idempotency) stays in the Durable Object and no Contribution can bypass it.
- A Bot-authored change is a durable effect: the Bot records intent, the resulting artifact is immutable and content-addressed, and its provenance names the Bot, Session, and Turn that produced it. Artifacts are superseded, never edited in place.
- Activation is immediate and needs no human approval, subject to composition failing closed. The User can inspect, diff, disable, and revert any Bot-authored change; reverting is itself a recorded generation. A Bot may revert its own setup generations when its User asks; undo covers the Bot's setup, never actions taken through Connections, and last known-good is set only by a successful mount, never by a revert.
- Self-modification never widens authority. Bot-authored and installed code runs within its allowed subset of what the Bot currently holds; there is no path by which a Bot requests more, and a capability the Bot does not hold is unavailable to its code.
- An Applet is authored as TypeScript under the Applets Package's durable root on the User's Computer, checked, linted, and previewed there through the Applets SDK, and published as an immutable generation the Applet Durable Object mounts. The Computer is where an Applet is written and never where it runs: a Turn that uses an Applet's tools or a User who opens an Applet wakes nothing. Publishing reads the built artifact through the Workspace file surface; no credential reaches the Computer for it.
- Skills are files under the Bot's instruction root. An edit is visible to the Bot on its next admitted Turn; the exact Skill generation each Turn used is reconstructable.
- Bot-authored Packages are shareable: they are publishable and installable by other Bots and Users through the same catalog and manifest as first-party Packages. Publication beyond the authoring User is a User action.

## Computer and Workspace

- A Computer is the User's working environment: a persistent Workspace with compute attached on demand. One Computer serves all of a User's Bots; each Bot receives its own directories and desktop on it, and all Bots share the User's browser profile. Separation between Bots on a Computer is organizational, not a security boundary; the User's Computer is the trust boundary. Bots of one User may read each other's Workspace files; a Bot's instruction root and Bot Memory root are writable only by that Bot or its User, and every write to a durable root records its writer. A file that reaches a durable root without passing through the Workspace file surface (a shell write on the Computer) is mirrored to object storage by the sync with an unattributed writer: it is data, readable and durable, never an instruction and never accepted as a writer on a later write.
- The Computer host is non-authoritative. The Workspace is durable User and Bot state with its own durability model: durable roots, declared by the Computer Package's Workspace layout and by Package manifests, survive hibernation, cold start, host migration, and image rebuild; everything else on the Computer may be lost.
- The Agent loop, Memory, Skills, Package composition, and Routines function correctly while the Computer is hibernated and do not wake it. The Computer wakes only when a Bot uses it or its User explicitly opens it; rendering the Computer's durable state — screenshots, its last self-check, its phase — wakes nothing.
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

- Models, Computers, Memory, and other external systems are backend capabilities exposed through narrow interfaces.
- Every model provider is a runtime Plugin behind the shared model interface. Provider-specific authentication, request translation, streaming normalization, usage reporting, and errors stay inside that Plugin.
- Provider and model settings are durable cloud state scoped to their User or Bot.
- Secrets remain server-side and cross interfaces only as opaque references when necessary.
- A Routine executes as its Bot, with exactly that Bot's authority. Every firing is an admitted child Turn of that Bot: it may use the Bot's tools and record its own Session events, but it does not write to the User-visible conversation; its outcome is delivered to the Bot's next conversational Turn as durable input, and only an explicit hand-off surfaces it to the User immediately.
- The Agent loop contains product-neutral orchestration and does not branch on individual providers, Packages, or client platforms.

## Explicit seams

- Cross-runtime communication uses narrow, versioned DTOs, and every inbound value is decoded at its seam.
- Electron, Cloudflare, provider SDK, and Computer implementation types remain inside their adapters.
- Core and runtime modules are independent of Electron and client-framework authority.
- Backend runtime Contributions execute within Durable Object constraints; Bot isolate Contributions execute in an isolated loaded host; any other host must be declared in the manifest and remains non-authoritative.
- Prefer deep modules: substantial behavior behind a small interface that is also the module's test surface.

## Package contributions

- A Package declares each Contribution by runtime: backend runtime, Bot isolate, browser client, native client, platform adapter, or instance. Declaring a client runtime never permits executable native code from an untrusted Package.
- A non-first-party UI Contribution is a bounded declarative document rendered through a compiled, reviewed widget catalog, a declarative entry in a named slot, or an isolated cookieless web fallback. It loads no executable native code, gains no native API authority from its document, and runs no Package JavaScript in the application origin. The host owns attribution, navigation, authentication, credentials, recovery, and trust chrome. Unsupported documents fail visibly within their extension region.
- Canonical state and orchestration live in the backend, under their durable owners; the reviewed base and backend Contributions implement policy through those owners.
- Desktop and mobile Contributions provide optional platform adapters; their absence does not stop Agent execution.
- Every client renders backend state and submits commands. It does not become an alternate authority.

## Settings surfaces

- Enablement is separate from configuration. The Plugins surface installs, uninstalls, enables, and disables Packages and holds no Package configuration; a Package's own knobs, credentials, and accounts are never edited there.
- A Package's configuration lives on the surface that owns what it configures: model providers on Models, external accounts a User grants a Bot on Connections, and any remaining declared Package settings in Application settings. Every declared setting has exactly one such home, and a Package that is disabled or uninstalled shows none.
- Models is where a User configures model provider Packages and selects models: provider Connections and their credentials, provider catalogs, and the User's default model. Bot-specific model binding stays in that Bot's settings.
- Connections is where a User authorizes external accounts and services a Bot may be given access to. It holds account authorization and its durable state only, never Package enablement. A Connection is made only here, by the User; no Bot output leads to it.
- A surface renders configuration only from what a Package declares in its manifest, so adding a knob or a Connection Type requires no edit to a settings surface.

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
6. its native and browser UI projections, optional platform enhancements, and the single surface that owns each of its controls; for any per-Bot control, why the choice cannot be account-level;
7. observable failure states and recovery tests;
8. the parity-register item it matches, or its explicit label as beyond parity.

Ship complete vertical slices. Production controls represent implemented backend behavior; unfinished experiences remain behind an explicit prototype or feature flag.

## Architecture checks

Add automated checks for constitutional rules whenever they can be enforced mechanically. Important paths prove that:

- admitted work survives client shutdown and Durable Object restart;
- a reconstructed Bot Durable Object remounts its pinned Composition and resumes from its durable cursor;
- a durable record written by the previous released shape of every stored DTO decodes through its migration and round-trips to the current shape;
- duplicate delivery does not duplicate effects;
- cancellation is explicit and durable;
- browser and native shells use the same backend execution path;
- two provider Packages satisfy the model interface with no kernel diff;
- the kernel imports no Package;
- Computer provider SDKs remain inside their Computer host adapter;
- a Turn that does not use the Computer makes no Computer interface call;
- Memory is readable and writable with no Computer interface call, a Workspace write into a Memory root is rejected, and conflicting Workspace and object-storage writes to any other durable root both survive as generations and are surfaced;
- a non-first-party Package loads with ambient outbound access disabled, its bindings derive only from its allowed subset of what the Bot holds, and a missing, disabled, or revoked Connection is an `unavailable` outcome recorded as a visible, repairable failure; no request widens authority;
- a Connection enabled at account level is usable by every Bot of that User at its next admitted Turn, and one revoked at account level is unavailable to every Bot at its next admitted Turn;
- revocation during a pinned Turn refuses its next external effect through every binding path and records the refusal durably;
- with a per-Bot override Package disabled, every Bot resolves the account-level value, and the overrides it captured survive to be restored when it is re-enabled;
- a broken Bot-authored generation leaves the last known-good Composition running, records a visible failure, and delivers that failure to the Bot on its next Turn;
- every renderer retains the compiled required core when all extensions fail or are disabled, and an extension cannot impersonate its trust chrome;
- an Applet's facet storage survives a compatible code generation change and revert; an incompatible revert is refused visibly before mounting; a generation whose health check fails leaves the prior facet resident; deleting an Applet deletes its storage, versions, and directory entry;
- the Applets Package authored through `package_author` mounts and behaves identically to the shipped artifact-backed member, and no Contribution is resolved by a switch over Package identity;
- an open Applet's page carries no credential and reaches its facet only through a short-lived viewer token scoped to that Applet and User;
- reverting a Bot-authored change restores a compatible prior generation, whether the User or the Bot reverts; an incompatible revert preserves data and records a repairable refusal, and a revert never sets last known-good;
- a Skill written outside the Bot's own authority is not loaded as an instruction;
- an operation exceeding a durable per-User quota is refused and records a visible failure;
- every declared Package setting and Connection Type resolves to exactly one configuration surface, and the Plugins surface offers enablement only;
- Computer tools operate without a desktop client;
- client bundles and protocols contain no secrets;
- core runtime code has no Electron dependency.

## Documentation roles

- `AGENTS.md` contains enduring project invariants.
- `CONTEXT.md` contains domain language only.
- `docs/architecture.md` and `docs/architecture/` describe the current system shape and replaceable mechanisms.
- `docs/adr/` records hard-to-reverse decisions whose trade-offs would otherwise be surprising.
- `docs/research/` records primary-source findings about external systems FrockBot copies or depends on.
- Plans and issues contain migration steps and temporary constraints.
