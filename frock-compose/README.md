# `@frockbot/frock-compose`

The Bot isolate host. Untrusted code — Bot-authored and third-party — runs in a
loaded Worker with `globalOutbound` disabled and only its named grants; this
module is what loads it.

It mounts one Composition member's content-addressed artifact as a Dynamic
Worker, generates the wrapper that narrows the capability stub into the `ctx` a
Package author writes against, and registers the tools the isolate's health
report declares.

What a member declares about itself is a contract, not a host concern:
`PluginDescriptorV1` and the four vocabularies it names live in
`@frockbot/core/contracts`, and the failure phases activation records live in
`@frockbot/core/durable/composition-failure`.

```ts
import { BotIsolateContributionHost } from "@frockbot/frock-compose";
```
