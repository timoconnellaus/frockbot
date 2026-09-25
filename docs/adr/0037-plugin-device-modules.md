# ADR 0037: A Plugin may run a module on the desktop

Status: proposed, 2026-09-25. Numbered after ADR 0036; nothing on `main` or in
an open pull request holds 0037. Decisions are Tim's from the 2026-09-25
discussion:

- The integration is a Plugin, not first-party. That includes device abilities:
  a host ability may be a Plugin.
- The desktop runs the Plugin's own code, which holds the source's connection.
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
events after a `subscriptions.set` command.

A Plugin cannot reach it. Its worker runs in the cloud, and `localhost` there
is not the person's Mac. [ADR 0035](0035-device-bridge.md) answers native reach
with device abilities compiled into the host, so every new integration of this
kind would be a client release and first-party code. That is the wrong layer:
Beeper, and Messages with it, is a runtime extension a User chooses, which is
what a Plugin is.

What already exists:

- **A process on the Mac that talks to the cloud.** The Mac app bundles
  `apps/mac-messages`, a helper that enrols over the machine protocol, claims
  commands first-write-wins and reports results
  (`app/machine/device-runner.ts`). Its send ledger
  (`apps/mac-messages/send-ledger.ts`) never runs a claimed `commandId` twice.
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
- **Content-addressed Plugin artifacts** under the Plugin's generation, served
  hash-checked and immutable.

## Decision

### A device module is Plugin code the desktop runs

A Plugin may declare modules beside its worker, pages and triggers:

```ts
device: {
  modules: [
    {
      id: "bridge",
      platforms: ["macos"],
      localhost: [23373],
      calls: ["search", "read", "send"],
      events: ["message"],
    },
  ];
}
```

- `localhost` is the outbound the module has.
- `calls` is what the Plugin's cloud code may ask the module to do.
- `events` names what the module may send to the cloud. Each is one of the
  Plugin's `triggers`.

Frock Compose builds each module into a content-addressed artifact under the
Plugin's generation. A Bot authors a module the way it authors the rest of a
Plugin.

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

What the operating system grants to the app, such as Full Disk Access or
Automation, the host passes to a module that declares it. Messages moves from
`apps/mac-messages` to a Plugin on this path.

### The desktop keeps the modules running

The Device's sync ([ADR 0035](0035-device-bridge.md)) carries the modules the
account runs: `(pluginId, moduleId, artifact hash, generation)` for each
installed Plugin enabled on at least one Bot. The desktop fetches each
artifact, checks its hash, and runs it while the app is open. A new generation
replaces the running module; a module never updates itself. The Device reports
each module as running, stopped or crashed, and a crashing module restarts with
backoff.

The module host is the Mac helper, generalised. Each module runs in its own
isolate, with the outbound it declared, and a small key-value store on the
Device for its own cursor. It holds the connection the source offers, such as
Beeper's WebSocket, for as long as the app runs.

### The desktop holds one hibernating WebSocket

The desktop reaches the cloud over one WebSocket to the User Durable Object,
accepted with `acceptWebSocket` and tagged with the Device's id. It replaces
the long poll.

- **Idle costs nothing.** The Durable Object hibernates while the socket is
  quiet. Keep-alive pings are answered by `setWebSocketAutoResponse` without
  waking it.
- **Presence is the socket.** A Device is present while its socket is open.
  There is no lease to renew.
- **Commands go down it.** When a Turn calls a module, the Durable Object is
  already awake, finds the Device's socket and sends the command.
- **Events and results come up it.** Each wakes the Durable Object once.
- **A dropped socket reconnects.** A deploy closes every socket, and the host
  reconnects with backoff. A call in flight across the drop ends as described
  under the deadline below.

### In: a module event fires a Routine

When the source pushes, the module calls `emit(event, payload, { key })`. The
host sends it up the socket, keyed by `key`, the source's own id for the
occurrence (Beeper's message id). The User Durable Object acknowledges only
once it has admitted the event.

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

## Not decided here

- The isolate the host uses. Local workerd matches the cloud Plugin worker, so
  a module's author writes one kind of code; it has to hold a long-lived
  outbound WebSocket, which a spike settles before the host ships.
- Windows and Linux hosts.
- Moving the phone's presence lease (`apps/native/lib/activity/push.dart`
  renews it every six seconds while the app is focused) onto its channel
  socket.

## Amendments to the constitution

On acceptance, `AGENTS.md` changes as follows:

- **Extension points** gains **Device modules**: code a Plugin ships for the
  desktop to run, reaching what it declares, answering its Plugin's calls and
  emitting its Plugin's triggers.
- **Triggers** says a Plugin trigger may also be fed by the Plugin's own
  device module.
- **Untrusted code gets an isolate** covers the desktop host.

ADR 0035 changes with it: a device ability may be provided by a Plugin module,
and its own-machine tier is no longer first-party only. Its device command path
keeps the ledger and the deadline, and for a module call drops the queue for an
absent Device and the Pending-input result.

`CONTEXT.md` gains **Device module**.

## Consequences

- The Mac helper becomes the module host. It keeps enrolment and the ledger,
  and gains module loading, isolation and lifecycle.
- The long poll goes. The helper's connection is the hibernating socket, and
  the User Durable Object is no longer resident while a Mac is online.
- The Device's sync gains the module list and the listening flags, and the
  Device reports each module's state.
- The machine protocol gains the `module` operation and its outcomes.
- The Plugin worker gains the `device` binding.
- Frock Compose builds module artifacts.
- Messages leaves the first-party code for a Plugin. Its code, surfaces and
  stored shapes go under the disposable-state rule, and a fresh conversation is
  verified.

## Order

Each step leaves `main` shippable.

1. This document.
2. The hibernating socket, replacing the long poll for the helper as it is.
3. The module host with a module that only logs, the sync that delivers it, and
   its reported state.
4. Module events into Plugin triggers, with the listening flags, the replay key
   and catch-up.
5. `device.call`, with the ledger, the deadline and its outcomes.
6. Proof: ask Frock for a Beeper Plugin on a clean account. Anything it cannot
   build without Beeper-specific platform code is a gap in this design.
7. Messages as a Plugin, and the first-party Messages code removed.
