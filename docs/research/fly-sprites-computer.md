# Fly.io Sprites computer integration

## Status

Primary-source research for a FrockBot Computer provider backed by Fly.io Sprites. The provider now implements `@frockbot/computer-core`; generic tools, memory, and viewer UI are owned by separate Packages.

## Documented capabilities

- A Sprite is a persistent Linux environment whose filesystem survives hibernation. Sending a command or HTTP request wakes it, and its filesystem state remains available across sessions. [Sprites quickstart](https://docs.sprites.dev/quickstart/)
- The official JavaScript SDK is `@fly/sprites`. `SpritesClient` creates, retrieves, lists, updates, and deletes Sprites; a `Sprite` supports command execution, detachable sessions, services, filesystem APIs, checkpoints, and port proxies. Command execution accepts an `AbortSignal`. [Official SDK README](https://github.com/superfly/sprites-js#readme)
- The SDK requires Node.js 24 or newer and defaults to `https://api.sprites.dev`. It authenticates API requests with a Sprites token. [Official SDK README](https://github.com/superfly/sprites-js#readme)
- Every Sprite has one HTTPS URL routed to its configured HTTP service. The URL is authenticated to Sprite organization members by default and may be changed to public access. A separate `sprite proxy` mechanism can expose arbitrary TCP ports locally, but it requires a running client-side tunnel. [Sprites networking](https://docs.sprites.dev/concepts/networking/)
- Sprite services are the supported mechanism for supervised processes that restart after crashes and return after cold wakes. An HTTP service may claim the Sprite URL's HTTP port. [Sprites services](https://docs.sprites.dev/concepts/services/)
- Exec sessions are WebSocket-backed and may be persistent/detachable. Processes started manually are not a substitute for services because hibernation can terminate them. [Exec API](https://docs.sprites.dev/api/dev-latest/exec/)
- Sprite checkpoints snapshot filesystem state but not in-memory process state. Restoring a checkpoint restarts the environment and terminates active sessions. [Sprites checkpoints](https://docs.sprites.dev/concepts/checkpoints/)
- noVNC's embedded viewer accepts connection settings, including `autoconnect` and `password`, from a URL query string or fragment. [noVNC embedding guide](https://novnc.com/noVNC/docs/EMBEDDING.html)

## Important gap

The first-party Sprites documentation does not describe a built-in graphical desktop, VNC server, noVNC client, Chromium automation API, or Chrome DevTools Protocol endpoint. A human-controllable browser therefore has to be provisioned as software inside the Sprite. This is an integration design, not a native Sprites feature.

## Integration design inferred from those capabilities

1. Use one stable Sprite per Bot and a separate non-viewer storage Sprite for User-scoped Package files. Expose both through the Computer workspace interface.
2. Create `/workspaces/<bot-key>` for shell work and Package-private durable directories under `/home/box/agent-data`. Memory owns its Markdown and index layout; the Fly provider does not inject memory or mirror sessions.
3. Derive a traversal-safe Bot key from persistent `botId`. Allocate each Bot a registry slot, Chromium profile, X display, CDP port, and VNC port.
4. Provision Chromium, Xvfb, a lightweight window manager, x11vnc, noVNC, and websockify in the Sprite. A single supervised gateway service serves noVNC and uses websockify's reloadable `TokenFile` routing to reach bot-scoped loopback VNC ports.
5. Route noVNC through the Sprite HTTPS URL. Because an embedded iframe cannot attach an API `Authorization` header, use public URL mode only for this gateway and protect each route with an opaque viewer token plus a high-entropy VNC password passed in the URL fragment. Public exposure, token routing, and passwords are FrockBot design choices, not guarantees supplied by Sprites.
6. Put an owner-scoped takeover lease under each Bot runtime directory. Serialize assertion, acquisition, renewal, release, and expired-lease replacement with `flock`. New process and browser operations refuse work while another fresh human lease exists; durable Package file operations remain available. A failed heartbeat immediately re-shields the viewer.
7. Keep the Sprites token only in the backend Fly provider Plugin. Hosted clients receive the selected Bot's noVNC URL/password through authenticated, decoded DTOs, never the API token.
8. Use the SDK's cancellable HTTP exec path for bounded non-interactive commands; the pinned SDK's WebSocket `execFile` path does not honor `AbortSignal` or timeouts.
9. Treat takeover as coordination rather than a security boundary for work already in flight. Bot isolation comes from assigning separate Sprites; Cordis contexts and directory names are not security controls.
10. Treat the memory Package's workspace-backed Markdown as canonical on desktop. Cloudflare uses its explicit R2 adapter. Vector indexes are derived; session events remain authoritative and are not mirrored by the Fly provider.

## Configuration

Production configuration uses `SPRITES_TOKEN`, matching the current SDK README; alternate spellings are not part of the hosted contract. `FROCKBOT_SPRITE_NAME` overrides the base name from which stable Bot and User storage Sprite names are derived. Standalone agent-runtime development may also set `FROCKBOT_COMPUTER_PROVIDER=fly-sprite`, `FROCKBOT_BOT_ID`, `FROCKBOT_AGENT_ID`, and `FROCKBOT_SESSION_ID`; hosted identity comes from durable backend authority instead of these process variables.

## Verification limits

No Sprite token is available in the development environment, so automated tests must use fakes and live provisioning must remain an explicit manual/integration check.
