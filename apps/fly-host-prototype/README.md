# Shared Computer host — compatibility prototype (superseded)

**Superseded by [`apps/computer-host`](../computer-host/README.md).** This
directory is kept only as the record of the compatibility experiment that ADR
0004 required, and it is no longer deployed: `apps/computer-host` now owns the
`frockbot-computer-host` Worker script, its container, and its durable effect
journal.

What it proved, against a real disposable Sprite from inside a real Cloudflare
Container: streaming command output, file persistence, cancellation, adapter
reconstruction, and cleanup. What it did **not** prove, and what the production
host had to solve, is how a command large enough to matter reaches the Sprite
at all — the Sprites SDK puts a command's argv and environment into its request
URL, and Fly answers a ~2.5 KB query with HTTP 431. The production host ships
every script on the command's stdin instead. See ADR 0004's consequences.

Nothing here is a production path. Read `apps/computer-host` instead.
