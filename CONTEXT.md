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
The queue a turn is admitted on. `user` is the conversation: it waits FIFO ahead of other work, and a chat turn running on it yields at its next step boundary to a user message waiting behind it; `agent` is a question from another Bot, the voice session, or the Bot's own hand-off, and waits FIFO behind user work; `background` is work the bot started for itself — a routine firing, a subagent dispatch — and retries when the Bot is busy. A turn's lane is what its turn type says unless its record names another.

**Agent Turn**
: A non-user conversational Turn admitted by another Bot. It runs in the target Bot Durable Object on the `agent` lane, is visible in that Bot's thread with its origin, and answers its caller through `reply_to_request`.

**Bot message**
: A same-User question sent with the Flock Package's `bot_message` tool. It is not a Channel: the target Bot answers with `reply_to_request`, that answer returns as the asking Turn's tool result, and the target's own Session records the exchange.
_Avoid_: Priority, queue, channel

**Exchange**
: One request and its answer between a Bot and a counterpart — another of the User's Bots, or the voice session — as the clients read it: a centred marker in the thread ("Messaged Codex Watch", "Message from Voice") that opens a view-only chat of every exchange between the two. Never a bubble in the conversation, and never typed into.
_Avoid_: DM, room, channel, thread

**Group Chat**
: A conversation between the User and two to eight of their Bots. Every message reaches every member, and a member asked to reply — by an @mention, or by Jev judging the message is theirs — runs a Turn in its own Bot under the group's Session, whose sends are posted to the group. Its members share its Memory.
_Avoid_: Channel, room, project, team

**Hand-off**
: A Turn a Bot admitted on its own `agent` lane with the `subagent` tool, so the Turn that asked could answer the person straight away. It is an ordinary Turn of that Bot — its own tools, its own Session — and it speaks for itself with `send_to_user` rather than answering a caller; its origin names the run that handed it over and how deep the chain is. One level only, and a chat Turn may hand off four times.
_Avoid_: Background job, async task, child agent (that is the Subagents Package's `Task`)

**Steering**:
A user message sent mid-turn reaching the running chat turn at its next step boundary. The turn finishes the step it is in — its model response and every tool call it made — and then ends `completed`; the message runs next, with everything that turn did in its context and a pending input saying the work was unfinished. The bot decides what to do with it. Nothing in flight is cut off or sent again, and only `/stop` cancels a turn. The thread draws the message where it landed: after what the bot had already said, above what the running turn went on to say before it yielded. Not Jev's acknowledgement steering, which shapes a turn's first reply.
_Avoid_: Supersede, interrupt, barge-in

**Reply draft**:
The words of a `send_to_user` the model is still writing, drawn in the thread where the message will land and replaced by it when it does. It is shown only to a client that is watching: never journaled, published or replayed, so an eviction or a dropped socket loses it and the message still arrives whole.
_Avoid_: Partial text, streaming message, draft (that is the person's unsent composer text)

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
Code that wraps a Bot's loop, adds tools, keeps its own data or reaches the network, and was not there at build time: seeded by the deployment at runtime or written by a Bot. It declares itself with a Frock Compose descriptor — hooks, tools, hosts, grants, slots, settings schema, provides and consumes, triggers, model providers, contract version — and is installed per User, enabled per Bot. A **model provider Plugin** serves one provider's model protocol: the kernel hands it a normalized request, it answers with normalized stream events, and its one upstream call goes through the host, which is the only thing holding the Connection's credential (ADR 0032). The user-facing noun for a Bot's Plugins page, which also lists the first-party features a User may turn off per Bot; those are app code with a flag, never a Plugin. A Plugin with nothing to switch — a locked one, or one that only serves a model — is not listed there.
_Avoid_: Package, extension, capability, Applet

**Plugin worker**:
The one Dynamic Worker per User that holds every installed Plugin as a module map behind a generated index. Its identity is the hash of the artifacts, the index, the binding digest and the hook contract version, so a deploy of unchanged code leaves it alone, and a new index or contract version is a new worker. The Bot Durable Object calls it once per open hook per Turn with the Bot's enabled list.
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

**Connection trigger**:
A Routine trigger kind whose event arrives from a connected app — a new Gmail message, an email sent — through one deployment-wide events door. The provider holds the instance; the User Durable Object maps it to a Bot and a Routine; the Bot enqueues the firing keyed by the event id.
_Avoid_: Integration trigger, Composio trigger (the provider is plumbing)

**Computer**:
A User's working environment: one persistent Workspace with compute attached on demand, shared by all of that User's Bots, each with its own directories and desktop, all sharing the User's browser profile.
_Avoid_: Sandbox, box, Sprite (a provider)

**Workspace**:
The durable disk of a Computer. Declared durable roots on it survive hibernation, cold start, migration, and image rebuild; the rest is scratch.
_Avoid_: Volume, filesystem, box

**Demonstration**:
What a person did in the Computer's browser while they held control and pressed Record: an ordered log of steps — where they went, what they clicked, which field they typed into but never what, which keys — and a few screenshots with every form field covered. They send it to their Bot as a message's files so it can draft a Skill, and it is deleted once that Skill is decided.
_Avoid_: Recording (the act, not the thing), teach session, video, macro

**Memory**:
What a Bot knows across Sessions, written only through the Memory Package. Bot Memory belongs to one Bot; User Memory is shared by a User's Bots; a Group Chat's Memory is shared by its members, and a Bot that leaves the group loses it. Bot and User Memory are also Markdown files under durable roots of the Workspace, sharded per writing Bot so each file has one writer.
_Avoid_: Context, history, knowledge base

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

**Canvas**:
The host region beside the conversation that holds a Bot's Plugin panel tabs. Closed by default on a phone until opened.
_Avoid_: Preview pane, right panel (the Flutter shell slot, not this surface)

**Conversation panel**:
A Plugin `conversation.panel` view: a host-drawn `ViewDocument` page in the Canvas. Several Plugins may declare one; the host shows them as tabs and one page at a time ([ADR 0034](docs/adr/0034-plugin-panels.md)).
_Avoid_: Applet, widget, iframe

**Bot nav**:
A Plugin `bot.nav` view: a door on this Bot's page, with Settings / Routines / Plugins. A press focuses that Plugin's conversation panel.
_Avoid_: Sidebar entry, Bot list row

**Bot badge**:
A Plugin `bot.badge` view: a count, a short label or a host icon on a Bot's row in the Bot list, drawn by the host after that Bot's name, avatar and status marks and never over them ([ADR 0034](docs/adr/0034-plugin-panels.md), amended 2026-09-24).
_Avoid_: Status, indicator (those are the host's)

**Sidebar section**:
A Plugin `sidebar.sections` view: a host-drawn block in the Bot list, beneath the row of the Bot it renders as, headed with the Plugin's name.
_Avoid_: Sidebar entry, Bot list row

**Device ability**:
Something on the person's device the host opens for a Plugin's page, never the page itself — today the microphone. Declared under the `device` grant, approved on the Plugin's card, and shown in host chrome with a Stop while in use ([ADR 0035](docs/adr/0035-device-bridge.md), [ADR 0036](docs/adr/0036-plugin-html-surfaces.md)).
_Avoid_: Permission, capability (that is a Package's)

**Panel focus**:
The Session's selected conversation-panel tab, `{ pluginId, surfaceId }`, or closed. Written by a tab click, a bot-nav press, or the Bot's `panel_focus` tool. The cloud is the authority.
_Avoid_: Active applet, selected gadget

**Account feature**:
A capability an administrator turns on for one account from the admin portal. Plugin authoring is one. Off is silence on every surface — no tools, no managed Skill — and the account's data is kept. Held by the User, set only by an admin.
_Avoid_: Feature flag, beta, entitlement, plan

**Isolate**:
A Dynamic Worker loaded to execute code that was not in the deploy — the User's Plugin worker — with no ambient network and only the loopback bindings its User's authority grants, masked per Bot per Turn.
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
A persisted trigger and instruction that schedules future work for a bot. Conversation authors it; the list is what is armed, and the detail is a read-only look at one Routine ([ADR 0033](docs/adr/0033-conversation-authored-routines.md)).
_Avoid_: Job, cron

**Firing**:
One occurrence of a Routine: a durable record written before the automation Turn it admits, and the same-Routine lock while that Turn is unsettled. A connected-app firing may skip when the standalone event is clearly not the prompt.
_Avoid_: Execution, invocation

**Completion inbox**:
Where a firing's outcome lands for the User, because an automation Turn cannot speak in the conversation. One acknowledged-or-not entry per completed firing.
_Avoid_: Notification list, activity feed

**Pending input**:
A durable input the Bot's next conversational Turn is owed — a Routine hand-off, a decided approval, a press on a card, a finished machine command, or the note that the Turn before it yielded unfinished. Drained once, idempotently, and never delivered as something the User said. A decided approval, a card press no handler answered, and a machine result each open that Turn when they land.
_Avoid_: Queued message, pending wake

**Approval**:
A durable pending decision the User answers: what the Bot proposes to do, its risk, and a deadline past which it expires. Recorded once — a replayed answer reads back the decision already stored — and never a grant of authority the Bot did not already hold. Given on a card whose fields the User changed, it is a decision about what they left there, not about what the Bot proposed.
_Avoid_: Permission, consent prompt, confirmation

**Compaction**:
The durable summary of a conversation's earliest turns, computed once when the assembled history grows past its budget and replayed into every later request in their place. It covers a prefix of the conversation, so a later one supersedes it; the turns it covers are still in the log and still readable. It runs on the platform's summary model whatever model the Bot is on, one bounded slice of the oldest turns per call.
_Avoid_: Truncation, trimming, context window management
