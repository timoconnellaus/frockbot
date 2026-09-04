# Client renderers and extension hosts

The implemented browser client is Cordis WebUI/Vue. Electron opens the hosted UI; Capacitor Android and iOS use direct `server.url` navigation with optional native Contributions. These are the current mechanisms, preserved during the native rollout. `apps/mobile/android` remains the installed Android identity and signing baseline.

The accepted native direction uses Flutter for permanent app behavior and A2UI through a compiled, reviewed FrockBot catalog for extension regions. A separate untrusted WebView hosts existing Applets and the Computer viewer. No Flutter application is implemented in phase 1. The qualification and retirement gates live in [the native plan](../plans/native-app.md).

Backend conversational execution stays in the Bot Durable Object. Current extension execution uses Cloudflare Worker Loader / Dynamic Workers with `globalOutbound` disabled. Applet server classes mount as Durable Object facets under `AppletState`; composition code owns no facet storage. The Fly Sprites SDK remains inside the Computer host adapter. These are hosting choices implementing the constitution's authority, isolation, provenance and durability guarantees.

Compose is being vendored independently as `@frockbot/compose-*`. Native rendering does not depend on its completion or a wholesale replacement of Cordis. Qualify it behind one backend adapter; TypeScript composition helpers are not a Dart renderer or an Agent runtime.
