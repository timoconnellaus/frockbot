/**
 * A stand-in for `api.sprites.dev`, as a Worker.
 *
 * The bridge reaches the Sprites API with the global `fetch`, so miniflare's
 * outbound service is where an impersonator belongs: nothing is injected past
 * a seam the production code does not already have, and the bridge under test
 * is the real one, unmodified.
 *
 * It has to be a Worker rather than a Node-side function because the whole
 * point is the upgrade — only workerd can answer one with a real
 * `WebSocketPair`, and a Node `Response` has nowhere to put a socket.
 *
 * What it models is only what `exec` depends on: an upgrade that completes, a
 * frame sent unprompted the moment the socket opens, and an echo for anything
 * the caller sends. The unprompted frame matters — the SDK's keepalive treats
 * *any* inbound message as liveness, and it was that silence, not a protocol
 * error, that surfaced in production as `WebSocket keepalive timeout`.
 */
export const SPRITES_ORIGIN_FAKE_NAME = "sprites-origin-fake";

/** The frame the origin sends as soon as the socket is open. */
export const SPRITES_ORIGIN_GREETING = "sprites:open";

/** Echoes carry this prefix, so a test can tell direction apart. */
export const SPRITES_ORIGIN_ECHO_PREFIX = "sprites:echo:";

/** The StreamID byte the origin prefixes to a binary answer, as stdout does. */
export const SPRITES_ORIGIN_STDOUT_STREAM_ID = 1;

/**
 * Reported back over the socket on request, so a test can assert what actually
 * crossed the wire — in particular that `authorization` survived and that the
 * runtime, not the caller, owns the handshake.
 */
export const SPRITES_ORIGIN_HEADERS_PROBE = "headers?";

const SCRIPT = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") !== "websocket") {
      return Response.json({ ok: true, path: url.pathname });
    }

    const seen = {
      authorization: request.headers.get("authorization"),
      // Whatever key reaches here is the runtime's own: the caller's must not
      // have been replayed.
      secWebSocketKey: request.headers.get("sec-websocket-key"),
      path: url.pathname + url.search,
    };

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    server.binaryType = "arraybuffer";
    server.addEventListener("message", (event) => {
      // A binary frame is answered in kind, with the payload's bytes
      // untouched. This is the shape \`exec\` actually uses: a StreamID byte
      // then payload, never text.
      if (event.data instanceof ArrayBuffer) {
        const payload = new Uint8Array(event.data);
        const answer = new Uint8Array(payload.length + 1);
        answer[0] = ${JSON.stringify(1)};
        answer.set(payload, 1);
        server.send(answer.buffer);
        return;
      }
      if (event.data === ${JSON.stringify(SPRITES_ORIGIN_HEADERS_PROBE)}) {
        server.send(JSON.stringify(seen));
        return;
      }
      server.send(${JSON.stringify(SPRITES_ORIGIN_ECHO_PREFIX)} + event.data);
    });
    server.addEventListener("close", (event) => {
      try {
        server.close(event.code, event.reason);
      } catch {}
    });

    // Unprompted, before anything is asked of it.
    server.send(${JSON.stringify(SPRITES_ORIGIN_GREETING)});

    return new Response(null, { status: 101, webSocket: client });
  },
};
`;

/** The auxiliary Worker definition, for `miniflare.workers`. */
export function createSpritesOriginFakeWorker(compatibilityDate: string) {
  return {
    name: SPRITES_ORIGIN_FAKE_NAME,
    modules: true,
    script: SCRIPT,
    compatibilityDate,
  };
}
