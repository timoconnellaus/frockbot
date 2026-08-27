---
status: accepted
---

# Make Cordis the application spine

FrockBot will use pinned upstream Cordis as the composition and lifecycle spine in Electron main, the agent utility process, and the Cordis WebUI/Vue renderer. FrockBot will own a custom event-sourced agent loop rather than retaining Pi or consuming DeepSeek Harness as its runtime, because the product requires every host, agent, and UI capability to participate in one plugin-oriented architecture while preserving explicit process seams.

## Considered options

- **Pi-native desktop:** reached a working vertical slice quickly, but leaves the desktop package/UI lifecycle beside a separate agent-extension kernel.
- **Cordis host with Pi adapter:** reduces host coupling but retains two authoritative plugin and lifecycle systems.
- **DeepSeek Harness runtime or vendored Cordis:** provides a proven reference architecture but carries a large, materially patched private fork and product-specific contracts.
- **Pinned upstream Cordis with a FrockBot loop:** chosen to keep ownership of product contracts while localizing prerelease Cordis churn behind FrockBot interfaces.

## Consequences

The Pi-backed React application remains a rollback point until the custom loop and Cordis WebUI reach parity, then is removed. Each process owns an independent Cordis root; cross-process communication uses versioned DTOs rather than service proxies. Cordis lifecycle isolation is never treated as a security boundary, and exact upstream package pins must pass Electron, Bun, loader, WebUI, and disposal proofs before product capabilities build on them.
