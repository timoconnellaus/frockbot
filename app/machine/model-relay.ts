// Local model relays, as the User Durable Object runs them.
//
// A Bot's model call to a local model is sent down the machine socket of the
// Mac its Connection names, and the Mac streams the model server's answer back
// up the same socket. This holds each relay between the two: the frame out,
// then a `Response` whose body is fed by the frames that come back.
//
// Nothing here is durable. A relay lives exactly as long as the model call
// that asked for it, which is holding this object awake; the kernel's
// idempotency key is what stops a call being sent twice, and the relay id is
// that key. A Mac that is not connected is refused before anything is sent,
// and one whose socket closes mid-answer fails every relay it was running:
// there is never a fallback to another model.

import {
  LOCAL_MODEL_DROPPED_V1,
  LOCAL_MODEL_OFFLINE_V1,
  MACHINE_RELAY_LIMITS_V1,
  type MachineModelRelayRequestV1,
  type MachineRelayCancelFrameV1,
  type MachineRelayFrameV1,
  type MachineRelayUpFrameV1,
} from "@frockbot/core/machine-protocol";

export interface MachineModelRelaysHostV1 {
  connected(machineId: string): boolean;
  push(
    machineId: string,
    frame: MachineRelayFrameV1 | MachineRelayCancelFrameV1,
  ): void;
  now?(): number;
}

interface OpenRelay {
  machineId: string;
  bytes: number;
  head(response: Response): void;
  refuse(error: Error): void;
  /** Set once the head arrived: the body the answer is streamed into. */
  stream?: ReadableStreamDefaultController<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
}

export class MachineModelRelaysV1 {
  readonly #open = new Map<string, OpenRelay>();
  readonly #encoder = new TextEncoder();

  constructor(private readonly host: MachineModelRelaysHostV1) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** How many relays are waiting on a Mac, for tests. */
  get size(): number {
    return this.#open.size;
  }

  /**
   * Send one request to the Mac and answer its response once the head
   * arrives. Refused at once when the Mac is not connected.
   */
  open(request: MachineModelRelayRequestV1): Promise<Response> {
    if (!this.host.connected(request.machineId)) {
      return Promise.reject(new Error(LOCAL_MODEL_OFFLINE_V1));
    }
    if (this.#open.has(request.relayId)) {
      return Promise.reject(
        new Error("This local model request is already running."),
      );
    }
    const { relayId, machineId } = request;
    return new Promise<Response>((resolve, reject) => {
      const relay: OpenRelay = {
        machineId,
        bytes: 0,
        head: resolve,
        refuse: reject,
        timer: setTimeout(() => {
          this.finish(relayId);
          this.cancel(machineId, relayId);
          reject(
            new Error(
              "Your local model didn't start answering in time. It may still be loading; try again in a moment.",
            ),
          );
        }, request.firstByteMs),
      };
      this.#open.set(relayId, relay);
      const now = this.now();
      this.host.push(machineId, {
        type: "relay",
        relayId,
        method: request.method,
        url: request.url,
        body: request.body,
        deadline: new Date(now + request.firstByteMs).toISOString(),
        serverTime: new Date(now).toISOString(),
      });
    });
  }

  /** One frame a Mac sent up its socket. A frame for another Mac's relay is ignored. */
  receive(machineId: string, frame: MachineRelayUpFrameV1): void {
    const relay = this.#open.get(frame.relayId);
    if (!relay || relay.machineId !== machineId) return;
    switch (frame.type) {
      case "relay-head": {
        if (relay.stream) return;
        clearTimeout(relay.timer);
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            relay.stream = controller;
          },
          cancel: () => {
            if (this.finish(frame.relayId)) {
              this.cancel(machineId, frame.relayId);
            }
          },
        });
        relay.head(
          new Response(body, {
            status: frame.status,
            headers: frame.contentType
              ? { "content-type": frame.contentType }
              : {},
          }),
        );
        return;
      }
      case "relay-data": {
        if (!relay.stream) return;
        const bytes = this.#encoder.encode(frame.data);
        relay.bytes += bytes.byteLength;
        if (relay.bytes > MACHINE_RELAY_LIMITS_V1.responseBytes) {
          relay.stream.error(
            new Error(
              "Your local model's answer was larger than FrockBot accepts.",
            ),
          );
          this.finish(frame.relayId);
          this.cancel(machineId, frame.relayId);
          return;
        }
        relay.stream.enqueue(bytes);
        return;
      }
      case "relay-end":
        if (relay.stream) relay.stream.close();
        else
          relay.refuse(new Error("Your Mac ended the answer before it began."));
        this.finish(frame.relayId);
        return;
      case "relay-fail":
        if (relay.stream) relay.stream.error(new Error(frame.error));
        else relay.refuse(new Error(frame.error));
        this.finish(frame.relayId);
        return;
    }
  }

  /** The Mac's socket closed: nothing it was answering can finish. */
  closed(machineId: string): void {
    for (const [relayId, relay] of [...this.#open]) {
      if (relay.machineId !== machineId) continue;
      if (relay.stream) relay.stream.error(new Error(LOCAL_MODEL_DROPPED_V1));
      else relay.refuse(new Error(LOCAL_MODEL_OFFLINE_V1));
      this.finish(relayId);
    }
  }

  private finish(relayId: string): boolean {
    const relay = this.#open.get(relayId);
    if (!relay) return false;
    clearTimeout(relay.timer);
    this.#open.delete(relayId);
    return true;
  }

  private cancel(machineId: string, relayId: string): void {
    try {
      this.host.push(machineId, { type: "relay-cancel", relayId });
    } catch {
      // A socket that cannot take the cancel is closing, which stops the Mac's
      // request too.
    }
  }
}
