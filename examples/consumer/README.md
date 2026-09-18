# Consumer fixture

The empty-repo shape a second product starts from. It depends on the
workspace packages (the same names npm publishes) and writes only what
must be its own: an auth chooser, a `ProductConfig`, and a wrangler stub.

No brand lands here. DexFi's theme, avatars, Privy app and Cloudflare
account stay on that project.

```
src/auth-package.ts   #auth-package chooser; id is not AuthPackageIdV1
src/index.ts          createWorkerApp + Durable Object exports
wrangler.jsonc        bindings stub; greenfield migrations are the consumer's
flutter/              ProductConfig + runFrockBot
```

Install from this repository with path/workspace dependencies. A release
tag publishes the same names to npm; swap `workspace:*` / `path:` for
the tag version.
