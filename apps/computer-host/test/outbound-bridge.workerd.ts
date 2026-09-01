/**
 * The bridge in the runtime that actually has to agree with it.
 *
 * Production reached this shape by way of three green suites and three failed
 * deploys, each failing on something the injected fakes could not model: the
 * handler was never registered, then the handshake was replayed, then frames
 * did not flow and the SDK reported `WebSocket keepalive timeout` — which it
 * raises after 45s of silence, not on any protocol error. So the assertion
 * that matters here is the plain one: does a frame get through, in each
 * direction, over a socket the runtime made.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  SPRITES_ORIGIN_ECHO_PREFIX,
  SPRITES_ORIGIN_GREETING,
  SPRITES_ORIGIN_HEADERS_PROBE,
} from "./sprites-origin-fake.ts";

const EXEC_URL =
  "https://api.sprites.dev/v1/sprites/frockbot-test/exec?cmd=bash&cmd=-s&path=bash&stdin=true";

/** The upgrade exactly as the Sprites SDK makes it, headers included. */
function execUpgrade(): RequestInit {
  return {
    headers: {
      authorization: "Bearer sprites-token",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  };
}

/** Reads frames off an accepted socket until `count` have arrived. */
function collect(socket: WebSocket, count: number): Promise<string[]> {
  const frames: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `only ${frames.length} of ${count} frames arrived: ${JSON.stringify(frames)}`,
          ),
        ),
      10_000,
    );
    socket.addEventListener("message", (event: MessageEvent) => {
      frames.push(String(event.data));
      if (frames.length >= count) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("the socket errored before the frames arrived"));
    });
  });
}

/** Frames as they actually arrive, so a Blob cannot pass for its own bytes. */
function collectRaw(
  socket: WebSocket,
  count: number,
): Promise<Array<string | ArrayBuffer>> {
  const frames: Array<string | ArrayBuffer> = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`only ${frames.length} of ${count} frames`)),
      10_000,
    );
    socket.addEventListener("message", (event: MessageEvent) => {
      frames.push(event.data as string | ArrayBuffer);
      if (frames.length >= count) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
  });
}

async function openExec(): Promise<WebSocket> {
  const response = await SELF.fetch(EXEC_URL, execUpgrade());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the bridge returned no socket");
  socket.accept();
  return socket;
}

describe("the outbound bridge under workerd", () => {
  test("completes the upgrade and returns a usable socket", async () => {
    const response = await SELF.fetch(EXEC_URL, execUpgrade());

    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
  });

  test("delivers a frame the origin sends unprompted", async () => {
    // The silence this catches is exactly what the SDK reports as a keepalive
    // timeout: it resets that timer on any inbound message.
    const socket = await openExec();

    const [first] = await collect(socket, 1);

    expect(first).toBe(SPRITES_ORIGIN_GREETING);
  });

  test("carries a frame to the origin and its answer back", async () => {
    const socket = await openExec();
    const frames = collect(socket, 2);

    socket.send("stdin-payload");

    expect(await frames).toEqual([
      SPRITES_ORIGIN_GREETING,
      `${SPRITES_ORIGIN_ECHO_PREFIX}stdin-payload`,
    ]);
  });

  test("gives the origin the credential and its own handshake key", async () => {
    const socket = await openExec();
    const frames = collect(socket, 2);

    socket.send(SPRITES_ORIGIN_HEADERS_PROBE);

    const seen = JSON.parse((await frames)[1] ?? "{}") as {
      authorization: string | null;
      secWebSocketKey: string | null;
      path: string | null;
    };
    expect(seen.authorization).toBe("Bearer sprites-token");
    // The runtime performs its own handshake; replaying the caller's key is
    // what tore the connection down with `Network connection lost.`
    expect(seen.secWebSocketKey).not.toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(seen.path).toBe(
      "/v1/sprites/frockbot-test/exec?cmd=bash&cmd=-s&path=bash&stdin=true",
    );
  });

  test("carries a binary frame through with its bytes intact", async () => {
    // What `exec` actually sends: a StreamID byte then payload, never text.
    // Forwarded without asking for `arraybuffer`, each frame arrived as a
    // `Blob` and `send` stringified it to the literal `[object Blob]`, so
    // Sprites never received a readable stdin and answered nothing at all.
    const response = await SELF.fetch(EXEC_URL, execUpgrade());
    const socket = response.webSocket;
    if (!socket) throw new Error("the bridge returned no socket");
    socket.binaryType = "arraybuffer";
    socket.accept();

    const frames = collectRaw(socket, 2);
    const stdin = new Uint8Array([0, ...new TextEncoder().encode("echo hi\n")]);
    socket.send(stdin.buffer as ArrayBuffer);

    const answer = (await frames)[1];
    expect(answer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(answer as ArrayBuffer))).toEqual([
      1,
      ...stdin,
    ]);
  });

  test("leaves a request that is not an upgrade alone", async () => {
    const response = await SELF.fetch(
      "https://api.sprites.dev/v1/sprites/frockbot-test",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: "/v1/sprites/frockbot-test",
    });
  });
});
