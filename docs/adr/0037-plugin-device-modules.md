# ADR 0037: A Plugin may run a module on the desktop

Status: proposed, 2026-09-25. Numbered after ADR 0036; nothing on `main` or in
an open pull request holds 0037. Decisions are Tim's from the 2026-09-25
discussion: the integration is a Plugin, not first-party; the desktop runs the
Plugin's own code; an event reaches a Routine as an HTTP request to the cloud;
the outgoing side is a tool the Plugin exposes. Consent for what a module may
reach is decided elsewhere and is not repeated here.

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
  `apps/mac-messages`, a helper that enrols over the machine protocol, long-polls
  the User Durable Object, claims commands first-write-wins and reports results
  (`app/machine/device-runner.ts`). Its send ledger
  (`apps/mac-messages/send-ledger.ts`) never runs a claimed `commandId` twice.
- **A command path back to the Bot.** A machine result lands on the User
  Durable Object and reaches the Bot as a Pending input
  (`app/machine/delivery.ts`).
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

- `localhost` is the only outbound the module has.
- `calls` is what the Plugin's cloud code may ask the module to do.
- `events` names what the module may send to the cloud. Each is one of the
  Plugin's `triggers`.

Frock Compose builds each module into a content-addressed artifact under the
Plugin's generation. A Bot authors a module the way it authors the rest of a
Plugin. A module is desktop-only: phones do not keep a process alive for it.

### The desktop keeps the modules running

The Device's sync ([ADR 0035](0035-device-bridge.md)) carries the modules the
account runs: `(pluginId, moduleId, artifact hash, generation)` for each
installed Plugin enabled on at least one Bot. The desktop fetches each
artifact, checks its hash, and runs it while the app is open. A new generation
replaces the running module; a module never updates itself. The Device reports
each module as running, stopped or crashed, and a crashing module restarts with
backoff.

The module host is the Mac helper, generalised: the process that already
enrols, polls and keeps a ledger now also loads modules. Each module runs in
its own isolate. Its outbound is a loopback that admits only the ports it
declared, it has no filesystem, and it has a small key-value store on the
Device for its own cursor.

A module is a long-lived process. It holds the connection the source offers,
such as Beeper's WebSocket, for as long as the app runs.

### In: a module event is an HTTP request that fires a Routine

When the source pushes, the module calls `emit(event, payload, { key })`. The
host sends it to the cloud as one HTTP request, authenticated by the Device's
command credential and keyed by `key`, the source's own id for the occurrence
(Beeper's message id).

From there it is the Plugin trigger path that exists:

1. The User Durable Object finds the Routines whose `plugin` trigger names this
   Plugin and this event, on any of the User's Bots.
2. For each, the delivery passes the webhook door's digest and replay guard,
   keyed by `(deviceId, pluginId, key)`, so a module that reconnects and
   replays does not fire twice.
3. `deliverPluginTriggerV1` asks the Plugin to shape it or drop it.
4. The app enqueues the firing.

The Device credential stands in for a Routine's key because the module serves
every Routine that uses its trigger, and a Routine's key is shown once and never
kept where the sync could hand it out. Nothing after the check is new: a module
event is a second way into the door the Plugin trigger already uses. The Plugin
never learns which way it came.

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

A Plugin tool such as `beeper_send` uses it. The call rides the machine
command path as a new operation, `{ kind: "module", pluginId, moduleId, call,
input }`:

1. The intent is recorded, keyed by the Turn's effect id.
2. It is queued on the User Durable Object, for the named Device or, when the
   account has one desktop running the module, that one.
3. The host claims it, checks its ledger and runs the module's handler.
4. The result lands on the User Durable Object.

The ledger lives in the host, not the module, so every module call is
at-most-once whatever the module does.

The tool call is what Jev reviews. A Plugin tool is `mutate` by default, and a
tool like `beeper_send({ chatId, text })` carries the whole effect in its
arguments. A Routine Turn sends only when review finds the User's
authorisation in durable policy; otherwise the Bot asks in conversation.

### A read waits, briefly

Delivering every result as a Pending input would cost a Turn for each
`search`. So a call waits inside the Turn for its result, for at most
`DEVICE_CALL_WAIT_MS`, while the target Device is present. A result inside
that window is the tool's result. A result after it, or for a Device that is
not present, is delivered as a Pending input that opens the next Turn, as a
machine result is now. The Turn is resident only for that window, so it still
survives eviction: the command is already recorded, and its result still
arrives.

Every call has a deadline. A call unclaimed at its deadline is `expired`, and
the Bot is told it did not run.

## Not decided here

- The isolate the host uses. Local workerd matches the cloud Plugin worker, so
  a module's author writes one kind of code; it has to hold a long-lived
  outbound WebSocket, which a spike settles before the host ships.
- Host primitives a module may call for what the operating system grants only
  to the app, such as reading the Messages database or sending through
  Messages. Moving Messages from first-party code to a Plugin needs these, and
  it is the intended follow-up.
- Windows and Linux hosts.

## Amendments to the constitution

On acceptance, `AGENTS.md` changes as follows:

- **Extension points** gains **Device modules**: code a Plugin ships for the
  desktop to run, reaching the localhost ports it declares, answering its
  Plugin's calls and emitting its Plugin's triggers.
- **Triggers** says a Plugin trigger may also be fed by the Plugin's own
  device module.
- **Untrusted code gets an isolate** covers the desktop host.

ADR 0035's "a new ability is a client release and an amendment to the catalog,
never a Plugin" narrows to host abilities. A device module is not an ability:
it is Plugin code, and it reaches only what its declaration names.

`CONTEXT.md` gains **Device module**.

## Consequences

- The Mac helper becomes the module host. It keeps enrolment, polling and the
  ledger, and gains module loading, isolation and lifecycle.
- The Device's sync gains the module list, and the Device reports each module's
  state.
- The machine protocol gains the `module` operation and the bounded wait.
- The cloud gains one authenticated route for module events, feeding the
  existing Plugin trigger path.
- The Plugin worker gains the `device` binding.
- Frock Compose builds module artifacts.

## Order

Each step leaves `main` shippable.

1. This document.
2. The module host with a module that only logs, the sync that delivers it, and
   its reported state.
3. Module events into Plugin triggers, with the replay key and catch-up.
4. `device.call` on the machine path, with the ledger and the bounded wait.
5. Proof: ask Frock for a Beeper Plugin on a clean account. Anything it cannot
   build without Beeper-specific platform code is a gap in this design.
6. The host primitives for Messages, and Messages as a Plugin.
