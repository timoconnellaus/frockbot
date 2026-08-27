# FrockBot

FrockBot is a desktop environment for creating and operating persistent conversational bots whose behavior and interface can be extended through installable packages.

## Language

**User**:
A person who owns bots and one shared set of enabled, configured packages inherited by all of those bots.
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
A versioned, installable FrockBot distribution containing a manifest and one or more contributions.
_Avoid_: Plugin, extension

**Contribution**:
One environment-specific part of a package, such as desktop-host behavior, agent capability, or WebUI presentation.
_Avoid_: Package

**Plugin**:
A live contribution mounted into an application context with owned lifecycle and cleanup.
_Avoid_: Package

**Computer**:
An isolated execution environment assigned to a bot for filesystem, process, browser, or other stateful work.
_Avoid_: Worker, sandbox

**Routine**:
A persisted trigger and instruction that schedules future work for a bot.
_Avoid_: Job, cron
