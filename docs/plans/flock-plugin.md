# Flock Plugin Plan

## Status

Implemented on this branch: the full durable Bot directory/create/switch flow, built-in Flock Package Contributions, exact hosted protocols, Bot membership enforcement, durable sheep updates, responsive hosted picker, and promoted approved asset collection.

Approved product direction: add a complete durable Bot directory/create flow and a built-in `@frockbot/plugin-flock` Package. Every created Bot receives a composable sheep identity. The hosted editor supports rerolling the whole sheep and choosing background, headwear, facewear, and neckwear independently. All visually approved prototype assets are promoted into package-owned production assets with recorded provenance and hashes.

## Constitutional feature definition

1. **Authoritative backend owner:** the Flock Package owns a User-runtime Bot directory Contribution and a Bot-runtime sheep-identity Contribution. The User Durable Object remains authoritative for User ownership and Bot registration; each Bot Durable Object remains authoritative for its materialized profile, sheep recipe, settings, sessions, and execution.
2. **Durable state, commands, and events:** the User contribution stores a bounded versioned Bot directory, optimistic revision, registration seeds, and create receipts keyed by command ID and fingerprint. The Bot contribution stores a versioned sheep recipe, revision, and update receipts. Exact v1 list/create/read/update DTOs cross hosted seams. Creation is an atomic directory admission; first Bot materialization idempotently applies its admitted profile/model/sheep seed.
3. **Disconnect and eviction:** browser disconnect never cancels admitted creation or updates. Directory admission is one User Durable Object transaction. Bot materialization has no external effect and is safe to repeat after eviction from the admitted registration seed.
4. **Cancellation, retry, idempotency, and reconciliation:** an atomic create/update has no post-admission cancellation state; closing the dialog before submit cancels locally. Duplicate command delivery returns the original receipt, fingerprint collisions fail, and stale revisions fail explicitly. Partial Bot materialization retries from the same immutable seed without duplicating an external effect.
5. **Authority and trust:** every Bot-scoped settings, Turn, run, fence, reconciliation, notification, and sheep request verifies User directory membership before touching Bot storage. Caller values are exactly decoded and bounded. Raster assets are immutable client artifacts; no credential or secret enters the recipe or bundle.
6. **Hosted UI and platform behavior:** a hosted Vue Flock client Contribution mounts into generic shell sidebar and overlay slots. It owns Bot list/create/switch and sheep picker UI. Browser, Electron, and mobile shells use that same hosted Contribution; no native process is required.
7. **Failures and recovery tests:** unknown Bots return 404 without storage writes; duplicate IDs, invalid recipes, stale revisions, and command collisions are visible typed failures. Tests cover reconstruction, duplicate delivery, explicit Bot IDs on transports, stale-response suppression, all Bot route membership checks, asset integrity, and deterministic composition at 32/64/256px.

## Module shape

`@frockbot/plugin-flock` is one deep product module with four declared Contributions:

- `host: "gateway"`: authenticated, exact `/api/bots` and `/api/bots/:id/sheep` routes;
- `host: "user"`: durable directory admission, receipts, and registration lookup;
- `host: "bot"`: idempotent sheep materialization and durable sheep updates;
- hosted `client`: Bot list, creator, switcher, avatar renderer, and picker.

The shell exposes only generic sidebar/overlay/identity slots and Bot-selection state. It does not contain sheep policy or asset knowledge. The Flock package owns recipe validation, legal dependency paths, randomness, composition order, labels, and assets.

## Creation protocol

1. Client loads the bounded authoritative directory before choosing an active Bot.
2. Creator chooses a client-generated Bot ID and command ID, displays a random valid recipe, and optionally edits it.
3. `bot/create` is decoded by the Flock gateway Contribution.
4. The User Flock Contribution transaction checks the receipt/fingerprint, expected directory revision, uniqueness and limit, snapshots the current new-Bot model default, writes the registration seed and applied receipt, and increments the directory revision.
5. The client may navigate only to a registered Bot.
6. The first Bot RPC resolves the registration before any Bot storage write, then idempotently materializes shell settings and the sheep recipe from that seed.

No model, Sprite, Connection, or provider call occurs during creation.

## Compatibility scope

This remains a pre-user system. The old arbitrary `?bot=` lazy-creation behavior is removed rather than preserved behind a second path. An unknown query-selected Bot opens creation onboarding and performs no durable Bot write. There is no historical Bot enumeration or migration fallback.

## Asset promotion

Only the 43 approved wearables, six vivid backgrounds, and canonical white sheep used by the validated prototype are copied under the Flock package. They are resized for avatar UI, composed in declared dependency/z-order, and accompanied by a machine-readable manifest containing source provenance, dimensions, and SHA-256 hashes. The runtime never imports from `artifacts/`.

## Verification

- exact DTO decoding and unknown-field rejection;
- atomic User directory create receipt, replay, collision, conflict, duplicate ID, and limit;
- unknown Bot rejection before any Bot storage write across every route;
- idempotent Bot materialization after contribution reconstruction;
- sheep update receipt/replay/collision/conflict;
- valid catalog IDs and parent paths only;
- production asset manifest hashes and dimensions;
- explicit Bot ID on every Bot-scoped client transport method;
- Bot switching aborts/detaches observers and ignores stale responses;
- hosted creator/picker smoke test at desktop and 390px mobile;
  - `flock-plugin-desktop-smoke.png` captures the production hosted creator;
  - `flock-plugin-390px-smoke.png` captures the 390×844 creator with measured `scrollWidth=390`, dialog width 370, and no horizontal overflow;
- Capacitor thin-shell proof: local auth/native bridge frames the hosted WebUI and contains no local Bot/Turn product runtime;
- 32/64/256 avatar readability and unchanged unrelated production assets.
