import { describe, expect, test } from "bun:test";
import { createOutboundWebSocketProxyV1 } from "./outbound.ts";

class FakeSocket {
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  accepted = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  accept(): void {
    this.accepted = true;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * What one outbound call actually asks for, normalised across both forms of
 * `fetch` — so an assertion holds whether the handler passes a `Request`
 * through or states a URL and headers.
 */
interface OutboundCall {
  url: string;
  headers: Headers;
}

function outboundCall(
  input: Request | string,
  init?: RequestInit,
): OutboundCall {
  const request = typeof input === "string" ? undefined : input;
  return {
    url: request?.url ?? (input as string),
    headers: init?.headers
      ? new Headers(init.headers)
      : new Headers(request?.headers),
  };
}

/** The upgrade the Sprites SDK makes for every `exec`. */
function proxyOverUpgrade(originHeaders: Headers = new Headers()) {
  const origin = new FakeSocket();
  const client = new FakeSocket();
  const server = new FakeSocket();
  const calls: OutboundCall[] = [];
  const proxy = createOutboundWebSocketProxyV1({
    fetch: (input, init) => {
      calls.push(outboundCall(input, init));
      return Promise.resolve({
        status: 101,
        headers: originHeaders,
        webSocket: origin,
      } as never);
    },
    webSocketPair: () => ({ client: client as never, server: server as never }),
  });
  return { proxy, origin, client, server, calls };
}

/**
 * The exec upgrade exactly as it reached `ContainerProxy` in production —
 * the container's own handshake headers included, since replaying those is
 * what broke it.
 */
const request = () =>
  new Request("https://api.sprites.dev/v1/sprites/x/exec?cmd=bash", {
    headers: {
      authorization: "Bearer sprites-token",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });

/** The REST half of the SDK: same host, no upgrade. */
const restRequest = () =>
  new Request("https://api.sprites.dev/v1/sprites/x", {
    headers: { authorization: "Bearer sprites-token" },
  });

describe("outbound Sprites proxy", () => {
  test("passes a request that is not an upgrade straight through", async () => {
    const body = Response.json({ ok: true });
    const forwarded: Array<Request | string> = [];
    const proxy = createOutboundWebSocketProxyV1({
      fetch: (input) => {
        forwarded.push(input);
        return Promise.resolve(body);
      },
      webSocketPair: () => {
        throw new Error("a plain request must not build a pair");
      },
    });

    const rest = restRequest();
    expect(await proxy(rest)).toBe(body);
    // Untouched: this is the half that already worked in production.
    expect(forwarded).toEqual([rest]);
  });

  describe("the handshake the runtime owns", () => {
    test("does not replay the container's key, version or connection headers", async () => {
      const { proxy, calls } = proxyOverUpgrade();

      await proxy(request());

      // Replaying these made Sprites answer a key the runtime never sent, and
      // the runtime tore the connection down: `Network connection lost.`
      expect(calls[0]?.headers.get("sec-websocket-key")).toBeNull();
      expect(calls[0]?.headers.get("sec-websocket-version")).toBeNull();
      expect(calls[0]?.headers.get("connection")).toBeNull();
    });

    test("asks for the upgrade by URL, so the runtime performs it", async () => {
      const { proxy, calls } = proxyOverUpgrade();

      await proxy(request());

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "https://api.sprites.dev/v1/sprites/x/exec?cmd=bash",
      );
      expect(calls[0]?.headers.get("upgrade")).toBe("websocket");
    });

    test("keeps the credential the origin still needs", async () => {
      const { proxy, calls } = proxyOverUpgrade();

      await proxy(request());

      expect(calls[0]?.headers.get("authorization")).toBe(
        "Bearer sprites-token",
      );
    });

    test("returns no handshake headers of the origin's back to the container", async () => {
      const { proxy } = proxyOverUpgrade(
        new Headers({
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        }),
      );

      const response = await proxy(request());

      // The runtime writes its own handshake to the container; the origin's
      // accept value answers a different key.
      expect(response.headers.get("sec-websocket-accept")).toBeNull();
      expect(response.headers.get("connection")).toBeNull();
    });

    test("carries a negotiated subprotocol in both directions", async () => {
      const { proxy, calls } = proxyOverUpgrade(
        new Headers({ "sec-websocket-protocol": "sprites.v1" }),
      );

      const response = await proxy(request());

      expect(response.headers.get("sec-websocket-protocol")).toBe("sprites.v1");
      // The request carried none, so none should be invented.
      expect(calls[0]?.headers.get("sec-websocket-protocol")).toBeNull();
    });
  });

  test("accepts the origin and its own end, and returns the other to the container", async () => {
    const { proxy, origin, client, server } = proxyOverUpgrade();

    const response = await proxy(request());

    expect(origin.accepted).toBe(true);
    expect(server.accepted).toBe(true);
    // The container's end is accepted by the container, never here.
    expect(client.accepted).toBe(false);
    expect(response.status).toBe(101);
  });

  test("pumps frames in both directions", async () => {
    const { proxy, origin, server } = proxyOverUpgrade();
    await proxy(request());

    server.emit("message", { data: "to-sprites" });
    origin.emit("message", { data: "to-container" });

    expect(origin.sent).toEqual(["to-sprites"]);
    expect(server.sent).toEqual(["to-container"]);
  });

  test("substitutes reserved close codes, which cannot travel in a frame", async () => {
    const { proxy, origin, server } = proxyOverUpgrade();
    await proxy(request());

    server.emit("close", { code: 1006, reason: "abnormal" });

    expect(origin.closes).toEqual([{ code: 1000, reason: "abnormal" }]);
  });

  test("carries an ordinary close code through unchanged", async () => {
    const { proxy, origin, server } = proxyOverUpgrade();
    await proxy(request());

    origin.emit("close", { code: 1000, reason: "done" });

    expect(server.closes).toEqual([{ code: 1000, reason: "done" }]);
  });

  test("closes the far side when either end errors", async () => {
    const { proxy, origin, server } = proxyOverUpgrade();
    await proxy(request());

    server.emit("error", {});
    origin.emit("error", {});

    expect(origin.closes).toHaveLength(1);
    expect(server.closes).toHaveLength(1);
  });
});
