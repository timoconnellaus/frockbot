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

/** The upgrade the Sprites SDK makes for every `exec`. */
function proxyOverUpgrade() {
  const origin = new FakeSocket();
  const client = new FakeSocket();
  const server = new FakeSocket();
  const proxy = createOutboundWebSocketProxyV1({
    fetch: () =>
      Promise.resolve({
        status: 101,
        headers: new Headers(),
        webSocket: origin,
      } as never),
    webSocketPair: () => ({ client: client as never, server: server as never }),
  });
  return { proxy, origin, client, server };
}

const request = () => new Request("https://api.sprites.dev/v1/sprites/x/exec");

describe("outbound Sprites proxy", () => {
  test("passes a response that is not an upgrade straight through", async () => {
    const body = Response.json({ ok: true });
    const proxy = createOutboundWebSocketProxyV1({
      fetch: () => Promise.resolve(body),
      webSocketPair: () => {
        throw new Error("a plain response must not build a pair");
      },
    });

    expect(await proxy(request())).toBe(body);
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
