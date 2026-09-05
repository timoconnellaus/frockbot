# `@frockbot/compose-agent`

> Vendored from `tanstack-compose` commit `69163be` on 2026-09-05. At that
> commit the former public `compose-agent` package lived at
> `examples/shared/agent`; this package preserves its framework-neutral agent
> primitives while deliberately leaving out the example's OpenAI and
> Cloudflare model providers and React view adapter.

The package contains the Compose-based conversation loop, append-only session,
model/tool/prompt registries, composer integration, credentials abstraction,
and scripted test provider. It is a library only: FrockBot's running Agent loop
and model providers do not import it in this slice.

Use `@frockbot/compose-tools` for the framework-neutral tool definitions that
edit a Compose client. Provider implementations remain in FrockBot's existing
provider Packages.
