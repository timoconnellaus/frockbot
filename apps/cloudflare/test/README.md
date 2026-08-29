# Cloudflare runtime compatibility tests

`bun run test:workerd` runs the hermetic Durable Object compatibility suite in local Workerd. It does not read or expose a Sprites credential.

`bun run test:fly:workerd:live` is an opt-in boundary probe. It records the known incompatibility between Workerd response re-chunking and the Sprites HTTP exec framing used by provider workspace operations. The probe passes only when that specific failure is observed and always deletes its disposable `frockbot-test-*` Sprite.

The local shared-host compatibility prototype lives in `apps/fly-host-prototype`. Run its `test:live` script to verify streaming, files, cancellation, reconstruction, and cleanup through a Cloudflare Container.
