# `@frockbot/compose-frockbot`

The Bot isolate host. Untrusted code — Bot-authored and third-party — runs in a
loaded Worker with `globalOutbound` disabled and only its named grants; this
package is what loads it.

It mounts one Composition member's content-addressed artifact as a Dynamic
Worker, generates the wrapper that narrows the capability stub into the `ctx` a
Package author writes against, and registers the tools the isolate's health
report declares.

```ts
import { BotIsolateContributionHost } from "@frockbot/compose-frockbot";
```
