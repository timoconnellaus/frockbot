/**
 * The egress handler for the Sprites API.
 *
 * Interception is what makes the container's allowlist mean anything, and the
 * proxy that enforces it ends in a plain `fetch`. That is enough for the REST
 * half of the SDK and not for the other half: `exec` — every shell command,
 * `computer_doctor` included — is a WebSocket, and a proxied upgrade only
 * completes if someone accepts both ends and pumps between them. Without that
 * the container gets a response with no usable upgrade and the SDK reports
 * `WebSocket error: Invalid Upgrade header`.
 *
 * So this does for outbound what the library already does for inbound: pass
 * anything that is not an upgrade straight through, and for an upgrade, bridge
 * the socket the origin returned to a fresh pair whose other end goes back to
 * the container.
 *
 * Dependencies are injected so the bridge can be tested without workerd.
 */
export interface OutboundWebSocketDeps {
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  webSocketPair: () => { client: WebSocket; server: WebSocket };
}

const defaultDeps = (): OutboundWebSocketDeps => ({
  fetch: (input, init) => fetch(input as never, init as never),
  webSocketPair: () => {
    const [client, server] = Object.values(new WebSocketPair());
    return { client: client as WebSocket, server: server as WebSocket };
  },
});

/**
 * The handshake headers the runtime owns.
 *
 * Given `Upgrade: websocket`, Workers runs the handshake itself: it generates
 * `Sec-WebSocket-Key` and validates the origin's `Sec-WebSocket-Accept`
 * against the key *it* sent. Forwarding the container's copies makes Sprites
 * answer a key the runtime never sent, the validation fails, and the
 * connection is torn down. In production that surfaced as `Network connection
 * lost.` thrown out of this handler for `/exec` while plain REST requests
 * through the same handler returned normally.
 *
 * `sec-websocket-protocol` is deliberately not here: a negotiated subprotocol
 * is the origin's answer to the container, not part of the runtime's own
 * handshake, so it travels in both directions.
 */
const RUNTIME_OWNED_HANDSHAKE_HEADERS_V1 = [
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
] as const;

function isUpgradeV1(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Everything the origin still needs — `authorization` above all — and nothing
 * the runtime will supply itself.
 */
function handshakeHeadersV1(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of RUNTIME_OWNED_HANDSHAKE_HEADERS_V1) headers.delete(name);
  headers.set("upgrade", "websocket");
  return headers;
}

/**
 * Reserved codes cannot travel in a close frame; the library's inbound bridge
 * makes the same substitution.
 */
function sendableCloseCode(code: number): number {
  return code === 1005 || code === 1006 ? 1000 : code;
}

export function createOutboundWebSocketProxyV1(
  deps: OutboundWebSocketDeps = defaultDeps(),
) {
  return async (request: Request): Promise<Response> => {
    // Anything that is not an upgrade is the REST half of the SDK, which the
    // plain forward already serves correctly.
    if (!isUpgradeV1(request)) return deps.fetch(request);

    // The documented form for an outbound upgrade: a URL and headers, so the
    // runtime performs its own handshake rather than replaying the
    // container's.
    const response = await deps.fetch(request.url, {
      method: request.method,
      headers: handshakeHeadersV1(request),
    });
    const origin = response.webSocket;
    if (!origin) return response;

    const { client, server } = deps.webSocketPair();
    // `exec` multiplexes stdin and stdout as binary frames — a StreamID byte
    // then payload — and a binary frame arrives as a `Blob` unless this asks
    // otherwise. A `Blob` handed to `send` stringifies: every frame became the
    // literal text `[object Blob]`, so Sprites never received a readable
    // stdin, never ran the command, and never sent anything back. The SDK
    // reports that silence as `WebSocket keepalive timeout`, which it raises
    // after 45s without a message rather than on any protocol error.
    origin.binaryType = "arraybuffer";
    server.binaryType = "arraybuffer";
    origin.accept();
    server.accept();

    server.addEventListener("message", (event: MessageEvent) => {
      try {
        origin.send(event.data as string | ArrayBuffer);
      } catch {
        server.close(1011, "Failed to forward message to the Sprites API");
      }
    });
    origin.addEventListener("message", (event: MessageEvent) => {
      try {
        server.send(event.data as string | ArrayBuffer);
      } catch {
        origin.close(1011, "Failed to forward message to the container");
      }
    });
    server.addEventListener("close", (event: CloseEvent) => {
      origin.close(sendableCloseCode(event.code), event.reason);
    });
    origin.addEventListener("close", (event: CloseEvent) => {
      server.close(sendableCloseCode(event.code), event.reason);
    });
    server.addEventListener("error", () => {
      origin.close(1011, "Container WebSocket error");
    });
    origin.addEventListener("error", () => {
      server.close(1011, "Sprites API WebSocket error");
    });

    // The runtime writes its own handshake back to the container, so the
    // origin's 101 headers must not be replayed either. Only a negotiated
    // subprotocol is the origin's to state.
    const headers = new Headers();
    const protocol = response.headers.get("sec-websocket-protocol");
    if (protocol) headers.set("sec-websocket-protocol", protocol);

    return new Response(null, {
      status: response.status,
      headers,
      webSocket: client,
    });
  };
}
