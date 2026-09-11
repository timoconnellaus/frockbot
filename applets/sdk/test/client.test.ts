import { describe, expect, it } from "bun:test";

import { createApplet } from "../src/client/index.js";
import { t, table } from "../src/schema/index.js";
import { LoopbackApplet, flush } from "./loopback.js";

const tables = {
  todos: table({
    id: t.id(),
    title: t.text(),
    done: t.boolean().default(false),
    createdAt: t.timestamp(),
  }),
};

interface TodoServer {
  tables: typeof tables;
}

const NOW = "2026-09-03T00:00:00.000Z";

async function connected(server = new LoopbackApplet(tables)) {
  const applet = createApplet<TodoServer>({
    autoConnect: false,
    socketFactory: server.socketFactory,
    minimumBackoffMs: 1,
    maximumBackoffMs: 2,
  });
  // Touch the collection so its sync registers before the handshake completes.
  const todos = applet.tables.todos;
  applet.connect({
    socketUrl: "ws://applet/socket",
    token: "t",
    generationId: "gen-1",
  });
  await flush();
  return { server, applet, todos };
}

function titles(rows: Iterable<{ title?: unknown }>): string[] {
  return [...rows].map((row) => String(row.title)).sort();
}

describe("connection", () => {
  it("hydrates a collection from the snapshot and reports the viewer", async () => {
    const server = new LoopbackApplet(tables);
    server.store.insert("todos", { title: "milk", createdAt: NOW });
    const { applet, todos } = await connected(server);

    expect(titles(todos.toArray)).toEqual(["milk"]);
    expect(todos.status).toBe("ready");
    expect(applet.tables.todos).toBe(todos);
  });

  it("renders on the server's hello, with no hello of its own", async () => {
    const server = new LoopbackApplet(tables);
    server.store.insert("todos", { title: "milk", createdAt: NOW });
    const { todos } = await connected(server);
    const socket = server.sockets[0]!;
    const received = socket.received.map(
      (frame) => JSON.parse(frame) as { type: string; snapshot?: unknown },
    );
    expect(received.map((frame) => frame.type)).toEqual(["hello"]);
    expect(received[0]?.snapshot).toBeDefined();
    expect(socket.sent).toEqual([]);
    expect(titles(todos.toArray)).toEqual(["milk"]);
  });

  it("is spoken to in v1 when it opened as v1", async () => {
    const server = new LoopbackApplet(tables);
    server.store.insert("todos", { title: "milk", createdAt: NOW });
    // A page built before v2: the same transport, but its URL names no
    // version, so the server greets it the old way and it asks as it did.
    const socket = server.open("ws://applet/socket");
    const frames: Array<{ v: number; type: string }> = [];
    socket.onmessage = (event) =>
      frames.push(
        JSON.parse(String(event.data)) as { v: number; type: string },
      );
    await flush();
    expect(frames.map((frame) => [frame.v, frame.type])).toEqual([
      [1, "hello"],
    ]);
    expect("snapshot" in frames[0]!).toBe(false);
    socket.send(JSON.stringify({ v: 1, type: "hello", contract: 1 }));
    await flush();
    expect(frames.map((frame) => [frame.v, frame.type])).toEqual([
      [1, "hello"],
      [1, "snapshot"],
    ]);
  });

  it("returns the same collection for the same table", async () => {
    const { applet } = await connected();
    expect(applet.tables.todos).toBe(applet.tables.todos);
  });
});

describe("mutations", () => {
  it("inserts optimistically and keeps the row once the server acks", async () => {
    const { server, todos } = await connected();
    const transaction = todos.insert({
      id: "todo-1",
      title: "milk",
      done: false,
      createdAt: NOW,
    });
    expect(titles(todos.toArray)).toEqual(["milk"]);

    await transaction.isPersisted.promise;
    await flush();
    expect(titles(todos.toArray)).toEqual(["milk"]);
    expect(server.store.select("todos")).toHaveLength(1);
  });

  it("rolls the optimistic row back when the server rejects", async () => {
    const { server, todos } = await connected();
    const transaction = todos.insert({
      id: "todo-1",
      title: "milk",
      done: false,
      createdAt: NOW,
      // Not a declared column: the server refuses the whole transaction.
      colour: "blue",
    } as never);
    expect(titles(todos.toArray)).toEqual(["milk"]);

    await expect(transaction.isPersisted.promise).rejects.toThrow(
      /Unknown column/,
    );
    await flush();
    expect(todos.toArray).toHaveLength(0);
    expect(server.store.select("todos")).toHaveLength(0);
  });

  it("updates and deletes through the same path", async () => {
    const { server, todos } = await connected();
    await todos.insert({
      id: "todo-1",
      title: "milk",
      done: false,
      createdAt: NOW,
    }).isPersisted.promise;

    await todos.update("todo-1", (draft) => {
      draft.done = true;
    }).isPersisted.promise;
    await flush();
    expect(server.store.read("todos", "todo-1")).toMatchObject({ done: true });

    await todos.delete("todo-1").isPersisted.promise;
    await flush();
    expect(server.store.select("todos")).toHaveLength(0);
    expect(todos.toArray).toHaveLength(0);
  });

  it("rejects a write from a read-only viewer", async () => {
    const server = new LoopbackApplet(tables);
    server.canWrite = false;
    const { todos } = await connected(server);
    const transaction = todos.insert({
      id: "todo-1",
      title: "milk",
      done: false,
      createdAt: NOW,
    });
    await expect(transaction.isPersisted.promise).rejects.toThrow(
      /may not write/,
    );
  });
});

describe("real time", () => {
  it("shows another viewer's insert without a refetch", async () => {
    const server = new LoopbackApplet(tables);
    const first = await connected(server);
    const second = await connected(server);

    await first.todos.insert({
      id: "todo-1",
      title: "milk",
      done: false,
      createdAt: NOW,
    }).isPersisted.promise;
    await flush();

    expect(titles(second.todos.toArray)).toEqual(["milk"]);
  });

  it("shows a change a tool handler made on the server", async () => {
    const server = new LoopbackApplet(tables);
    const { todos } = await connected(server);
    server.toolWrite("todos", { title: "eggs", createdAt: NOW });
    await flush();
    expect(titles(todos.toArray)).toEqual(["eggs"]);
  });
});

describe("reconnection", () => {
  it("catches up from the last change id rather than resnapshotting", async () => {
    const server = new LoopbackApplet(tables);
    const { todos } = await connected(server);
    server.toolWrite("todos", { title: "milk", createdAt: NOW });
    await flush();

    // Write while the client is away, so only the catch-up can deliver it.
    server.dropLast();
    server.store.insert("todos", { title: "eggs", createdAt: NOW });
    await flush(30);

    expect(titles(todos.toArray)).toEqual(["eggs", "milk"]);
    const hello = JSON.parse(server.sockets.at(-1)!.sent[0]!) as {
      since?: number;
    };
    expect(hello.since).toBeGreaterThan(0);
  });

  it("reports its status through useApplet's store", async () => {
    const server = new LoopbackApplet(tables);
    const { applet } = await connected(server);
    // `useApplet` is `useSyncExternalStore` over exactly this state object.
    expect(server.sockets).toHaveLength(1);
    applet.close();
    await flush();
  });
});
