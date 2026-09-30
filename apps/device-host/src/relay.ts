// The local model relay: the cloud's model request, forwarded to a model
// server on this Mac's loopback and streamed back over the machine socket.
//
// It is narrow on purpose. The destination rule is checked here again, whatever
// the cloud sent — `localhost`, `127.0.0.1` or `[::1]` and nothing else — and
// the host's own Deno permissions admit only those hosts beside the
// deployment, so a flaw in this check still reaches no other address. A
// redirect is refused rather than followed, since following one is how a
// loopback server would hand the relay somewhere else.

import {
  MACHINE_RELAY_LIMITS_V1,
  decodeLocalModelUrlV1,
  type MachineRelayCancelFrameV1,
  type MachineRelayFrameV1,
  type MachineRelayUpFrameV1,
} from "@frockbot/core/machine-protocol";

export interface LocalModelRelayOptionsV1 {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** Relay ids remembered, so a frame delivered twice is forwarded once. */
const SEEN_MAX = 500;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Split text into frame-sized pieces without cutting a surrogate pair. */
export function relayPiecesV1(
  text: string,
  size: number = MACHINE_RELAY_LIMITS_V1.dataChars,
): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Why a request never reached the model server, in the person's words. */
function unreachable(url: string, error: unknown): string {
  const origin = new URL(url).host;
  const text = message(error);
  if (/refused|ECONNREFUSED|connect/i.test(text)) {
    return `Nothing is answering at ${origin} on this Mac. Start the model server and try again.`;
  }
  return `The model server at ${origin} could not be reached: ${text}`;
}

export class LocalModelRelayV1 {
  private readonly running = new Map<string, AbortController>();
  private readonly seen: string[] = [];

  constructor(private readonly options: LocalModelRelayOptionsV1) {}

  /** One frame from the cloud. Never throws; every failure is a `relay-fail`. */
  async handle(
    frame: MachineRelayFrameV1 | MachineRelayCancelFrameV1,
    send: (reply: MachineRelayUpFrameV1) => void,
    receivedAt: number = Date.now(),
  ): Promise<void> {
    if (frame.type === "relay-cancel") {
      this.running.get(frame.relayId)?.abort();
      return;
    }
    const { relayId } = frame;
    if (this.seen.includes(relayId)) return;
    this.seen.push(relayId);
    if (this.seen.length > SEEN_MAX) this.seen.shift();
    const refuse = (error: string): void =>
      send({
        type: "relay-fail",
        relayId,
        error: error.slice(0, MACHINE_RELAY_LIMITS_V1.error),
      });
    let url: string;
    try {
      url = decodeLocalModelUrlV1(frame.url);
    } catch (error) {
      refuse(`refused: ${message(error)}`);
      return;
    }
    if (this.running.size >= MACHINE_RELAY_LIMITS_V1.concurrent) {
      refuse(
        `This Mac is already answering ${MACHINE_RELAY_LIMITS_V1.concurrent} local model requests. Try again when one finishes.`,
      );
      return;
    }
    const allowed = Date.parse(frame.deadline) - Date.parse(frame.serverTime);
    const firstByte = allowed - (Date.now() - receivedAt);
    if (firstByte <= 0) {
      refuse("the request arrived after its deadline");
      return;
    }
    const controller = new AbortController();
    this.running.set(relayId, controller);
    const timer = setTimeout(() => controller.abort(), firstByte);
    let headed = false;
    try {
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          method: frame.method,
          headers: {
            accept: "application/json, text/event-stream",
            ...(frame.body === null
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(frame.body === null ? {} : { body: frame.body }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          refuse("the model server did not answer before the deadline");
        } else {
          refuse(unreachable(url, error));
        }
        return;
      }
      clearTimeout(timer);
      const contentType = response.headers.get("content-type");
      send({
        type: "relay-head",
        relayId,
        status: response.status,
        ...(contentType
          ? {
              contentType: contentType.slice(
                0,
                MACHINE_RELAY_LIMITS_V1.contentType,
              ),
            }
          : {}),
      });
      headed = true;
      const decoder = new TextDecoder();
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const piece of relayPiecesV1(
            decoder.decode(value, { stream: true }),
          )) {
            send({ type: "relay-data", relayId, data: piece });
          }
        }
      }
      for (const piece of relayPiecesV1(decoder.decode())) {
        send({ type: "relay-data", relayId, data: piece });
      }
      send({ type: "relay-end", relayId });
    } catch (error) {
      // A cancel is the cloud's own doing; it is waiting for nothing.
      if (!controller.signal.aborted || !headed) {
        refuse(
          headed
            ? `the model server stopped mid-answer: ${message(error)}`
            : unreachable(url, error),
        );
      }
    } finally {
      clearTimeout(timer);
      this.running.delete(relayId);
    }
  }

  /** The socket is gone: nobody is waiting for any answer in flight. */
  stopAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }
}
