---
status: accepted
---

# Make Cordis the application spine

FrockBot uses pinned upstream Cordis as the composition and lifecycle spine in the hosted backend, Cordis WebUI/Vue client, and optional native platform shells. FrockBot owns a custom event-sourced agent loop rather than retaining Pi or consuming DeepSeek Harness as its runtime, because the product requires every host, Agent, and UI capability to participate in one plugin-oriented architecture while preserving explicit runtime seams.

## Considered options

- **Pi-native desktop:** reached a working vertical slice quickly, but leaves the desktop package/UI lifecycle beside a separate agent-extension kernel.
- **Cordis host with Pi adapter:** reduces host coupling but retains two authoritative plugin and lifecycle systems.
- **DeepSeek Harness runtime or vendored Cordis:** provides a proven reference architecture but carries a large, materially patched private fork and product-specific contracts.
- **Pinned upstream Cordis with a FrockBot loop:** chosen to keep ownership of product contracts while localizing prerelease Cordis churn behind FrockBot interfaces.

## Consequences

The Pi-backed React application was retained at Git commit `0d5a41e` as a rollback point after the custom loop and Cordis WebUI reached parity. Each runtime owns an independent Cordis root; cross-runtime communication uses versioned DTOs rather than service proxies. Cordis lifecycle isolation is never treated as a security boundary, and exact upstream package pins must pass Electron, Bun, loader, WebUI, and disposal proofs before product capabilities build on them.
