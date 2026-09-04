# FrockBot

FrockBot is a hosted application for creating and operating persistent conversational bots whose behavior and interface can be extended through installable packages and optional platform shells.

## Language

**User**:
A person who owns Bots, enabled Packages, authorized Connections, and preferences shared across their Bots. What a user enables is available to all of that user's bots.
_Avoid_: Account, tenant

**Bot**:
A persistent, configured conversational actor with its own identity, sessions, routines, and optional computer. Its extensible behavior comes from its user's shared package setup.
_Avoid_: Agent, assistant instance

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
The queue a turn is admitted on. `user` is the conversation and may supersede what is running; `background` is work the bot started for itself — a routine firing, a subagent dispatch — and always waits. A turn's lane is what its turn type says unless its record names another.
_Avoid_: Priority, queue, channel

**Supersede**:
A user message sent mid-turn taking the place of the running turn: the running turn is interrupted and reaches the terminal state `superseded`, and the message becomes a new turn. Never an injection into the model request already in flight, and never a stop — the bot's background work carries on.
_Avoid_: Steer, interrupt, barge-in, queue

**Package**:
A versioned, installable FrockBot distribution containing a manifest and one or more Contributions.
_Avoid_: Plugin, extension

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
A model-facing group of dynamic tools disclosed by name in the system prompt and by schema only on request. A tool without a namespace is native; a namespaced tool is discovered and invoked through the registry's two meta-tools.
_Avoid_: Package, Connection, tool prefix

**Enablement**:
A User-owned grant turning a Package or Connection on for every one of that user's bots. There is no per-bot grant.
_Avoid_: Assignment, installation, per-bot permission

**Connectors**:
The surface where a user authorizes, credentials, enables, and revokes Connections. It is a name for the surface; the things it manages are Connections.
_Avoid_: Integrations, apps, plugins

**Contribution**:
One environment-specific part of a package, such as desktop-host behavior, agent capability, or WebUI presentation.
_Avoid_: Package

**Plugin**:
A live contribution mounted into an application context with owned lifecycle and cleanup.
_Avoid_: Package

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
An instruction file under a Bot's instruction root on the Workspace that the Bot loads to learn how to do something. A Bot may write its own.
_Avoid_: Prompt, workflow, tool, instruction file

**Skill ref**:
The name that identifies one Skill across a seam — its source and slug — carried instead of its text, so what runs is the Skill generation the Turn resolves.
_Avoid_: Skill id, skill path, handle

**Invoke**:
A User attaching a Skill ref to a message, which expands that Skill's body into the Turn's first step. Distinct from a Bot loading a Skill on its own initiative, and from merely mentioning one.
_Avoid_: Run a skill, trigger, call

**Catalog**:
The set of Packages available for installation, whether first-party, User-published, or Bot-authored. Published as immutable, content-addressed generations; a reader pins one generation and installs only from it.
_Avoid_: Registry, marketplace, store

**Catalog generation**:
One immutable, content-addressed publication of the Catalog: an index and its entries, named by a mutable pointer. A generation is never edited, only superseded.
_Avoid_: Version, snapshot, release

**Catalog entry**:
One installable row in a Catalog generation, identified by an opaque immutable catalogId and naming the Package it installs.
_Avoid_: Listing, item, plugin record

**Applet**:
A small real-time application a Bot builds for its User and the User opens beside the conversation: one Package's Instance Contribution, one durable instance of it, its UI, and the tools it exposes to every Bot of that User. Its code is a Package; its state is not.
_Avoid_: App, gadget, application, widget

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
The one Applet a Session is currently building or using; what the Canvas shows and what `applet_*` tools act on when no Applet is named.
_Avoid_: Active app, selected gadget

**Applets SDK**:
The package a Bot writes an Applet against on the Computer: the server base class, schema-first tables, the TanStack DB client, the component kit, the linter, the template, and the embedded workerd dev runner.
_Avoid_: Framework, runtime

**Isolate**:
A Dynamic Worker the Bot's Durable Object loads to execute non-first-party Package code with only the bindings its User's enabled Packages and Connections grant.
_Avoid_: Sandbox, container, worker

**Keyring**:
The versioned deployment secret that encrypts credential generations. It never leaves the backend.
_Avoid_: Master key, secret

**Kernel**:
The only non-Package code: Durable Object authority, the Agent loop, and Package composition.
_Avoid_: Core, host

**Composition**:
The durable, versioned set of Package generations a Bot mounts. Every admitted Turn records the Composition it ran under.
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
The checklist of GrokBot capabilities FrockBot must match, kept in `docs/research/grokbot-computer.md`.
_Avoid_: Feature list, roadmap

**Provenance**:
The recorded origin of a Package or change: first-party, User, or Bot, and for a Bot the Session and Turn that produced it.
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
