/**
 * Reconnection is the one part of the transport a loopback test cannot drive
 * honestly: it needs sockets that fail in the awkward orders a real network
 * produces — `error` and `close` for one failure, a late `close` from a socket
 * that has already been replaced, a fresh token arriving mid-backoff. These
 * tests drive `AppletTransport` through its socket and scheduler seams so each
 * of those orders is exercised exactly once.
 */

import { describe, expect, it } from "bun:test";

import { AppletTransport, type AppletSocket } from "../src/client/transport.js";

interface RecordedSocket extends AppletSocket {
  readonly url: string;
  closed: boolean;
}

function harness() {
  const sockets: RecordedSocket[] = [];
  const timers: Array<() => void> = [];
  const transport = new AppletTransport({
    socketFactory: (url) => {
      const socket: RecordedSocket = {
        url,
        closed: false,
        send() {},
        close() {
          if (socket.closed) return;
          socket.closed = true;
          socket.onclose?.({});
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
    schedule: (closure) => {
      timers.push(closure);
      return timers.length;
    },
  });
  const runTimers = () => {
    for (const timer of timers.splice(0)) timer();
  };
  const connect = (token = "token-1") =>
    transport.connect({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token,
      generationId: "gen-1",
    });
  return { sockets, timers, transport, runTimers, connect };
}

/** What a real socket does on a network failure: `error`, then `close`. */
function fail(socket: RecordedSocket): void {
  socket.onerror?.({});
  socket.closed = true;
  socket.onclose?.({});
}

describe("reconnection", () => {
  it("one socket error followed by close opens only one replacement", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();

    fail(sockets[0]!);
    runTimers();

    expect(sockets).toHaveLength(2);
    transport.close();
  });

  it("ignores a close from a socket it already replaced", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();

    fail(sockets[0]!);
    runTimers();
    expect(sockets).toHaveLength(2);

    // The dead socket finally reports its close, long after the replacement
    // connected. It must not drop the live connection or open a third socket.
    sockets[0]!.onclose?.({});
    runTimers();

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closed).toBe(false);
    transport.close();
  });

  it("supersedes a pending retry when the caller reconnects during backoff", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();

    fail(sockets[0]!);
    // A fresh viewer token arrives while the reconnect is still waiting.
    connect("token-2");
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("token=token-2");

    runTimers();

    expect(sockets).toHaveLength(2);
    transport.close();
  });

  it("closes the socket it supersedes when the caller reconnects", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();

    connect("token-2");

    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    runTimers();
    expect(sockets).toHaveLength(2);
    transport.close();
  });

  it("cancels a pending retry when the transport is closed", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();

    fail(sockets[0]!);
    transport.close();
    runTimers();

    expect(sockets).toHaveLength(1);
    expect(transport.state.status).toBe("closed");
  });
});
