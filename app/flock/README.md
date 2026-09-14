# @frockbot/app/flock

Built-in Package for durable Bot registration and composable sheep identity.

- Gateway Contribution: authenticated exact v1 Bot directory and sheep routes.
- User Contribution: bounded directory, immutable registration seeds, optimistic revision, durable create receipts, and General: `provisionGeneral` registers it under a freshly minted `general-<hex>` id in the same transaction as the `flock:bootstrap:v1` marker that names it, when the directory is empty and no marker exists, so racing calls and an interrupted write leave exactly one or none, a later delete never re-provisions it, and a tombstoned Bot object is never reused. `readBootstrap` is the only answer to which Bot is General.
- Bot Contribution: idempotent materialization and durable sheep update receipts.
- Hosted client Contribution: Bot list/create/switch and responsive sheep picker in generic shell outlets.

The production asset manifest contains one canonical sheep, six backgrounds, and 43 approved wearable layers at 256×256. Runtime code never reads from `artifacts/`; Vite inlines the package-owned WebPs into the immutable hosted stylesheet.
