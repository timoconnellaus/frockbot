# Shared Computer host

This Worker is the replaceable, non-authoritative production Computer host selected in [ADR 0004](../../docs/adr/0004-host-fly-computer-in-cloudflare-containers.md). Bot Durable Objects call it through an internal service binding with exact provider-neutral effect DTOs. A durable journal records each effect identity before dispatch and replays completed outcomes without duplicating uncertain work. The container alone loads the Sprites SDK and `SPRITES_TOKEN`.

## Checks

```sh
bun run --filter @frockbot/computer-host typecheck
bun run --filter @frockbot/computer-host test
```

The opt-in live smoke requires Docker and `SPRITES_TOKEN` in gitignored `apps/fly-host-prototype/.dev.vars`:

```sh
bun run --filter @frockbot/computer-host test:live
```

The smoke starts Wrangler locally, builds the Node container, sends a decoded `/v1/computer/smoke` DTO, and verifies streaming command output, file persistence, cancellation, reconstruction, and cleanup against a disposable `frockbot-test-*` Sprite.
