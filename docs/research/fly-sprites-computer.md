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

1. Use one stable Sprite name per FrockBot bot so browser profile and filesystem state persist.
2. Provision Chromium, Xvfb, a lightweight window manager, x11vnc, and noVNC in the Sprite.
3. Register the desktop stack as a Sprite service so it returns after hibernation.
4. Route noVNC through the Sprite HTTPS URL. Because an embedded iframe cannot attach an API `Authorization` header, use the public URL mode only for this service and protect noVNC with a high-entropy per-installation password passed in the viewer URL fragment so it is not sent in HTTP requests. The public exposure and password are FrockBot design choices, not guarantees supplied by Sprites.
5. Put an owner-scoped takeover lease file in the Sprite filesystem. Agent-side and desktop-side provisioning plus computer tools refuse new operations while another fresh human lease exists. The controlling desktop refreshes the lease periodically, removes only its own lease on release/disposal, and lets a replacement desktop atomically reclaim an expired lease after a short crash-recovery window. A failed heartbeat immediately re-shields the viewer and revokes the local UI's human-control state.
6. Keep the Sprites token only in desktop-host and agent-runtime processes. The trusted WebUI receives the noVNC URL/password through the existing authenticated loopback RPC, never the API token.
7. Use the SDK's cancellable HTTP exec path for bounded non-interactive commands; the pinned SDK's WebSocket `execFile` path does not honor `AbortSignal` or timeouts.
8. Treat takeover as coordination, not a complete security boundary: commands already running when takeover starts may continue briefly, and software inside the Sprite can observe its own display and filesystem.

## Configuration

Support `SPRITES_TOKEN` (the current SDK README spelling) and `SPRITE_TOKEN` (used by some first-party examples) for compatibility. Use `FROCKBOT_SPRITE_NAME` to override the stable default Sprite name.

## Verification limits

No Sprite token is available in the development environment, so automated tests must use fakes and live provisioning must remain an explicit manual/integration check.
