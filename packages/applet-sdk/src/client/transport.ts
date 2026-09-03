/**
 * The one socket an open Applet holds, and everything that hangs off it:
 * the v1 handshake, snapshot and catch-up, mutate/ack/reject, reconnection.
 *
 * TanStack DB never sees a frame. It sees a sink per table (`begin`/`write`/
 * `commit`/`markReady`/`truncate`) and a promise per client transaction, which
 * is the entire seam between this module and `collections.ts`.
 */

import {
  APPLET_CONTRACT_VERSION,
  decodeServerFrame,
  encodeFrame,
  type AppletChangeV1,
  type AppletMutationV1,
  type AppletViewerV1,
} from "../protocol/index.js";

export interface AppletInitV1 {
  /** Absolute ws(s):// URL of the Applet's socket, minted by the kernel. */
  socketUrl: string;
  /** Short-lived viewer token; appended as `?token=`. */
  token: string;
  generationId: string;
}

export type AppletStatus =
  "idle" | "connecting" | "ready" | "reconnecting" | "closed";

export interface AppletState {
  status: AppletStatus;
  viewer: AppletViewerV1 | null;
  generationId: string | null;
}

/** Minimal socket shape, so tests and the dev runner can supply their own. */
export interface AppletSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type AppletSocketFactory = (url: string) => AppletSocket;

/** What a TanStack DB collection hands the transport for one table. */
export interface AppletTableSink {
  begin(): void;
  write(message: {
    type: "insert" | "update" | "delete";
    key?: string;
    value?: Record<string, unknown>;
  }): void;
  commit(): void;
  markReady(): void;
  truncate(): void;
}

export interface AppletTransportOptions {
  socketFactory?: AppletSocketFactory;
  /** Reconnection backoff bounds, in milliseconds. */
  minimumBackoffMs?: number;
  maximumBackoffMs?: number;
  /** Scheduler seam so tests do not wait in real time. */
  schedule?: (closure: () => void, delayMs: number) => unknown;
}

class RejectedMutation extends Error {}

function defaultSocketFactory(url: string): AppletSocket {
  return new WebSocket(url) as unknown as AppletSocket;
}

export class AppletTransport {
  #options: Required<Omit<AppletTransportOptions, "socketFactory">> & {
    socketFactory: AppletSocketFactory;
  };
  #socket?: AppletSocket;
  #init?: AppletInitV1;
  #state: AppletState = { status: "idle", viewer: null, generationId: null };
  #listeners = new Set<() => void>();
  #sinks = new Map<string, AppletTableSink>();
  #pending = new Map<
    string,
    {
      resolve: (changes: AppletChangeV1[]) => void;
      reject: (error: Error) => void;
    }
  >();
  #lastChangeId = 0;
  #synced = false;
  #buffer: AppletChangeV1[] = [];
  #attempt = 0;
  #closed = false;
  #resyncQueued = false;
  #txnSeq = 0;

  constructor(options: AppletTransportOptions = {}) {
    this.#options = {
      socketFactory: options.socketFactory ?? defaultSocketFactory,
      minimumBackoffMs: options.minimumBackoffMs ?? 250,
      maximumBackoffMs: options.maximumBackoffMs ?? 8_000,
      schedule:
        options.schedule ?? ((closure, delay) => setTimeout(closure, delay)),
    };
  }

  get state(): AppletState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Open the socket. Called by the dev runner, the tests, and the `init` bridge. */
  connect(init: AppletInitV1): void {
    this.#init = init;
    this.#closed = false;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close(1000, "closed");
    this.#socket = undefined;
    this.#failPending(new Error("The Applet connection was closed"));
    this.#setState({ status: "closed" });
  }

  #open(): void {
    if (!this.#init || this.#closed) return;
    this.#setState({
      status: this.#attempt === 0 ? "connecting" : "reconnecting",
    });
    const url = new URL(this.#init.socketUrl);
    url.searchParams.set("token", this.#init.token);
    const socket = this.#options.socketFactory(url.toString());
    this.#socket = socket;
    socket.onopen = () => this.#handshake();
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = () => this.#dropped();
    socket.onerror = () => this.#dropped();
  }

  #handshake(): void {
    const since = this.#lastChangeId === 0 ? undefined : this.#lastChangeId;
    this.#write({
      v: 1,
      type: "hello",
      contract: APPLET_CONTRACT_VERSION,
      ...(since === undefined ? {} : { since }),
    });
  }

  #dropped(): void {
    if (this.#closed) return;
    this.#socket = undefined;
    this.#synced = false;
    this.#failPending(new Error("The Applet connection dropped"));
    const delay = Math.min(
      this.#options.maximumBackoffMs,
      this.#options.minimumBackoffMs * 2 ** this.#attempt,
    );
    this.#attempt += 1;
    this.#setState({ status: "reconnecting" });
    this.#options.schedule(
      () => this.#open(),
      delay * (0.5 + Math.random() / 2),
    );
  }

  #receive(data: unknown): void {
    let frame;
    try {
      frame = decodeServerFrame(data);
    } catch {
      // A frame this client cannot understand is a protocol break, not a blip:
      // drop the socket so the reconnect path takes a clean snapshot.
      this.#socket?.close(1008, "Unreadable frame");
      return;
    }

    if (frame.type === "hello") {
      const changedGeneration =
        this.#state.generationId !== null &&
        this.#state.generationId !== frame.generationId;
      this.#setState({
        viewer: frame.viewer,
        generationId: frame.generationId,
      });
      if (changedGeneration) {
        // New code over the same storage: never replay across the boundary.
        this.#lastChangeId = 0;
        this.#synced = false;
        this.#buffer = [];
        this.#write({ v: 1, type: "hello", contract: APPLET_CONTRACT_VERSION });
      }
      return;
    }

    if (frame.type === "snapshot") {
      this.#lastChangeId = frame.lastChangeId;
      for (const [name, sink] of this.#sinks) {
        // `truncate` only has meaning inside an open sync transaction.
        sink.begin();
        sink.truncate();
        for (const row of frame.tables[name] ?? [])
          sink.write({ type: "insert", value: row });
        sink.commit();
        sink.markReady();
      }
      this.#synced = true;
      this.#attempt = 0;
      this.#setState({ status: "ready" });
      const buffered = this.#buffer;
      this.#buffer = [];
      if (buffered.length > 0) this.#apply(buffered);
      return;
    }

    if (frame.type === "changes") {
      this.#lastChangeId = frame.lastChangeId;
      if (!this.#synced) {
        // Catch-up after a reconnect arrives without a snapshot; the sinks are
        // already populated from the previous session, so apply it directly.
        this.#synced = true;
        this.#attempt = 0;
        this.#setState({ status: "ready" });
        for (const sink of this.#sinks.values()) sink.markReady();
      }
      this.#apply(frame.changes);
      return;
    }

    if (frame.type === "ack") {
      this.#lastChangeId = frame.lastChangeId;
      // The authoritative rows must reach the sync layer before the optimistic
      // transaction is discarded, or the row would vanish on resolve.
      this.#apply(frame.changes);
      this.#pending.get(frame.txnId)?.resolve(frame.changes);
      this.#pending.delete(frame.txnId);
      return;
    }

    this.#pending.get(frame.txnId)?.reject(new RejectedMutation(frame.reason));
    this.#pending.delete(frame.txnId);
  }

  #apply(changes: AppletChangeV1[]): void {
    if (!this.#synced) {
      this.#buffer.push(...changes);
      return;
    }
    const byTable = new Map<string, AppletChangeV1[]>();
    for (const change of changes) {
      const list = byTable.get(change.table);
      if (list) list.push(change);
      else byTable.set(change.table, [change]);
    }
    for (const [name, list] of byTable) {
      const sink = this.#sinks.get(name);
      if (!sink) continue;
      sink.begin();
      for (const change of list) {
        if (change.op === "delete")
          sink.write({ type: "delete", key: change.key });
        else sink.write({ type: change.op, value: change.row });
      }
      sink.commit();
    }
  }

  /** Register a table's sink; returns the cleanup TanStack DB expects. */
  registerTable(name: string, sink: AppletTableSink): () => void {
    this.#sinks.set(name, sink);
    if (this.#synced) this.#queueResync();
    return () => {
      if (this.#sinks.get(name) === sink) this.#sinks.delete(name);
    };
  }

  /**
   * A table that mounts after the first snapshot has no rows of its own, so ask
   * for a fresh snapshot. Coalesced, because a first render registers them all
   * in the same tick.
   */
  #queueResync(): void {
    if (this.#resyncQueued) return;
    this.#resyncQueued = true;
    queueMicrotask(() => {
      this.#resyncQueued = false;
      if (!this.#socket) return;
      this.#synced = false;
      this.#write({ v: 1, type: "hello", contract: APPLET_CONTRACT_VERSION });
    });
  }

  /** Send one client transaction; resolves on `ack`, rejects on `reject`. */
  mutate(mutations: AppletMutationV1[]): Promise<AppletChangeV1[]> {
    if (!this.#socket) {
      return Promise.reject(new Error("The Applet is not connected"));
    }
    const txnId = `c${++this.#txnSeq}`;
    return new Promise<AppletChangeV1[]>((resolve, reject) => {
      this.#pending.set(txnId, { resolve, reject });
      try {
        this.#write({ v: 1, type: "mutate", txnId, mutations });
      } catch (error) {
        this.#pending.delete(txnId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #write(frame: Parameters<typeof encodeFrame>[0]): void {
    const socket = this.#socket;
    if (!socket) throw new Error("The Applet is not connected");
    socket.send(encodeFrame(frame));
  }

  #failPending(error: Error): void {
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
  }

  #setState(patch: Partial<AppletState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
