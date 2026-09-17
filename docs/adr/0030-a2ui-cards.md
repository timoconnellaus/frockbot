# ADR 0030: Cards are A2UI

Status: proposed, 2026-09-17. Numbered after ADR 0029 (PR #537); nothing on
`main` or in an open pull request holds 0030. Decisions are Tim's from the
2026-09-17 discussion; the shapes below are the proposal that discussion asked
for.

## Context

A Bot that drafts an email has to show the draft — who it is to, who is
copied, the subject, the body — and offer one control that sends it and one
that discards it. When the email is sent the card is not gone; it settles into
a one-line receipt, "Sent to nick@… — Re: Following up", with the same title
and a green pill where the "Ready to send" pill was. Every other rich thing a
Bot wants to put in the conversation has the same shape: a thing, some
controls, a settled state.

Today the conversation has exactly one rich vocabulary, the `send_to_user`
payload union in `core/contracts/send-to-user.ts`: `text`, `attachment`,
`widget`, `approval`, `secret-request`, `agent-card` and `applet`, each drawn
by its own Flutter widget in `apps/native/lib/shell/send_payload.dart`. Adding
the email card that way means a new union member, a new decoder, a new widget,
and a release. A Plugin cannot add one at all.

FrockBot has been here before. Step 9 of the client work vendored A2UI 0.9.1
(`genui`, `a2ui_core`) for a qualification form, nothing used it, and PR #332
(2026-09-07) deleted it in favour of `ViewDocument` — six node types the host
draws, with budgets, for settings pages and the one open Plugin slot. That was
the right call for settings, where the host owns the layout. It is not a
vocabulary a Bot can write a card in.

A2UI is now at a v1.0 release candidate. The facts that matter here, from the
specification and the catalog documentation:

- A surface is an adjacency list of components with `id`s, a data model, and
  JSON-Pointer binding between them. The agent sends `createSurface`,
  `updateComponents`, `updateDataModel` and `deleteSurface`; the renderer
  sends `action`, `callAgentFunction`, `rendererFunctionResponse` and `error`.
  Layout and values travel separately, so a card can be a fixed layout whose
  values change.
- A catalog is JSON Schema only, "known to the agent and client beforehand (at
  compile/deploy time)", standalone, with no reference to any external file.
  Implementations are host code. The protocol's security model is that
  sentence: declarative data, no code, nothing renders that the host did not
  compile in.
- The standard catalog is eighteen components — Text, Image, Icon, Video,
  AudioPlayer, Row, Column, List, Card, Tabs, Divider, Modal, Button, CheckBox,
  TextField, DateTimeInput, ChoicePicker, Slider — and a small set of
  formatting and validation functions. Catalogs mix on one surface in v1.0.
- Google's Flutter renderer is `genui` (0.10.3 on pub.dev at the time of
  writing) with `a2ui_core`; a host adds a component as a `CatalogItem` with a
  name, a data schema and a widget builder.

Two directions were weighed and set aside in the discussion. A web renderer in
the sandboxed `HostFrame` would let a Plugin ship JavaScript components, but
under the catalog rule a Plugin can only compose what the host compiled in,
so web buys nothing and costs a WebView per card in a thread where cards do
not tear down. And a plugin-rendered card format of FrockBot's own would be a
second declarative UI beside A2UI for no reason A2UI does not already cover.

## Decision

### Cards are A2UI 1.0 surfaces, drawn by the Flutter renderer

A **Card** is one A2UI surface in the conversation. The client draws it with
the `genui` renderer as native widgets inside the transcript, on the phone and
in the browser build alike, from two catalogs compiled into the app: the A2UI
standard catalog and the **Frock catalog**, FrockBot's own, which is larger
than the standard one on purpose. The Frock catalog is Dart in `apps/native`,
themed from the app's tokens, and its schema is generated from the same source
so the model and the renderer cannot disagree about it.

A Card never carries code. The renderer draws catalog components and nothing
else; a surface naming an unknown component is refused whole, the way a
`ViewDocument` past its budget is today.

### One payload, two authors

`send_to_user` gains one member:

```ts
{ type: "card"; surfaceId: string; messages: A2uiAgentMessageV1[] }
```

The messages are the surface's own protocol — `createSurface`,
`updateComponents`, `updateDataModel`, `deleteSurface` — bounded and decoded at
the seam like every other payload. The Bot Durable Object folds them into the
Card's durable record on the Session (`card:<surfaceId>`: the component set,
the data model, the revision) so a client that reconnects reads the current
surface over REST and never replays a stream. A later `card` send naming the
same `surfaceId` updates the Card in place; the transcript keeps it where it
was, as Applet cards are kept today. Cards do not tear down. A settled card is
a card whose data model says so.

Two things author a Card:

- **The Bot**, bespoke, when nothing pre-made fits. It writes the components
  and the data model itself, from the catalog the A2UI Skill teaches it. This
  is A2UI used as intended.
- **A Plugin**, pre-configured. The descriptor's `cards` entry names a fixed
  surface — the components — and a data-model schema; the Bot sends the
  values and the Plugin worker's `renderCard` returns the messages. The email
  card is this kind: the model emits `{to, cc, subject, inReplyTo, body}` and
  the card looks the same every time. A Plugin card costs the model the
  values, not the layout.

Nothing distinguishes the two on the wire or in the client. A Plugin card is a
Bot card whose messages a Plugin wrote.

### Actions go to the kernel, and the kernel decides what they mean

A renderer `action` — `{ event: { name, context } }` plus the surface's data
model when the surface asks for it — is posted by the client to the Bot
Durable Object against the Card's `surfaceId` and revision. The kernel routes
it by the action's name:

- **`approval/<approvalId>`** is a decision. It is recorded exactly as an
  Approval is recorded today (`app/approvals/bot.ts`, `decideApproval`):
  durable, once, with its expiry, ending the Turn that asked. The Card is the
  face of the Approval; the Approval is not in the Card. A Card cannot mint an
  `approvalId` the kernel did not record when the Bot proposed the action.
- **`plugin/<pluginId>/<action>`** is a Plugin handler, called by RPC on the
  Plugin worker with the Bot's authority for that Turn, the way a Plugin tool
  is called. The handler answers with messages that update the Card, so
  "Regenerate" or "Show more" costs no Turn. A handler that throws or overruns
  is skipped and the failure counts toward the Plugin's quarantine, as a hook
  failure does.
- **Anything else** is conversation input: the event name and context are the
  Bot's next user-lane Turn's pending input, never delivered as something the
  User said. This is what a `widget` answer is today.

A `callAgentFunction` from the renderer is the second kind with a reply, and
maps to the same Plugin handler path. `callRendererFunction` is not carried:
the kernel never asks the client to compute anything.

### The first-party cards are Plugins

`approval`, `widget`, `attachment`, `secret-request` and `agent-card` are
rebuilt as A2UI Cards, each a **locked** seeded Plugin in
`DEPLOYMENT_PLUGIN_CATALOG_V1`, so the deployment ships its own cards the way
a User's Bot would ship one, and the catalog stops being empty (known issue
16). Their `send_to_user` members stay accepted for one release and are
mapped to the Plugin card at the seam, then removed under the disposable-state
rule; `text` and `applet` stay as they are.

What does not move into a Plugin is the meaning. An approval decision is
kernel state; a secret's value goes from the client to a Connection write and
is never in a data model the agent can read back; the receipt of a send is
written by the kernel. A locked Plugin composes the face of those things from
catalog components the kernel binds — `ApprovalActions` bound to an
`approvalId` the kernel issued, `SecretField` whose value the renderer routes
to the secret door — and a User's Plugin composing the same components gets
the same binding, because the component is host code and the id is the
kernel's. Trust chrome is still never a slot; it is a component only the host
draws.

### The catalog is a Skill, not a prompt section

A rich catalog in every prompt is thousands of tokens a Turn that draws no
card. The catalog is therefore a managed Skill, `managed/a2ui`, listed in
`<agent_skills>` by name and description like every Skill and loaded when the
Bot decides to draw a card. Its `SKILL.md` carries the message model, the
binding rules, the action names the kernel owns, and a one-line index of its
references; `references/` carries the catalog split by family — layout, text
and media, forms, actions, data display, the Frock components — each loaded
on its own.

That needs the Skill system to know a second level. Today a Skill is one
`SKILL.md` of at most 64 KiB, the catalog sees no other file in its
directory, and `skill_load` returns one whole body. The change:

1. **A Skill is a directory.** `LoadedSkillV1` gains `references`, the
   Markdown files under `skills/<slug>/references/` — at most 32, each at most
   64 KiB — listed by the same `WorkspaceReadsV1` the `SKILL.md` came through
   and loaded under the same rule: same directory, same writer, same
   authority, so `isLoadableSkillSourceV1` has nothing new to decide. A
   managed Skill's `ManagedSkillDocumentV1` gains `references: {path, text}[]`
   and `scripts/build-applets-assets.ts` reads a directory where it read a
   file.
2. **`skill_load` takes `reference`.** `{ path: "managed/a2ui", reference:
"forms.md" }` returns that one file; only references of a Skill loaded for
   this Turn, everything else the existing refusal. `skill/injected` lists the
   references each Skill offered with their generations, so a reference that
   was not there is visible in durable state.
3. **`skill_write` accepts a reference path** inside the Skill's own
   directory, under the same quota and provenance, so a Bot can author a
   multi-file Skill for itself or its User.
4. **Plugins contribute Skills.** `PluginDescriptorV1` gains `skills`, bundled
   in the artifact like managed ones; the ref `plugin/<pluginId>/<slug>` that
   `skill_load`'s help text already promises becomes a fourth
   `SKILL_REF_SOURCES_V1` entry, offered only to a Bot with that Plugin on. A
   Plugin that ships a card ships the Skill that says when to use it.

The index of references is a convention of the `SKILL.md` body, as it is in
the harnesses this format was borrowed from; the loader does not invent a
frontmatter for it.

### Budgets and trust

A Card is untrusted content whichever author wrote it. The seam bounds it:
components per surface, bytes per message, surfaces per Session, actions per
surface, and the size of a data model. A surface past a budget is refused
whole. Images load over https only; `openUrl` opens through the host's own
link handling, never directly. No Plugin ships client code, on any renderer,
and the ADR that changes that is not this one.

### `ViewDocument` stays where it is

Settings pages and the `settings.sections` slot keep `ViewDocument`. It is the
host's layout with a Plugin's values in it, which is a different thing from a
Card, and nothing in this decision needs the two to be one. Whether the slots
fold into A2UI is a later decision, taken when a slot needs something
`ViewDocument` does not have.

## Amendments to the constitution

- **Extension points** gain `cards` and `skills` on the Plugin descriptor, and
  the Card action namespace — `approval/`, `plugin/`, and conversation input —
  as the shape of what a Card may ask.
- **Skills** — "a Skill is an instruction file" becomes "a Skill is a
  directory: one `SKILL.md` and the references beside it, loaded under one
  authority".
- **Slots** — unchanged. A Card is not a slot; it is a send. "Trust chrome is
  never a slot" gains its Card form: trust chrome is a catalog component only
  the host draws, bound to an id only the kernel issues.

## Consequences

- `send_to_user` gains `card`; five members are mapped to Plugin cards for one
  release and then removed. `SEND_TO_USER_LIMITS_V1` gains the Card budgets.
- The Session gains `card:<surfaceId>` records and a Card read route; the
  state channel's invalidation notices cover them.
- `apps/native` regains `genui` and `a2ui_core`, this time with a caller. The
  Frock catalog is a Dart package under `apps/native/lib/cards/` and a
  generated schema under `core/protocol-schemas`, gated like the client wire.
  Whether `genui` 0.10.x speaks the 1.0 release candidate or 0.9.1 is checked
  at step 1; if it lags, the seam decodes 1.0 and the renderer is fed what it
  speaks until it catches up, and the Frock catalog never depends on the
  difference.

  > Built 2026-09-17, step 1. It lags, and by one version more than the bullet
  > assumed. `genui` is 0.10.3 on pub.dev (published 2026-09-12) and depends on
  > `a2ui_core` `^0.1.0`; the published `a2ui_core` is 0.1.1 (2026-08-14). Both
  > speak **v0.9** — not v0.9.1, and not the v1.0 candidate.
  > `A2uiMessage.fromJson` in `a2ui_core/lib/src/core/messages.dart` refuses any
  > envelope whose `version` is not the literal `v0.9`, and 0.10.3's changelog
  > points `basicCatalogId` at
  > `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`. The
  > specification's own version table calls v0.9.1 the current production
  > release and v1.0 a candidate that adds client-to-server RPC
  > (`actionResponse`), action ids, and renames `theme` to `surfaceProperties`.
  >
  > The four agent-to-client names the decision uses are safe: `createSurface`,
  > `updateComponents`, `updateDataModel` and `deleteSurface` are v0.9 names
  > that v1.0 keeps, and `a2ui_core` decodes exactly those four keys into
  > `CreateSurfaceMessage`, `UpdateComponentsMessage`, `UpdateDataModelMessage`
  > and `DeleteSurfaceMessage`. Two details of the shape are v0.9's, not 1.0's:
  > `createSurface` carries `theme`, which 1.0 renames, and the envelope carries
  > `version: "v0.9"`.
  >
  > The renderer-to-agent side is thinner than the decision assumes. `action` is
  > there — `genui` sends `{ version: "v0.9", action: … }` from
  > `surface_controller.dart`, from the `event` a component's `action` property
  > names, as `A2uiClientAction` with the action's `name`, the surface, the
  > component that raised it and its context — so the action route and its three
  > kinds work on what ships today, and `A2uiClientError` carries a refusal
  > back. What is absent is `callAgentFunction`: it exists in the 1.0
  > specification and nowhere in the Dart, so the Card's one action kind with a
  > reply is the part the seam carries itself until the renderer catches up.
  > What the bullet already says is what happens: the seam decodes 1.0, the
  > renderer is fed what it speaks, and the Frock catalog never depends on the
  > difference.
  >
  > The SDK floors clear ours with room: `genui` asks Dart `>=3.10.0 <4.0.0`
  > and Flutter `>=3.35.7`, `a2ui_core` asks Dart `>=3.10.0 <4.0.0`, and
  > `apps/native/pubspec.yaml` pins Dart `>=3.13.0 <3.14.0` on Flutter
  > `3.47.0`.
  >
  > Relied on: <https://pub.dev/packages/genui/changelog>,
  > <https://pub.dev/packages/a2ui_core/changelog>, <https://a2ui.org/>,
  > <https://github.com/flutter/genui/tree/main/packages/genui>,
  > <https://github.com/a2ui-project/a2ui/tree/main/dart/a2ui_core>; the Dart
  > quoted above is from the published `genui` 0.10.3 and `a2ui_core` 0.1.1
  > archives.

- `PluginDescriptorV1` gains `cards` and `skills`; the Plugin worker gains
  `renderCard` and `cardAction`; the seeded catalog gains five locked entries.
- The Skills Package gains directories, `reference`, reference writes and the
  `plugin` source. `SKILL_CATALOG_CAPS_V1.managed` rises from 8: `a2ui` is the
  seventh managed Skill and the five card Plugins may bring their own.
- `docs/architecture.md` §6 gains the Card renderer; §5 the two descriptor
  fields; the parity register's `send_to_user` rows (57b, 57c) are annotated.

## Order

Each step leaves `main` shippable and is merged when green.

1. This document, the terms in `CONTEXT.md`, the amendments to `AGENTS.md`;
   the `genui` version check recorded here as a **Built** note.
2. Skills: directories, `reference`, reference writes, the `plugin` source.
   Independent of everything else and useful on its own.
3. The `card` payload, its decoder and budgets, the Session record and read
   route, the action route and the three action kinds. No renderer yet; the
   client draws a placeholder naming the surface.
4. The renderer: `genui` in `apps/native`, the standard catalog, the Frock
   catalog's first family, the generated schema and its gate. Screenshots of
   a Bot-authored card on the phone and the browser build are the evidence.
5. The `managed/a2ui` Skill with its references; a Bot draws a bespoke card
   from it in a real conversation.

   > Built 2026-09-17, step 5. `managed/a2ui` is the seventh managed Skill,
   > authored at `app/cards/skills/a2ui/` as a directory the step-2 generator
   > compiles. Its six references — `layout.md`, `text-and-media.md`,
   > `forms.md`, `actions.md`, `frock.md`, `examples.md` — have their
   > per-component tables and minimal examples _generated_ from the two
   > committed catalogs by `scripts/generate-a2ui-skill.ts`, which stitches
   > hand-written prose from `templates/`; it fails on a catalog component no
   > reference documents, on one documented twice, on an index in `SKILL.md`
   > that has stopped matching, and on a reference past 64 KiB, and
   > `bun run typecheck` runs it with `--check`.
   > `SKILL_CATALOG_CAPS_V1.managed` rose from 8 to 12 — the seven, plus the
   > Skill each of the five card Plugins may bring.
   >
   > One seam gap step 4 reported is closed: `a2uiActionCountV1` counted only
   > 1.0's `action.name`, while the shipping renderer raises a press from
   > v0.9's `action.event.name`, so the seam would have admitted surfaces
   > `admitCardV1` refuses. It now counts both.
   >
   > **The live Turn.** Local `development` stack (`bun scripts/native-dev.ts
serve`), the platform model over the remote Workers AI binding, asked
   > "show me a draft reply to nick@example.com about the retainer as a card I
   > can approve". The Bot loaded `managed/a2ui` and three of its references —
   > `frock.md`, `forms.md`, `actions.md` — then sent one `card` and, in the
   > same reply, the `approval` whose id its `ApprovalActions` names. Seven
   > components: a `Column` at `root`, a `Row` of `Text` and `StatusPill`,
   > `KeyValueRows` for To and Subject, a long-text `TextField` bound to
   > `/body`, and `ApprovalActions` on `appr-nick-retainer`, with
   > `sendDataModel: true`. The record folded at revision 1 with no refusal,
   > and the card drew on the browser build at phone and desktop widths
   > (`docs/screenshots/cards/`).
   >
   > Nothing was refused, so nothing in the Skill had to be repaired to make a
   > card at all. One thing the screenshots showed was fixed anyway: the model
   > wrote the title-and-pill `Row` with the default `justify`, and at phone
   > width the pill ran past the card's edge
   > (`card-draft-phone-before-layout-note.png`). `frock.md` now says to write
   > that `Row` with `"justify": "spaceBetween"` and `"weight": 1` on the
   > title, and `examples.md` shows it. A second Turn, on a second Bot loading
   > the Skill fresh, wrote exactly that — and reached for `CollapsibleText`
   > rather than a `TextField` for the body, which is what `frock.md` says the
   > component is for. That card is `card-draft-phone.png` and
   > `card-draft-desktop.png`; the pill sits inside the card.
   >
   > What the screenshots also show is the duplication step 7 exists to
   > remove: the `approval` send draws its own bubble under the card, so the
   > same decision is offered twice. That is the old member still being
   > accepted, exactly as the decision says it is for one release.

6. Descriptor `cards` and `skills`, `renderCard` and `cardAction` on the
   Plugin worker, `plugin/` actions. The email card as the first seeded
   Plugin, sending through a Connection.
7. The five first-party cards as locked Plugins; the old members mapped, then
   removed a release later.
8. The rest of the Frock catalog, family by family, each with its reference.
