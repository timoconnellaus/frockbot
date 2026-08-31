---
status: accepted
---

# One Computer per User, shared by all Bots

FrockBot will provision one Computer per User and let every Bot the User owns share it, each with its own directories and desktop, and all sharing the User's browser profile so logins are a User-level asset, as they are in GrokBot. Separation between Bots on a Computer is organizational; the User's Computer is the trust boundary. This replaces the previous design of one Sprite per Bot plus a separate User storage Sprite.

## Considered options

- **One Computer per Bot:** real isolation between Bots and no shared browser state, but a Sprite per Bot multiplies cost and cold starts, and diverges from GrokBot, which runs all of a User's agents on one shared box with per-agent directories and X displays.
- **Per-User default with per-Bot opt-in:** flexible, but two provisioning modes in the Computer interface and a second isolation story to test.
- **One Computer per User:** chosen. It is what the parity target does, it lets Bots share logins and installed tooling, and it keeps one provider Sprite per User.

## Consequences

Bots on one Computer can read each other's files and share one cookie jar; the constitution therefore treats the Computer as the User's trust boundary, forbids every secret on the Workspace except the browser profile's own credential stores, and requires the kernel to load Skills only from a Bot's instruction roots — its own and its User's — written under the Bot's or its User's authority, with every durable-root write recording its writer. Per-Bot desktops, browser profiles, and directories are conventions the Computer provider Package enforces, not security controls. Package installations on the Computer are shared across Bots and are not guaranteed to survive an image rebuild; declared durable roots are.
