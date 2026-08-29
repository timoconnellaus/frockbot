---
status: accepted
---

# Make Capacitor a thin host for the hosted WebUI

The mobile app now keeps only authentication and optional native capability adapters in its local Capacitor bundle, then renders the same hosted FrockBot WebUI used by browsers and Electron. A narrow exact `postMessage` seam proxies bearer-authenticated hosted requests and mobile capability commands between the hosted frame and the local shell, eliminating the former local `FrockBotWebData` product runtime.

## Considered options

- **Continue the local Vue product projection:** rejected because it duplicated Bot selection, Turn admission, settings, and feature UI, making hosted Plugins such as Flock unavailable without a second implementation.
- **Load the remote URL directly as Capacitor `server.url`:** rejected because production bearer authentication and optional native capability adapters would lose their explicit local authority seam.
- **Local auth/capability shell with a hosted frame:** chosen because core UI and backend protocols stay identical while bearer credentials and native commands remain behind one decoded bridge.

## Consequences

The hosted application permits only the `capacitor://localhost` and `frockbot://localhost` frame ancestors. The mobile parent validates the hosted origin and exact message source before forwarding requests; the hosted child is still same product code and never receives a persisted bearer token. Native capability host failure does not stop core hosted workflows. The deleted local Turn, Bot projection, and shell modules are no longer an alternate product runtime.
