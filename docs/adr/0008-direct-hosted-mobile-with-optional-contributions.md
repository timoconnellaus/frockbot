---
status: accepted
---

# Load the hosted WebUI directly and mount declared mobile Contributions

This decision supersedes [ADR-0005](0005-mobile-hosted-webui-cutover.md). Capacitor now navigates directly to the configured hosted application with `server.url`, so browser and mobile run the same hosted client, authentication, and backend transport without a local frame, bearer proxy, or product UI. A local Cordis root may mount only mobile Contributions declared by the immutable compiled application, in declaration order, against narrow Capacitor adapters.

## Considered options

- **Retain a local frame and API proxy:** rejected because it adds a second authentication and transport path around the hosted application.
- **Use direct hosted navigation with unrestricted native globals:** rejected because hosted code could reach capabilities not declared by the application.
- **Use direct hosted navigation plus a declared optional Contribution host:** chosen because core workflows use the production Web path while native capabilities remain explicit progressive enhancements.

## Consequences

The hosted origin is required at build time and is the WebView's top-level origin. Native mounting additionally requires the configured origin and immutable application deployment hash to match the loaded document. Capability calls use exact bounded invoke/result/error DTOs with cancellation and timeouts; no general API proxy or credentials cross this seam. Missing declarations, denied capabilities, or host startup failure leave the hosted application running with Web fallbacks and do not affect Agent execution.

Android Google sign-in follows the same boundary. A dedicated Capacitor plugin invokes Credential Manager and returns only a one-use ID token plus its nonce. The hosted auth Package submits both to Better Auth on the loaded origin, where the configured Web OAuth client ID is enforced as audience and the ordinary hosted session cookie is created. The Android OAuth client is registered in Google Cloud by package `com.frockbot.mobile` plus signing SHA-1; the app uses the matching Web client ID as Credential Manager's `serverClientId`.
