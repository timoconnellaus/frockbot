# FrockBot

FrockBot is a hosted application for creating and operating persistent conversational bots whose behavior and interface can be extended through installable packages and optional platform shells.

## Language

**User**:
A person who owns Bots, installed Packages, authorized Connections, and preferences shared across their Bots. Shared availability does not grant a Bot authority to use a Capability.
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

**Assignment**:
A Bot-owned grant selecting a Capability and, when required, a Connection.
_Avoid_: Installation, connection

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

**Channel**:
A Package-provided delivery surface, such as Telegram or the hosted WebUI, through which a User and a Bot exchange messages.
_Avoid_: Integration, transport

**Catalog**:
The set of Packages available for installation, whether first-party, User-published, or Bot-authored. Published as immutable, content-addressed generations; a reader pins one generation and installs only from it.
_Avoid_: Registry, marketplace, store

**Catalog generation**:
One immutable, content-addressed publication of the Catalog: an index and its entries, named by a mutable pointer. A generation is never edited, only superseded.
_Avoid_: Version, snapshot, release

**Catalog entry**:
One installable row in a Catalog generation, identified by an opaque immutable catalogId and naming the Package it installs.
_Avoid_: Listing, item, plugin record

**Isolate**:
A Dynamic Worker the Bot's Durable Object loads to execute non-first-party Package code with only the bindings the Bot's Assignments grant.
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
A durable input the Bot's next conversational Turn is owed — a Routine hand-off today, a decided approval later. Drained once, idempotently, and never delivered as something the User said.
_Avoid_: Queued message, pending wake
