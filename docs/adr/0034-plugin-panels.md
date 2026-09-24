# ADR 0034: Plugins fill the conversation, Applets go

Status: accepted, 2026-09-21. Numbered after ADR 0033. Decisions are Tim's
from the 2026-09-21 discussion; the shapes below are that discussion written
down.

## Context

A Bot customises itself by writing a Plugin. A Plugin already has tools,
per-Bot storage, grants, hooks, cards, and one open slot: `settings.sections`,
a small block on its own Plugins card. The host draws a `ViewDocument`; the
plugin ships no markup ([ADR 0026](0026-plugins.md) step 9).

Beside that sits a second untrusted product: Applets. An Applet is a live
mini-app — its own Durable Object, a SQLite facet, an arbitrary HTML page on
`ui.<host>`, a websocket, fourteen `applet_*` tools, Bot ownership, share and
transfer ([ADR 0027](0027-bot-owned-applets.md)). The User opens it beside the
conversation. ADR 0026 deferred the overlap: "Applets fold into the Plugin
family once Plugins have the slots Applets need."

Two products, two isolates, two authoring loops, two SDKs, for one job: a Bot
puts a surface next to the chat. There are no Users yet, so the Applet runtime
is not something to migrate. The fold is a deletion plus two slots, not a
rename of the facet.

A Plugin already serves every view it declares from one module. `renderView`
already names `botId`. What was missing is a page-sized hole beside the
conversation, a door onto it, a way to switch when several Plugins declare
that hole, and a tool that puts a given surface in front of the person.

## Decision

### Applets are deleted

The Applet product ends. Removed with it: the `applet_*` tools, the managed
`applets` Skill, the `applets` account feature, the directory, `AppletState`
and its Worker Loader, Composition `applets[]`, `send_to_user` type `applet`,
the native canvas / list / chat card, the applet build pipeline and the applet
half of the SDK. Source under `applets/source/`, leftover Durable Object
storage and Composition members are dropped by a receipted cleanup on the User
Durable Object in the same release. A Plugin is the only untrusted code a Bot
writes.

The build service stays. It already builds Plugins. `plugin_*`, the Plugins
page, enablement, approval and the per-User worker are unchanged.

### Two new slots

`PLUGIN_SLOTS_V1` gains `conversation.panel` and `bot.nav`. `sidebar.entries`
never opened and named the wrong place (the Bot list is trust chrome); it is
removed from the vocabulary rather than kept closed.

Open in this deployment:

- `settings.sections` — unchanged: extra block on the Plugin's card.
- `conversation.panel` — the page beside the chat.
- `bot.nav` — a door on _this Bot_, with Settings / Routines / Plugins.

Still closed, until a host region draws them: `composer.toolbar`,
`message.actions`, `bot.profile`. A descriptor naming a closed slot is refused
at resolve, as today.

> Amended 2026-09-24. The Bot list opens to Plugins. Closing all of it was
> blunter than the guarantee needs, and customising the interface around the
> conversation is the point of Plugins. What a person trusts in the list is
> each Bot's name and avatar, the host's status marks (working, waiting for an
> approval, failed) and approvals. A Plugin that cannot fake or hide those may
> draw beside them. Two slots join the vocabulary, closed until the host draws
> them:
>
> - `bot.badge`: a small mark on a Bot's row.
> - `sidebar.sections`: a block in the Bot list, beneath the row of the Bot it
>   belongs to.
>
> The host holds four rules:
>
> 1. **Host-drawn only.** A badge is a count, a label of at most 12 characters
>    or an icon from the host's set, in a tone from the theme. A section uses
>    the section vocabulary and budget: `text`, `group`, `list` and `action`,
>    64 nodes, depth 8. Neither may contain a page
>    ([ADR 0036](0036-plugin-html-surfaces.md)) or an `embed`, because only
>    content the host draws is content the host can stop looking like its own
>    marks.
> 2. **Identity and status keep their places.** The host draws each Bot's
>    name, avatar and status marks where they always are. A Plugin's badge sits
>    after them. Nothing a Plugin sends covers, replaces or reorders them, and
>    the icons and tones offered to Plugins leave out the ones status uses. The
>    order of the Bot list stays the host's.
> 3. **Bot-scoped.** Both render as the Bot whose row they are on, for each
>    Bot that runs the Plugin, as `bot.nav` does. A section carries the
>    Plugin's name in a header it cannot cover. No block belongs to no Bot,
>    because such a block would have no Bot to render as.
> 4. **Capped.** A row shows at most two Plugin badges, and a Bot at most
>    three sections, in mount order. Extras are omitted with a notice on the
>    Plugin's card, as the panel bag's are.
>
> Pressing a badge or a section's control focuses the Plugin's panel, as a
> `bot.nav` press does, or calls one of its tools outside a Turn, as a
> `plugin-tool` action does. Both redraw on the same state-channel notice that
> redraws a panel.

One Plugin may declare views in any mix of the open slots. They run in the
same module, against the same per-Bot storage and the same tools. There is no
second server and no per-surface isolate.

### A view is still a ViewDocument

The plugin returns a tree; the host draws it. No HTML artifact, no iframe, no
websocket, no facet. `conversation.panel` uses the full page vocabulary and
budget (`text`, `group`, `list`, `field`, `action`, `embed` as a host image;
512 nodes, depth 16). `bot.nav` uses the section vocabulary and budget
(`text`, `group`, `list`, `action`; 64 nodes, depth 8) — a row, not a page.
A control's `actionId` names one of the Plugin's tools and runs as
`plugin-tool` does on settings sections: outside a Turn, then the surface is
drawn again.

`PluginViewV1` gains an optional `label` (short, non-empty). The host uses it
on tabs and on a synthesised door; absent, the Plugin's `displayName`. A
Plugin that declares more than one `conversation.panel` view must label each.

### The panel is a bag; the chrome is tabs

`conversation.panel` is many-valued. The bag is every `conversation.panel`
surface on this Bot's enabled Plugins, in Composition mount order, at most
eight. Extra declarations are omitted with a notice on that Plugin's card;
they do not fail the worker. One Plugin with two panel surfaces is two
members, the same as two Plugins with one each.

The host draws one region — the right column on a wide window, a pushed page
on a phone — that is not a sibling of Settings/Routines/Plugins as separate
panel keys. Inside that region: a tab strip (host chrome, never a plugin
tree) and the active surface's document. One tab is visible. The bag is a
set so a later layout can show two without a new slot; this change shows one.

A strip of one tab is omitted. Empty bag: the region is not offered.

### Focus is Session state

The selected tab is a durable pointer on the Bot Durable Object, keyed per
Session, replacing `applets:focused`:

```
{ schemaVersion: 1, pluginId: string, surfaceId: string }
```

Absent or `{ pluginId: null }` means the region is closed. The person clicking
a tab, a `bot.nav` press, and the Bot's `panel_focus` tool write this same
record. The cloud is the authority; a client does not keep a private
selection. Every connected client of that Session paints the same tab. The
projection rides the path the focused Applet used (the shell snapshot / the
open read a running Turn already refreshes), so a tool call during a Turn can
put the page in front of the person before the Turn ends.

If the focused surface leaves the bag (Plugin off, quarantined, dropped from
the cap), the pointer is cleared and the region closes. It does not silently
jump to a neighbour.

### `panel_focus`

A first-party tool in the `frockbot` namespace, not a `plugin_*` authoring
verb. Mounted on a Turn only when this Bot's enabled bag is non-empty, so a
Bot with no panel Plugins is not offered a chrome tool.

```
panel_focus({ pluginId, surfaceId? } | { pluginId: null })
```

`pluginId` plus optional `surfaceId` opens the region and selects that
surface. One panel view on that Plugin: `pluginId` is enough. `pluginId: null`
closes the region. Unknown, disabled, or not a `conversation.panel` view is a
tool error that names the tabs this Bot actually has.

No approval. Showing a tab does not widen authority. Creating or publishing a
Plugin that declares `conversation.panel` does not auto-focus it; the Bot
calls `panel_focus` when it wants the person to look.

### `bot.nav` is the door

Each `bot.nav` view is a row on this Bot's page, in mount order, same cap
as the bag (eight). Pressing a row is `panel_focus` for that Plugin: the
view's optional `opens` (a `surfaceId` of the same Plugin's
`conversation.panel`), else that Plugin's first panel surface in declaration
order. A nav view that opens nothing is still drawn (status) and the press is
ignored.

A Plugin that declares `conversation.panel` and no `bot.nav` still gets a
host-drawn door from `label` / `displayName`. The page is otherwise
unreachable when the region is closed. The host does not let the Plugin draw
the Bot list.

> Amended 2026-09-24. A Plugin still never draws a Bot's row. It may put a
> badge on one or a section beneath it, under the rules in
> [Two new slots](#two-new-slots).

### Bot-scoped, always

`conversation.panel` and `bot.nav` render as the Bot whose page they are on.
`renderView` already carries `botId`; the view `ctx` already names `user`,
`bot`, `session`. Storage is already per Bot per Plugin. `panel_focus` is
that Bot's Session. There is no User-level panel, and a document cannot
claim to be another Bot's: the host knows which Bot asked.

The Plugin worker remains one per User. Identity is per call, not a global
"current Bot" inside the isolate. Filtering another Bot's rows is a Plugin
that chose User-scoped data; the default storage pile is already this Bot's.

### What a Plugin does not get from Applets

No instance directory, no share/transfer, no owner Bot, no per-instance
Durable Object, no live TanStack sync. One install, enable per Bot, one
storage pile per Bot. A second "app" is a second Plugin. Rich in-thread UI
stays Cards ([ADR 0030](0030-a2ui-cards.md)), not an applet chat card.

## Amendments to the constitution

- **Slots** name `conversation.panel` and `bot.nav` beside the three that
  stay closed and `settings.sections`. Trust chrome is still never a slot.
  `sidebar.entries` leaves the list.

  > Amended 2026-09-24. **Slots** also name `bot.badge` and
  > `sidebar.sections`, closed until the host draws them. In the Bot list,
  > trust chrome is each Bot's name, avatar and status marks. A Plugin draws
  > beside them and never over them.

- **Extension points** do not gain a new kind. These are slots, not a second
  untrusted runtime.
- **Untrusted code gets an isolate** drops the Applet sentence. Only the
  Plugin worker remains.
- **Account feature** `applets` is deleted. Plugin authoring is unchanged.
- CONTEXT terms Applet, Owner Bot, Shared Bot, Applet access, Transfer,
  Applet availability, Applet impact, Instance Contribution, Applet
  generation, Focused Applet, Applets SDK go. Canvas becomes the host region
  that holds the panel tabs. Panel focus is the Session pointer above.

## Consequences

- `OPEN_PLUGIN_SLOTS_V1` becomes
  `settings.sections | conversation.panel | bot.nav`.
- Native shell: one panel region with a host tab strip; Bot page grows nav
  rows; `lib/applets/` and the full-window applet path go.
- `apps/applet-build` keeps Plugin mode and loses Applet mode. Bindings
  `APPLET_STATES` and the Applets loader go with the cleanup.
- [ADR 0025](0025-applet-open-path.md) and [ADR 0027](0027-bot-owned-applets.md)
  describe a product that no longer exists; they stay as history. This
  document is what to build.
- `docs/architecture.md` §9 is rewritten when the host lands, not before.

## Order

Each step leaves `main` shippable.

1. This document, the terms in `CONTEXT.md`, the slot list in `AGENTS.md`.
2. Descriptor and worker host: the two names, drop `sidebar.entries`, optional
   `label` / `opens`, open-slot tests only.
3. Delete Applets. Receipted cleanup of directory, `AppletState`, source,
   Composition `applets[]`, focused pointer. Native surfaces and the account
   feature go in the same cut. A fresh conversation is verified.
4. Host: the bag, the two render paths, the Session pointer, `panel_focus`,
   the client command, the projection a running Turn already refreshes.
5. Native: tab strip, nav rows, the panel region in the right column / phone
   push. Browser suite.
6. Managed `plugins` Skill: how to declare the two slots and when to call
   `panel_focus`.
