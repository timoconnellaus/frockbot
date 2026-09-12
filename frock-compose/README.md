# `@frockbot/frock-compose`

The Plugin worker host. Untrusted code — Bot-authored and third-party — runs in
a loaded Worker with only its named grants and no network beyond what the User
approved; this module is what loads it.

It mounts every Plugin a Composition generation names into one Dynamic Worker
per User, behind a generated index (`plugin-worker-wrapper.ts`) that imports
each Plugin's content-addressed artifact, narrows the capability stub into the
`ctx` a Plugin author writes against, hands a provider's services to the
Plugins mounted after it, and runs an open hook over every enabled Plugin that
declared it. The host orders providers before consumers, registers the tools
and hooks each Plugin's health report declares, and names the Plugins it could
not mount instead of failing the whole generation.

What a member declares about itself is a contract, not a host concern:
`PluginDescriptorV1` and the vocabularies it names live in
`@frockbot/core/contracts`, and the failure phases activation records live in
`@frockbot/core/durable/composition-failure`.

```ts
import { PluginWorkerHost } from "@frockbot/frock-compose";
```
