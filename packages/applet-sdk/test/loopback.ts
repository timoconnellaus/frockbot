/**
 * Both halves of the wire in one process: the real `AppletProtocolServer` over
 * a `bun:sqlite` store, joined to the real client transport by a pair of fake
 * sockets. Nothing about the protocol is re-implemented here, so a client test
 * that passes is a test against the code the Durable Object runs.
 */

import { encodeFrame, type AppletChangeV1 } from "../src/protocol/index.js";
import type {
  AppletSocket,
  AppletSocketFactory,
} from "../src/client/transport.js";
import {
  AppletProtocolServer,
  type AppletPeer,
} from "../src/server/session.js";
import { AppletStore } from "../src/server/store.js";
import type { TablesShape } from "../src/schema/index.js";
import { createTestSql, type TestSql } from "./sqlite.js";

export function flush(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
  }
  return chain;
}

class FakeSocket implements AppletSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  readonly sent: string[] = [];

  constructor(private readonly toServer: (data: string) => void) {}

  send(data: string): void {
    this.sent.push(data);
    if (this.closed) return;
    queueMicrotask(() => this.toServer(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }

  /** Server -> client. */
  deliver(data: string): void {
    if (this.closed) return;
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  /** Drop the socket the way a network failure would. */
  drop(): void {
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }
}

export class LoopbackApplet {
  readonly store: AppletStore;
  readonly sockets: FakeSocket[] = [];
  generationId = "gen-1";
  canWrite = true;
  private readonly peers = new Map<FakeSocket, AppletPeer>();
  private readonly sql: TestSql;

  constructor(tables: TablesShape) {
    this.sql = createTestSql();
    this.store = new AppletStore(this.sql, tables);
    this.store.ensureSchema();
  }

  get socketFactory(): AppletSocketFactory {
    return () => this.open();
  }

  open(): AppletSocket {
    const socket = new FakeSocket((data) => {
      const peer = this.peers.get(socket);
      if (peer) this.protocol().receive(peer, data);
    });
    const peer: AppletPeer = {
      viewer: {
        id: `viewer-${this.sockets.length + 1}`,
        canWrite: this.canWrite,
      },
      synced: false,
      send: (frame) => socket.deliver(encodeFrame(frame)),
      close: () => socket.drop(),
    };
    this.sockets.push(socket);
    this.peers.set(socket, peer);
    queueMicrotask(() => socket.onopen?.({}));
    this.protocol().greet(peer);
    return socket;
  }

  /** Simulate the network dropping the client's current socket. */
  dropLast(): void {
    const socket = this.sockets.at(-1);
    if (!socket) return;
    this.peers.delete(socket);
    socket.drop();
  }

  /** What a tool handler's write does: apply, then broadcast to viewers. */
  toolWrite(table: string, values: Record<string, unknown>): AppletChangeV1 {
    const change = this.sql.transactionSync(() =>
      this.store.insert(table, values),
    );
    this.protocol().broadcastChanges([change]);
    return change;
  }

  private protocol(): AppletProtocolServer {
    return new AppletProtocolServer(this.store, {
      generationId: this.generationId,
      schemaRevision: 1,
      transaction: (closure) => this.sql.transactionSync(closure),
      peers: () => [...this.peers.values()],
    });
  }
}
