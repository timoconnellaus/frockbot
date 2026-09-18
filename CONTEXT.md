# FrockBot

FrockBot is a hosted application for creating and operating persistent conversational bots whose behavior and interface can be extended through installable packages and optional platform shells.

## Language

**User**:
A person who owns Bots, enabled Packages, authorized Connections, and preferences shared across their Bots. What a user enables is available to all of that user's bots.
_Avoid_: Account, tenant

**Bot**:
A persistent, configured conversational actor with its own identity, sessions, routines, and optional computer. Its extensible behavior comes from its user's shared package setup.
_Avoid_: Agent, assistant instance

**General**:
The automatically provisioned, general-purpose Bot for a User starting without Bots; see the [bootstrap contract](app/flock/README.md#general-bootstrap).
_Avoid_: Default Bot, starter Bot

**Agent**:
A live execution of a bot that claims queued input, calls a model, executes tools, and records the resulting session events.
_Avoid_: Bot, worker

**Session**:
The durable, ordered history of a bot conversation, represented as events from which user-visible history and each exact normalized model request can be reconstructed.
_Avoid_: Chat, transcript

**Turn**:
One run of an agent that begins when queued input is durably admitted and ends when the agent completes, fails, is blocked, is interrupted, or is cancelled. A turn may contain several model-and-tool steps.
_Avoid_: Message, request

**Lane**:
The queue a turn is admitted on. `user` is the conversation and may supersede what is running; `agent` is a question from another Bot, the voice session, or the Bot's own hand-off, and waits FIFO behind user work; `background` is work the bot started for itself — a routine firing, a subagent dispatch — and retries when the Bot is busy. A turn's lane is what its turn type says unless its record names another.

**Agent Turn**
: A non-user conversational Turn admitted by another Bot. It runs in the target Bot Durable Object on the `agent` lane, is visible in that Bot's thread with its origin, and answers its caller through `reply_to_request`.

**Bot message**
: A same-User question sent with the Flock Package's `bot_message` tool. It is not a Channel: the target Bot answers with `reply_to_request`, that answer returns as the asking Turn's tool result, and the target's own Session records the exchange.
_Avoid_: Priority, queue, channel

**Exchange**
: One request and its answer between a Bot and a counterpart — another of the User's Bots, or the voice session — as the clients read it: a centred marker in the thread ("Messaged Codex Watch", "Message from Voice") that opens a view-only chat of every exchange between the two. Never a bubble in the conversation, and never typed into.
_Avoid_: DM, room, channel, thread

**Hand-off**
: A Turn a Bot admitted on its own `agent` lane with the `subagent` tool, so the Turn that asked could answer the person straight away. It is an ordinary Turn of that Bot — its own tools, its own Session — and it speaks for itself with `send_to_user` rather than answering a caller; its origin names the run that handed it over and how deep the chain is. One level only, and a chat Turn may hand off four times.
_Avoid_: Background job, async task, child agent (that is the Subagents Package's `Task`)

**Supersede**:
A user message sent mid-turn taking the place of the running turn: the running turn is interrupted and reaches the terminal state `superseded`, and the message becomes a new turn. Never an injection into the model request already in flight, and never a stop — the bot's background work carries on.
_Avoid_: Steer, interrupt, barge-in, queue

**Package**:
A swappable implementation chosen at build time, behind an interface: sign-in, the Computer host, model providers, storage. First-party Packages ship with the deploy and describe themselves with a static `PackageDefinitionV1`; only untrusted code carries a descriptor, an artifact and a generation.
_Avoid_: Plugin, extension

**Deployment profile**:
Who one deployment is, in a checked-in file the deployable configs are generated from: its Cloudflare account, Worker names, hostnames, resources, auth Package and identity vars. Two exist — `hosted`, which is frockbot.com, and `simple`, which an installer writes into a deployer's own account — and a profile is which auth Package is built in, which secrets exist and which workflows run, never a fork or a gated feature.
_Avoid_: Environment, tier, edition, tenant

**Auth Package**:
The sign-in Package, behind `AuthPackageV1`: resolve an identity from a request, serve the sign-in and sign-out routes, and hand the native authorize page its identity step. Two builds, better-auth with Google and Cloudflare Access, each named by one chooser file the profile selects; a build carries only its own.
_Avoid_: Auth provider, identity provider, login backend

**Connection Type**:
A Package-declared kind of configured external capability. Its authorization is explicitly `none`, `api-key`, `ambient-native`, or `grant`.
_Avoid_: Plugin, provider account

**Connection**:
A durable instance of one Connection Type with an opaque identity and editable label. A Connection may reference a separate credential record, ambient authority, a provider grant, or no credentials at all.
_Avoid_: User Connection, credential, integration, account

**Capability**:
Behavior made available by an installed Package, such as a model, tool set, memory provider, or notification adapter.
_Avoid_: Plugin, feature

**Tool Namespace**:
A model-facing group of dynamic tools disclosed by name in the system prompt and by schema only on request. A tool without a namespace is native; a namespaced tool is discovered and invoked through the registry's discovery and invocation meta-tools.
_Avoid_: Package, Connection, tool prefix

**Enablement**:
A User-owned grant turning a Package or Connection on for every one of that user's bots. A Plugin is the one exception: installed per User, enabled per Bot.
_Avoid_: Assignment, installation, per-bot permission

**Connectors**:
The surface where a user authorizes, credentials, enables, and revokes Connections. It is a name for the surface; the things it manages are Connections.
_Avoid_: Integrations, apps, plugins

**Contribution**:
One environment-specific part of a package, such as desktop-host behavior, agent capability, or WebUI presentation.
_Avoid_: Package

**Plugin**:
Code that wraps a Bot's loop, adds tools, keeps its own data or reaches the network, and was not there at build time: seeded by the deployment at runtime or written by a Bot. It declares itself with a Frock Compose descriptor — hooks, tools, hosts, grants, slots, settings schema, provides and consumes, triggers, model providers, contract version — and is installed per User, enabled per Bot. A **model provider Plugin** serves one provider's model protocol: the kernel hands it a normalized request, it answers with normalized stream events, and its one upstream call goes through the host, which is the only thing holding the Connection's credential (ADR 0032). The user-facing noun for the Plugins page, which also lists the first-party features a User may turn off per Bot; those are app code with a flag, never a Plugin.
_Avoid_: Package, extension, capability

**Plugin worker**:
The one Dynamic Worker per User that holds every installed Plugin as a module map behind a generated index. Its identity is the hash of the artifacts, the index, the binding digest and the hook contract version; a deploy leaves it alone unless the contract version changes. The Bot Durable Object calls it once per open hook per Turn with the Bot's enabled list.
_Avoid_: Isolate per plugin, runtime bundle

**Hook**:
A named event a Plugin may wrap — the loop events `system-prompt/assemble`, `agent/tool-exposure`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping`, `agent/request`, and `theme/assemble` outside a Turn — each answering with a plain patch, chained in Plugin order.
_Avoid_: Middleware, interceptor, action

**Seed state**:
How the deployment ships a Plugin: `locked` (on for every Bot, no switch), `default-on` (on unless a Bot switches it off), `default-off` (off until a Bot switches it on), `admin-gated` (absent from the account until an admin opens it, then on unless a Bot switches it off) or `installable` (in the Marketplace catalog and seeded on no account: the account's own Package command installs and removes it — ADR 0032).
_Avoid_: Tier, preinstall flag

**Plugin trigger**:
A Routine trigger kind whose event arrives on the app-owned Routine webhook door — the same signed, keyed, replay-guarded route a webhook Routine uses — is verified and shaped by the trigger the Plugin exports under `triggers`, and is enqueued as a firing by the app, or dropped with the Plugin's reason. The Plugin never binds a route and never enqueues a Turn.
_Avoid_: Webhook plugin, inbound handler

**Computer**:
A User's working environment: one persistent Workspace with compute attached on demand, shared by all of that User's Bots, each with its own directories and desktop, all sharing the User's browser profile.
_Avoid_: Sandbox, box, Sprite (a provider)

**Workspace**:
The durable disk of a Computer. Declared durable roots on it survive hibernation, cold start, migration, and image rebuild; the rest is scratch.
_Avoid_: Volume, filesystem, box

**Memory**:
Markdown files under a durable root of the Workspace that persist what a Bot knows across Sessions, written only through the Memory Package and mirrored to the Workspace. Bot Memory belongs to one Bot; User Memory is shared by a User's Bots; Project Memory is shared by the Bots that have joined a Project. Shared tiers are sharded per writing Bot so each file has one writer.
_Avoid_: Context, history, knowledge base

**Project**:
An opt-in grouping a Bot creates or joins that carries its own shared Memory tier; only the Projects a Bot has joined are injected into its prompts.
_Avoid_: Workspace, folder, team

**Skill**:
An instruction directory under a Bot's instruction root on the Workspace — one `SKILL.md` and the references beside it — that the Bot loads to learn how to do something. A Bot may write its own.
_Avoid_: Prompt, workflow, tool, instruction file

**Reference**:
One Markdown file under a Skill's `references/` directory, loaded on its own after the Skill's `SKILL.md` names it, so a large Skill costs the prompt only what a Turn reads ([ADR 0030](docs/adr/0030-a2ui-cards.md)).
_Avoid_: Sub-skill, attachment, appendix

**Card**:
One A2UI surface in the conversation — its components, its data model and its revision — sent by a Bot through `send_to_user`, drawn by the client from the catalogs compiled into it, and updated in place until it settles. Authored by the Bot outright or by a Plugin from the values the Bot sends ([ADR 0030](docs/adr/0030-a2ui-cards.md)).
_Avoid_: Widget, rich message, embed, component

**Frock catalog**:
FrockBot's own A2UI catalog beside the standard one: the components the client draws and the schema the model composes them from, generated from one source. Trust chrome is a Frock catalog component only the host draws, bound to an id only the kernel issues.
_Avoid_: Component library, design system, custom widgets

**Skill ref**:
The name that identifies one Skill across a seam — its source and slug, plus the Plugin for a `plugin` Skill — carried instead of its text, so what runs is the Skill generation the Turn resolves.
_Avoid_: Skill id, skill path, handle

**Invoke**:
A User attaching a Skill ref to a message, which expands that Skill's body into the Turn's first step. Distinct from a Bot loading a Skill on its own initiative, and from merely mentioning one.
_Avoid_: Run a skill, trigger, call

**Applet**:
A small real-time application a Bot builds and the User opens beside the conversation: one Package's Instance Contribution, one durable instance of it, its UI, and the tools it exposes to the Bots with access to it. Its code is a Package; its state is not. Its source, state, generations and data are the User's, so which Bot owns it is metadata ([ADR 0027](docs/adr/0027-bot-owned-applets.md)).
_Avoid_: App, gadget, application, widget

**Owner Bot**:
The one Bot an Applet names as `ownerBotId`. Ownership implies access, and only the owner may read or change the source, check, publish, revert, read the generations, delete, share, unshare or transfer. Every Applet has exactly one.
_Avoid_: Author, creator (the provenance, which never changes), User-owned Applet

**Shared Bot**:
An active Bot of the same User named in an Applet's `sharedWithBotIds`. A shared Bot may list the Applet, open or focus it, use its page and call its published tools, and nothing else.
_Avoid_: Collaborator, member, viewer

**Applet access**:
Being the owner Bot or a shared Bot of an Applet that is available. Every list, Composition, focus, open, chat card and viewer token is scoped to the Bot acting; a Bot without access is told the Applet does not exist. Access changes reach new Turns and new opens; an admitted Turn keeps the Applet tools its Composition pinned.
_Avoid_: Permission, grant (a Plugin's), visibility

**Transfer**:
The owner Bot making another active Bot of the same User the owner. The former owner keeps shared access. Metadata only: the source, state, generations and data stay where they are.
_Avoid_: Move, reassign, copy

**Applet availability**:
Whether an Applet is usable at all, separate from its publication status (`draft` or `published`). Archiving its owner Bot makes it unavailable to every Bot without deleting anything; restoring the owner makes it available again. Deleting the owner deletes it.
_Avoid_: Status, archived Applet, hidden

**Applet impact**:
What archiving or deleting a Bot does to Applets: the Applets it owns and the Bots they are shared with, with a fingerprint a delete must present so it cannot destroy an Applet the confirmation did not name.
_Avoid_: Preview, dependents, blast radius

**Account feature**:
A capability an administrator turns on for one account from the admin portal; Applets is the first, Plugin authoring the second. Off is silence on every surface — no tools, no Composition members, no canvas, no managed Skill — and the account's data is kept. Held by the User, set only by an admin.
_Avoid_: Feature flag, beta, entitlement, plan

**Instance Contribution**:
The part of a Package that runs as a Durable Object facet under a kernel-owned Applet Durable Object: a server class with its own storage, a UI page, and declared tools. Its storage is User product state that survives every code generation.
_Avoid_: Backend, facet package, stateful plugin

**Applet generation**:
One immutable, content-addressed publication of an Applet's code. The current generation is a pointer the kernel moves; revert moves it back and is itself recorded. Never a branch.
_Avoid_: Version number, draft, preview branch

**Canvas**:
The surface beside the conversation where the Session's focused Applet renders. Closed by default on a phone until opened.
_Avoid_: Preview pane, right panel (the slot, not the surface)

**Focused Applet**:
The one Applet a Session is currently building or using, always one its Bot has access to; what the Canvas shows and what `applet_*` tools act on when no Applet is named.
_Avoid_: Active app, selected gadget

**Applets SDK**:
The package a Bot writes an Applet against on the Computer: the server base class, schema-first tables, the TanStack DB client, the component kit, the linter, the template, and the embedded workerd dev runner.
_Avoid_: Framework, runtime

**Isolate**:
A Dynamic Worker loaded to execute code that was not in the deploy — the User's Plugin worker, an Applet's server — with no ambient network and only the loopback bindings its User's authority grants, masked per Bot per Turn.
_Avoid_: Sandbox, container, worker

**Keyring**:
The versioned deployment secret that encrypts credential generations. It never leaves the backend.
_Avoid_: Master key, secret

**Kernel**:
The only non-Package code: Durable Object authority, the Agent loop, and Package composition.
_Avoid_: Core, host

**Composition**:
The durable, versioned set of Plugins a User has installed, held by the User Durable Object with its last-known-good and quarantine, never first-party code. A Bot mounts it through its own enable map. Every admitted Turn records the Composition generation and the enable map it ran under.
_Avoid_: Configuration, bundle, profile

**Generation**:
One immutable, content-addressed version of a Package, Composition, Skill, credential, Memory file, or other file under a durable root. Generations are superseded, never edited.
_Avoid_: Version number, revision, patch

**Instruction root**:
The durable root on the Workspace holding one Bot's Skills. Only that Bot or its User may write it.
_Avoid_: Skills folder, prompt directory

**Effect identifier**:
The durable key a Durable Object records for one external effect before it runs, by which recovery finds its outcome.
_Avoid_: Request ID, correlation ID

**Quota**:
A durable per-User bound on generation rate, artifact size, retained generations, Workspace disk, isolate CPU, subrequests, or model spend.
_Avoid_: Limit, rate limit

**Parity register**:
The checklist of GrokBot capabilities FrockBot must match, kept in `docs/grokbot-parity.md`.
_Avoid_: Feature list, roadmap

**Provenance**:
The recorded origin of a Package or change: first-party, User, or Bot, and for a Bot the Session and Turn that produced it. A provider Plugin's Composition member carries `installed`: the deployment ships it, the account's own Package command installs it, and reconciliation leaves it where the User put it ([ADR 0032](docs/adr/0032-plugin-model-providers.md)).
_Avoid_: Author, source

**Routine**:
A persisted trigger and instruction that schedules future work for a bot.
_Avoid_: Job, cron

**Firing**:
One occurrence of a Routine: a durable record written before the automation Turn it admits, and the same-Routine lock while that Turn is unsettled.
_Avoid_: Execution, invocation

**Completion inbox**:
Where a firing's outcome lands for the User, because an automation Turn cannot speak in the conversation. One acknowledged-or-not entry per completed firing.
_Avoid_: Notification list, activity feed

**Pending input**:
A durable input the Bot's next conversational Turn is owed — a Routine hand-off or a decided approval. Drained once, idempotently, and never delivered as something the User said.
_Avoid_: Queued message, pending wake

**Approval**:
A durable pending decision the User answers: what the Bot proposes to do, its risk, and a deadline past which it expires. Recorded once — a replayed answer reads back the decision already stored — and never a grant of authority the Bot did not already hold.
_Avoid_: Permission, consent prompt, confirmation

**Compaction**:
The durable summary of a conversation's earliest turns, computed once when the assembled history grows past its budget and replayed into every later request in their place. It covers a prefix of the conversation, so a later one supersedes it; the turns it covers are still in the log and still readable.
_Avoid_: Truncation, trimming, context window management
