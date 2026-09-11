/**
 * The server half of wire protocol v1, with no Durable Object in sight.
 *
 * `Applet` supplies peers backed by hibernating WebSockets; a test supplies
 * peers backed by anything. Either way this is the only implementation of the
 * handshake, catch-up, and mutate/ack/reject rules, so the two can never drift.
 */

import {
  APPLET_CONTRACT_VERSION,
  AppletProtocolError,
  decodeClientFrame,
  type AppletChangeV1,
  type AppletProtocolVersion,
  type AppletServerFrameV1,
  type AppletViewerV1,
} from "../protocol/index.js";
import type { AppletStore } from "./store.js";

export interface AppletPeer {
  send(frame: AppletServerFrameV1): void;
  close(code: number, reason: string): void;
  readonly viewer: AppletViewerV1;
  /**
   * The protocol this socket's page speaks, settled by its URL before the
   * first frame. Every frame sent to it carries this `v`.
   */
  readonly protocol: AppletProtocolVersion;
  /** False until the peer has been sent a snapshot or a catch-up. */
  synced: boolean;
}

export interface AppletProtocolServerOptions {
  generationId: string;
  schemaRevision: number;
  /** Wraps one client transaction; the Durable Object uses `transactionSync`. */
  transaction<T>(closure: () => T): T;
  /** Every currently attached peer, including the one being served. */
  peers(): AppletPeer[];
}

export class AppletProtocolServer {
  constructor(
    private readonly store: AppletStore,
    private readonly options: AppletProtocolServerOptions,
  ) {}

  /**
   * The unprompted `hello` a peer gets the moment its socket is accepted.
   *
   * A v2 page that opened with no cursor is handed the snapshot in the same
   * frame, so its first render waits on nothing else. A page resuming from a
   * cursor asks for its catch-up itself, as v1 always has, and a snapshot that
   * would not fit the frame is left for the v1 exchange too.
   */
  greet(peer: AppletPeer, handshake: { since?: number } = {}): void {
    const hello: AppletServerFrameV1 = {
      v: peer.protocol,
      type: "hello",
      contract: APPLET_CONTRACT_VERSION,
      generationId: this.options.generationId,
      viewer: peer.viewer,
      tables: Object.keys(this.store.tables),
      schemaRevision: this.options.schemaRevision,
      lastChangeId: this.store.lastChangeId,
    };
    if (peer.protocol === 2 && handshake.since === undefined) {
      try {
        peer.send({ ...hello, snapshot: this.store.snapshot() });
        peer.synced = true;
        return;
      } catch (error) {
        if (!(error instanceof AppletProtocolError)) throw error;
      }
    }
    peer.send(hello);
  }

  /** Handle one inbound frame. Never throws; a bad frame closes the socket. */
  receive(peer: AppletPeer, message: unknown): void {
    let frame;
    try {
      frame = decodeClientFrame(message);
    } catch (error) {
      peer.close(1008, describe(error));
      return;
    }

    if (frame.type === "hello") {
      const catchUp =
        frame.since === undefined
          ? undefined
          : this.store.changesSince(frame.since);
      if (catchUp) {
        peer.send({
          v: peer.protocol,
          type: "changes",
          lastChangeId: this.store.lastChangeId,
          changes: catchUp,
        });
      } else {
        peer.send({
          v: peer.protocol,
          type: "snapshot",
          lastChangeId: this.store.lastChangeId,
          tables: this.store.snapshot(),
        });
      }
      peer.synced = true;
      return;
    }

    if (!peer.viewer.canWrite) {
      peer.send({
        v: peer.protocol,
        type: "reject",
        txnId: frame.txnId,
        reason: "This viewer may not write",
      });
      return;
    }

    let changes: AppletChangeV1[];
    try {
      changes = this.options.transaction(() =>
        this.store.applyMutations(frame.mutations, frame.txnId),
      );
    } catch (error) {
      peer.send({
        v: peer.protocol,
        type: "reject",
        txnId: frame.txnId,
        reason: describe(error),
      });
      return;
    }

    const lastChangeId = this.store.lastChangeId;
    peer.send({
      v: peer.protocol,
      type: "ack",
      txnId: frame.txnId,
      lastChangeId,
      changes,
    });
    this.broadcast(
      { v: 1, type: "changes", lastChangeId, txnId: frame.txnId, changes },
      peer,
    );
  }

  /** Push changes made outside a client transaction — a tool call — to viewers. */
  broadcastChanges(changes: AppletChangeV1[]): void {
    if (changes.length === 0) return;
    this.broadcast({
      v: 1,
      type: "changes",
      lastChangeId: this.store.lastChangeId,
      changes,
    });
  }

  /** One frame to every synced peer, each in the version its socket speaks. */
  private broadcast(frame: AppletServerFrameV1, except?: AppletPeer): void {
    for (const peer of this.options.peers()) {
      if (peer === except || !peer.synced) continue;
      try {
        peer.send({ ...frame, v: peer.protocol });
      } catch (error) {
        if (!(error instanceof AppletProtocolError)) throw error;
        // A batch too large for one frame: tell the peer where the log now is
        // and let it resync from there rather than silently diverge.
        peer.send({
          v: peer.protocol,
          type: "changes",
          lastChangeId: this.store.lastChangeId,
          changes: [],
        });
      }
    }
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
