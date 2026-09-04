# `@frockbot/compose-frockbot`

The single adapter between FrockBot's versioned manifest and kernel wire
contracts and FrockBot Compose's slots, actions, context keys, and named grants.

The adapter is deliberately a collection of pure projections. It does not
mount a Package, mutate a Composition, compile source, schedule work, own
storage, or change the running product. Those responsibilities stay with the
existing kernel and Durable Object authorities. A later vertical slice can use
this seam to qualify one real extension without teaching the product about
Compose internals.

```ts
import {
  adaptFrockBotAuthorityV1,
  adaptFrockBotManifestV1,
} from "@frockbot/compose-frockbot";

const surface = adaptFrockBotManifestV1(untrustedManifest);
const authority = adaptFrockBotAuthorityV1(untrustedCapabilityList);
```

Both inputs cross existing exact decoders before they are projected. Applet
storage is exposed only for a declared Instance Contribution. Scheduling is a
command routed to the Bot's durable owner, never an ambient timer. Generation
projection likewise records that compilation occurs outside Durable Objects
and that activation begins with the next admitted Turn.
