---
status: superseded by ADR-0005
---

# Add mobile as a FrockBot host environment

FrockBot treats mobile as an optional platform shell around the hosted backend protocol. `apps/mobile` ships a Capacitor application whose WebView reuses the hosted Vue shell through a fetch-driven `FrockBotWebData`, while its bundle owns a Cordis root that mounts `mobile` Contributions against device capabilities. Agent execution and durable product authority remain in the cloud backend.

## Considered options

- **Responsive web only:** no store presence and no path to device capabilities such as notifications, clipboard, or share, which are the reason a mobile host exists at all.
- **React Native or native clients:** best platform fidelity, but a second UI stack with no share of `@frockbot/webui-shell` and a second set of product contracts.
- **Capacitor WebView with an embedded agent runtime:** would put model credentials and the agent loop on the device and duplicate the gateway's session ownership.
- **Capacitor WebView as a gateway client with a local mobile Cordis root:** chosen. The interface is the shared Vue shell, turns stay server-side behind one authenticated seam, and device capabilities remain plugin-oriented rather than hard-coded into the UI.

## Consequences

Authentication uses bearer tokens rather than cookies, because a WebView origin (`capacitor://localhost` on iOS, `frockbot://localhost` on Android) cannot rely on third-party cookie behavior. The client reads the token from the `set-auth-token` response header, persists it through Capacitor Preferences with a `localStorage` fallback, replays it as `Authorization: Bearer`, and sends `credentials: "omit"`. A 401 clears the stored token and returns the app to its connect screen. The gateway admits the app only when its origin is listed in the `ALLOWED_CLIENT_ORIGINS` wrangler variable, and preflight allows only the `authorization` and `content-type` request headers, so no FrockBot-specific request header can carry identity from a mobile origin.

The package model gains a `mobile` contribution kind. `@frockbot/mobile-core` declares the contracts — a `MobileCommandRegistry` plus abstract notification, clipboard, and share capabilities — `apps/mobile` provides them from Capacitor with browser fallbacks, and `@frockbot/plugin-mobile-notifications` and `@frockbot/plugin-mobile-clipboard` consume them without importing any device API. This keeps architecture principle 4 intact: definitions, providers, and consumers stay in separate packages.

A bundled host cannot `import(specifier)` an arbitrary package path, so the mobile host registers `LocalCordisContributionHost("mobile", root, resolver)` with a static resolver over statically imported contributions, mirroring the agent runtime. Installing a mobile package therefore requires a new application build until a signed, reviewed contribution channel exists.

Device capability failures surface as ordinary command failures. Notification and clipboard permission denials, and an unavailable Web Share target, reject the invoked command rather than degrading silently, so the UI reports them like any other turn error.

Turn commands use the shared hosted protocol. After an uncertain admission, the client repeatedly performs authenticated run lookup and, when no run is visible, durably fences that run ID before reopening submission; stopping or switching observers detaches this reconciliation without cancelling admitted backend work. The Plugins catalog is projected from the hosted immutable application manifest. Native OAuth/deep-link return is still absent, so mobile hides the Plugins surface instead of exposing a Connection flow it cannot complete. App-store review of an application whose behavior is served from a gateway bundle remains unresolved and may constrain how much of the interface can change without a new release.
