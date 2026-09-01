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
  fetch: (request: Request) => Promise<Response>;
  webSocketPair: () => { client: WebSocket; server: WebSocket };
}

const defaultDeps = (): OutboundWebSocketDeps => ({
  fetch: (request) => fetch(request),
  webSocketPair: () => {
    const [client, server] = Object.values(new WebSocketPair());
    return { client: client as WebSocket, server: server as WebSocket };
  },
});

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
    const response = await deps.fetch(request);
    const origin = response.webSocket;
    if (!origin) return response;

    const { client, server } = deps.webSocketPair();
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

    return new Response(null, {
      status: response.status,
      headers: response.headers,
      webSocket: client,
    });
  };
}
