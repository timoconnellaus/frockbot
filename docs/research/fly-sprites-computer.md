# Fly.io Sprites computer integration

## Status

Primary-source research for a FrockBot computer package backed by Fly.io Sprites.

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

1. Use one stable Sprite per FrockBot user/application so bots share a persistent Linux filesystem.
2. Create shared `/home/box` and `/workspace` roots. Under `/home/box/agent-data`, create bot-scoped profile, standing-memory, log, skills, automation-storage, and transcript-mirror directories plus shared user memory.
3. Derive a traversal-safe bot key from the explicit agent identity. Allocate each bot a persistent registry slot, Chromium profile, X display, CDP port, and VNC port.
4. Provision Chromium, Xvfb, a lightweight window manager, x11vnc, noVNC, and websockify in the Sprite. A single supervised gateway service serves noVNC and uses websockify's reloadable `TokenFile` routing to reach bot-scoped loopback VNC ports.
5. Route noVNC through the Sprite HTTPS URL. Because an embedded iframe cannot attach an API `Authorization` header, use public URL mode only for this gateway and protect each route with an opaque viewer token plus a high-entropy VNC password passed in the URL fragment. Public exposure, token routing, and passwords are FrockBot design choices, not guarantees supplied by Sprites.
6. Put an owner-scoped takeover lease under each bot runtime directory. Serialize assertion, acquisition, renewal, release, and expired-lease replacement with `flock`. Agent and desktop provisioning plus computer tools refuse new operations only while that bot has another fresh human lease. A failed heartbeat immediately re-shields the viewer.
7. Keep the Sprites token only in desktop-host and agent-runtime processes. The trusted WebUI receives the selected bot's noVNC URL/password through authenticated loopback RPC, never the API token.
8. Use the SDK's cancellable HTTP exec path for bounded non-interactive commands; the pinned SDK's WebSocket `execFile` path does not honor `AbortSignal` or timeouts.
9. Treat bot directories and takeover as coordination, not security boundaries: bots share one Unix account, commands already running when takeover starts may continue briefly, and software inside the Sprite can inspect shared files and displays.
10. Treat Sprite standing-memory files as the local desktop computer's canonical notes. Transcript files are derived mirrors of the event journal. Do not present cloud R2/Vectorize memory or cloud Durable Object transcripts as synchronized until an explicit one-way export exists. Automation folders are durable storage only; no scheduler exists yet.

## Configuration

Support `SPRITES_TOKEN` (the current SDK README spelling) and `SPRITE_TOKEN` (used by some first-party examples) for compatibility. Use `FROCKBOT_SPRITE_NAME` to override the stable shared Sprite name. `FROCKBOT_AGENT_ID` selects the desktop-host bot binding, `FROCKBOT_AGENT_NAME` supplies its display name, and `FROCKBOT_SESSION_ID` may separate a conversation journal from the stable agent identity.

## Verification limits

No Sprite token is available in the development environment, so automated tests must use fakes and live provisioning must remain an explicit manual/integration check.
