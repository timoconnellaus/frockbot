# @frockbot/app/flock

Built-in Package for durable Bot registration and composable sheep identity.

- Gateway Contribution: authenticated exact v1 Bot directory and sheep routes.
- User Contribution: bounded directory, immutable registration seeds, optimistic revision, durable create receipts, and [General bootstrap](#general-bootstrap).
- Bot Contribution: idempotent materialization and durable sheep update receipts.
- Hosted client Contribution: Bot list/create/switch and responsive sheep picker in generic shell outlets.

The production asset manifest contains one canonical sheep, six backgrounds, and 43 approved wearable layers at 256×256. Runtime code never reads from `artifacts/`; Vite inlines the package-owned WebPs into the immutable hosted stylesheet.

## General bootstrap

The User Durable Object's `assertUserIdentity` calls `provisionGeneral` before answering admitted account requests, once per instance. The read-only signup-policy probe does not bootstrap an account or change admission policy.

When the directory is empty and no `flock:bootstrap:v1` marker exists, `provisionGeneral` registers General under a freshly minted id in the same transaction as the marker that names it. Concurrent calls and interrupted writes cannot leave a registration without its marker. Existing empty accounts are backfilled through the same path; accounts already owning Bots receive only the marker, preserving their registrations. The marker survives deletion, so General is never re-provisioned, and a fresh id avoids reusing an old tombstoned Bot object. The marker is additive: existing registration shapes and codecs are unchanged, so no incompatible stored-data cleanup is needed.

`readBootstrap`, exposed as authenticated `GET /api/bots/bootstrap`, projects the recorded id while the Bot remains registered, or `null` otherwise. Clients use this projection rather than inferring General from a name or directory order. See the [first-run guidance](../../README.md#getting-started) for client behavior.
