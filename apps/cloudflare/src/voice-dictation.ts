// The composer's dictation relay: one client socket, one upstream socket.
//
// Deliberately not a Durable Object. Dictation is short-lived and admits
// nothing durable — the transcript lands in an editable draft and only the
// ordinary Send admits a Turn — and the one thing it must protect is the
// provider key, which stays here. The gateway proves the identity before
// this runs; this module never sees a cookie or a bearer token.
//
// What it does hold the line on:
//
//   Spend. Before the upstream is opened the account's lease is taken from
//   the voice object — one dictation at a time per account, a bounded window
//   of seconds reserved up front and renewed while the capture runs — so a
//   page that opens sockets in a loop is refused rather than billed.
//
//   Completeness. The upstream has no turn detection — the streaming
//   transcription models refuse it — so a capture is one item and the
//   relay's commit after `stop` is the only thing that closes it. Deltas
//   grow the draft while the person speaks; the committed item's transcript
//   is the segment that replaces them. The relay still hands segments over
//   in committed order and says `final` only once every committed item has
//   answered, which costs nothing and holds if an upstream ever commits more
//   than one. A stop the upstream cannot finish in time, or a provider
//   failure after stop, is reported as what it is; the draft keeps what
//   arrived.
//
//   Opening audio. Frames that arrive before the upstream has accepted the
//   session are held in order, bounded, and forwarded once it has, so
//   pressing the microphone and speaking at once loses nothing.
import {
  voiceDictationSessionUpdateV1,
  voiceDictationUpstreamTargetV1,
  type VoiceDictationEnvV1,
} from "@frockbot/app/voice/dictation-upstream";
import {
  translateVoiceRealtimeUpstreamFrameV1,
  voiceRealtimeAppendV1,
  voiceRealtimeCommitV1,
} from "@frockbot/app/voice/openai-realtime";
import {
  decodeVoiceDictationClientFrameV1,
  VOICE_DICTATION_FINAL_TIMEOUT_MS_V1,
  VOICE_DICTATION_LEASE_RENEW_MS_V1,
  VOICE_DICTATION_MAX_MS_V1,
  VOICE_DICTATION_OPENING_BUFFER_BYTES_V1,
  VOICE_REALTIME_CONNECT_TIMEOUT_MS_V1,
  type VoiceDictationServerFrameV1,
} from "@frockbot/app/voice/shared";

/**
 * The account's dictation lease, held by the voice object. Acquired before
 * the provider is opened, renewed while the capture runs, released with the
 * seconds actually used so the meter is reconciled.
 */
export interface VoiceDictationLeaseV1 {
  acquire(): Promise<
    { status: "acquired" } | { status: "refused"; reason: string }
  >;
  /** False when the account has run out of allowance; the relay then stops. */
  renew(): Promise<boolean>;
  release(activeSeconds: number): Promise<void>;
}

export interface VoiceDictationRelayOptions {
  env: VoiceDictationEnvV1;
  lease?: VoiceDictationLeaseV1;
  /** Opens the upstream socket; the default is a `fetch` upgrade. */
  connectUpstream?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<WebSocket>;
  connectTimeoutMs?: number;
  finalTimeoutMs?: number;
  maxCaptureMs?: number;
  leaseRenewMs?: number;
  now?: () => number;
}

/** Opens the upstream with a `fetch` upgrade, the way a Worker must. */
async function fetchUpstreamSocket(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  const target = new URL(url);
  if (target.protocol === "wss:") target.protocol = "https:";
  if (target.protocol === "ws:") target.protocol = "http:";
  const response = await fetch(target, {
    headers: { ...headers, upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    throw new Error(`upstream refused the upgrade (${response.status})`);
  }
  socket.accept();
  return socket;
}

/**
 * Answers the authenticated `GET /api/voice/dictation` upgrade.
 *
 * The response is the 101 the gateway hands back; everything after it is the
 * relay's own loop over the two sockets.
 */
export function openVoiceDictationRelayV1(
  request: Request,
  options: VoiceDictationRelayOptions,
): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      { error: "expected a WebSocket upgrade" },
      { status: 426 },
    );
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  // Audio must arrive as bytes, not as a Blob to be read asynchronously,
  // or frames could be forwarded out of order.
  try {
    (server as { binaryType?: string }).binaryType = "arraybuffer";
  } catch {
    // An older runtime without the setter still answers ArrayBuffers.
  }
  runRelay(server, options);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * A binary frame as bytes, whichever shape the runtime hands it over in.
 * `instanceof ArrayBuffer` is not enough on its own: a buffer created in
 * another realm (the test runner's module context, for one) fails it while
 * still being exactly what it says it is.
 */
function binaryFrame(data: unknown): ArrayBuffer | undefined {
  if (typeof data === "string") return undefined;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    return data as ArrayBuffer;
  }
  return undefined;
}

function send(socket: WebSocket, frame: VoiceDictationServerFrameV1): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Closed already; the close handler tears the rest down.
  }
}

type FailureCode =
  "unconfigured" | "upstream" | "timeout" | "limit" | "protocol";

function runRelay(
  client: WebSocket,
  options: VoiceDictationRelayOptions,
): void {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? VOICE_REALTIME_CONNECT_TIMEOUT_MS_V1;
  const finalTimeoutMs =
    options.finalTimeoutMs ?? VOICE_DICTATION_FINAL_TIMEOUT_MS_V1;
  const maxCaptureMs = options.maxCaptureMs ?? VOICE_DICTATION_MAX_MS_V1;
  const leaseRenewMs =
    options.leaseRenewMs ?? VOICE_DICTATION_LEASE_RENEW_MS_V1;
  const connectUpstream = options.connectUpstream ?? fetchUpstreamSocket;
  const now = options.now ?? (() => Date.now());

  let started = false;
  let upstream: WebSocket | undefined;
  let upstreamReady = false;
  let upstreamOpenedAt: number | undefined;
  let closed = false;
  let stopping = false;
  /** The relay's own commit after `stop` has been sent, and then answered. */
  let commitSent = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopCommitSettled = false;
  /** The five-minute cap fired: the capture is finalised, then refused. */
  let capped = false;
  let leaseHeld = false;
  let pending: ArrayBuffer[] = [];
  let pendingBytes = 0;
  let truncated = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  // Items the upstream committed, in the order it committed them, and the
  // transcriptions that have answered so far. Segments go to the client in
  // committed order even when completions arrive out of it.
  const committedOrder: string[] = [];
  const answered = new Map<string, string>();
  const delivered = new Set<string>();
  const outstanding = new Set<string>();
  const partials = new Map<string, string>();

  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const activeSeconds = () =>
    upstreamOpenedAt === undefined ? 0 : (now() - upstreamOpenedAt) / 1000;

  const finish = (frame?: VoiceDictationServerFrameV1) => {
    if (closed) return;
    closed = true;
    if (frame) send(client, frame);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try {
      upstream?.close(1000, "dictation ended");
    } catch {
      // Already closed.
    }
    try {
      client.close(1000, "dictation ended");
    } catch {
      // Already closed.
    }
    if (leaseHeld) {
      leaseHeld = false;
      void options.lease?.release(activeSeconds()).catch(() => undefined);
    }
  };

  const fail = (message: string, code: FailureCode) =>
    finish({ schemaVersion: 1, type: "error", message, code });

  const forward = (chunk: ArrayBuffer) => {
    if (upstream && upstreamReady) {
      try {
        upstream.send(voiceRealtimeAppendV1(chunk));
      } catch {
        fail("Dictation stopped: the speech service went away.", "upstream");
      }
      return;
    }
    pending.push(chunk);
    pendingBytes += chunk.byteLength;
    while (
      pendingBytes > VOICE_DICTATION_OPENING_BUFFER_BYTES_V1 &&
      pending.length > 1
    ) {
      pendingBytes -= pending.shift()!.byteLength;
      truncated = true;
    }
  };

  /** Hands every answered item at the head of the committed order to the client. */
  const flushSegments = () => {
    while (committedOrder.length > 0) {
      const head = committedOrder[0]!;
      const text = answered.get(head);
      if (text === undefined) break;
      committedOrder.shift();
      answered.delete(head);
      delivered.add(head);
      partials.delete(head);
      if (text) send(client, { schemaVersion: 1, type: "segment", text });
    }
    if (partials.size > 0)
      send(client, {
        schemaVersion: 1,
        type: "delta",
        text: [...partials.values()].join(" "),
      });
  };

  const stopIsComplete = () =>
    stopping && stopCommitSettled && outstanding.size === 0;

  /**
   * Ends a capture the upstream finished. A capture the five-minute cap
   * stopped keeps every segment it produced and closes on the `limit` error
   * in place of `final`, so the person is told why dictation ended.
   */
  const finishCapture = () => {
    if (capped) {
      fail(
        "Dictation stopped after five minutes. Press the microphone to continue.",
        "limit",
      );
      return;
    }
    finish({ schemaVersion: 1, type: "final" });
  };

  const finishIfComplete = () => {
    if (stopIsComplete()) finishCapture();
  };

  const onUpstreamEvent = (raw: string) => {
    const event = translateVoiceRealtimeUpstreamFrameV1(raw);
    if (!event) return;
    switch (event.kind) {
      case "session-updated":
        if (!upstreamReady) acceptSession();
        return;
      case "delta": {
        const id = event.itemId ?? "uncommitted";
        if (delivered.has(id)) return;
        partials.set(id, (partials.get(id) ?? "") + event.text);
        send(client, {
          schemaVersion: 1,
          type: "delta",
          text: [...partials.values()].join(" "),
        });
        return;
      }
      case "committed":
        if (!delivered.has(event.itemId)) {
          if (!committedOrder.includes(event.itemId)) {
            committedOrder.push(event.itemId);
          }
          if (!answered.has(event.itemId)) outstanding.add(event.itemId);
        }
        // Turn detection is off upstream, so the only thing that commits an
        // item is the relay's own commit after `stop`.
        if (stopping && commitSent) stopCommitSettled = true;
        flushSegments();
        return;
      case "completed": {
        const id = event.itemId ?? `unnamed-${answered.size + delivered.size}`;
        outstanding.delete(id);
        if (!committedOrder.includes(id) && !delivered.has(id)) {
          committedOrder.push(id);
        }
        answered.set(id, event.text);
        flushSegments();
        finishIfComplete();
        return;
      }
      case "failed": {
        // One item the provider could not transcribe. Its words are lost and
        // the person is told; the rest of the capture stands.
        const id = event.itemId;
        if (id) {
          outstanding.delete(id);
          if (!delivered.has(id)) {
            if (!committedOrder.includes(id)) committedOrder.push(id);
            answered.set(id, "");
          }
        }
        console.error("voice dictation item failed", event.message);
        send(client, {
          schemaVersion: 1,
          type: "notice",
          message: "Part of what you said could not be transcribed.",
        });
        flushSegments();
        finishIfComplete();
        return;
      }
      case "error":
        if (stopping && event.emptyBuffer) {
          // The relay committed a buffer with nothing in it: the person
          // pressed stop without saying anything new.
          stopCommitSettled = true;
          finishIfComplete();
          return;
        }
        console.error("voice dictation upstream error", event.message);
        fail(
          stopping
            ? "Dictation ended before the last words were transcribed. What arrived is in your draft."
            : "Dictation stopped: the speech service refused the session. Try again.",
          "upstream",
        );
        return;
    }
  };

  const start = async () => {
    const target = voiceDictationUpstreamTargetV1(options.env);
    if (target.path === "unconfigured") {
      fail(target.message, "unconfigured");
      return;
    }
    if (options.lease) {
      let admission: Awaited<ReturnType<VoiceDictationLeaseV1["acquire"]>>;
      try {
        admission = await options.lease.acquire();
      } catch (error) {
        console.error("voice dictation lease unavailable", error);
        fail("Dictation is unavailable right now. Try again.", "limit");
        return;
      }
      if (closed) return;
      if (admission.status === "refused") {
        fail(admission.reason, "limit");
        return;
      }
      leaseHeld = true;
      const renew = () =>
        after(leaseRenewMs, async () => {
          if (closed) return;
          let ok = false;
          try {
            ok = await options.lease!.renew();
          } catch {
            ok = false;
          }
          if (closed) return;
          if (!ok) {
            fail(
              "Today's dictation allowance is used up. What arrived is in your draft.",
              "limit",
            );
            return;
          }
          renew();
        });
      renew();
    }
    connectTimer = after(connectTimeoutMs, () =>
      fail("Dictation didn't start in time. Try again.", "timeout"),
    );
    let socket: WebSocket;
    try {
      socket = await connectUpstream(target.url, target.headers);
    } catch (error) {
      console.error("voice dictation upstream refused", error);
      fail(
        "Dictation stopped: the speech service refused the connection. Try again.",
        "upstream",
      );
      return;
    }
    if (closed) {
      socket.close(1000, "client left");
      return;
    }
    upstream = socket;
    upstreamOpenedAt = now();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      onUpstreamEvent(event.data);
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      if (stopIsComplete()) {
        finishCapture();
        return;
      }
      fail(
        stopping
          ? "Dictation ended before the last words were transcribed. What arrived is in your draft."
          : "Dictation stopped: the speech service closed the session.",
        "upstream",
      );
    });
    socket.addEventListener("error", () => {
      if (!closed)
        fail("Dictation stopped: the speech service failed.", "upstream");
    });
    socket.send(JSON.stringify(voiceDictationSessionUpdateV1()));
  };

  const acceptSession = () => {
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer);
      timers.delete(connectTimer);
    }
    upstreamReady = true;
    const held = pending;
    pending = [];
    pendingBytes = 0;
    for (const chunk of held) forward(chunk);
    if (truncated) {
      send(client, {
        schemaVersion: 1,
        type: "notice",
        message:
          "The first part of what you said was lost while dictation was starting.",
      });
    }
    send(client, { schemaVersion: 1, type: "ready" });
    after(maxCaptureMs, () => {
      if (closed || stopping) return;
      capped = true;
      stop();
    });
    if (stopping) commit();
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Bounded from the moment of the stop, whether or not the upstream has
    // opened yet: audio held here is still sent once it opens and committed
    // then, and a stop the upstream cannot finish is reported, not faked.
    after(finalTimeoutMs, () => {
      if (closed) return;
      fail(
        "Dictation ended before the last words were transcribed. What arrived is in your draft.",
        "timeout",
      );
    });
    if (upstream && upstreamReady) commit();
  };

  const commit = () => {
    if (commitSent) return;
    commitSent = true;
    try {
      upstream!.send(voiceRealtimeCommitV1());
    } catch {
      fail(
        "Dictation ended before the last words were transcribed. What arrived is in your draft.",
        "upstream",
      );
    }
  };

  client.addEventListener("message", (event) => {
    if (closed) return;
    const binary = binaryFrame(event.data);
    if (binary) {
      if (!started) {
        fail("Send the start frame before audio.", "protocol");
        return;
      }
      if (stopping) return;
      forward(binary);
      return;
    }
    if (typeof event.data !== "string") return;
    let frame;
    try {
      frame = decodeVoiceDictationClientFrameV1(JSON.parse(event.data));
    } catch {
      fail("That dictation frame is not understood.", "protocol");
      return;
    }
    if (frame.type === "start") {
      if (started) return;
      started = true;
      void start();
      return;
    }
    if (frame.type === "stop") {
      if (!started) {
        finish({ schemaVersion: 1, type: "final" });
        return;
      }
      stop();
    }
  });
  client.addEventListener("close", () => {
    finish();
  });
  client.addEventListener("error", () => {
    finish();
  });
}
