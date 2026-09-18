# ADR 0032: Plugins own their data and their surfaces

Status: proposed, 2026-09-18. Numbered after ADR 0031; nothing on `main` or in
an open pull request holds 0032. The bar this is designed against is
[`docs/plugin-scenarios.md`](../plugin-scenarios.md).

## Context

FrockBot's premise is that it becomes exactly what one person needs it to be.
The twelve scenarios say what that means concretely: eleven of them need a
surface over structured data that a Bot built, and all twelve need the shell
itself to become the tool rather than a chat window with a panel bolted on.

Two half-answers exist, and neither can build one of the twelve alone.

An **Applet** has the data and the page. It is a Durable Object facet with
schema-first SQLite tables reached through a structured API, an iframe page
built from a fixed component kit and synced live over a socket, an owner Bot
that may write its source and other Bots it is shared with (ADR 0027). It has
no hooks, no triggers, no per-Bot enablement, no settings, no health, and its
page hangs off a canvas of its own rather than appearing anywhere in the app.

A **Plugin** has the loop and the lifecycle. It has the six hooks, triggers
through the Routine door, provides and consumes, grants, a per-Bot enable map
with seed states, health and quarantine, a settings schema, a Skill, and since
ADR 0030 the Cards it draws in the thread. Its data is a key-value store with
64 KiB values, and its only place in the app is one settings section on its own
card, because `settings.sections` is the only open slot.

Both deferrals were deliberate and both named this moment. ADR 0026: "Applets
fold into the Plugin family once Plugins have the slots Applets need." ADR
0030: "Whether the slots fold into A2UI is a later decision, taken when a slot
needs something `ViewDocument` does not have." A panel listing a plumber's
quotes needs a table, a form and an upload. That is the moment, and both
questions turn out to be one question, because a surface is only worth having
where there is data behind it.

The requirement that shapes everything below is stability. The extension points
are a contract that outlives every Plugin written against it, and a marketplace
makes that contract public. So this decision is about the seams that are
expensive to move — where data lives, who scopes it, where code runs, what a
surface is — and deliberately not about how many of them exist on day one. More
slots, more components, more hooks and more grants are horizontal: they are
added later without redesigning anything here. A vertical slice that is right
matters more than a wide one that is provisional.

## Decision

### The Applet stops being a kind of thing

There is one extensible thing, the Plugin. What was an Applet is a Plugin that
declares tables and a surface. The separate loader, the separate build kind,
the Applets canvas, the Applets account feature, the share and transfer tools
and the noun all go.

This is not a tidying. An Applet's data cannot be read by a hook, a trigger
cannot write to it, and an Applet cannot be turned off for one Bot — so the
plumber's quote trigger, the surface it feeds and the Bot that drafts from it
cannot be one thing a person installs and switches on. Every scenario needs
them to be.

### Tables live in Stores, Stores have Instances, Bots are bound to one

A Plugin declares one or more **Stores**, each a named group of tables. A Store
has one or more **Instances**. Every Bot that runs the Plugin is **bound** to
exactly one Instance of each Store. What has been called scope is the default
binding the author declares:

- `scope: "user"` — one Instance, every Bot bound to it. Shared contacts.
- `scope: "bot"` — one Instance per Bot. The Bot's own working list.

A Store may be declared `fixed`, which means the author's scope is a
correctness requirement and the User may not rebind it. Otherwise the User may:
bind several Bots to one Instance, give one Bot its own, or create and name
further Instances — "Work CRM" beside "Home CRM" — and choose per Bot. A
Plugin may declare several Stores with different scopes, which is how one CRM
Plugin gives every Bot the same contacts and its own notes.

Rebinding never moves rows. Merging two Instances is a separate, explicit act:
the kernel copies rows, tombstones the source, and writes an audit row. The
Plugin is not consulted, and nothing merges silently.

**Why Instances exist on day one**, when most accounts will have one of each:
they are the unit the rest of the roadmap attaches to. Sharing a household
calendar between two Users is one Instance bound into another User's Bot, and a
marketplace Bot installed twice is two Instances of the same Store. If binding
arrives later, every Plugin written before it has baked its own assumption into
its code, and the contract cannot be repaired.

One Bot is bound to one Instance per Store, never several. A Plugin that could
be looking at either of two Instances has no way to say which it means, and the
person has no way to know which they are reading. Two Bots is the answer.

### Plugin code is scope-blind, and the kernel does the scoping

A Plugin reads and writes "the Store". It never sees an Instance id, never
filters by Bot, and has no way to address data it was not bound to. The kernel
resolves the Instance from the Bot the call is running under and applies it to
every read and write. Rows carry the Bot that wrote them, which a surface may
show, but that is provenance and never a filter the Plugin maintains.

This is the reason the structured table API is the only door to a Store, now
permanently: it is what makes the scoping enforceable rather than advisory. No
raw SQL is exported, in any grant, ever. The build refuses it.

Three things follow. The same Plugin works per Bot, shared, or partitioned,
with no branch in its code. A reviewer — ours today, a marketplace's later —
never has to establish that a Plugin filters correctly, because it cannot fail
to. And the User's binding choice is a real choice rather than a hint, because
nothing downstream of it can disagree.

### Plugin code runs in one place: the User's Plugin worker

A Store is a loopback service the worker calls, the way `storage` is today. The
table API becomes asynchronous, and a read-modify-write is expressed as a
transaction: a batch of operations with preconditions, sent in one call,
applied atomically in the facet, returning a conflict the Plugin retries. This
generalises the optimistic concurrency the `workspace` grant already uses.

Rejected: mounting the module in two hosts, the worker for hooks and the
Store's facet for table-backed tools, which is what Applets do today. A
Durable Object serialises, so anything that runs inside one must be short and
bounded. A hook has a sixty-second deadline and may call a model, so it can
never run there — one Bot's slow hook would stall every other Bot of that User
and break the invariant that a Bot is never blocked by another Bot. Splitting
by call kind avoids that, but leaves an author and a reviewer needing to know
which host a given function runs in and what it can reach from there. That cost
never goes away, and it falls hardest on the least experienced author.

The cost accepted is ergonomic: the Applet's synchronous `this.db.todos.insert`
becomes an awaited call, and every existing Applet server is rewritten by its
maintainer Bot. A later addition — pure table functions declared by the Plugin
and executed inside the facet — would restore the ergonomics without moving the
boundary, and is horizontal.

### A surface is a Plugin's rendering at a named slot

A Plugin declares **surfaces**. Each names a slot, names the Store it follows,
and is rendered by the Plugin worker on demand. One Plugin may declare several,
which is the point: the todo list is a strip above the composer and a panel in
the sidebar, drawn from the same Store.

A surface renders under the Bot it is shown for, with that Bot's binding and
that Bot's budget, and appears only where the Plugin is enabled. A surface that
follows no Store is per Bot. The User owns placement: hide, collapse and order
within a slot are theirs, per Bot, and a Plugin cannot force itself open.

Pushing is by invalidation. A write to a Store invalidates the surfaces that
follow it, the host re-renders and sends the revised document on the Bot state
channel. So the Bot ticking off its own todo mid-Turn moves the strip while it
is still working, without the person refreshing anything.

There is no Applet picker and no Plugins canvas, and nothing replaces them. A
Plugin appears where it asked to appear. If someone wants a picker, that is a
Plugin with a sidebar surface listing others.

### Surfaces are A2UI, and the slots fold

A surface is drawn by the host from the catalogs compiled into the client, the
same way a Card is (ADR 0030). This is the "later decision" that ADR left open,
and the answer is that slots fold into A2UI rather than growing `ViewDocument`
a second time. One declarative format, one catalog, one renderer, one review
surface, one phone-Mac-web answer.

`ViewDocument` keeps the settings pages and the `settings.sections` slot, which
is the host's layout with a Plugin's values in it and a genuinely different
thing. It does not grow.

**No Plugin ships client code.** ADR 0030 said it for Cards, and it holds for
every surface: it is what makes one Plugin render identically on three
platforms, makes a surface reviewable as data, and keeps the cost of a rich
surface off the client. The consequence is accepted honestly — a component the
catalog lacks cannot be built by a Plugin, and the answer is to add it to the
catalog, which is horizontal and benefits every Plugin at once.

The one exception is migration. An existing Applet becomes a Plugin with a
sidebar surface pointing at its current iframe page, so nothing is rebuilt on
the day of the change. That path is not offered to new Plugins, and it retires
when the last migrated Applet has been rebuilt against the catalog.

### Which slots open, and what a surface may do

`sidebar.entries` and `composer.toolbar` open, joining `settings.sections`.
The first is where a former Applet lives and where the panels in the scenarios
go. The second is the placement above the composer, which is where a Bot's own
working list belongs: visible while it works, in the thread, without taking the
thread's space. If a row of controls and a standing strip prove to want
different budgets and different phone treatment, the strip takes a slot of its
own; that is a name and a budget, not a redesign. `message.actions` and
`bot.profile` stay closed until a Plugin needs them, and further slots — a
thread banner, a row on the Bot list, a home view — are added the same way.
Cards remain what they are: a send, not a slot.

A surface's actions are the Plugin's own tools, run outside a Turn, as settings
actions are today. One further action puts text in the composer, so a tap can
begin a conversation. A Plugin never enqueues a Turn; the person does. Budgets
are per slot — a strip is not a panel — and a surface over budget is refused
whole and reported unavailable, never at the cost of the Turn.

### Identity is namespaced

A Plugin id becomes `<publisher>/<name>`, with the User's own identifier as the
publisher for locally authored Plugins. Tools are exposed under the Plugin's
namespace, the mechanism connected apps already use, and the account-wide tool
name uniqueness rule that ADR 0027 needed goes with it.

This is not marketplace work, and it is here because it cannot be retrofitted.
Two publishers will ship a `contacts` Plugin with an `add_contact` tool, and
every Composition generation written before namespacing would have to be
rewritten to accommodate the second one.

### Maintainer, not owner

The Bot that authored a Plugin is its **maintainer**: it alone may read and
write the source, publish, revert and delete. Which Bots may _use_ it is the
enable map, which already exists. ADR 0027's `sharedWithBotIds`,
`applet_share` and `applet_unshare` disappear into that; transfer survives as
the act of changing maintainer.

Installation stays per User and enablement per Bot, unchanged. A Plugin that
arrived inside an installed Bot is usable by every Bot of that User once
switched on, and its page says where it came from. Editing an installed
Plugin forks it under local maintenance and it stops receiving its publisher's
updates.

### Migration

Every existing Applet becomes a Plugin: one Store with `scope: "user"` holding
its tables, one `sidebar.entries` surface pointing at its current iframe page,
its owner Bot as maintainer, and every Bot it was shared with enabled. No data
moves, no Applet is rebuilt, and no User sees a broken thing.

Durable Composition generations name Applet tools as they were. Those names
keep resolving through an alias until no live generation references one, not
for a fixed number of releases — an archived Bot woken months later must still
mount. After the deploy, a real Bot reply is verified before the change is
called done.

## What this ADR does not decide

- **The numbers.** Re-render cadence and byte caps per slot are configuration,
  measured from the documents the settings surfaces already produce, not
  contract.
- **The catalog's contents.** Which components exist is a versioned, additive
  list, and adding one is not an ADR.
- **Cross-User binding.** Sharing an Instance with another User is the shape the
  household and landlord scenarios need. Instances exist so that decision is
  possible; it is not taken here.
- **The marketplace.** Review, pinned artifact hashes and a pull switch are
  named in the scenarios as the direction, and are their own decision.
- **Transactions in practice.** Whether preconditioned batches cover the
  read-modify-write the scenarios need, without Plugins looping on conflicts,
  is settled by a spike before this is built, and it is the one place where the
  single-host decision could be forced back open.

## Amendments to the constitution

- **Plugin** — "code that runs at runtime and was not there at build time:
  Plugins the deployment seeds, Plugins a Bot writes, Applets" loses its third
  member. There are no Applets.
- **Extension points** gain **Stores** — the tables a Plugin declares, their
  Instances, and the binding that decides which Instance a Bot reads — and
  **Surfaces** — what a Plugin renders at a slot, following a Store, drawn by
  the host from its catalogs.
- **Slots** — `sidebar.entries` and `composer.toolbar` join `settings.sections`
  as open. What a slot renders is A2UI, drawn by the host; `ViewDocument`
  remains the settings surface. Trust chrome is still never a slot.
- **Grants** — `stores` joins the list, held by a Plugin that declares tables.
  `storage` stays what it is: a key-value store per Bot per Plugin, with no
  Instances and no binding.
- A Plugin id is `<publisher>/<name>`, and tool names are unique within a
  Plugin rather than within an account.

## Consequences

- `applets/` and `app/applets-host/` fold into the Plugin SDK and
  `app/plugins/`; the build service loses its second kind and keeps its lint
  stage for everything.
- The Applets account feature merges into the Plugins gate. One admin switch.
- The Applets page, canvas and tools are renamed or removed, the e2e specs
  rewritten, and `docs/screenshots/applets/*` regenerated.
- `AppletState`'s facet becomes the Store facet, keyed by User and Store
  Instance rather than by User and Applet.
- The Applet's socket and TanStack DB client survive only to serve migrated
  iframe pages, and retire with them.
- Bots authoring a Plugin get a larger surface to get wrong, so the managed
  Skill grows a Stores and Surfaces section with worked examples.

## Order

1. Stores: descriptor, the Store facet, the async table API and transactions,
   Instances and bindings, kernel scoping. No surfaces yet.
2. The vertical slice: a todo Plugin with one `scope: "bot"` Store, three
   tools, a `tools/post-execute` hook, a composer strip and a sidebar panel —
   authored in conversation, enabled on two Bots, then rebound to one shared
   Instance.
3. Surfaces: the declaration, invalidation and push, the two slots, the phone
   mapping, budgets.
4. Namespaced ids and Plugin-scoped tool names, with the alias path.
5. Migration of live Applets, maintainer, the gate merge, the rename.
6. The catalog components the twelve scenarios need, added one at a time.

Steps 1 to 3 are the architecture. Steps 4 to 6 are the first horizontal
expansion, and everything after them should be too.
