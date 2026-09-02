# Plan: the Bot as the primary path for change

## Status

accepted 2026-09-02; ADR 0019 and the `AGENTS.md` amendment gate slices 1, 3, 4 (isolate half), and 5. Slice 2 is inside the current constitution and runs now.

## Intent

A non-technical User connects accounts, chats, and says "undo". The Bot does everything else to its own setup — authoring, installing from the ecosystem, revising, reverting — immediately, visibly, and revertibly. There is one plugin model with two contribution kinds, one trust bit, and five Bot verbs:

- **Backend contribution**: code in the Bot's isolate with the Bot's bindings; registers tools and hooks loop events.
- **UI contribution**: an HTML page mounted in a named slot as a cookieless-origin sandboxed iframe with a small bridge.
- **Trust**: first-party runs in-process; everything else runs in an isolate or an iframe.
- **Authority**: the Bot's Connections, made by the User out of band; a Package has exactly the Bot's authority.
- **Verbs**: `search`, `inspect`, `install`, `author`, `undo`.

The desktop app is a shell around the hosted UI plus the "this computer" Connection; native abilities are tools on that Connection. No separate desktop contribution host.

Deliberately not in this plan (decided 2026-09-02, "lock down later where the log shows it is needed"): per-Package grants, envelopes, approval cards, effect classes, confirmation guards, egress rules, signed indexes, revocation lists, a loop phase taxonomy, declarative UI vocabularies, a command registry, desktop declarative blocks, per-Package spend accounting.

## Slice 0 — Constitution amendment + ADR 0019

Deltas to `AGENTS.md`: a Bot may install Packages; authority is per-Bot Connections made by the User out of band and never requested by the Bot; a required core set; loop policy may run in an isolate; undo is a Bot-callable revert of setup generations. Gate: human acceptance.

## Slice 1 — Authority = the Bot's Connections

Collapse Assignments to (Bot, Connection). The isolate's `CAPABILITIES` becomes "what the Bot has": `model`, `tools.invoke`, `memory`, `workspace`, `connection(id)` leases, `notify`, `schedule`. Remove `requestAuthority` and pending decisions from the Bot-facing surface; a missing Connection is `unavailable`. The loader binding digest keys on the Bot's Connection set. Gate (workerd): a Package uses a connected service with no grant step; an unconnected one gets `unavailable`; a Connection change yields a new isolate.

## Slice 2 — Authoring made solid, undo, binding catalog

Fixes from the 2026-09-02 review: required core set enforced in the composition decoder (F1); a real, stored, decodable manifest and no `model` field (F2); declared tools must equal exported tools (F3); tool-name collisions refused at author time (F4); mount failures delivered to the Bot as durable input (F5); new generations parent on last-known-good (F6); TypeScript source retained beside the artifact and shown in the inspect view (F7). New: `package_undo` (Bot-origin revert reusing the existing revert path; last-known-good set only by a successful mount) and `package_inspect_self` (a generated, drift-tested catalog of the isolate `ctx` contract plus the Bot's current Composition and failures). Gate: one failing-then-passing test per item; a Bot authors a broken Package, learns why next Turn, appends a fix, and later undoes it — all through chat.

## Slice 3 — Catalog + install by chat

Extend the existing remote Catalog (ADR 0014: today an entry names a reviewed first-party Package and records `catalog` provenance) so an entry may also name a hash-addressed, non-first-party bundle with a real manifest; ADR 0008 publication is the supply side, and such an entry mounts in the isolate like any Bot-authored Package. Bot tools `package_search`, `package_inspect`, `package_install {catalogId, contentHash, summary?}`, `package_update {catalogId, contentHash, summary?}`, `package_remove {packageId, summary?}` (non-core). Delisting is a platform action: it moves `catalog/current` to a generation without the entry but deletes no immutable entry or artifact and changes no User installation or Bot Composition, so an already-installed Package keeps running until the User or Bot removes or undoes it; delisting never revokes it. Implemented in Slice 3 with bounded generation summaries and Catalog-aware `package_undo`. Gate (workerd): hash-pinned install → missing authority is unavailable; the Bot describes what it installed in plain words; undo removes the installation and appends a revert. The connected → active half remains the Slice 1 Connection-binding gate: this branch still contains the pre-ADR Assignment binding in the separately owned isolate backend.

## Slice 4 — Loop events as Cordis waterfalls

Expose the events the loop already emits (`turn/start`, `model/request`, `tool/call`, `tool/result`, `turn/end`, …) as Cordis waterfalls; migrate first-party memory, Skills, and prompt injection onto them with zero behaviour change (suite green, no test edits); then admit isolate-hosted hooks for non-first-party Packages. Deny-only guards stay first-party. Gate: a Bot-authored hook alters one step's tool list and the session log still reconstructs the exact request.

## Slice 5 — Iframe UI host

One host, one bridge (`callTool`, `subscribe`, theme tokens). First slots: the tool-result renderer and the settings panel. `package_author` accepts a UI page; it goes through the same bundler and is content-addressed. Core chrome is never Package-owned; Package surfaces are attributed. Gate: a Bot-authored Package renders its tool's output as a table and adds a settings form with no Package JavaScript in the page.

## Lanes

Slice 2 runs now. Slices 1 and 3 start on acceptance of Slice 0, in parallel. Slices 4 and 5 follow, in parallel, with an integration lane at the end. Each lane is a Codex worktree with strict file ownership and a report listing changes it needs in files it does not own.
