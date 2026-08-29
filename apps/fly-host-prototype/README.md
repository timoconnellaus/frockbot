# Shared Fly host compatibility prototype

This local-only prototype proves the versioned boundary selected in [ADR 0003](../../docs/adr/0003-host-fly-computer-in-cloudflare-containers.md): Bot Durable Objects call one logical, shared Computer host; Cloudflare routes each Bot deterministically across a bounded container pool; the container runs the Sprites SDK without owning canonical Bot state.

## Checks

```sh
bun run --filter @frockbot/fly-host-prototype typecheck
bun run --filter @frockbot/fly-host-prototype test
```

The opt-in live smoke requires Docker and `SPRITES_TOKEN` in the gitignored `apps/cloudflare/.dev.vars`:

```sh
bun run --filter @frockbot/fly-host-prototype test:live
```

The script starts Wrangler locally, builds the Node container, sends a decoded `/v1/computer/smoke` DTO, and verifies streaming command output, file persistence, cancellation, adapter reconstruction, and cleanup against a disposable `frockbot-test-*` Sprite. Temporary secret material and local processes are removed in a `finally` path.

This is a compatibility prototype, not a production Contribution. The prototype recognizes one local credential reference; production work must resolve User-scoped opaque references through the credential broker and add authenticated service-to-service authorization, durable effect reconciliation, and bounded load shedding before routing Bot work here.
