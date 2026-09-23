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

Drawing a Card reaches no network. The renderer validates a surface against
the catalog's schemas, and the schema stack resolves the `$schema` that would
otherwise be fetched: the draft 2020-12 meta-schema, which sits in
`apps/native/lib/cards/schema_documents.g.dart` — lifted from ajv, the same
document set the deployment's validator uses — and is answered by the client
the renderer's intake is run with (`cards/schema_client.dart`). That client
refuses every other schema URI without a request, because a schema this build
does not carry is one it cannot validate against: the catalog is compiled in,
and a Card never makes the app fetch a schema of its own choosing.

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

   > Built 2026-09-17, step 6. The descriptor's `cards` entry names no
   > surface, against "A Plugin, pre-configured" above: an entry is
   > `{id, displayName, description, dataSchema, actions}` and the
   > components are what `renderCard` answers with, because a Plugin's
   > surface depends on the values it was drawn with — the email card's
   > `Receipt` is not its draft. `renderCard` and `cardAction` answer
   > `rendered`/`drop` rather than the task's `ok`/`refused`, to match the
   > view and trigger results already on the Plugin worker contract. A card
   > action name is unique per Plugin rather than per card, because the wire
   > namespace `plugin/<pluginId>/<action>` carries no card, so the wrapper
   > finds the card by the action it declares. A seeded Plugin's artifact
   > travels in the Worker bundle
   > (`app/plugins/seeded/artifacts.generated.ts`, module text included)
   > because a seeded artifact has no publisher to put it in R2, and is read
   > back through the same content address by
   > `createR2PackageArtifactStore`. Sending is a kernel loopback —
   > `ctx.email` to `isolateEmail` to `app/email/sender.ts` — attributed to
   > the Bot and holding no credential the Plugin can see, and inert until a
   > deployment binds `SEND_EMAIL` and `EMAIL_SENDER_ADDRESS`. An Approval a
   > Card asks for is bound to what it authorizes: `renderCard` answers with
   > `covers` — the canonical values the Plugin drew and will act on — beside
   > its messages, and the kernel records the Plugin, the surface and a digest
   > of _those_ beside the Approval ids. It is the Plugin's word and not the
   > model's because a Plugin need not draw its input: the email card redraws
   > the draft it holds, so binding the tool input would bind values nobody
   > saw. A draw that asks for a decision and declares no `covers` is refused.
   > The ids themselves are derived from the Session and the effect that
   > records the send rather than minted, so a replayed tool call recomputes
   > them, the send dedupe makes the ask a no-op and the binding it rewrites
   > is the one that was already there; the Session is in the derivation
   > because an effect id is unique only inside one while card and Approval
   > records are Bot-wide. The wording an Approval is recorded with — its
   > action, risk and rationale — is declared on the render result's
   > `decision` rather than on the `ApprovalActions` component, because the
   > committed Frock catalog allows that component only `approvalId`,
   > `approveLabel` and `declineLabel`; the component carries the buttons and
   > the kernel-minted id, and the words come from the result beside it.
   > `isolateEmail` refuses a decision that is not the one bound to this send,
   > and a redraw of a pending draft reuses that decision rather than minting
   > a second over one draft.

7. The five first-party cards as locked Plugins; the old members mapped, then
   removed a release later.

   > Built 2026-09-18, step 7. Five locked seeded Plugins, one card each:
   > `approvals`/`decision` for `approval`, `questions`/`ask` for `widget`,
   > `attachments`/`file` for `attachment`, `credentials`/`request` for
   > `secret-request`, `agents`/`note` for `agent-card`. Each declares no tool
   > of its own, holds no grant, and ships no Skill — `send_to_user` already
   > tells the Bot what these five are, and a Skill each would be five entries
   > in every prompt repeating it, so `scripts/build-seeded-plugins.ts` makes
   > `skill.md` optional and `SKILL_CATALOG_CAPS_V1.managed` stays at 12 as
   > headroom rather than as a count.
   >
   > **The send is still the kernel's; only its face moved.** The payload is
   > recorded on the Turn's log exactly as before, because that log is where
   > `approvalTerminalRecordsV1` mints the Approval, where a Machine command
   > and a Plugin intent find the id they are keyed by, where `delivery.ts`
   > decides the Turn is over and where a notification finds its words. The
   > Card is drawn beside it. So an `approval` maps with
   > `PluginCardSendV1.approvalIds` — the kernel's own list — and
   > `bindCardApprovalsV1` binds the surface's `ApprovalActions` to the
   > `approvalId` the Bot chose rather than minting a second decision over one
   > question; a draw that carries kernel ids asks for no Approval of its own
   > and records no binding, because the decision is already on the log. Every
   > other draw mints, exactly as a User's Plugin does.
   >
   > **The seam.** `app/shell/first-party-cards.ts` maps a payload to a draw
   > and decides nothing else; `AgentRuntimeV1.firstPartyCards` is how it is
   > reached — set by the Plugin host when it mounts a generation
   > (`createShellCompositionHost`), read by the Shell's send, the way
   > `credentials` is set by the feature that owns it. Four places record one
   > of the five and all four call it: `send_to_user`, the Plugin-authoring
   > ask, the Machine command ask and the Bot-template card. The draw itself
   > is `ActivePluginWorker.drawCard`, which is the card tool's own body
   > extracted — same schema check, same minted surface, same `renderCard`,
   > same `sendCard` — so first-party is not a shorter path by a single line.
   >
   > One thing the live Turn found: the card send has to carry its **own
   > occurrence**. `recordSendToUserV1` dedupes a send by its occurrence id, so
   > a card recorded under the tool call's effect id is the _same send_ as the
   > payload and the second of the two is dropped in silence — the approval
   > landed and no card ever folded. The draw now runs under
   > `<effectId>:card`, derived rather than minted so a replayed call
   > recomputes the same occurrence, the same surface and the same ids.
   >
   > **What the client lost.** `apps/native/lib/shell/send_payload.dart` drew
   > each of the five with a widget of its own; all five are gone, along with
   > `_Card`, `_Widget`, `_Attachment`, `_Approval` and `_SecretRequest`, and
   > the `approvals` and `onOpenSettings` parameter chains behind them
   > (`transcript.dart`, `chat_pane.dart`, `app_shell.dart`). They draw
   > _nothing_ now rather than "this client cannot display that message", and
   > `transcript.dart` skips them before it builds a bubble, so a send whose
   > face is a Card leaves no empty one behind. That is the duplication step 5
   > reported, removed: the screenshots show one card per send.
   >
   > Two things moved rather than died. `ApprovalsController` is now
   > `apps/native/lib/shell/approvals.dart` and reaches the catalog through
   > `CardApprovalsScope`, because an Approval settles without its surface
   > moving — somebody answers on another device, or the alarm expires it — so
   > `ApprovalActions` draws "You approved this." from the Bot's own approvals
   > projection rather than leaving a live-looking button over a decision that
   > is already recorded, and re-reads it after a press the kernel routed to an
   > Approval. And `ShellIds.approve`/`deny` moved onto the catalog component's
   > two buttons, so the accessibility tree and `plugins-publish.e2e.ts` name
   > the same controls they always did.
   >
   > **Three deviations, taken deliberately.** A draw that could not happen
   > writes _nothing_: no plain line beside the send. A `send_to_user` text
   > payload is conversation and goes into the Bot's own history, so a fallback
   > line would come back to the model as a second message saying what it just
   > asked — two records of one send, which is the thing this step removes.
   > Every environment binds the Plugin worker loader, and a locked Plugin that
   > cannot mount is an outage the decision above already accepts. Second, the
   > credential card has no "Open Settings" button: no catalog component opens
   > an in-app route — a card's only link handling is the host's external
   > opener, which admits `https` and nothing else — so the card names the door
   > in words, and a host-drawn settings component is the follow-up rather than
   > a button that does nothing. Third, the question card _answers_: the old
   > bubble drew its options as dead pills and left the person to type one
   > back, and `ChoiceChips` raising a conversation action is what the decision
   > above already calls "what a `widget` answer is today". A one-option
   > question is a `Button` rather than a chip row, because `ChoiceChips` holds
   > two or more.
   >
   > **The live Turn.** Local `development` stack (`bun scripts/native-dev.ts
serve`), the platform model over the remote Workers AI binding. Asked
   > for an approval to delete the staging bucket, then for a report as an
   > attachment. Both folded at revision 1 with no refusal —
   > `approvals_decision.…` as `Column`, `CardHeader`, `Markdown`,
   > `ApprovalActions`, and `attachments_file.…` as `Column`, `FileAttachment`
   > — and the transcript shows one bubble per send at 412 and 1440
   > (`docs/screenshots/cards/first-party-phone.png`,
   > `first-party-desktop.png`). The Plugins panel listed all five as
   > first-party and Always on with no switch; since 2026-09-23 it leaves them
   > out, because a row with nothing to switch is not something a person can
   > use ([ADR 0026](0026-plugins.md)).

8. The rest of the Frock catalog, family by family, each with its reference.

   > Built 2026-09-18, step 8. Eighteen components in five families, on top of
   > step 4's five: **structure** — `CardHeader`, `SectionHeader`, `Callout`,
   > `IdentityRow`; **data** — `MetricTile`, `ProgressBar`, `DataTable`,
   > `Timeline`; **rich text** — `Markdown`, `CodeBlock`, `Quote`; **media** —
   > `ImageGallery`, `FileAttachment`, `LinkPreview`; **input** —
   > `ChoiceChips`, `MultiSelect`, `SegmentedControl`, `Rating`. Each family is
   > one file of schemas under `frock_catalog/schemas/`, one file of widgets
   > beside it, one reference generated from the first, and one commit; the
   > generator reads the directory rather than a single constant and refuses a
   > component two families declare.
   >
   > **The layout is the host's, not the prose's.** Step 5 closed its pill
   > overflow by telling the model how to write the `Row`. That fixes the next
   > Turn. `CardHeader` fixes every Turn: it lays out the title, the quiet line
   > and the state pill itself, and there is nothing left for a card to get
   > wrong. Underneath it, three things changed so that a card written before
   > this step still cannot overflow — `StatusPill` is implicitly flexible and
   > ellipsizes on one line, `Receipt`'s pill gives way before the card's edge
   > does, and the standard catalog's `Text` is re-registered as implicitly
   > flexible, because `genui`'s `Row` lays an inflexible child out at its
   > natural width and pushes its sibling clean off the card.
   >
   > The same argument reaches every component, not just the pill. `genui`
   > wraps a flex child in a `Flexible` only when the model wrote a `weight`
   > on it, and a child it does not wrap is laid out at unbounded width — which
   > a component holding an `Expanded`, a stretched `Column` or a scroller does
   > not survive. An `ImageGallery` beside something in a `Row`, a composition
   > the Skill invites, would have failed to draw at all. So every Frock
   > component is registered as implicitly flexible, in one place, and
   > `ApprovalActions` and `Rating` wrap their controls rather than overflow
   > them: `cards_row_test.dart` draws all twenty-three inside a `Row` at
   > phone width and fails when a component is added that it does not cover.
   >
   > Two smaller seams moved with the families. `admitCardV1` asks the
   > https-only question of every literal link a component carries at any
   > depth — `url`, `imageUrl`, the ones inside a gallery's rows — rather than
   > of one top-level property; and opening a link is one host function
   > (`frock_catalog/links.dart`), which checks the scheme again at the moment
   > of opening, because a link can arrive through the data model and
   > admission never sees that.
   >
   > **The open cost from step 4 is closed.** `chat_card.dart` said a notice
   > arriving mid-typing cost the person what they had typed, and named the
   > next catalog family as where to do it properly. Adopting a record still
   > rebuilds the surface — one settle path, as before — but when the record's
   > own data model has not moved, the model the old renderer held is this
   > person's half-finished answer and is handed to the new one. A card with
   > `ChoiceChips` and a `MultiSelect` on it is answered over several seconds,
   > and a notice about something else must not empty it.
   >
   > **The live Turn.** Local `development` stack (`bun scripts/native-dev.ts
serve`), the platform model over the remote Workers AI binding, asked for
   > "a card summarising September invoices: a header with a status, two
   > metric tiles, a table of the line items, a callout warning, and a
   > multi-select of who to chase with a button to send the reminders". The
   > Bot loaded `managed/a2ui`, then `frock.md`, `structure.md`, `data.md` and
   > `input.md`, and sent one `card`: thirteen components — `CardHeader`, a
   > `Row` of two `MetricTile`s, two `SectionHeader`s, a `DataTable`, a
   > `Callout`, a `MultiSelect` and a `Button` — folded at revision 1 with no
   > refusal, `sendDataModel: true`, and two clients pre-ticked in the data
   > model. Nothing had to be repaired to make a card at all.
   >
   > What the phone screenshot showed was a real defect, and it is fixed
   > rather than written around: the model wrote four columns at 412 logical
   > pixels, and sharing the width between them squeezed "INV-0912" into a
   > mid-word wrap. A column narrower than a short value is not a column, so a
   > `DataTable` now claims a floor per column and becomes one horizontal
   > scroller when the card cannot give it — the transcript scrolls the other
   > way, so the two never fight over a drag — and `data.md` says three
   > columns is what fits a phone. `docs/screenshots/cards/card-report-phone.png`
   > and `card-report-desktop.png` are the card after that fix, at 412 and 1440.
