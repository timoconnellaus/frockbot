# ADR 0036: A Plugin may draw a surface in HTML

Status: proposed, 2026-09-24. Numbered after ADR 0035; nothing on `main` or in
an open pull request holds 0036. Decisions are Tim's from the 2026-09-24
discussion: HTML is the fallback when the host's vocabulary cannot express a
surface, it is allowed in conversation panels and in Cards, and a page reaches
the device only through abilities the User approved
([ADR 0035](0035-device-bridge.md)). The shapes below are the proposal that
discussion asked for.

## Context

[ADR 0034](0034-plugin-panels.md) made every Plugin surface host-drawn: "No
HTML artifact, no iframe, no websocket, no facet." [ADR 0030](0030-a2ui-cards.md)
said the same of Cards: "No Plugin ships client code, on any renderer, and the
ADR that changes that is not this one." This is that ADR.

The host vocabulary covers forms, lists, status and Cards. It cannot cover a
surface whose point is its own drawing or interaction:

1. **A guitar tuner.** It hears the microphone and redraws a needle many times a
   second, and the audio never leaves the device.
2. **Scan into the Bot.** A camera view in a panel captures a receipt and hands
   the image to the Bot.
3. **A custom interactive board.** A chess board or whiteboard the person drags
   on. The state lives in the Plugin's storage, and the Bot can move too.
4. **A live location map.** A map follows where the phone is.
5. **Any of these as a Card** in the conversation, such as the board inline in
   the thread.

None of these can be a `ViewDocument`. A press there is a round trip to the
cloud, and the host has no canvas, audio or camera node. Adding one per idea is
the growth the catalog exists to prevent. HTML was always meant to be the
fallback, and the marketing page already says so ("HTML is the intended option
for a custom web interface"). The written decisions did not.

Most of what this needs survived the Applet deletion:

- **The artifact origin.** `servePackageUiArtifact` (`apps/cloudflare/src/gateway.ts`)
  serves `ui.<host>/packages/<sha256>.html`: content-addressed, hash-checked,
  immutable, with `default-src 'none'`.
- **The frame.** `HostFrameView` (`apps/native/lib/view/host_frame*.dart`) is a
  `sandbox="allow-scripts"` credentialless iframe on the web and a hardened
  WebView on a phone. The WebView refuses every permission request and
  navigates to exactly one URL.
- **The bridge.** `PackagePageFrame` (`apps/native/lib/packages/frame.dart`) is
  what first-party package pages and the Computer viewer speak. It has a
  versioned `hello`, `resize`, `focus`, `openExternal` and a `callTool` gated by
  what the contribution declared, plus theme and state feeds.

What does not come back is what ADR 0034 removed for good reasons: a per-surface
Durable Object, a SQLite facet, a websocket, a viewer token and an instance
directory.

## Decision

### Host-drawn first, HTML as the fallback

A Plugin surface is a `ViewDocument` or an A2UI Card unless it declares HTML.
A host-drawn surface is accessible, themed and consistent on every client,
including the glance surfaces where no page can run. The managed `plugins`
Skill tells the Bot to prefer it, and to reach for a page only when the surface
is its own drawing or interaction.

### Where a page may appear

A page may appear in two places:

- a `conversation.panel` view;
- a Card the Plugin declares under `cards`.

It may not appear in these places:

- `settings.sections` or `bot.nav`. Those are a block and a row beside host
  controls, and the host vocabulary is enough for both.
- The glance surfaces of ADR 0035. No platform runs a page there.

There is no new full-page slot. On a phone the panel already is a pushed page,
and on a wide window the Canvas may offer a maximise control. That control is
host chrome.

### Declaration

A panel view (`PluginViewV1`) and a card entry each gain
`render: "html"` and `page: "<path in the Plugin's source>"`. For an HTML
surface:

- a panel view's function returns a **state**, JSON of at most 64 KiB, instead
  of a `ViewDocument`;
- a Card's `renderCard` returns the state for the values the Bot sent. The
  card's `dataSchema` still says what the Bot sends, so an HTML Card costs the
  model the values, as a Plugin card does today.

A Card's durable record on the Session carries the Plugin, its generation, the
page's hash and the state, and it is updated in place like any Card.

### Build and artifact

The build service's Plugin mode bundles each declared page into one
self-contained document, with scripts and styles inline and no subresource. It
adds the page to the Plugin's artifact set, so the generation's hash covers the
page with the worker. The same checks apply as elsewhere:

- A publish that declares a page the build did not produce is refused, as a
  declared tool the module lacks is refused.
- A page is superseded, never edited. A revert restores the old page with the
  old worker.

The page is served by the artifact route that exists. `ui.<host>` must survive
every later cleanup of Applet leftovers.

> Amended 2026-09-24. It did not survive: #775 removed `ui.<host>` and its
> route the day this was written, and Tim chose not to bring a second origin
> back. A page is served from the app's own origin at
> `/plugin-pages/<sha256>.html`, anonymous, stored under the same key in the
> artifact bucket. The origin is only where the bytes come from, never what
> they run as: every response carries CSP `sandbox allow-scripts`, so the
> document has an opaque origin however it is opened, framed or not, and the
> frame's own `sandbox` says the same again. The app document frames that one
> path of its own origin and nothing else of it. There is no deployment
> setting, so a self-hosted install has pages too. The first slice serves
> every page with no network at all (`connect-src` names only the Insights
> beacon); a page reaching its Plugin's approved hosts comes with the policy
> that names them.
>
> The microphone shipped as described below, with three narrowings. The
> ability is declared as `"device": {"abilities": ["microphone"]}` beside
> the `device` grant, and only on a Plugin with a page. A page is the
> weakest owner of the microphone: it gets it only when nobody holds it, and
> dictation or a call takes it back. No audit row is written yet; the
> host-drawn bar and its Stop are how a person sees and ends it.

### The frame

Every placement draws the page in `HostFrameView`, as an untrusted page:

- **An opaque origin.** It has `allow-scripts` and nothing else, is
  credentialless on the web, has no same-origin, forms, popups or top
  navigation, and runs one URL on the phone.
- **No credential.** The page holds no token and opens no socket to FrockBot.
- **Network only to approved hosts.** The page's `connect-src`, `img-src` and
  `media-src` name exactly the hosts the User approved under this Plugin's
  `http` grant ([ADR 0026](0026-plugins.md)), and nothing when there are none.
  Open network access does not reach a page. A request from a page carries no
  credential, because credentials are attached only at the worker's egress. The
  gateway composes the policy per request from the account's approval. The page
  bytes stay shared and content-addressed, and the edge cache keys on the page
  hash and the policy digest.
- **No permission of its own.** The iframe carries no `allow` attribute, and
  the WebView keeps refusing every permission request. A page never asks the
  operating system for anything.

### Device abilities come through the host

A page that needs the device asks the host over the bridge, and the host is
what touches the device. This is "native reach stays with the host", and it
works the same on every renderer, whatever each engine's rules for permissions
in sandboxed frames are.

- **`microphone`.** The host opens the microphone natively, or in its own
  origin on the web, and streams PCM frames to the page over a `MessagePort`.
  The page joins `mic_ownership` as a third kind of owner, and the person's
  latest gesture wins the microphone.
- **`camera`.** The host presents its own capture or document-scanner UI and
  hands the page the still image. A live viewfinder inside a page is not
  offered.
- **`location`.** The host streams position updates to the page.

The host grants an ability only when the Plugin holds it under ADR 0035's
`device` grant and the Device has consented. Otherwise the request is refused
with the host's own sentence. The OS prompt still appears once per Device.

While a page holds an ability, the host draws an indicator in the frame's
chrome ("Tuner is using the microphone") with a stop control. The indicator is
trust chrome and never part of the page. The host stops the stream when the
page leaves the screen or the app goes to the background. When a use ends, the
client writes one audit row naming the Plugin, the ability, the Device and how
long.

For the tuner, the audio goes from host to page on the device, and the page's
policy lets it reach only the hosts the User approved. With none approved, the
audio cannot leave. That is also what the Plugin's card says.

Abilities with no local form, such as alarms, calendar, NFC and shell, are not
reachable from a page. A Plugin reaches ordinary abilities through a tool and
the device command path, and own-machine abilities not at all.

### The bridge

The page speaks `PackagePageFrame`'s protocol, at a new bridge version. The
host makes every call on the person's own session, naming the Bot, the Plugin
and the surface.

| From the page       | What the host does                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hello`             | Answers with the surface, the revision, the state, the theme tokens, the locale and the abilities granted            |
| `callTool`          | Runs one of this Plugin's tools outside a Turn, as a panel control's `plugin-tool` does, then re-reads the state     |
| `action`            | Cards only: a `plugin/<pluginId>/<action>` handler, as a Card press is routed today                                  |
| `send`              | Conversation input: the Bot's next Turn's Pending input, never something the User said                               |
| `attach`            | Uploads a file the page made, such as a scan, and hands it to the Bot as Pending input; the host shows what was sent |
| `device.open/close` | Starts or stops a local ability, as above                                                                            |
| `resize`            | Asks for a height within the host's bounds                                                                           |
| `openExternal`      | Opens a link through the host's own link handling                                                                    |

The host sends `state` whenever the surface is invalidated, and `result`
answers a call. After any of this Plugin's tools runs for this Bot, whether
from a page, a panel control or a Turn, the Bot Durable Object's state-channel
notice names the Plugin, and a client showing one of its pages re-reads the
state. That is how the Bot's chess move reaches the board.

Some things are not on the bridge at all:

- the `approval/` namespace and any secret field, because trust chrome is never
  in a page;
- another Plugin's tools;
- navigation;
- anything of the Bot's except through this Plugin's own tools.

Calls are rate-limited per frame. Tool arguments keep the 8,000-byte cap
`plugin-tool` already has, and an attachment has a size cap. A page past a
limit is stopped, and its region draws the host's unavailable state.

### HTML in the conversation

A Card may be a page. The transcript is where trust chrome lives, so the host
holds a harder line there:

- **The host draws the card frame.** That includes the border and a header with
  the Plugin's name and icon that the page cannot cover. The height is bounded,
  and the page can grow only by `resize` within it. There is no fullscreen and
  no overlay, and nothing is drawn outside the frame.
- **No trust chrome inside.** An HTML Card never carries an Approval, a secret
  field or any trust-chrome component. A Bot that needs a decision sends an A2UI
  card.
- **Few live frames.** A live frame in a scrolling list is expensive. At most
  two HTML Cards are live at once, and only while on screen. The rest show a
  host placeholder with the Plugin's name and an Open control. Their state is in
  the Card record and the Plugin's storage, so tearing a frame down loses
  nothing.
- **The same device rules.** Device abilities work in a Card under the same
  grant and the same indicator, and stop when the Card scrolls away.

### Untrusted code on the device

A page is untrusted code that now runs on the person's device rather than in
the isolate. Its boundary, from the rules above:

- an opaque origin;
- no credential;
- network only to the hosts the User approved;
- device abilities only through the host, as granted and indicated;
- the Bot reached only through its own Plugin's tools and conversation input.

Plugins in one User's worker share a realm, but pages do not share one: each
page is its own frame. A page a Bot wrote runs with exactly what its Plugin was
approved for.

## Amendments to the constitution

On acceptance, `AGENTS.md` changes as follows:

- **Invariants: Untrusted code gets an isolate** gains its page form: a Plugin
  page gets a frame on the device, with an opaque origin, no credential,
  network only to the hosts the User approved, device abilities only through
  the host, and the Bot reached only through its own Plugin's tools.
- **Extension points, Cards:** "never from code the plugin ships" gains its
  exception: a Card declared `html` is the page the Plugin's artifact carries,
  in a host frame.
- **Extension points, Slots:** a `conversation.panel` view may declare
  `render: "html"`. Trust chrome is still never a slot and never in a page.

ADR 0030's "No Plugin ships client code" and ADR 0034's "No HTML artifact, no
iframe" are superseded for panels and Cards by this document. Everything else
in both stands.

## Consequences

- `PluginViewV1` and the card entry gain `render` and `page`. The Card record
  gains the page hash and state, and the client wire gains the new bridge
  version.
- The build service's Plugin mode builds pages into the artifact set. The
  artifact route composes a per-account policy.
- `PackagePageFrame` serves Plugin pages under an opaque origin and gains
  `send`, `attach`, `action` and `device.*`.
- The native client streams microphone frames, location and camera stills to a
  page, draws the in-use indicator, and bounds live Card frames.
- The managed `plugins` Skill teaches when a page is right and how to declare
  one.
- The browser suite drives an HTML panel and an HTML Card.

## Order

Each step leaves `main` shippable.

1. This document, then the `CONTEXT.md` and `AGENTS.md` amendments on
   acceptance.
2. The build service's page mode, the descriptor fields and decoding, and the
   per-account frame policy on the artifact route.
3. An HTML panel over the bridge (`hello`, `callTool`, `state`, `send`), with
   the board scenario end to end.
4. Local abilities through the host, with the indicator, `attach` and audit:
   the tuner, the map and the scan. This needs step 7 of ADR 0035 for the
   grant.
5. HTML Cards: the host card frame and the live-frame limit.
6. The managed `plugins` Skill.
