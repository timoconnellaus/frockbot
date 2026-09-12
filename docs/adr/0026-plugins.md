# ADR 0026: Plugins

Status: accepted, 2026-09-12. Numbered after ADR 0025; nothing on `main` or in
an open pull request holds 0026.

## Context

A User customises a Bot by talking to it. The way a Bot changes is by adding
Plugins: code that wraps the agent loop, adds tools, keeps its own data and
reaches the network. A deployment ships Plugins of its own so that every
account starts with them, and a User turns Plugins on and off per Bot, both the
ones the deployment shipped and the ones their Bots wrote.

Today the untrusted layer exists but nothing produces a member. The isolate
host in `frock-compose/isolate-host.ts` mounts one Dynamic Worker per
Composition member, the descriptor names six actions, eight grants and five
slots, and `BotCapabilities` is the loopback an isolate reaches the kernel
through. The "Bot capabilities" page toggles compiled-in first-party features
account-wide. Nothing lets a Bot write a Plugin, and nothing lets an operator
seed one.

Three platform facts shaped the design, all from the Dynamic Workers
documentation:

- A Dynamic Worker is billed per unique worker per day, and a Durable Object
  may have at most ten distinct dynamic workers in flight. One isolate per
  Plugin burns both.
- A loaded worker's `env` accepts structured-cloneable values and service
  stubs only. Storage, models, network and Durable Objects reach the worker as
  `ctx.exports` loopback entrypoints carrying per-call props, which is what
  `BotCapabilities` already is.
- A loaded worker's identity is the hash of its module set, and the loader
  callback must be idempotent. Nothing is bundled at load time: a module map
  of pre-built artifacts plus a generated index is the whole load.

Two harnesses were read as prior art. DeepSeek Harness opens five waterfalls
on its loop — pre-step, request, request-error, pre and post tool — plus
turn-stopping, gives Plugins a provide/inject service seam and a settings
schema, and says plainly that its `vm` sandbox is not a security boundary.
pi opens roughly thirty events whose return values are plain patches, has no
sandbox, and its third-party extensions hand-rolled a versioned RPC over an
untyped bus because nothing typed existed. FrockBot already opens five of the
same hooks to isolates. The lesson from both is that the hook list with
JSON-patch returns is the product surface, that isolation is the thing neither
could offer, and that Plugins will consume each other, so that seam is designed
rather than discovered.

## Decision

### Two layers

**Layer one is the deploy.** The parent Worker and the Bot Durable Object hold
the agent loop, the first-party features, the capability loopbacks and the
hook contract. They ship as ordinary code. First-party features that a User
may turn off — web, image, routines, subagents, machine messages — stay in
layer one and are switched per Bot by flags read at Turn time. They are listed
on the Plugins page beside the Plugins the deployment shipped so the User sees
one list, but they are never artifacts and never in a worker.

**Layer two is one Dynamic Worker per User** holding only code that was not in
the deploy: Plugins the deployment seeded at runtime and Plugins a Bot wrote.
Its loader id is the hash of the Plugin artifacts, the generated index module,
the binding digest and the hook contract version. A deploy leaves that id
alone unless the contract version bumps, so a release neither cold-starts every
User's worker nor counts a new unique worker for every account.

The loop is not swappable per Bot. Plugins wrap it at the hooks below; they do
not replace it. Neither harness surveyed lets a Plugin replace the loop
either.

### A Turn crosses the boundary six times at most

The Bot Durable Object admits the Turn and runs the loop in-process. At each
open hook it makes one RPC into the Plugin worker's entrypoint with the event
payload and this Bot's enabled list. The generated index fans out to the
enabled Plugins in order and returns one JSON patch. A disabled Plugin is never
invoked. Plugin tools are reported at `health()` and called by RPC the same
way. Plugin code reaches storage, the network, the model and the rest through
the loopback stubs in its `env`, minted by the Bot Durable Object for this Bot
and Turn.

The open hooks are `system-prompt/assemble`, `agent/tool-exposure`,
`tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping` and, new,
`agent/request`. Every hook returns a plain patch, chained in Plugin order, so
a later Plugin sees an earlier one's change. Live objects never cross.

### Records

The User Durable Object owns the generation: the installed set, the module-set
hash, last-known-good and quarantine. The Bot Durable Object owns its enable
map, the approvals the User gave for that Bot, the Plugin settings values, and
the per-Bot failure count. Admission reads the User's pin and the Bot's flags.
One install recompiles once, not once per Bot.

Reverting a generation happens at the User and restores the installed set for
every Bot, as the composition store already does. A Bot's enable map and
settings are revisioned separately. Every change, whether the User pressed it
or the Bot proposed it, is one audit row naming who and which Turn.

### Capabilities are loopback only

`env` is the User's authority masked per Bot per Turn through the props on the
loopback stubs. No Plugin, seeded or authored, holds more than the Bot whose
Turn it is.

- **Storage** is a loopback key-value store scoped per Bot per Plugin. The SDK
  shape leaves room for per-User storage, Vectorize, R2, SQLite and other
  services the base may export later; the base exports things Plugins consume,
  and a model provider is the first non-storage example.
- **Network.** `globalOutbound` stays `null`. The descriptor declares the hosts
  a Plugin needs; the User sees them on the card and approves them when
  enabling the Plugin for a Bot; the egress stub refuses everything else and
  attaches Connection credentials server-side. A Plugin may instead ask for
  open network access. Because every Plugin in the worker shares one JS realm,
  the caller of a loopback stub is not reliably identifiable, so open access is
  shown honestly as worker-wide: the card says it gives every Plugin on this
  account open network access.
- **Plugin to plugin** is typed `provides` and `consumes` in the descriptor.
  The generated index mounts in dependency order and hands each consumer its
  providers. An unmet or mismatched need disables only that Plugin with a
  notice. The base's own exports are the first provider.
- **Model calls** through the `ai` capability draw from the Bot's own budget at
  the Bot's rates, attributed to the Plugin id in the usage event and itemised
  on the Work view.

### Contract, failure, limits

The hook and capability contract is versioned. A descriptor names the version
it was built for; layer one serves the current and the previous version. A
Plugin on a retired version is disabled with a notice, and the Bot rebuilds it
on request. User code is never rebuilt silently at deploy.

A Plugin that throws in a hook or exceeds its deadline is skipped for the Turn.
The Turn completes without it, the User sees a notice in the Bot's words, and
the failure counts toward a per-Bot quarantine at three. A quarantined Plugin
stays off for that Bot until the User re-enables it. A locked Plugin cannot be
skipped, so its failure fails the Turn.

The loader limits cap the User's Plugin worker for the Turn. Each hook and tool
call carries its own deadline. Limits are deployment settings, not per Plugin,
because they cannot be enforced per Plugin inside one isolate.

### Catalog and seed states

Plugins come from two places: the deployment catalog, seeded at deploy, and a
Bot writing one in conversation. There is no upload path and no marketplace.

A seeded Plugin has one of four states: `locked` (on for every Bot, the User
cannot disable it), `default-on` (on for new Bots, the User may disable it per
Bot), `default-off` (in the module set, off until enabled) and `admin-gated`
(absent from the User's module set until an administrator turns it on for the
account, the Account feature rule). A seeded Plugin may also be `hidden`, which
removes it from the Plugins page entirely and is allowed only when it is not
enableable — `locked` or `admin-gated` off.

> Amended 2026-09-12, in step 6. `hidden` did not ship: `PLUGIN_SEED_STATES_V1`
> in `app/plugins/catalog.ts` carries the four states only. A seeded Plugin the
> page should not show is left out of the catalog, or kept `admin-gated` and
> unopened, which the page already omits.

The master toggle is an admin-held Account feature that gates Bot authoring
only. Turning seeded Plugins on and off is open to every User. Off keeps the
account's authored Plugins and their data.

### Authoring and activation

The Bot authors with a `plugin_*` Tool Namespace — list, enable, disable,
settings, create, files, write, check, publish — disclosed by name in the
prompt and by schema on request, beside a managed Skill that explains the SDK
and the rules. The catalog is never in the prompt. Builds go through the same
build service Applets use.

A new or changed Plugin takes effect through an Approval card in the
conversation that lists its hooks, hosts and grants. On approval the User
Durable Object records a new generation and this Bot enables it. The Turn in
flight keeps its generation, as today; the change is live from the next
admitted Turn. Every prior generation stays revertable.

### Triggers

A Plugin may be a Routine trigger source, beside schedule, webhook and
connection. The app owns the inbound route, `/hooks/<token>`, where the token
is opaque and maps to one User, Bot and Plugin, and the app rate-limits it. The
app then calls `trigger.receive` in the Plugin worker with the headers and body;
the Plugin verifies any provider signature through a Connection secret it
reaches by loopback and returns Turn input or a drop. The app enqueues the
Routine firing. A Plugin never binds a route and never enqueues a Turn.

### Slots

`settings.sections` opens in this change: a Plugin's card renders a
`ViewDocument` beyond its schema-driven settings, for status or a custom
control. The other four named slots stay closed until a Plugin needs them.

### Settings

The descriptor carries a JSON Schema for its settings; values live per Bot and
render on the Plugin's card through the existing settings `ViewDocument`. The
Bot edits them in conversation through the same action. Secrets never enter
Plugin settings; a secret is a Connection.

### Applets

Applets keep their own loader and facet for now. Both Applets and Plugins use
the build service and share the descriptor vocabulary where it fits. Applets
fold into the Plugin family once Plugins have the slots Applets need.

### Naming

The user-facing noun is **Plugin**, for the page and for the thing. The page
"Bot capabilities" becomes "Plugins" and lists first-party toggleables beside
seeded and authored Plugins. `Package` stays the term for a build-time
substitution and for the artifact a Plugin is built into; `Capability` stays
the term for what a Package or Plugin makes available.

> Amended 2026-09-12, in step 6. The rename was a split, not a retitle. Plugins
> is a Bot's page — what that Bot could run and whether it does, each switch
> that Bot's own — and the account-wide page that installs and uninstalls the
> built-in features stayed, retitled **Account features**. `docs/profile-settings.md`
> owns what each of the two surfaces is for.

## Amendments to the constitution

Three sentences in `AGENTS.md` change with this decision.

- **Configuration is account-shaped** gains a per-Bot exception: a Plugin is
  installed per account and enabled per Bot, because "make this Bot able to do
  X" is what a User says, and a second Bot inheriting a Plugin nobody asked it
  to have is a surprise.
- **Self-modification never widens authority** gains its one path: a User may
  widen a Plugin's reach by approving, on its card, the hosts its descriptor
  declares or its request for open network access. The Bot proposes and the
  User grants; there is still no way for a Bot to grant itself anything.
- **Extension points** gain the sixth hook, `agent/request`; declared hosts and
  open network access as the shape of the `http` grant; `provides` and
  `consumes`; `trigger.receive`; and the hook contract version.

## Consequences

- One Dynamic Worker per User holds every Plugin; the per-member host in
  `frock-compose/isolate-host.ts` is replaced by a per-User host that generates
  an index over N artifacts.
- The composition store moves from the Bot Durable Object to the User Durable
  Object; the Bot keeps flags, approvals, settings and failure counts. The
  per-Bot composition keys are cleaned up in the same release, under the
  disposable-state rule, and a fresh conversation is verified after.
- `BotCapabilities` grows key-value storage, an egress stub that enforces
  declared hosts, a model call attributed to a Plugin, and settings reads.
- The Plugins page replaces Bot capabilities, and the Flutter host and the
  browser suite that name it change in the same pull request. (Amended in step
  6; see Naming.)
- Routines gain a `plugin` trigger kind and the app gains the `/hooks/<token>`
  route.
- `docs/architecture.md` §5 is rewritten around the two layers when the host
  lands, not before.

## Order

Each step leaves `main` shippable, is validated locally including the browser
suite, and is merged when green.

1. This document, the terms in `CONTEXT.md`, the amendments to `AGENTS.md`.
2. The descriptor and the Plugin worker contract, decoders and tests only.
3. The per-User Plugin worker host in `frock-compose`.
4. The generation store on the User Durable Object, last known good and the
   generation quarantine with it, as Records says; per-Bot flags and settings
   on the Bot. The per-Plugin failure count and quarantine are step 9's.
5. The loopback capabilities: storage, egress, model, settings.
6. The catalog, seed states, the Plugins page and per-Bot toggles.
7. Bot authoring: the Tool Namespace, the managed Skill, the build, the
   Approval card, the authoring gate.
8. Triggers.
9. The settings slot, failure notices, Work view itemisation and the
   contract's current-and-previous rule.
