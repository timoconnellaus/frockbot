# Inside FrockBot: website change plan

Date: 19 September 2026.

**Implementation scope update:** The nine illustrated concepts are deferred at
Tim's request. Do not build their grid, detail views, images, or placeholders in
this change. Retain the briefs below for a separate follow-up. The rest of the
page, architecture diagrams, capability reference, and homepage card remain in
scope. References below to concept-specific examples are superseded by this
update; use neutral product illustrations for the current page.

Planning baseline: checkout `6143c31a0` (Unify macOS desktop shell chrome).
This is a plan for the existing marketing application, `apps/marketing`.
Implementation should reconcile its technical examples and availability labels
with the release being described, since the plugin and slot architecture is
changing in other work.

## Purpose and agreed direction

Create a substantial, illustrated explanation of FrockBot: what people can do
with it, how it works, and what its architecture makes possible. It is a website
article with optional technical depth, without an executive summary.

The page title is **Inside FrockBot**. The main navigation label is **How it
works**, and the canonical route is `/how-it-works/`. A prominent contrast card
on the homepage introduces it.

The name matters: a frock is something you wear, and the user should be able to
dress their Bot however they want. Explain that through appearance, behaviour,
tools, and interfaces. Open source extends that freedom to the underlying
platform and to running a deployment of your own.

Cover the whole product. Native applications, memory, Skills, routines, voice,
multiple Bots, the cloud Computer, model choice, and ownership all belong beside
plugins and cross-device coordination.

Treat software a Bot creates as plugins with state and interfaces in slots.
Do not introduce the retiring standalone application concept or terminology in
public copy. A plugin may render through A2UI or HTML in supported slots; the
page must identify this as the intended design wherever the release does not
yet provide it.

Use nine illustrated examples to communicate the possibilities. There is no
interactive automation builder or "imagine an automation" explorer. Filtering a
capability reference remains useful and is a separate, much smaller interaction.

## Existing site and change scope

The site is static HTML, CSS, and a small shared JavaScript file served by a
Cloudflare Worker. It already has a homepage, `/open/`, legal pages, and a Mac
download redirect. Build on that structure.

The homepage currently runs: hero, `#why` feature grid, `#how` work example,
`#uses` examples, pricing, open-source teaser, final call to action.

Its visual language is ink `#1e1d27`, pink `#db4b6d`, blush, cream, and white;
Archivo Black headings, Manrope body text, DM Serif accents, and occasional
Caveat annotations. Product depictions use a dark interface. The repository
already supplies the character artwork, self-hosted fonts, SVG diagrams, and
code-block styles.

Keep the current product introduction, character hero, pricing, downloads, and
primary sign-up journey. Extend the marketing experience using the same visual
language. This task does not implement the product capabilities depicted in
concepts or change native applications.

### Homepage

1. Change the primary **How it works** link from `#how` to `/how-it-works/`.
   Keep the existing `#how` anchor as the destination of links to the current
   work example. On secondary pages, homepage section links use `/#why`,
   `/#uses`, and `/#pricing`.
2. Add the contrast card after the `#why` feature overview and before the
   existing work example. Use a bounded ink card inside a cream or white section,
   with enough surrounding space to distinguish it from the full-width dark
   section that follows. On desktop, put copy and illustration beside one
   another; on phones, stack them.
3. Add **Inside FrockBot** to the footer. Include a contextual link from the
   open-source teaser.
4. Align the feature about making its own tools with Bot-authored plugins and
   slot interfaces. Rewrite the open-source teaser's claim that everything is
   a plugin to reflect the host/extension boundary. Inspect nearby absolute
   claims about approvals when editing this copy and use the actual scope of
   the product's enforcement.

Initial card copy:

> **INSIDE FROCKBOT**
>
> **Dress your Bot however you want.**
>
> A persistent cloud Bot, native apps, and plugins that shape its behaviour and
> interface. See how FrockBot works, explore what you could build, and discover
> the open-source platform behind it.
>
> **Explore how FrockBot works →**

Use a simplified architecture illustration: a familiar Bot, its plugin pieces,
and phone and desktop clients. Keep technical labels for the destination page.

### Open-source page

Keep `/open/` as a useful destination, focused on the MIT licence, inspecting
and contributing source, developing plugins, self-hosting prerequisites, and
the install guide. Link prominently to `/how-it-works/` for the architecture.
Retain working anchors or replace their sections with concise introductions
and direct links to the corresponding new-page sections.

Consolidate the long architecture material onto the new page. Replace existing
claims such as "Everything a Bot does is a plugin", unconditional continuation
after every plugin failure, and unqualified approval guarantees. Drop the
unsupported price comparison with other products while touching the opening.
Licence claims are grounded in the repository's MIT `LICENSE`.

## New page structure

Write roughly 2,500–3,500 words of core narrative, with the example details,
code, and full capability reference providing optional additional depth. This
is a guide to depth, not a length target that justifies filler.

Provide a desktop contents rail with section anchors and a compact, accessible
contents disclosure on mobile. Group related subsections so the navigation
remains scannable. Give each heading a stable, linkable anchor.

| Order | Section and anchor                           | Purpose and content                                                                                                                                                                                                              | Main visual                                                                        |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1     | Introduction, `#inside`                      | Explain the name and the promise of a Bot shaped to its user. Establish persistent cloud execution, native apps, customisation, and open source.                                                                                 | Simplified Bot/cloud/device illustration.                                          |
| 2     | Native apps, `#native-apps`                  | Describe the Flutter applications, native rendering and platform integration, the browser build, and the split between local interaction and cloud work. Show availability for the release being described.                      | Recognisable phone and desktop product views.                                      |
| 3     | What could your Bot do?, `#possibilities`    | Nine illustrated concepts with distinct combinations of capabilities.                                                                                                                                                            | A 3 × 3 grid; two columns on tablets and one on phones.                            |
| 4     | A persistent Bot, `#persistent-bot`          | Define Bot and Turn, durable admission, recovery, and continued work after a device disconnects. Explain that a Turn can contain several model/tool steps.                                                                       | Turn timeline with disconnection and recovery.                                     |
| 5     | Plugins, `#plugins`                          | Explain separate execution, one plugin worker per User, per-Bot enablement, ordered hooks, tools, services, grants, authoring, versions, and failure handling. Credit dsh/DeepSeek Harness and pi.dev with verified attribution. | Runtime/trust-boundary diagram, hook lifecycle, and short snippets.                |
| 6     | Slots and interfaces, `#interfaces`          | Explain placement separately from rendering. Show A2UI/native catalogues and contained HTML, persistent plugin data, updates, and the route a user action takes back to the host.                                                | Two rendering paths plus the CRM pipeline and chat cards.                          |
| 7     | Platform capabilities, `#capabilities`       | Explain Slot, Entry, Trigger, Handler, and Action; show their breadth through a browsable reference derived from Tim's full matrix.                                                                                              | Category overview and platform-filtered reference.                                 |
| 8     | Memory, Skills, and routines, `#continuity`  | Distinguish history from memory, explain Bot/User/Project memory, instruction directories, scheduled and event-driven work, and how multiple Bots can cooperate.                                                                 | Small linked examples; avoid a second system diagram.                              |
| 9     | The Bot's Computer, `#computer`              | Explain the remote browser, filesystem and terminal, persistent Workspace, watch/takeover, and the distinction from the user's own connected devices.                                                                            | Cloud desktop with a watch/takeover annotation.                                    |
| 10    | Voice and models, `#voice-and-models`        | Distinguish dictation from live voice; explain how voice reaches Bot work. Cover model configuration, supported provider entries, server-side keys, and the built-in Workers AI path.                                            | Brief voice journey and a compact provider display.                                |
| 11    | Open source. Yours to shape., `#open-source` | Explain inspection, modification, contribution, plugin development, and self-hosting. Link to `/open/`, the repository, and real guides.                                                                                         | Source-to-plugin-to-personal-deployment illustration or restrained source excerpt. |
| 12    | Next step                                    | Offer the hosted product, source, and self-hosting guide with clear labels.                                                                                                                                                      | Simple closing treatment.                                                          |

The first narrative pass should be readable without expanding anything. Technical
diagrams and code sit next to the explanation they substantiate.

## Nine example cards and image briefs

CRM, Game Night, and Side Quests are explicitly approved concepts. The other six
are the latest working proposals; refine their copy and images within this
direction. The superseded spoiler-bouncer and generic background-research
concepts are not part of the grid.

Each card contains a substantial picture, a short title, roughly 30–45 words
explaining the outcome, and three to five capability labels. A native `details`
disclosure can reveal the event-to-outcome sequence, the plugin's particular
rules/state, and relevant planned capabilities. Give cards their own anchors
and link capability labels to the reference where useful. Avoid modal-only
content, hover-only explanations, and fake install/run buttons.

| ID             | Title and story                                                                                                                                                                              | What the plugin specifically adds                                                                                  | Main combination                                                                                     | Image direction                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crm`          | **A CRM that keeps itself current.** Connected emails and meetings update contacts, opportunities, and follow-ups.                                                                           | Customer/deal records, extraction rules, a pipeline in slots, and interactive CRM cards inside chat.               | Connected services; plugin state; slots; chat-card actions.                                          | Show the recognisable FrockBot desktop shell with a populated pipeline beside chat containing Maya's contact card and an updated opportunity. Both the slot and in-chat UI must be prominent.                                  |
| `game-night`   | **Your gaming rig rolls out the red carpet.** Friday arrival launches a game and voice-chat app, arranges monitors, changes wallpaper, and plays entrance music with an absurd introduction. | Timing conditions, desktop setup, application choices, and a personal entrance routine.                            | Android location; cloud coordination; local commands; window management; wallpaper/audio.            | A person arriving while a connected gaming desktop springs into a theatrical launch sequence. Include a small arrival notification on the phone. Do not imply the Bot bypasses a locked device or turns an offline machine on. |
| `collector`    | **A treasure hunter for your obsessions.** Photograph a collection; the plugin tracks missing pieces, watches selected sources, and annotates listings as you browse.                        | Collection and wish-list records, matching rules, browser annotations, and alerts.                                 | Camera recognition; state; schedules/network; browser extension overlays.                            | A shelf with one missing blue robot, a listing outlined in the browser, and a triumphant match notice. Use invented collectible brands and fictional listings.                                                                 |
| `cooking`      | **A kitchen co-pilot with impeccable timing.** Talk hands-free while the plugin tracks what each pan needs and nudges the watch at the next step.                                            | Cooking-session state, coordinated timers, recipe progress, and mappings from voice to cooking actions.            | Voice; camera; timers; watch notifications/haptics.                                                  | Flour-covered hands, a phone showing the current step, and a watch reading “Flip the pancakes.” The story is coordination while cooking.                                                                                       |
| `side-quests`  | **Your neighbourhood becomes a side quest.** Start a twenty-minute scavenger hunt from a watch; location and photos unlock clues and badges.                                                 | Quest generation, progress, discovery checks, scoring, and remembered expeditions.                                 | Watch entry; location; camera/model; haptics; persistent game state.                                 | Watch clue, phone framing an odd architectural detail, and “Dubious gargoyle accepted. +20 points.” Show an ordinary public walking environment.                                                                               |
| `campaign`     | **A dungeon master who keeps the campaign alive.** The Bot narrates encounters using the campaign's characters, inventory, dice results, and history.                                        | Structured campaign state, custom dice tools, and hooks that supply relevant state to each response.               | Plugin tools/state; prompt hooks; voice; image generation.                                           | An illustrated tavern, a dice result, and the innkeeper portrait labelled “Still annoyed.” Explain what the plugin contributes beyond a role-play prompt.                                                                      |
| `focus-goblin` | **A focus goblin with permission to nag.** During a focus session, selected app/browser events trigger theatrical reminders; a shortcut negotiates a break.                                  | Focus rules, session history, distraction classifications, and the personality used for nudges.                    | Activity triggers; scheduling; behaviour hooks; native notifications; global shortcut.               | A distraction tab and a native notification: “You said five minutes. I have receipts.” Use user-selected activity sources, not a claim of unrestricted surveillance.                                                           |
| `comic-diary`  | **Your weekend becomes a comic strip.** A selected photo album and shared notes feed a recurring illustrated diary for review and sharing.                                                   | Journal records, story assembly, character/style references, and a review/export workflow.                         | Photo events; memory; routine; image generation; files/share sheet.                                  | Three ordinary photos becoming panels headed “The Wrong Train”, “Unexpected Dumplings”, and “A Strategic Nap.” Depict continuity as a design goal, not perfect image consistency.                                              |
| `plants`       | **Houseplants with opinions.** Ask the Bot to create an integration for compatible sensors, then give the plants their own notification personalities.                                       | Sensor adaptation, per-plant readings and rules, personality settings, and a plugin authored through conversation. | Plugin authoring; Bluetooth through a connected device; approved grants; cloud rules; notifications. | Plant and sensor beside “I see you watered the orchid. Interesting.” Add a small creation/permission vignette so authoring is visible.                                                                                         |

Present these as **plugin concepts showing the platform's direction**, not a
marketplace of available installations. Attach precise capability status to the
expanded explanation. The three approved concepts retain their core stories.

### Art production

Use a coherent illustrated style, the existing character family, the site's
pink/ink/cream palette, and recognisable native product chrome. Vary the scene:
CRM is UI-heavy, Game Night is environmental, Side Quests is physical, and the
remaining images combine objects, devices, and outcomes.

Create nine individual illustrations, one reusable overview asset for the
homepage card/page opening, and a dedicated social-sharing image. Reuse overview
components for the native-client explanation where appropriate.

Use image generation for scene artwork, character situations, and textures.
Draw readable product UI and important text as HTML/SVG or carefully composed
overlays from actual native screenshots. Do not depend on generated tiny text
or fabricated screenshots of features presented as live. Inspect the existing
character references before making variants.

Plan a shared 4:3 card-image ratio, with safe crops for mobile. Generate large
masters and deliver responsive WebP/AVIF derivatives plus an ordinary fallback.
Retain useful source assets and record their intended placements. Set intrinsic
dimensions and meaningful alt text. Lazy-load below-the-fold images; do not
preload all nine.

## Diagrams and infographics

Use source-controlled semantic HTML/CSS for technical diagrams so labels remain
selectable and the figures can reflow at narrow widths. Keep a text description
beside each. The dedicated social-sharing image remains source-controlled SVG
with a generated PNG fallback.

| Asset                         | Placement                          | What it must make clear                                                                                                                                                                             |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview infographic          | Homepage card and new-page opening | Native clients connect to a cloud Bot; plugins and the Computer extend what it can do. The homepage version uses very few labels.                                                                   |
| Runtime and authority diagram | Plugins                            | One User authority object, Bot authority/state objects, one installed-plugin worker per User, mediated capabilities, external services, and connected clients. Mark shared plugin trust explicitly. |
| Turn lifecycle sequence       | Persistent Bot / Plugins           | Store input, acknowledge, execute model/tool steps, settle. Show repeatable steps and relevant hook positions, plus recovery from recorded progress.                                                |
| Slot rendering diagram        | Interfaces                         | Slot placement, A2UI to compiled Flutter widgets, HTML in host-contained web surfaces, and the return path of interactions. Mark intended slot support where appropriate.                           |
| Cross-device sequence         | Game Night detail / Capabilities   | Phone event, cloud admission, plugin conditions, authorised desktop action, receipt. Show disconnected target/expiry as a compact branch.                                                           |
| Plugin lifecycle              | Plugin authoring                   | Request, author, check/build, grant approval, activate a generation, next-Turn use, recorded versions and revert. Code rollback does not undo earlier external effects.                             |

Avoid putting secrets into a plugin box, depicting one isolate per plugin,
placing the agent loop in a client, or making plugin execution appear to occur
on the cloud Computer. Animate only when it clarifies direction or repetition;
respect reduced-motion preferences and pause offscreen animations.

## Code examples

Use three or four short, readable excerpts, usually 8–20 lines each:

1. A minimal plugin descriptor showing the contribution and requested grants.
2. One real prompt hook showing how a plugin changes Bot behaviour.
3. A small A2UI interface beside its rendered result.
4. An HTML slot example beside its interface, using the accepted API when that
   exists or explicitly labelled pseudocode while it is a design proposal.

Use a coherent small example across excerpts where practical. Source executable
snippets from the actual SDK and link to the complete example. Escape code into
static HTML and highlight it at build time or with existing CSS classes; avoid
loading a runtime syntax-highlighting package for a few blocks.

Add a keyboard-accessible copy button with an announced success/failure state.
Code remains selectable if clipboard access fails. Keep full example source
under the article assets if a repository example is not a suitable link.
Validate claimed runnable examples against the release's SDK; do not invent
imports to conceal a package rename that has not happened yet.

## The full capability reference

The input is Tim's complete platform/capability matrix supplied in this task on
18 September, including its per-platform status and store-gated annotations.
Preserve that breadth when turning it into data; do not silently publish only
the examples visible in the grid.

Start with five plain-language introductions:

| Type    | Meaning                                                  | Reader-facing label          |
| ------- | -------------------------------------------------------- | ---------------------------- |
| Slot    | A place the host offers for an interface.                | Show something useful        |
| Entry   | A person starts work or opens a surface.                 | Start it your way            |
| Trigger | An event starts work.                                    | React when something happens |
| Handler | The host asks for a decision or transformation.          | Shape what happens next      |
| Action  | The Bot or plugin asks the host to perform an operation. | Get something done           |

Then provide a searchable, category- and platform-filtered list with an option
to see the full comparison. This reference is informational. It does not
assemble or run automations.

Source groups to preserve:

- Slots: conversation cards and message additions; composer controls; navigation,
  Bot pages, settings and themes; device widgets, notifications, menu/tray,
  file surfaces, keyboards and screensavers; browser side panels, popups,
  new-tab pages and overlays.
- Entries: deep links, command palette and shortcuts; notification/widget/watch
  interactions, assistants, NFC, lightweight app entry; share sheets, file
  opening, drag/drop, context menus and browser toolbar/omnibox entry.
- Triggers: webhooks; location/presence, Bluetooth/network/USB/display/audio
  changes; battery/session/idle/active-app/device events; notifications,
  clipboard/calendar/contacts/media/home changes; page/tab/download/bookmark
  and history events.
- Handlers: the six agent-loop hooks, the separate `theme/assemble` hook that
  runs outside a Turn, approvals and routing; platform call/SMS/identity,
  mail/focus and browser-request handlers. The reference contains 149 entries.
- Actions: authenticated network and notifications; outbound share/compose,
  calls/maps/opening; personal data/files/clipboard/search; sensors, camera,
  media, speech, Bluetooth/USB/NFC, discovery/home/wallet/payment/biometrics,
  printing/device state/local models; system settings and desktop controls;
  browser content, tabs, downloads, history and bookmarks.

Use nine distinct platform columns: Web, Android, iPhone, macOS, Windows,
Linux, Apple Watch, Wear OS, Browser extension. Keep a cloud/runtime scope on
server capabilities so repeating a hook across platforms never implies all
those native clients are released.

Suggested source record:

```text
id, category, group, title, description, scope,
platforms: { platform: { status, note, evidence } },
exampleIds, checkedAt
```

Availability is `available`, `planned`, or `not-applicable`. Restrictions such
as store policy or native permission requirements are notes on that status,
not a fourth state that obscures whether implementation exists. Internally,
uncertain cells need verification; do not silently turn them into available
capabilities. Audit time-sensitive platform assertions against official
platform documentation before publishing the matrix.

Keep one checked-in data source and render the initial reference into HTML.
Small JavaScript filters enhance that document in place. The unfiltered list
is readable without JavaScript; the mobile presentation is grouped rows with
platform badges, and the optional full matrix can scroll within its own
labelled region. Announce filtered counts, offer reset, and avoid colour-only
statuses.

## Factual and editorial constraints

Separate implemented behaviour from architectural direction with local labels
and short explanations. A concept card is not evidence that a platform release
or every capability it combines exists.

- A Bot's Durable Object owns authority and durable state; large file bodies
  can reside in object storage. A Turn can make multiple model/tool steps.
- The host owns the loop. Plugins execute separately, installed per User and
  enabled per Bot. Installed modules and enabled contributions are different.
- Capability bindings are per User in the inspected code; execution-scoped
  calls carry their Bot/Turn identity and the host resolves authority on use.
- Plugins share a realm. Network reach is the approved combined policy, not
  isolation between individual plugins.
- Hooks fire at lifecycle points and may repeat. In the inspected code,
  `agent/turn-stopping` is a settling notification, not a patch or veto over
  completion. Verify this again when writing the published hook reference.
- Worker budgets and invocation deadlines bound execution. Ordinary failures
  can be skipped and repeated failures quarantined; locked or worker-wide
  failures require more precise language than “the Turn always continues”.
- Host-mediated credential use keeps secrets out of plugin backend code. An
  HTML interface can run contained client-side JavaScript, so avoid saying
  that no plugin-related code ever runs on a device.
- A2UI rendering uses compiled component catalogues. HTML has its own
  containment and host bridge. Explain both within the intended slots design.
- The inspected provider catalogue has 40 entries, including regional and
  subscription endpoints. Recalculate from its source at implementation time.
  The host resolves the configured model; do not imply autonomous provider
  shopping. Optional model providers and default Frock AI have distinct paths.
- Describe native Flutter applications accurately; “native” does not mean
  that every control is an operating-system-supplied UIKit/AppKit widget.
  Verify publicly downloadable/qualified platforms before setting badges.
- Use “always available” with an explanation of durable, event-driven work.
  It is not a claim of perpetual CPU execution or unlimited background access
  on a phone.
- Reuse of effect keys is not a universal guarantee that every third party
  deduplicates. Code reverts do not reverse all external actions.
- Verify exact dsh/DeepSeek Harness and pi.dev source links and attribute the
  ideas borrowed. Do not invent comparative claims about their architectures.

Existing documentation is a discovery aid. New slot/data work and the removal
of the retiring interface concept take precedence where Tim has specified the
target. Verify live claims from code, tests, and release evidence; explain
future behaviour as future behaviour.

## Proposed implementation files

| Path                                            | Change                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/marketing/public/index.html`              | Navigation, contrast card, footer link, and scoped copy alignment.                         |
| `apps/marketing/public/how-it-works/index.html` | New semantic article, examples, diagrams, snippets, contents and capability reference.     |
| `apps/marketing/public/how-it-works/styles.css` | Article-specific layout and components using shared site tokens.                           |
| `apps/marketing/public/how-it-works/script.js`  | Contents enhancement, capability filters, copy controls, and optional diagram interaction. |
| `apps/marketing/public/styles.css`              | Homepage card and genuinely shared styles only.                                            |
| `apps/marketing/public/open/index.html`         | Focused open-source/self-hosting page and cross-links.                                     |
| `apps/marketing/content/capabilities.json`      | Complete editorial matrix with status, evidence, scope and example mapping.                |
| `apps/marketing/scripts/render-capabilities.ts` | Small deterministic renderer for the capability section, with a check mode.                |
| `apps/marketing/package.json`                   | Run/check capability rendering before the marketing build as appropriate.                  |
| `apps/marketing/public/assets/inside-frockbot/` | Illustrations, responsive variants, diagrams, and social image.                            |
| `apps/marketing/src/index.test.ts`              | Extend the existing coverage for relevant routes, navigation and CSP-compatible output.    |

Use a bounded generated region in the static article for the capability
reference; the rest remains ordinary authored HTML. Do not introduce an
application framework or content-management service for this change. Use a
small shared data source for filtering rather than duplicating platform states
in hand-authored JavaScript.

The existing asset routing should serve the new directory without a Worker
change. Verify slash handling and canonical URLs. The existing CSP permits
self-hosted scripts/styles/images and restricts frames; all diagrams and demos
on the marketing site should be static depictions or same-document components.
Represent HTML slot execution with diagrams/examples, not a live embedded
third-party app that forces weaker security headers.

Add a unique title, description, canonical URL, social image and descriptive
image alt text. Link the new route from the homepage, `/open/`, and footer.

## Delivery sequence

1. **Content and evidence:** reconcile the release baseline, write the article,
   transpose the complete capability matrix, record status evidence, and
   prepare real snippets. Preserve the approved concepts and terminology.
2. **Page structure:** implement the route, global links, homepage card,
   article hierarchy, contents, and responsive example grid with fixed image
   dimensions. Reuse site typography and character assets.
3. **Illustrations and diagrams:** produce the nine scene assets, overview,
   native product views, six visual treatments, and social image. Inspect
   the assembled page at desktop and phone sizes while refining them.
4. **Technical depth and reference:** add the code examples, capability
   rendering/filtering, working anchor links, and accessible disclosures.
5. **Integration and verification:** update `/open/` and overlapping homepage
   copy, finish metadata, verify accessibility and performance, and complete
   the required repository validation for the implementation diff.

The implementation can be reviewed as one cohesive marketing change; the
sequence is an execution order, not a requirement for multiple partially
published pages. Follow the repository's normal review/publication workflow
when implementation is requested. This planning task does not request a deploy
or version tag.

## Acceptance and verification

### Content

- Homepage has the contrast card and a working **How it works** navigation link.
- `/how-it-works/` is titled **Inside FrockBot** and explains the name, open
  source, native apps, the wider product, plugins and planned slot interfaces.
- All nine concepts are present, with CRM cards in chat as well as its pipeline.
- Every example identifies what its plugin contributes and illustrates a
  distinct combination of features.
- No automation-builder/explorer UI and no retired standalone application
  terminology appear in public copy.
- The capability reference covers the supplied inventory, nine platforms,
  five types, restriction notes, and honest per-capability status.
- Current code examples work against the chosen SDK; proposed examples are
  visibly labelled. Source and self-hosting links resolve to real destinations.

### Browser and accessibility

- Inspect at 1440, 1024, 768, 390, and 320 CSS pixels, including text zoom.
  There is no page-wide horizontal overflow or clipped heading/control.
- Grid changes from three to two to one column. Important illustration details
  and CRM card text remain legible through the available expanded view.
- Navigate menu, contents, disclosures, filters, and copy buttons by keyboard;
  check focus visibility, accessible names, announcements, and touch targets.
- Read core content with JavaScript disabled. Test filter combinations,
  no-results/reset, deep links, clipboard failure, and reduced motion.
- Verify production-equivalent CSP, no console errors, missing assets or
  broken internal links, and a sensible scroll position for anchored headings.
- Confirm homepage signup, Mac download, pricing links, existing hero motion,
  open-source and legal navigation still work.

### Assets and performance

- All nine illustrations have intentional crops and alt text; no concept image
  is presented as a verified screenshot of an available feature.
- Images have dimensions, responsive sources and appropriate loading priority.
  Target approximately 80–180 KB per card derivative where quality permits;
  measure the actual first-view transfer and defer the rest.
- Technical labels remain selectable where practical; mobile diagrams have
  readable layouts and prose equivalents.
- No new remote font, illustration, diagram or syntax-highlighting dependency
  is required at runtime.

### Implementation checks

Run the marketing tests (`bun run --filter @frockbot/marketing test`), its
typecheck, its build, formatting, the capability-renderer consistency check,
and visual/browser checks over the served site. Add tests for meaningful
behaviour such as filter semantics, status/scope preservation, generated
reference consistency and internal links; avoid snapshotting every sentence
or duplicating CSS implementation details in tests.

The interactive browser work also follows the repository's required
`bun run validate` policy. If the implementation enters no-mistakes, give that
run custody of fixes/publication and use its completed validation rather than
rerunning full suites afterwards. A later code change or missing required
category is the reason to run further checks. Watch any created PR through its
required checks, and do not tag or deploy without a release request.

For this plan-only change, inspect Markdown and its local links; code tests are
not applicable.
