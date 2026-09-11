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
  readonly protocols?: string[];
  closed: boolean;
}

function harness() {
  const sockets: RecordedSocket[] = [];
  const timers: Array<() => void> = [];
  const transport = new AppletTransport({
    socketFactory: (url, protocols) => {
      const socket: RecordedSocket = {
        url,
        ...(protocols ? { protocols } : {}),
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

/** The server's hello, in the version the socket opened with. */
function hello(
  socket: RecordedSocket,
  options: { snapshot?: Record<string, Array<Record<string, unknown>>> } = {},
): void {
  socket.onmessage?.({
    data: JSON.stringify({
      v: 2,
      type: "hello",
      contract: 1,
      generationId: "gen-1",
      viewer: { id: "v", canWrite: true },
      tables: ["todos"],
      schemaRevision: 1,
      lastChangeId: 7,
      ...options,
    }),
  });
}

/** The socket opens and the server greets it. */
function greeting(
  socket: RecordedSocket,
  options: { snapshot?: Record<string, Array<Record<string, unknown>>> } = {},
): void {
  socket.onopen?.({});
  hello(socket, options);
}

describe("the v2 handshake", () => {
  it("opens with the version and no cursor, and renders on the hello alone", () => {
    const { sockets, transport, connect } = harness();
    const sent: string[] = [];
    const rows: unknown[] = [];
    let ready = 0;
    transport.registerTable("todos", {
      begin() {},
      write: (message) => rows.push(message.value),
      commit() {},
      markReady: () => ready++,
      truncate() {},
    });
    connect();
    const socket = sockets[0]!;
    socket.send = (data) => sent.push(data);
    const url = new URL(socket.url);
    expect(url.searchParams.get("v")).toBe("2");
    expect(url.searchParams.has("since")).toBe(false);

    greeting(socket, { snapshot: { todos: [{ id: "a" }] } });

    // No hello of its own: the greeting was the whole handshake.
    expect(sent).toEqual([]);
    expect(rows).toEqual([{ id: "a" }]);
    expect(ready).toBe(1);
    expect(transport.state.status).toBe("ready");
    transport.close();
  });

  it("asks for the snapshot when the hello came without one", () => {
    const { sockets, transport, connect } = harness();
    const sent: string[] = [];
    connect();
    const socket = sockets[0]!;
    socket.send = (data) => sent.push(data);

    greeting(socket);

    expect(sent.map((frame) => JSON.parse(frame) as object)).toEqual([
      { v: 2, type: "hello", contract: 1 },
    ]);
    expect(transport.state.status).toBe("connecting");
    transport.close();
  });

  it("resumes with the cursor on the URL and its own hello, as v1 did", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect();
    const first = sockets[0]!;
    greeting(first, { snapshot: { todos: [] } });
    expect(transport.state.status).toBe("ready");

    fail(first);
    runTimers();
    const second = sockets[1]!;
    const sent: string[] = [];
    second.send = (data) => sent.push(data);
    expect(new URL(second.url).searchParams.get("since")).toBe("7");
    second.onopen?.({});
    expect(sent.map((frame) => JSON.parse(frame) as object)).toEqual([
      { v: 2, type: "hello", contract: 1, since: 7 },
    ]);
    // The server's plain hello for a resume is not answered a second time.
    hello(second);
    expect(sent).toHaveLength(1);
    transport.close();
  });

  it("reports each hop to the host only when asked", () => {
    const hops: string[] = [];
    const sockets: RecordedSocket[] = [];
    const transport = new AppletTransport({
      socketFactory: (url) => {
        const socket: RecordedSocket = {
          url,
          closed: false,
          send() {},
          close() {},
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        sockets.push(socket);
        return socket;
      },
      onTiming: (hop) => hops.push(hop),
    });
    transport.connect({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token: "t",
      generationId: "gen-1",
    });
    greeting(sockets[0]!, { snapshot: {} });
    expect(hops).toEqual([]);
    transport.connect({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token: "t",
      generationId: "gen-1",
      timing: true,
    });
    greeting(sockets[1]!, { snapshot: {} });
    expect(hops).toEqual(["socket-open", "hello", "ready"]);
    transport.close();
  });
});

describe("a refreshed credential", () => {
  it("reconnects in place with the cursor, and ignores the credential it already holds", () => {
    const { sockets, transport, connect } = harness();
    connect("token-1");
    greeting(sockets[0]!, { snapshot: { todos: [] } });
    expect(transport.state.status).toBe("ready");

    // The same credential again: the live socket is kept.
    transport.refresh({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token: "token-1",
      generationId: "gen-1",
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);

    // A new one: the old socket goes, the new one opens with the cursor, so
    // the server answers with changes rather than a snapshot.
    transport.refresh({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token: "token-2",
      generationId: "gen-1",
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    const url = new URL(sockets[1]!.url);
    expect(url.searchParams.get("since")).toBe("7");
    expect(url.searchParams.get("token")).toBe("token-2");
    transport.close();
  });

  it("opens at once when it arrives during a reconnect backoff", () => {
    const { sockets, transport, runTimers, connect } = harness();
    connect("token-1");
    fail(sockets[0]!);
    transport.refresh({
      socketUrl: "wss://applet.example/api/applets/review/socket",
      token: "token-2",
      generationId: "gen-1",
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("token=token-2");
    runTimers();
    expect(sockets).toHaveLength(2);
    transport.close();
  });
});

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

it("native viewer credentials stay out of URLs through token renewal", () => {
  const { transport, sockets } = harness();
  const init = {
    socketUrl: "wss://bot.frockbot.com/api/applets/user.counter/socket",
    generationId: "gen-1",
    tokenTransport: "subprotocol-v1" as const,
  };
  transport.connect({ ...init, token: "synthetic-one" });
  transport.connect({ ...init, token: "synthetic-two" });
  // The URL names the protocol and nothing of the credential.
  expect(sockets.map((s) => s.url)).toEqual([
    `${init.socketUrl}?v=2`,
    `${init.socketUrl}?v=2`,
  ]);
  for (const socket of sockets) expect(socket.url).not.toContain("synthetic");
  expect(sockets[0]!.protocols).toEqual([
    "frockbot.applet.v1",
    "frockbot.viewer.synthetic-one",
  ]);
  expect(sockets[1]!.protocols).toEqual([
    "frockbot.applet.v1",
    "frockbot.viewer.synthetic-two",
  ]);
  expect(sockets[0]!.closed).toBe(true);
  transport.close();
});
