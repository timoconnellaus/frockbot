---
status: superseded by ADR-0008
---

# Make Capacitor a thin host for the hosted WebUI

The mobile app now keeps only authentication and optional native capability adapters in its local Capacitor bundle, then renders the same hosted FrockBot WebUI used by browsers and Electron. A narrow exact `postMessage` seam proxies bearer-authenticated hosted requests and mobile capability commands between the hosted frame and the local shell, eliminating the former local `FrockBotWebData` product runtime.

## Considered options

- **Continue the local Vue product projection:** rejected because it duplicated Bot selection, Turn admission, settings, and feature UI, making hosted Plugins such as Flock unavailable without a second implementation.
- **Load the remote URL directly as Capacitor `server.url`:** rejected because production bearer authentication and optional native capability adapters would lose their explicit local authority seam.
- **Local auth/capability shell with a hosted frame:** chosen because core UI and backend protocols stay identical while bearer credentials and native commands remain behind one decoded bridge.

## Consequences

The hosted application permits only the `capacitor://localhost` and `frockbot://localhost` frame ancestors. The mobile parent validates the hosted origin and exact message source before forwarding requests; the hosted child is still same product code and never receives a persisted bearer token. Native capability host failure does not stop core hosted workflows. The deleted local Turn, Bot projection, and shell modules are no longer an alternate product runtime.

## Android Google sign-in addendum (2026-09-04)

[ADR-0008](0008-direct-hosted-mobile-with-optional-contributions.md) later replaced the local frame with direct `server.url` navigation. Under that current shape, Android authentication remains an optional native adapter: Credential Manager obtains a Google ID token and the hosted auth Package submits it to Better Auth's existing social sign-in route. The resulting cookie belongs directly to the hosted origin loaded by the WebView; the shell stores no session and owns no authentication state.

Google Cloud setup requires an Android OAuth client with package `com.frockbot.mobile` and the signing certificate SHA-1. The debug certificate is `4B:C8:B1:F9:6A:60:3A:99:25:77:66:E0:D8:9F:45:54:82:82:F8:98`; a release certificate must be added when a release keystore exists. The app's `FROCKBOT_GOOGLE_WEB_CLIENT_ID` value is the Web OAuth client ID used by the Worker as `GOOGLE_CLIENT_ID`, not the Android OAuth client ID. Credential Manager sends that Web client ID as `serverClientId`, making it the ID token audience; `GOOGLE_CLIENT_SECRET` remains server-side.

This mobile-shell repair is beyond parity. Better Auth in the cloud remains authoritative for the durable User session and account linkage; the auth Package remains the single hosted sign-in surface. Destroying the Android shell cancels an outstanding Credential Manager request, while a client disconnect after submission leaves the server response unobserved and the User may safely sign in again through Better Auth's existing provider-account resolution. Durable Object eviction and Computer hibernation are irrelevant to the flow: it uses neither a Bot Durable Object nor the Computer. Native cancellation, missing-account, malformed-response, and verification failures are shown as plain retryable messages, and tests cover the shell configuration, strict native DTO, cryptographic issuer/audience/nonce checks, and hosted session-cookie creation.
