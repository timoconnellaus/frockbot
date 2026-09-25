# ADR 0037: A Plugin may run a module on the desktop

Status: accepted, 2026-09-25. Numbered after ADR 0036; nothing on `main` or in
an open pull request holds 0037. Decisions are Tim's from the 2026-09-25
discussion:

- An integration with something on the person's computer is a Plugin, never
  first-party. That includes device abilities: a host ability may be a Plugin.
- The first-party Messages integration is deleted before any of this is built.
  Messages comes back only as a Plugin a Bot writes.
- The desktop runs the Plugin's own code, with whatever packages it bundles,
  and that code holds the source's connection.
- An event reaches a Routine through the cloud, and the outgoing side is a tool
  the Plugin exposes.
- A call to a desktop that is not there, or does not answer in time, fails.
  Nothing arrives after the Turn has moved on.
- The desktop is reached without keeping a Durable Object resident.

Consent for what a module may reach is decided elsewhere and is not repeated
here.

## Context

Some things a Bot should reach live only on the person's computer. Beeper
Desktop is the example that started this: it exposes a REST API, an MCP server
and a WebSocket on `localhost:23373`, covering every chat network the person
has connected. The WebSocket streams `message.upserted` and `chat.upserted`
events after a `subscriptions.set` command. Messages is the other: its history
is a SQLite database under `~/Library/Messages`, and it sends through Apple
Events.

A Plugin cannot reach either. Its worker runs in the cloud, and `localhost`
there is not the person's Mac. [ADR 0035](0035-device-bridge.md) answers native
reach with device abilities compiled into the host, so every integration of
this kind would be a client release and first-party code. That is the wrong
layer: these are runtime extensions a User chooses, which is what a Plugin is.

What exists:

- **First-party Messages.** `app/machine-messages` holds its tools, SQL and
  AppleScript; `apps/mac-messages` is a Bun helper the Mac app bundles to run
  them, with a send ledger; `AppDelegate.swift` runs its sends; the machine
  protocol carries a `messages` operation; the Flutter app has its consent
  screen. It is the only client of the device agent (`app/machine/device.ts`).
- **A long poll that keeps the User Durable Object resident.** The helper holds
  a 25-second poll (`MACHINE_LIMITS_V1.pollMaxWaitSeconds`) and opens the next
  when it ends, so a request is in flight on the User Durable Object for as long
  as the Mac is online.
- **A hibernating WebSocket.** The Bot state channel
  (`apps/cloudflare/src/bot-state-channel.ts`) accepts its sockets with
  `acceptWebSocket`, so its Durable Object sleeps between frames while the
  socket stays open.
- **Plugin triggers.** A Routine whose trigger names a Plugin enters through the
  Routine webhook door: the same key, digest and replay guard, then
  `deliverPluginTriggerV1` (`app/plugins/triggers-bot.ts`) asks the Plugin to
  shape the delivery or drop it, and the app enqueues the firing.
- **A Bot's Plugin loop.** `plugin_check` type-checks, `plugin_publish` builds
  and asks for approval, `plugin_page_try` runs a page on the Bot's Computer
  first, and `plugin_page_reports` reads back what a page reported from the
  person's device (`app/plugins/skills/plugins/SKILL.md`).

## Decision

### First-party Messages is deleted first

Before the module host is built, Messages is removed entirely:
`app/machine-messages`, `apps/mac-messages`, the `messages` operation and its
limits in `core/machine-protocol`, the Messages channel in `AppDelegate.swift`,
`apps/native/lib/machines/mac_messages.dart` and its place on the machines
page, its Package definition and catalog entry, its tests, and the Messages
section of `apps/native/macos/README.md`. Its stored records go under the
disposable-state rule, and a fresh conversation is verified.

Nothing of it is kept as a reference. The device agent and the machine
protocol's queue, claim and ledger rules are not Messages and stay; the module
host builds on them.

### A device module is Plugin code the desktop runs

A Plugin may declare modules beside its worker, pages and triggers:

```ts
device: {
  modules: [
    {
      id: "bridge",
      platforms: ["macos"],
      read: [],
      net: ["localhost:23373"],
      appleEvents: [],
      calls: ["search", "read", "send"],
      events: ["message"],
    },
  ];
}
```

- `read` is the paths it may read and watch.
- `net` is the hosts and ports it may reach.
- `appleEvents` is the applications it may script, by bundle id.
- `calls` is what the Plugin's cloud code may ask the module to do.
- `events` names what the module may send to the cloud. Each is one of the
  Plugin's `triggers`.

A module is ordinary TypeScript and may bundle any npm package that needs no
native addon. Frock Compose builds it, with its dependencies, into one
content-addressed artifact under the Plugin's generation. A Bot authors a
module the way it authors the rest of a Plugin.

A module is desktop-only. A phone keeps nothing open in the background, so the
cloud reaches it only by push, which is too slow for a call that must answer
inside a Turn.

### A device ability may be a Plugin

ADR 0035 made every device ability host code and kept its own-machine tier
first-party. This ADR reverses both. A Plugin module may provide an ability,
including one that reaches the person's own machine and accounts, such as
sending through Messages.

The reason ADR 0035 gave was review: a Plugin tool that ran an effect inside
itself would hide it from Jev. A module's effect is a Plugin tool call whose
arguments carry the whole effect, such as `beeper_send({ chatId, text })`, and a
Plugin tool is `mutate` by default. Review sees what would be sent.

### Each module runs in Deno, inside a macOS sandbox

The app has Full Disk Access, and a process it starts inherits it. So a module
never runs as a plain process. Each module is its own process with two
boundaries, both generated from its declaration:

1. **Deno's permissions.** `--allow-read` for `read`, `--allow-net` for `net`
   and the host's local channel, and `--cached-only` so it loads no code it did
   not ship. Never `--allow-run`, `--allow-ffi`, `--allow-env` or
   `--allow-write`. Deno is Node-compatible, so a module uses `node:fs`,
   `node:sqlite`, WebSockets and npm packages as it would anywhere.
2. **A Seatbelt profile**, applied when the process starts: file reads only
   under `read` and the module's own artifact and store, network only to `net`
   and the host's channel, and no process execution. The operating system
   enforces it outside the process, so a flaw in Deno's checks still does not
   reach the rest of the disk.

Deno's own guidance is not to rely on its permissions alone for untrusted code;
the Seatbelt profile is that second layer. Seatbelt is deprecated as a public
API but is what Chrome and Firefox sandbox with, and the App Sandbox cannot
express paths that differ per module. The profile generator is kept small so a
replacement stays contained.

The Deno binary ships inside the Mac app, signed with the JIT entitlements the
Bun helper carries today.

### The one host binding: Apple Events

Neither boundary can say "only Messages": allowing `osascript` would let a
module script any application. So the host keeps one binding, reached over the
module's local channel:

```ts
appleEvents.run(bundleId, script);
```

The app runs the script only against a bundle id the module declared. The
operating system attributes it to the app, whose Automation consent covers it.

Every other reach is the module's own code under its two boundaries. A new host
binding is justified only by the same test: something the operating system
grants to the app that neither boundary can limit.

### The desktop keeps the modules running

The Device's sync ([ADR 0035](0035-device-bridge.md)) carries the modules the
account runs: `(pluginId, moduleId, artifact hash, generation)` for each
Plugin installed on the account, in its active Composition generation. A
Bot's switch is not consulted, because it lives in that Bot's Durable Object
and the User Durable Object that holds the socket never reads it. The desktop fetches each
artifact, checks its hash, and runs it while the app is open. A new generation
replaces the running module; a module never updates itself. A crashing module
restarts with backoff.

Each module has a small key-value store on the Device for its own cursor, and
holds the connection its source offers, such as Beeper's WebSocket, for as long
as the app runs.

### The desktop holds one hibernating WebSocket

The desktop reaches the cloud over one WebSocket to the User Durable Object,
accepted with `acceptWebSocket` and tagged with the Device's id. The long poll
goes with the Messages helper and does not come back.

- **Idle costs nothing.** The Durable Object hibernates while the socket is
  quiet. Keep-alive pings are answered by `setWebSocketAutoResponse` without
  waking it.
- **Presence is the socket.** A Device is present while its socket is open.
  There is no lease to renew.
- **Commands go down it.** When a Turn calls a module, the Durable Object is
  already awake, finds the Device's socket and sends the command.
- **Events, results and reports come up it.** Each wakes the Durable Object
  once.
- **A dropped socket reconnects.** A deploy closes every socket, and the host
  reconnects with backoff. A call in flight across the drop ends as described
  under the deadline below.

### In: a module event fires a Routine

When the source pushes, the module calls `emit(event, payload, { key })`. The
host sends it up the socket, keyed by `key`, the source's own id for the
occurrence, such as Beeper's message id. The User Durable Object acknowledges
only once it has admitted the event.

From there it is the Plugin trigger path that exists:

1. The User Durable Object finds the Routines whose `plugin` trigger names this
   Plugin and this event, on any of the User's Bots.
2. For each, the delivery passes the webhook door's digest and replay guard,
   keyed by `(deviceId, pluginId, key)`, so a module that reconnects and
   replays does not fire twice.
3. `deliverPluginTriggerV1` asks the Plugin to shape it or drop it.
4. The app enqueues the firing.

The Device routes the event, not the Routine, for three reasons:

- A Routine's key is shown once and never kept where the sync could hand it
  out. The Device already holds its own credential.
- Routines come and go in conversation. The desktop never needs to know which
  exist.
- One event may matter to Routines on several Bots, and only the User Durable
  Object sees them all. Connection triggers already route this way.

The sync tells each module which of its events have at least one Routine
listening: a flag per event, never a key. A module with no listener sends
nothing, so an unarmed Plugin does not wake the Durable Object for every
message the person receives.

A Routine is only the trigger and its instruction. What the firing Turn does
next is the model's, through tools.

Payloads are third-party content. The firing Turn carries them marked as such,
never as something the User said.

When the app starts, the host hands the module its last acknowledged `key`, so
the module can fetch what arrived while the app was closed.

### Out: a Plugin tool calls its module

The Plugin's cloud code gains a `device` loopback binding:

```ts
device.call(moduleId, call, input, { deviceId? })
```

A Plugin tool such as `beeper_send` uses it, and the tool call is what Jev
reviews. A Routine Turn sends only when review finds the User's authorisation
in durable policy; otherwise the Bot asks in conversation.

A call runs inside the Turn:

1. The intent is recorded, keyed by the Turn's effect id, with a deadline no
   later than `DEVICE_CALL_WAIT_MS` from now.
2. If no Device running the module is connected, the call fails now. Nothing is
   queued for later.
3. Otherwise the command goes down the named Device's socket, or the one
   connected Device running the module.
4. The host checks its ledger, refuses a command past its deadline, and runs
   the module's handler.
5. The result comes back up the socket and is the tool's result.

The ledger lives in the host, not the module, so a module call is at-most-once
whatever the module does.

### A call that times out fails, and its result is discarded

A call with no result by its deadline ends there. What the model is told
depends on what could have happened:

- **Not claimed:** `failed`. It never started, and the host will refuse it
  past its deadline.
- **A read, claimed:** `failed`. Nothing changed.
- **A mutation, claimed:** `unknown`. It may have taken effect, so the Bot
  checks before it tries again. It is never reported as `failed`, because a
  retry of a send that went through is a second send.

A result that arrives after the deadline is recorded in audit and on the Work
view, and never reaches the model. There is no Pending input for a module call:
the Turn that asked is the only one that hears the answer.

### How a Bot tests a module

A Bot building a module works from what it can find out, not from a fixture or
a reference we ship. Its loop extends the one it uses for pages:

- **`plugin_check`** also type-checks the module against the module SDK,
  confirms every declared `call` and `event` has a handler, and refuses a
  dependency that needs a native addon.
- **`plugin_module_try`** runs the module on the Bot's Computer under Deno with
  the flags its declaration generates, then invokes one call or plays one
  event. The Computer has no Beeper and no Messages, so the Bot supplies its own
  stand-ins: a mock of the API it is targeting, or a database it built from the
  schema it found. A read outside the declaration fails there as it will on the
  Mac.
- **`plugin_module_reports`** reads what the module reported from each Device:
  the generation running and its state, crash output, the module's own logs,
  every read, network or Apple Events request its boundaries denied, and each
  event emitted with what the Plugin's trigger did with it. Bounded per Plugin,
  newest kept, like page reports.
- **`plugin_trigger_try`** feeds a sample payload through the Plugin's
  `receiveTrigger` and shows what it returned, without firing a Routine.

Discovery happens on the real Mac. To build Messages, a Bot publishes a first
generation that declares read access under `~/Library/Messages` and a call that
reports what it finds, such as the database's `sqlite_master`. It calls that
from conversation, learns the schema, builds its own stand-in on its Computer,
and writes the real queries against it. Beeper is the same, with its API
reference and the responses its first calls return.

## Not decided here

- Whether a generation that changes only code, under a declaration already
  approved, needs a new approval. Discovery on the real Mac takes several
  generations, and each approval is a round trip with the person.
- Windows and Linux hosts.
- Moving the phone's presence lease (`apps/native/lib/activity/push.dart`
  renews it every six seconds while the app is focused) onto its channel
  socket.

## Amendments to the constitution

`AGENTS.md` changes as follows:

- **Extension points** gains **Device modules**: code a Plugin ships for the
  desktop to run, reaching what it declares, answering its Plugin's calls and
  emitting its Plugin's triggers.
- **Triggers** says a Plugin trigger may also be fed by the Plugin's own
  device module.
- **Grants** gains what a module declares: paths to read, hosts to reach, and
  applications to send Apple Events to.
- **Untrusted code gets an isolate** covers the desktop: a module runs under
  Deno's permissions and a Seatbelt profile, both from its declaration.

ADR 0035 changes with it: a device ability may be provided by a Plugin module,
and its own-machine tier is no longer first-party only. Its device command path
keeps the ledger and the deadline, and for a module call drops the queue for an
absent Device and the Pending-input result.

`CONTEXT.md` gains **Device module**.

## Consequences

- First-party Messages and the Bun helper are gone.
- The Mac app gains the module host: Deno, the Seatbelt profile generator, the
  hibernating socket, the ledger and module lifecycle, built on the device
  agent that stays.
- `AppDelegate.swift` gains `appleEvents.run` for a declared target.
- The Device's sync gains the module list and the listening flags, and the
  Device reports each module's state and logs.
- The machine protocol gains the `module` operation and its outcomes.
- The Plugin worker gains the `device` binding.
- Frock Compose builds module artifacts with their dependencies.
- The Plugin skill gains a module reference and the four testing tools.

## Order

Each step leaves `main` shippable.

1. This document.
2. Delete first-party Messages and the Bun helper, with the stored-data
   cleanup.
3. The module host: Deno and the Seatbelt profile, the hibernating socket, the
   sync, a module that only logs, and `plugin_module_reports`.
4. Module events into Plugin triggers, with the listening flags, the replay key,
   catch-up and `plugin_trigger_try`.
5. `device.call`, with the ledger, the deadline and its outcomes, and
   `plugin_module_try`.
6. `appleEvents.run`.
7. Proof: on a clean account, ask Frock for a Beeper Plugin, then for a
   Messages Plugin. Anything it cannot build from the module SDK, its own
   discovery and these tools is a gap in this design.
