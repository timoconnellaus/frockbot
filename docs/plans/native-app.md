# A first-class native FrockBot

Tim accepted the direction on 2026-09-05. [ADR 0039](../adr/0039-a-first-class-native-base-with-declared-extension-seams.md) records the explicit constitutional amendment. Flutter is the primary native renderer; a compiled, reviewed A2UI catalog renders extensions; existing Applets and the Computer viewer have an isolated web fallback. One backend supplies both native and browser renderers. Compose vendoring as `@frockbot/compose-*` proceeds independently.

Phase 1 delivers the amendment, shared schemas, generated validators, compatibility refusal and this plan. It does not implement a Flutter application or enable an A2UI Contribution in production. Native rendering and its qualification are **beyond parity**. Existing workflows retain their status in the [parity register](../research/grokbot-computer.md): Bot identity/lifecycle (1–6), settings/panel (50–51), search (52), approval presentation (53), unread/notifications (56), and Computer/Memory/Skills remain the same product capabilities. This migration neither claims unfinished rows nor silently removes them.

## Permanent base behavior inventory

“Base” describes the accepted destination. Most behavior still lives in Packages today; moving it requires a tested extraction, not renaming directories or growing the kernel. Native widgets and browser components project the same durable facts.

| Permanent behavior                                                                              | Authoritative owner and current evidence                                                                     | Native and browser obligation                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, session expiry, account identity, sign-out, minimum-version refusal                    | Auth backend and User identity; Cloudflare gateway/client auth                                               | Trusted host UI, system authorization browser on native, redacted errors, secure session storage; no credential editor in extension content |
| Bot directory, identity, create, lifecycle, selection, visibility                               | User directory and Bot lifecycle; `plugin-flock`, client directory/identity/lifecycle methods                | Native navigation, avatar/provenance, lifecycle receipts, cross-device selection recovery; local selection is a preference, never Bot state |
| Conversation directory, new conversation, recent history, announcements, search entry           | Bot event log/read model; `plugin-shell/src/backend.ts`, search backend                                      | Paged projections, stable row ids, retained scroll anchors, structured sends, visible truncation; no extra bubble for plain assistant text  |
| Composer drafts, skill references, attachments, send, Stop, queued work and uncertain admission | Bot admission/idempotency/cancellation; `uncertain-admission.ts`, `composer-draft.ts`, `skill-invocation.ts` | Host text editor and send/Stop controls; locally persisted draft/command id; lookup and reconciliation after unknown delivery               |
| Tool activity, approvals, failures, recovery, audit and undo                                    | Bot event/intent log and User/Applet generation owners                                                       | Host-owned trust labels and action frames; approval presentation never creates a grant; recovery remains accessible when an extension fails |
| Models, Connections, Application settings, justified Bot settings                               | User configuration/Connections; Bot identity/instructions/notifications and permitted overrides              | Trusted frames and sensitive controls, exactly one home; absent/disabled optional controls stay absent; Plugins offers enablement only      |
| Extension management, authoring entry points, version history                                   | User availability, Bot Composition, Applet directory                                                         | Inspect Package provenance, allowed subset, enabled state and compatible undo; content cannot impersonate these controls                    |
| Computer and Applet navigation, opening/closing, unavailable state                              | User Computer assignment; Applet directory/viewer owner                                                      | Native chrome around isolated web regions; inspecting durable Computer state or opening an Applet wakes no Computer                         |
| Unread, notifications, links and user attention                                                 | Bot unread cursors/notification intents, User preferences                                                    | OS delivery is an observer; mark-read is explicit; reconnect and duplicate deliveries do not inflate badges                                 |
| Voice, clipboard, files, sharing, deep links, media permission and window lifecycle             | First-party platform adapters over shared backend commands                                                   | Platform interaction and permission UI; no extension-native bridge; browser alternatives preserve core workflows                            |
| Account policy, zero-configuration defaults, quotas, live authorization and recovery scheduling | User/Bot Durable Objects and reviewed base policy                                                            | Backend decisions projected consistently; no Dart implementation of model policy, grants, billing, scheduling or an Agent loop              |

The current transport in `packages/client-core/src/index.ts` is named `AgentTransport`; the Cloudflare client constructs it in `apps/cloudflare/src/client/index.ts`. It is evidence of the client transport boundary, not a portable Dart SDK: its package also imports Vue. Inventory behavior from `FrockBotApp.vue`, the shell controller, `SendPayloadView.vue`, `applets-client.ts`, `PackageIframeHost.vue`, transcript cache, voice, notifications and uncertain-admission helpers. Preserve their tested outcomes while extracting backend modules; do not port the giant controller into Flutter.

## Declared extension slots

| Seam                                                                 | Allowed extension behavior                                               | Host-owned boundary                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `application.settings`                                               | Deterministic, non-sensitive declared Package fields                     | Host resolves setting home, enabled state and save command; Models/Connections credentials remain trusted controls                |
| `bot.settings`                                                       | Declared Package fields with an accepted reason they must differ per Bot | Account inheritance and disabled-override inertness stay backend policy                                                           |
| `bot.right-panel`                                                    | Bounded cards/lists and status views                                     | Bot selection, panel navigation, trust labels and recovery cannot be replaced                                                     |
| `conversation.tool-result`                                           | Interactive result for its recorded tool/surface revision                | Chat history, input, Stop, approvals and tool authority remain outside the document                                               |
| `package.surface`                                                    | An identified extension page or Applet's optional A2UI view              | Native route, owner/provenance, close/back, unavailable state and recovery frame                                                  |
| Existing HTML iframe pages, sidebar actions and overlays             | Current manifest-declared web content and declarative entries            | Existing browser path; native entries open only the isolated fallback with host chrome                                            |
| Backend models, tools, integrations, loop hooks and Applet instances | Reviewed declared runtime interfaces                                     | Durable kernel and base invoke them; provenance selects an isolated host; per-Package allowed subset and live authorization apply |

`A2uiContribution` declares a named slot, immutable artifact hash/size, protocol version, catalog id/digest, bounded action schemas and optional web artifact. `A2uiSurface` identifies owner, Package, generation, revision, cursor and snapshot hash. The owner retains validated documents/snapshots as immutable content and records their identities with surface events. An action names its exact surface revision and a stable command id. The server decodes input against the pinned declared schema, checks ownership, enablement and live authorization, then durably admits it. A stale revision receives a visible refusal and refresh; it never targets the newest version implicitly. There is no generic tool dispatcher or native API action.

An unsupported protocol/catalog pair makes only its region unavailable. The host may offer the independently validated fallback if declared; otherwise it presents plain recovery copy. No remote Dart, JavaScript expression evaluator, arbitrary function names, remote schema references or catalog installation is permitted. The initial compiled catalog has text, row/column, bounded list, text/number/choice input, validation message and submit components; no credential fields, host trust labels, unrestricted HTML, scripts or native bridge components. Its final id/digest is produced from reviewed code during qualification, not invented or advertised in phase 1.

## Backend contracts to extract

These are small public contracts over existing durable owners, not new authorities or a second implementation for native clients. Phase 2 extracts their existing behavior behind interfaces before replacing the corresponding client code.

| Contract                | Commands and projections                                                                                                            | State, failures and proof                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConversationReadModel` | `listConversations`, `readPage(conversationId, cursor, limit)`, `lookupCommand(id)`; immutable display rows plus page/reset cursors | Bot-owned indexed events, no exact model payload on list reads. Bounded pages, stable order under concurrent appends, explicit invalid cursor, previous-shape migration, and query-count regression on a 10,000-Turn fixture                     |
| `ExtensionRuntime`      | Resolve desired artifacts and allowed bindings, pin, mount, invoke a declared action, activate/revert, describe unavailable         | Bot/Applet authority records generations, schema window and effect intent; host projections are disposable. Failed mount preserves data and prior healthy generation; restart remount, concurrent publication and revocation-between-steps tests |
| `UserRecoveryScheduler` | Register durable deadline, claim due recovery, record outcome/reschedule                                                            | User DO owns User work; delegates Bot-owned recovery to Bot admission. No client timers or resident contribution dependency. Evict before/after claim, duplicate alarm, failed contribution and bounded fan-out tests                            |

The [schema inventory](../../packages/protocol-schemas/README.md) maps current routes and planned additions. Auth PKCE/session exchange, a generic durable receipt lookup, stable-id new-conversation admission, a settings read model, A2UI routing and fallback bootstrap are defined contracts, not working endpoints in phase 1. Add them to shared backend owners and exercise them through both clients. No handwritten decoder is replaced on the strength of fixture conformance alone.

## Supported platforms and distribution

These are qualification targets, not claims of an already working native application.

| Target        | Product floor and first distribution                                                                                         | Required proof before support                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android       | API 24 remains the existing minimum; Pixel 9a is the phase-2 device; signed development APK installed over Tim's current app | Same package and signer, system-browser return, real WebView isolation, IME/back/media and suspend recovery; lowest supported API/device must pass before broad support |
| macOS desktop | macOS 13+ proposed product floor; Apple Silicon Mac for phase 2; signed/notarized direct preview before public distribution  | Keyboard/window/menu/focus behavior, verified return links, Applet fallback and token/cookie isolation; Intel qualification is separate                                 |
| iOS           | iOS 16+ proposed product floor; TestFlight after auth, media, fallback and distribution review                               | Physical device, verified links, VoiceOver, WebView lifetime, background behavior and Apple policy gate                                                                 |
| Browser       | Existing supported Vue/WebUI path throughout rollout                                                                         | Same command/receipt/projection fixtures and core workflow suite; Flutter Web is a separate retirement decision                                                         |
| Windows/Linux | Deferred, no shipping promise                                                                                                | Prove the entire auth/media/fallback/notification stack and signing/update path before adding a target; Flutter support alone is insufficient                           |

Android Play internal testing is a later distribution gate: a release signer cannot upgrade an existing debug-signed install simply because the package id matches. Preserve Tim's development upgrade track; decide any store-signing transition explicitly with data/session recovery verified. No signing material is committed.

Apple App Review 4.7 is a **policy risk** for the actual extension model. Review native API access (4.7.2), per-software data/privacy permission (4.7.3), software index/universal links (4.7.4) and age controls (4.7.5) before committing App Store distribution. A2UI supplies no exemption. An interpretation requiring a second grant conflicts with account-wide enablement: resolve the product scope or explicitly amend the constitution before implementing that flow. This is not a prediction of rejection. [Apple's guidelines](https://developer.apple.com/app-store/review/guidelines/#mini-apps-mini-games-streaming-games-chatbots-plug-ins-and-game-emulators).

## Android install continuity

Preserve `apps/mobile/android` as the baseline until the replacement actually upgrades it. Its application id and namespace are **`com.frockbot.mobile`**; versionName is `1.0`, versionCode is `1`, and min/compile/target SDK are 24/36/36. Inspect the installed versionCode immediately before building; use a strictly greater code, not an assumed `2`. The native semantic version starts at `1.1.0` for protocol negotiation.

Use the same existing debug signing keystore for the device track. ADR 0005 records certificate SHA-1 `4B:C8:B1:F9:6A:60:3A:99:25:77:66:E0:D8:9F:45:54:82:82:F8:98`; compare the actual old and candidate APK certificates with `apksigner verify --print-certs` before installation. This reference is a check, not authority to replace or regenerate a key. Assert the application id with APK inspection and upgrade via `adb install -r`; verify local data survives and reauthentication recovers the same cloud User/Bots. Do not uninstall to disguise a signer mismatch.

Keep the Google **web** client id `757079918011-jnhcm9etic2v7rpc8vq33kffmvo6j38h.apps.googleusercontent.com` and existing hosted origin `https://bot.frockbot.com`. The id is public configuration, not an application secret. Preserve existing browser/Capacitor auth while adding the native backend exchange; register verified return links for the actual signed application.

The reviewed job's `tmp/mobile-build.sh` uses Java 21, the Android SDK, a web build, Capacitor sync, Gradle `assembleDebug`, `adb install -r`, and a package launch. It hardcodes another worktree: use it as evidence only, never execute that path from this worktree. There are no `apps/mobile/*.md` files in this checkout; ADR 0005, the direct-hosted-mobile ADR 0008, Gradle/manifest/config files and the job brief provide the baseline. The Flutter slice replaces the build steps, not the package identity or signer. Phase 1 changes none of these Android files.

## Exact renderer pins and qualification

| Layer                   | Exact candidate                  | Why and qualification rule                                                                                                                                              |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2UI document protocol  | **0.9.1**                        | Upstream's current version in the review; commit the exact specification/catalog snapshot and digest used by fixtures. A protocol version is not a Dart package version |
| GenUI rendering adapter | **`genui: 0.10.2`**              | Published Android/iOS/macOS/web coverage; use catalog/surface rendering pieces behind one FrockBot adapter. Do not adopt a local conversation/model loop                |
| Web fallback plugin     | **`webview_flutter: 4.14.1`**    | Published Android/iOS/macOS support, with Android 24+; commit platform dependency resolutions and test their actual cookie/bridge/frame behavior                        |
| Qualification SDK       | **Flutter 3.47.0 / Dart 3.13.0** | Locally available SDK; pin engine/framework revision in phase-2 build metadata and measure that build. It is not a phase-1 Flutter dependency installation              |
| FrockBot catalog        | No advertised catalog yet        | Pin reviewed catalog source plus content digest only after the deterministic and hostile fixtures pass on phone and desktop                                             |

Use exact versions and commit `pubspec.lock`; no caret ranges or silent package upgrades in the spike. The protocol and package numbers do not prove interoperability. GenUI is described as experimental/alpha by Flutter; if the candidate combination fails, record the smallest adapter change or newly qualified exact pin and rerun both device fixtures before promotion. Current evidence: [A2UI version overview](https://a2ui.org/), [GenUI 0.10.2](https://pub.dev/packages/genui/versions/0.10.2), [Flutter GenUI guidance](https://docs.flutter.dev/ai/genui), and [webview_flutter 4.14.1](https://pub.dev/packages/webview_flutter/versions/4.14.1). The webview package's platform coverage is narrower than Flutter's.

## Protocol, catalog and storage windows

`packages/protocol-schemas/schema/client-wire.schema.json` is the sole JSON Schema 2020-12 source. TypeScript types/predicates/constants and Dart validated DTO wrappers/constants are generated from it. Both languages read `fixtures/valid.json` and `fixtures/invalid.json`; the existing TypeScript decoders remain and run mapped conformance fixtures. Local Dart 3.13.0 is available and runs the fixture test and analyzer; generated output is not being passed off as an untested SDK.

Initial wire window is **[1, 1]**, minimum native version **1.1.0**, and supported catalog list empty until qualification. The server publishes generated constants at `/api/client-compatibility`. Malformed or unsupported `x-frockbot-client` negotiation receives HTTP 426 and plain `Update the app to continue using FrockBot.` before application loading. Current browser/Capacitor traffic remains on its existing unversioned path. Native auth/session binding must enforce negotiation on all native requests, including reconnect, before the slice ships; headers are not authentication.

After the first qualified catalog, support at most current and previous wire/catalog generations for a 90-day migration period. A security removal may close the window early. Increase minimum versions only with a reachable signed update on every supported distribution target. Unsupported extension content leaves core controls operable. Exact-key decoders require a new version for incompatible fields; removed product features stay removed.

Keep this wire window separate from forward-only stored DTO migrations. Every runnable code generation declares readable/writable schema ranges. Before incompatible promotion, fence or drain active calls, preserve recoverable data, migrate behind a guarded boundary and validate health before commitment. Expand/contract by default; contraction waits for all old runnable/pinned code to retire. Refuse incompatible undo visibly. A code revert never promises a data revert or sets last known-good on its own. Record authorization epochs and recheck live grants before each new external effect, including in-flight pinned code; already-dispatched effects retain their reconciliation policy.

## Web fallback trust zone

Use a distinct untrusted WebView context, without application-session cookies, provider secrets, broad JavaScript-to-native bridges, file access or arbitrary navigation. Do not load the authenticated hosted application into it. A reviewed bootstrap hosts the existing sandboxed artifact iframe and receives only short-lived Applet/User-scoped viewer access. Fetch the bootstrap manifest and mint/renew tokens through the trusted native transport; never pass the native session token. Keep tokens out of URLs, history and logs; send the scoped token only after the expected bootstrap handshake. Computer viewer access uses its provider's separate scoped viewer/takeover lease, never an Applet token or generic credential bridge.

Validate exact bootstrap origin, expected frame identity and navigation epoch. Sandboxed artifact frames may have an opaque origin: accept only the known child frame under the approved bootstrap and current epoch, never treat the string `null` as an allowlist. Cross-origin navigation, recreated frames and disposal fence earlier callbacks and tokens. External links open in the system browser. Restrict subresource origins and test CSP, nested frames, redirects, downloads, popups and scheme handling; inability to enforce the policy on an OS blocks that fallback target. [Android documents cross-frame native bridge risks](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges).

Native login uses the system authorization browser with PKCE S256, random state, one-use exchange, expiry, verified HTTPS return links and OS-protected session storage. Reject mismatched state, verifier, return URI, replayed exchange and wrong signed-app identity. Logout/revocation clears the native session and fences scoped viewer renewals; disposing a view does not cancel an Agent. No application client secret lives in Dart. Test warm and cold return, browser cancellation, account switch and process death between callback and exchange. [RFC 8252](https://www.rfc-editor.org/info/rfc8252/).

Prove isolation on each OS with synthetic application cookies and tokens, hostile nested iframes and actual network/bridge inspection. The extension must fail to read native credentials or invoke host permissions. Verify viewer expiry, renewal, navigation epoch, cross-User denial and closed-view messages. Do not infer isolation from an iframe sandbox attribute or a plugin's API name.

## Native-feel acceptance fixture and budgets

Run one reproducible fixture on Tim's Pixel 9a and the phase-2 macOS desktop, in release mode with the exact pinned engine/catalog. Before broader release repeat it on the lowest supported real device; an emulator at API 24 is compatibility evidence, not performance evidence. Record device/OS, thermal state, refresh rate, build hashes, backend fixture seed and raw traces. Use 30 cold/warm launches, three five-minute interaction runs and 20 suspend/resume/open/close cycles. Proposed budgets below are acceptance targets, **not measurements already obtained**; baseline them in phase 2 and explicitly record any accepted change.

Seed 10,000 Turns across several conversations, structured sends, tools, errors, announcements and attachment references. Page lazily with stable scroll anchors; never fetch model-request history to display messages. Type and edit with English and Japanese IME composition, paste multiline text, select/copy across messages, use context menus, attach files by picker and desktop drag/drop, traverse with keyboard/screen reader, and use platform back/forward and shortcuts. Test 200% text scaling, safe areas, predictive Android back, focus after navigation, microphone interruption and permission denial. Verify keyboard composing Enter never submits accidentally.

| Measurement                                              | Proposed exit budget                                                                                                                  | Proof                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Frame build/raster time during typing and history scroll | p95 ≤16.7 ms, p99 ≤33.3 ms at a controlled 60 Hz; no extension stall >100 ms                                                          | Release performance trace with separate base/A2UI/fallback runs                                                  |
| Input to visible paint                                   | p95 ≤50 ms, p99 ≤100 ms                                                                                                               | Timestamped input/frame fixture, including IME                                                                   |
| Local first editable frame                               | Cold p95 ≤2 s, warm p95 ≤500 ms; network auth measured separately                                                                     | 30 launches, cached signed-in state, network-independent editor frame                                            |
| Process memory                                           | Settled base chat ≤180 MiB; one open web fallback ≤350 MiB; retained growth ≤10 MiB after 20 cycles                                   | Android PSS/macOS physical footprint, same seeded fixture; comparable platform baselines retained                |
| Idle activity                                            | Foreground settled CPU <1% averaged over 60 s; zero periodic history polling; no client task keeping Agent work alive in background   | CPU/network/timer traces with no user input                                                                      |
| Reconnect                                                | Current projection visible within 2 s of restored authenticated transport, excluding an explicitly measured service outage            | Cut network before/after receipt, reset observer cursor, duplicate frames; no duplicate effects or implicit Stop |
| Conversation reads                                       | ≤512,000 bytes per page, ≤32 Runs and bounded indexed reads independent of total history; append invalidation fetches one recent page | Read-model query counters and payload size assertions at 100/1,000/10,000 Turns                                  |
| Extension work                                           | ≤262,144 document bytes, depth 16, 500 components, 128 KiB buffered updates, ≤10 applied batches/s                                    | Boundaries tested at limit and limit+1; rate overflow discards the pending region and requests a fresh snapshot  |
| Media and extension work per frame                       | ≤4 visible decoded images, ≤8 MiB decoded media, no autoplay, ≤4 ms extension batch budget                                            | Decode off UI thread where available, lazy media, deadline failure contained to the region                       |

The deterministic A2UI form renders from fixed Package data with zero model calls, validates fields, saves one durable command and replays its receipt after double-submit. The hostile document covers oversized/deep/cyclic data, unknown components/functions, HTML/script/native bridge payloads, duplicate action ids, undeclared input fields, stale revision, wrong owner, revoked capability, floods and chrome impersonation. Its expected result is a bounded host-owned unavailable/refusal state while chat, Stop and recovery remain usable.

Create, publish and open one **real Applet**, mutate a value, reconnect and confirm persisted state through the isolated fallback. Keep the Computer hibernated throughout the Applet test. Separately open the Computer viewer intentionally and verify its lease and reconnect behavior. Suspend, kill the client, evict the owning DO and resume after uncertain send/Stop boundaries; every command has one durable receipt and terminal or resumable outcome. Accessibility and native editing are device checks, not screenshot judgments.

## Slice 0 — Repair and prove existing invariants

Land the review's failed-activation/data-preservation and concurrent-publication/pinned-call regressions first. Inspect the actual fixes already landing; do not duplicate another session's work. Then prove indexed history, observer reconnect and durable cold recovery. Triage reachable vulnerable dependency paths rather than coupling native work to a blanket dependency rewrite.

During phase 1, [PR #253](https://github.com/timoconnellaus/frockbot/pull/253) landed recoverable facet snapshots and refusal when an Applet call names a generation that is no longer resident; its workerd tests cover destructive failed activation and interrupted trials. The transcript read-cost ADR 0038 also landed indexed display reads. These are evidence for this slice, not completion of the newly required declared schema windows, live authorization checks or the full device/history fixture.

**Exit:** failed activation preserves prior code and data; publication cannot alter a pinned call; a revoked Connection prevents the next external effect; incompatible code undo is a visible refusal; cold recovery and history queries are bounded. These are backend gates before enabling the corresponding new native/extension behavior, not claims that phase 1 fixed them.

**Tests:** real workerd/facet storage migration and health-failure tests, overlapping publication/call latch, restart around intent/effect/result, revoke between tool steps, duplicate alarms and deliveries, 10,000-Turn query-count regression. Reuse the relevant Applet, observer and recovery suites and record merged PR/commit evidence in the slice before promotion.

## Slice 1 — Amend the constitution and define contracts

This PR: accepted amendment and one ADR; reviewed base inventory; JSON Schema source; generated TypeScript/Dart types and validators; shared positive/negative fixtures; compatibility constants and server refusal; platform and delivery gates. Keep existing decoders unless replacement equivalence is proven. Generated Dart DTOs expose validated typed object fields and scalar values, preserve JSON union discriminators, and round-trip the wire data; they are not a Flutter application.

**Exit:** authority, trust, version and migration rules are explicit; regeneration is deterministic; every named schema has valid/invalid examples; mapped production decoders agree with fixtures; unsupported negotiation is refused before application loading. No production A2UI manifest activation or native UI is claimed.

**Tests:** `bun install --force`; `bun run typecheck` (including schema freshness, kernel/provider-host import checks and generated artifact checks); touched-package `bun test`; `bun run format:check`; `bun scripts/check-ui-styles.ts`; shared Dart fixture runner and `dart analyze apps/native`. Verify the gateway refusal with a loader that must never run. These checks establish phase-1 contract behavior, not device qualification.

## Slice 2 — Prove one native vertical slice on Pixel and desktop

Build an isolated Flutter prototype alongside Vue against the production backend architecture. Extract the three public backend contracts above as needed, with no native-specific business rules. Deliver system-browser PKCE/verified-link auth, Bot selection, paged chat, send/explicit Stop/uncertain-delivery lookup/reconnect, one deterministic A2UI form, one hostile document, and one real Applet in the fallback WebView. Persist command ids before sends and OS-protect sessions. Bind compatibility metadata to native sessions. Preserve the Android upgrade identity and signer.

**Exit:** the complete flow runs on Tim's Pixel 9a and macOS desktop with exact pins, isolation and release-mode budgets recorded. The Applet works with the Computer hibernated. Client death and DO eviction preserve work and history; denied/missing catalog only affects its region. No adoption decision is based solely on a simulator or mock Applet. Failure is a useful stopping point: keep Vue and record the failed technology boundary.

**Tests:** shared protocol fixtures in Dart and TypeScript CI; gateway auth/PKCE replay and redirect tests; same backend contract suite through browser and native adapters; real-device acceptance fixture; signer/version upgrade assertion; malicious WebView cookie/frame/bridge inspection; deterministic form duplicate action and stale/revoked action tests; forced socket loss and process-kill trace correlated to durable receipts.

## Slice 3 — Deliver the native base alongside Vue

Complete trusted Models, Connections, settings, audit/undo/recovery, extension management, search, voice/files/sharing/notifications and native platform behavior. Extract permanent base modules incrementally while retaining narrow extension APIs and the minimal kernel. Keep the browser production path and existing Applet fallback. Ship compatible-client handling and a signed update route for every enabled distribution target. Qualify iOS and any additional desktop architecture separately.

**Exit:** core workflows have native/browser parity over one owner/command path; no local authority or client-specific product rule; no trust chrome depends on extension availability. Every enabled platform passes its distribution, version and accessibility gates. Deferred capabilities stay explicit prototypes or are declined through the parity-register process.

**Tests:** paired renderer scenarios against one backend, exact single settings home and disabled-override tests, corrupt-extension recovery/undo, old supported client and minimum-version refusal, revoked session and native storage inspection, voice/media interruptions, unread deduplication, deep links, file/clipboard permissions and lowest-device performance fixture. Review dependencies/imports to prove Dart carries no Agent loop or provider secrets.

### C1 — Settings and Models (2026-09-05)

The User owner supplies shared, bounded settings frames, searchable model pages
and revisioned, owner-bound commands to Vue and Flutter. Account model choice is
permanent; the optional Custom models Package holds only Bot overrides. Choosing
a provider installs its manifest dependency closure, and credentials remain on
the same-User backend Models surface. Disabled Package fields disappear while
captured overrides survive. Profile prefill comes from authenticated identity
without changing stored profile data on read.

Paired gateway scenarios cover both credentials over one User owner, save,
duplicate replay after owner eviction, stale revisions and cross-account
refusal. Native tests cover retained uncertain saves, large text in both themes,
search races and explicit default intent. The previous released settings DTO and
model resolver exercise the bounded compatibility projection. See the
[settings seam plan](native-settings.md) and [acceptance ledger](native-acceptance-2026-09-05-slice3.md).

The Pixel was unlocked again after the orchestrator restart; captures of these
new screens await C1 deployment so the device can use its production session. Local
macOS release captures use a test account through the production Worker harness;
they do not qualify production macOS sign-in or the remaining device budgets.
Connections, unread/deep links and Bot recovery remain subsequent milestones.

### C2 — Connections (2026-09-05)

Native Connectors is reached from Settings and projects the same User-owned
Connection lifecycle as Vue, with one entry per account. It excludes model
provider accounts (Models), revoked accounts and disabled Package surfaces.
Only bounded labels, service names and states reach Dart; provider errors,
metadata, tokens and credential records do not. Catalog search and grant,
reconnect and revocation controls use the existing trusted backend Connectors
surface in the system browser. Returning refreshes the native projection.

The paired gateway scenario completes a browser grant, replays its callback,
evicts the User owner and observes one ready Connection in native, then revokes
it and checks both Users' views. Native tests cover offline recovery, handoff
origin refusal, return refresh, single-home navigation, 200% text and reduced
motion. See [the Connections seam plan](native-connections.md). The dated
acceptance ledger records release captures and remaining physical gates.

## Slice 4 — Qualify A2UI and Compose independently

Promote the qualified A2UI manifest/catalog/action contract with immutable snapshots, declared slots, live subset checks and host unavailable states. In a separate backend slice, pin one reviewed vendored `@frockbot/compose-*` commit behind a FrockBot adapter and run one real extension. Native rendering must remain releasable without a wholesale Cordis-to-Compose rewrite.

**Exit:** both renderers consume the same qualified surface/action records; exact catalog negotiation works; untrusted source cannot select an in-process host. Compose may ship only when redirects stay inside granted origins, credentials cannot cross a redirect, request options are decoded from a whitelist, deadlines and response reads are bounded, and durable pinning/recovery/facet schema guards remain FrockBot-owned. Adoption or rejection does not block the native base.

**Tests:** valid/hostile catalog corpus in both renderers; recorded snapshot replay; cross-User/stale/revoked action refusal and idempotency; synthetic-credential cross-origin redirect test; omitted/untrusted host refusal; incompatible schema revert and failed health rollback; eviction and concurrent publish while an extension call is pinned. No live credential is used for the redirect probe.

## Slice 5 — Make explicit retirement decisions

Decide Capacitor/Electron retirement per platform only after installed-user upgrade, native parity and signed distribution work. Decide Flutter Web separately from Flutter native. Decide whether any Applet deserves an optional A2UI view without removing the web fallback for existing Applets. Update architecture docs and forward migrations when a mechanism is actually removed; old ADRs remain history.

**Exit:** each removal has an owner-accepted capability/upgrade decision, a supported replacement and recovery evidence. No minimum-version bump strands an installed client. No dormant compatibility implementation preserves a removed feature. The Computer viewer and Applets retain a working route.

**Tests:** upgrade from the previous released client/store shape, supported-window expiry and plain update response, browser fallback parity, existing Applet data/version recovery, Android same-signer install, removed-runtime import/dependency scan and final rule-by-rule constitutional review before the retirement PR.

## Phase-1 constitutional review

| Rule family                                                    | Phase-1 evidence and remaining gate                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product intent, constitutional gate, minimal kernel            | Explicit accepted amendment and ADR; native is beyond parity; no kernel expansion or Package import; kernel import check                                                                                         |
| Authorities, durable effects, Computer/Workspace, Memory       | Existing owners and effect paths retained; compatibility refusal happens before dispatch and has no state/effect; touched runtime/recovery tests; native and new action admission remain slice-2 gates           |
| One production path, explicit seams, plugin-owned integrations | One schema and compatibility adapter at the gateway; both language fixtures; no native-specific backend policy, provider adapter or alternate Agent loop                                                         |
| Configuration and settings surfaces                            | Inventory preserves one home and account-wide availability; generic settings projection is a planned shared adapter, not a new live control                                                                      |
| Composition, self-modification, Package contributions          | New kind is defined but not activated; no extension/native code is loaded; schema/storage and live-grant rules have explicit slice-0/4 regression gates before use                                               |
| Feature rule, architecture checks                              | Scope and owners above; version refusal tests, deterministic generation, existing-decoder conformance and touched-package checks; device/isolation/performance claims deferred to their explicit prototype gates |
| Landing and documentation roles                                | Three deliverable commits, reconcile main/ADR numbering, PR and CI watch through merge; no deployment tag; mechanisms in architecture docs, temporary gates here, decision in one ADR                            |

This review licenses only the phase-1 documents/contracts and compatibility response. A later slice must attach its own completed feature-rule and rule-by-rule evidence; the plan is not an exception allowing unfinished native or extension controls into production.
