# Plan: the Bot as the primary path for change

## Status

Implemented and integrated 2026-09-02. ADR 0019 supplies account-wide enablement and model resolution; ADR 0020 and the accepted `AGENTS.md` amendment add the Bot-driven authoring, Catalog, hook, undo, inspection, and iframe layers on that authority model.

## Intent

A non-technical User connects accounts, chats, and says "undo". The Bot does everything else to its own setup — authoring, installing from the ecosystem, revising, reverting — immediately, visibly, and revertibly. There is one plugin model with two contribution kinds, one trust bit, and five Bot verbs:

- **Backend contribution**: code in the Bot's isolate with the Bot's bindings; registers tools and hooks loop events.
- **UI contribution**: an HTML page mounted in a named slot as a cookieless-origin sandboxed iframe with a small bridge.
- **Trust**: first-party runs in-process; everything else runs in an isolate or an iframe.
- **Authority**: account-wide enabled Packages and the User's Connections, changed by the User out of band; every Package in one Bot Composition receives the same Bot authority projection.
- **Verbs**: `search`, `inspect`, `install`, `author`, `undo`.

The desktop app is a shell around the hosted UI plus the "this computer" Connection; native abilities are tools on that Connection. No separate desktop contribution host.

Deliberately not in this plan (decided 2026-09-02, "lock down later where the log shows it is needed"): per-Package grants, envelopes, approval cards, effect classes, confirmation guards, egress rules, signed indexes, revocation lists, a loop phase taxonomy, declarative UI vocabularies, a command registry, desktop declarative blocks, per-Package spend accounting.

## Slice 0 — Constitution amendment + ADR 0020

Deltas to `AGENTS.md`: a Bot may install Packages; account-wide Package enablement and Connections are User acts and are never requested by the Bot; a required core set; loop policy may run in an isolate; undo is a Bot-callable revert of setup generations. Gate: human acceptance. Accepted 2026-09-02.

## Slice 1 — Account-wide enablement projected as Bot authority

ADR 0019 removes per-Bot Assignments: Package installation and enablement are User-level, the Bot holds every Connection its User made, and model resolution follows the enabled `role: "model"` Package setting at Bot scope, then User scope, then the platform model. The isolate's `CAPABILITIES` is "what the Bot has": `model`, `tools.invoke`, `memory`, `workspace`, `connection(id)` leases, `notify`, and `schedule`. There is no authority-request or pending-authority-decision surface; a missing, disabled, or revoked Connection is `unavailable` and records a visible, repairable failure. Gate: an unconfigured Bot and its isolate use the platform model; a Package uses a connected service with no grant step; an unconnected one gets `unavailable`; identity or binding changes yield a new isolate.

As built, one mount snapshots every ready User Connection without credentials, the resolver's effective model binding, the active tool registry, Memory and Workspace availability, notifications, and durable scheduling; every Package receives that same projection. `isolateBindingDigestV1` hashes User identity, Bot identity, the mounted Composition generation, sorted `(connectionId, generation)` pairs, and the effective model binding into the loader identity, while the loopback stub pins returned leases to those admitted generations. The Assignment store and controls, authority-request and pending-decision DTOs, and MCP Bot-requested authorization command are gone; every missing seam returns `{ status: "unavailable", reason }`.

## Slice 2 — Authoring made solid, undo, binding catalog

Fixes from the 2026-09-02 review: required core set enforced in the composition decoder (F1); a real, stored, decodable manifest and no `model` field (F2); declared tools must equal exported tools (F3); tool-name collisions refused at author time (F4); mount failures delivered to the Bot as durable input (F5); new generations parent on last-known-good (F6); TypeScript source retained beside the artifact and shown in the inspect view (F7). New: `package_undo` (Bot-origin revert reusing the existing revert path; last-known-good set only by a successful mount) and `package_inspect_self` (a generated, drift-tested catalog of the isolate `ctx` contract plus the Bot's current Composition and failures). Gate: one failing-then-passing test per item; a Bot authors a broken Package, learns why next Turn, appends a fix, and later undoes it — all through chat.

## Slice 3 — Catalog + install by chat

Extend the existing remote Catalog (ADR 0014: today an entry names a reviewed first-party Package and records `catalog` provenance) so an entry may also name a hash-addressed, non-first-party bundle with a real manifest; ADR 0008 publication is the supply side, and such an entry mounts in the isolate like any Bot-authored Package. Bot tools `package_search`, `package_inspect`, `package_install {catalogId, contentHash, summary?}`, `package_update {catalogId, contentHash, summary?}`, `package_remove {packageId, summary?}` (non-core). Delisting is a platform action: it moves `catalog/current` to a generation without the entry but deletes no immutable entry or artifact and changes no User installation or Bot Composition, so an already-installed Package keeps running until the User or Bot removes or undoes it; delisting never revokes it. Implemented in Slice 3 with bounded generation summaries and Catalog-aware `package_undo`. The integrated workerd proof covers the whole transition: a hash-pinned install sees missing authority as `unavailable`, a ready Connection changes the binding digest and activates a new isolate without a grant step, and undo removes the installation and appends a revert.

## Slice 4 — Loop events as Cordis waterfalls

Expose the events the loop already emits (`turn/start`, `model/request`, `tool/call`, `tool/result`, `turn/end`, …) as Cordis waterfalls; migrate first-party memory, Skills, and prompt injection onto them with zero behaviour change (suite green, no test edits); then admit isolate-hosted hooks for non-first-party Packages. Deny-only guards stay first-party. Gate: a Bot-authored hook alters one step's tool list and the session log still reconstructs the exact request.

## Slice 5 — Iframe UI host

One host, one bridge (`callTool`, `subscribe`, theme tokens). First slots: the tool-result renderer and the settings panel. `package_author` accepts a UI page; it goes through the same bundler and is content-addressed. Core chrome is never Package-owned; Package surfaces are attributed. Gate: a Bot-authored Package renders its tool's output as a table and adds a settings form with no Package JavaScript in the page.

## Integration outcome

All five slices are integrated on ADR 0019's account-wide base. Main's Package-setting model resolver and Custom models Package replace Slice 1's provisional model assignment DTO. Slices 2–5 retain their first-party runtime hosts, immutable records and artifacts, generated isolate context, declared waterfall hooks, Package Catalog tools, and cookieless iframe path. The production Bot authority contains no per-Package grant, authority request, or pending authority decision.
