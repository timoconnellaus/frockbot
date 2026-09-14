# @frockbot/app/flock

Built-in Package for durable Bot registration and composable sheep identity.

- Gateway Contribution: authenticated exact v1 Bot directory and sheep routes.
- User Contribution: bounded directory, immutable registration seeds, optimistic revision, durable create receipts, and General: `provisionGeneral` registers it in the same transaction as the `flock:bootstrap:v1` marker when a directory is first read empty, so racing reads and an interrupted write leave exactly one or none, and a later delete never re-provisions it.
- Bot Contribution: idempotent materialization and durable sheep update receipts.
- Hosted client Contribution: Bot list/create/switch and responsive sheep picker in generic shell outlets.

The production asset manifest contains one canonical sheep, six backgrounds, and 43 approved wearable layers at 256×256. Runtime code never reads from `artifacts/`; Vite inlines the package-owned WebPs into the immutable hosted stylesheet.
