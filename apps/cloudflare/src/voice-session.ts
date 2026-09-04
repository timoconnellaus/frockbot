// The per-User voice transport (voice plan D2).
//
// One Durable Object per User, `idFromName(userId)`, holding two WebSockets:
// the browser's, opened through the authenticated gateway route, and the
// upstream provider's, opened from here. It holds **no authority**. Every
// durable fact — the voice budget — belongs to the `UserConfiguration` object
// and is reached over a narrow RPC, which is the rule ADR 0017 already sets
// for Subagent Durable Objects and the reason this object may be evicted at
// any moment without losing anything that matters.
//
// Why the object at all, when a browser could talk to a provider directly:
// the credential. AI Gateway authenticates a realtime WebSocket with
// `cf-aig-authorization`, and OpenAI with a bearer key; a browser leg can
// carry neither without minting an ephemeral token per session. The socket
// pair here means the credential never leaves the server, and slice B's
// assistant reuses the same transport.
//
// Deliberately **not** hibernated. Hibernation gives a Durable Object back its
// memory between messages, and the upstream socket *is* memory — a hibernated
// object would wake with the browser's socket and no provider on the other
// end. Dictation is seconds long and continuously active, so the object simply
// stays resident for the length of one capture, and an eviction is a dropped
// session the composer reports and the person retries.
import { DurableObject } from "cloudflare:workers";
import {
  decodeVoiceDictationClientFrameV1,
  VOICE_DICTATION_VERSION_V1,
  type VoiceDictationServerFrameV1,
} from "@frockbot/protocol";
import { answeredEntryV1, loggedEntryV1 } from "./entry-boundary.js";
import type { UserConfiguration } from "./user-configuration.js";
import {
  decodeVoiceQuotaReceiptV1,
  voiceQuotaDayV1,
  type VoiceQuotaReceiptV1,
} from "./voice-quota.js";
import {
  translateVoiceUpstreamFrameV1,
  voiceUpstreamSessionUpdateV1,
  voiceUpstreamTargetV1,
  type VoiceSessionEnvV1,
  type VoiceUpstreamTargetV1,
} from "./voice-upstream.js";

export const VOICE_DICTATION_INTERNAL_PATH = "/internal/voice-dictation/v1";

/** How long the upstream has to accept the WebSocket before we give up. */
export const VOICE_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long a commit waits for the last transcript before it answers anyway.
 *
 * A person has pressed send. Waiting forever for a provider that has stopped
 * talking would strand the message; sending what is already in the draft is
 * always the better failure.
 */
export const VOICE_COMMIT_TIMEOUT_MS = 6_000;

/** A capture that nobody stops is closed rather than left to spend the budget. */
export const VOICE_CAPTURE_MAX_MS = 5 * 60_000;

interface VoiceSessionBindings extends VoiceSessionEnvV1 {
  /** The User authority. This object asks it; it keeps nothing it is told. */
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
}

interface LiveCapture {
  userId: string;
  sessionId: string;
  day: string;
  client: WebSocket;
  upstream: WebSocket;
  startedAt: number;
  charged: boolean;
  awaitingCommit: boolean;
  guard: ReturnType<typeof setTimeout> | undefined;
}

function serverFrame(frame: VoiceDictationServerFrameV1): string {
  return JSON.stringify(frame);
}

/** Base64 without a data copy per sample; workerd has no Buffer. */
function base64OfV1(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

export class VoiceSession extends DurableObject<VoiceSessionBindings> {
  #capture: LiveCapture | undefined;

  /**
   * This object's one HTTP door, and it exists for the socket alone: a 101
   * response and its `webSocket` cross a stub boundary only over `fetch`.
   */
  override fetch(request: Request): Promise<Response> {
    return answeredEntryV1("voice dictation failed", () => this.#open(request));
  }

  async #open(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== VOICE_DICTATION_INTERNAL_PATH) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }
    if (
      url.searchParams.get("version") !== String(VOICE_DICTATION_VERSION_V1)
    ) {
      return Response.json(
        { error: "unsupported dictation protocol" },
        { status: 400 },
      );
    }
    const userId = request.headers.get("x-frockbot-user-id") ?? "";
    if (!userId) {
      return Response.json(
        { error: "authenticated identity required" },
        { status: 401 },
      );
    }

    // Newest capture wins (D10's rule, one session per User): a second tab
    // takes the microphone rather than fighting the first for the budget.
    this.#endCapture("a newer dictation session took over");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // Audio arrives as binary frames; without this workerd hands them over as
    // Blobs, which have no synchronous bytes and would be dropped below.
    server.binaryType = "arraybuffer";

    // Everything after the 101 is off the request's critical path, so a slow
    // upstream shows as a composer waiting for `ready` rather than as a
    // handshake that never completes.
    void loggedEntryV1("voice dictation start", () =>
      this.#start(server, userId),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async #start(client: WebSocket, userId: string): Promise<void> {
    const sessionId = crypto.randomUUID();
    const day = voiceQuotaDayV1();
    let receipt: VoiceQuotaReceiptV1;
    try {
      receipt = decodeVoiceQuotaReceiptV1(
        await this.#quota(userId).reserveVoiceCapture({
          schemaVersion: 1,
          userId,
          day,
          sessionId,
        }),
      );
    } catch (error) {
      return this.#refuse(
        client,
        `Dictation is unavailable right now: ${
          error instanceof Error
            ? error.message
            : "the voice budget could not be read"
        }`,
      );
    }
    if (receipt.status === "refused") {
      return this.#refuse(
        client,
        receipt.reason ?? "You've used up today's dictation.",
      );
    }

    const target = voiceUpstreamTargetV1(this.env);
    if (target.path === "unconfigured") {
      return this.#refuse(client, target.message);
    }
    let upstream: WebSocket;
    try {
      upstream = await this.#connectUpstream(target);
    } catch (error) {
      return this.#refuse(
        client,
        `Dictation couldn't reach the transcription service: ${
          error instanceof Error ? error.message : "the connection failed"
        }`,
      );
    }

    const capture: LiveCapture = {
      userId,
      sessionId,
      day,
      client,
      upstream,
      startedAt: Date.now(),
      charged: false,
      awaitingCommit: false,
      guard: undefined,
    };
    this.#capture = capture;
    capture.guard = setTimeout(() => {
      void loggedEntryV1("voice capture ceiling", async () => {
        this.#send(client, {
          schemaVersion: 1,
          type: "error",
          message:
            "Dictation stopped after five minutes. Press the microphone again to carry on.",
        });
        await this.#settle(capture);
      });
    }, VOICE_CAPTURE_MAX_MS);

    upstream.send(JSON.stringify(voiceUpstreamSessionUpdateV1()));

    upstream.addEventListener("message", (event: MessageEvent) => {
      void loggedEntryV1("voice upstream message", () =>
        this.#onUpstream(capture, event.data),
      );
    });
    upstream.addEventListener("close", () => {
      void loggedEntryV1("voice upstream close", () => this.#settle(capture));
    });
    upstream.addEventListener("error", () => {
      void loggedEntryV1("voice upstream error", () => this.#settle(capture));
    });
    client.addEventListener("message", (event: MessageEvent) => {
      void loggedEntryV1("voice client message", () =>
        this.#onClient(capture, event.data),
      );
    });
    client.addEventListener("close", () => {
      void loggedEntryV1("voice client close", () => this.#settle(capture));
    });
    client.addEventListener("error", () => {
      void loggedEntryV1("voice client error", () => this.#settle(capture));
    });

    this.#send(client, { schemaVersion: 1, type: "ready" });
  }

  async #connectUpstream(
    target: Exclude<VoiceUpstreamTargetV1, { path: "unconfigured" }>,
  ): Promise<WebSocket> {
    const response = await fetch(target.url.replace(/^ws/, "http"), {
      headers: { upgrade: "websocket", ...target.headers },
      signal: AbortSignal.timeout(VOICE_UPSTREAM_CONNECT_TIMEOUT_MS),
    });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`the upstream answered ${response.status}`);
    }
    socket.accept();
    // Without this, binary frames are silently dropped by workerd — the
    // constraint the plan records from the zerobsai implementation.
    socket.binaryType = "arraybuffer";
    return socket;
  }

  async #onClient(
    capture: LiveCapture,
    data: string | ArrayBuffer,
  ): Promise<void> {
    if (this.#capture !== capture) return;
    if (typeof data !== "string") {
      // Audio. PCM16 straight through, base64 as the realtime API takes it.
      capture.upstream.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64OfV1(new Uint8Array(data)),
        }),
      );
      return;
    }
    let frame;
    try {
      frame = decodeVoiceDictationClientFrameV1(JSON.parse(data) as unknown);
    } catch {
      return;
    }
    if (frame.type === "cancel") {
      await this.#settle(capture);
      return;
    }
    // Commit: flush the buffer, wait for the last transcript, then release the
    // composer. The deadline is what stops a silent provider stranding a
    // message the person has already pressed send on.
    capture.awaitingCommit = true;
    capture.upstream.send(
      JSON.stringify({ type: "input_audio_buffer.commit" }),
    );
    setTimeout(() => {
      void loggedEntryV1("voice commit deadline", async () => {
        if (!capture.awaitingCommit) return;
        capture.awaitingCommit = false;
        this.#send(capture.client, { schemaVersion: 1, type: "final" });
        await this.#settle(capture);
      });
    }, VOICE_COMMIT_TIMEOUT_MS);
  }

  async #onUpstream(
    capture: LiveCapture,
    data: string | ArrayBuffer,
  ): Promise<void> {
    if (this.#capture !== capture || typeof data !== "string") return;
    const translated = translateVoiceUpstreamFrameV1(data);
    if (!translated) return;
    this.#send(capture.client, translated.frame);
    if (translated.frame.type === "error") {
      await this.#settle(capture);
      return;
    }
    if (translated.completed && capture.awaitingCommit) {
      capture.awaitingCommit = false;
      this.#send(capture.client, { schemaVersion: 1, type: "final" });
      await this.#settle(capture);
    }
  }

  /** Charge the budget, then drop both legs. Idempotent per capture. */
  async #settle(capture: LiveCapture): Promise<void> {
    if (capture.charged) return;
    capture.charged = true;
    if (capture.guard !== undefined) clearTimeout(capture.guard);
    const seconds = Math.max(
      0,
      Math.round((Date.now() - capture.startedAt) / 1_000),
    );
    try {
      await this.#quota(capture.userId).recordVoiceUsage({
        schemaVersion: 1,
        userId: capture.userId,
        day: capture.day,
        sessionId: capture.sessionId,
        seconds,
      });
    } catch (error) {
      // The budget is the User object's; a failure to charge is recorded and
      // never allowed to hold a socket open.
      console.error(
        `voice usage was not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.#close(capture.upstream);
    this.#close(capture.client);
    if (this.#capture === capture) this.#capture = undefined;
  }

  #endCapture(reason: string): void {
    const capture = this.#capture;
    if (!capture) return;
    this.#send(capture.client, {
      schemaVersion: 1,
      type: "error",
      message: `Dictation stopped: ${reason}.`,
    });
    void loggedEntryV1("voice session takeover", () => this.#settle(capture));
  }

  #refuse(client: WebSocket, message: string): void {
    this.#send(client, { schemaVersion: 1, type: "error", message });
    this.#close(client);
  }

  #send(socket: WebSocket, frame: VoiceDictationServerFrameV1): void {
    try {
      socket.send(serverFrame(frame));
    } catch {
      // A socket the far end has already dropped is not a failure worth
      // reporting; the close handler settles the capture either way.
    }
  }

  #close(socket: WebSocket): void {
    try {
      socket.close(1000, "dictation ended");
    } catch {
      // Already closed.
    }
  }

  /**
   * The User authority, named by the identity the gateway authenticated. The
   * id travels with each call rather than being read back from storage,
   * because this object holds nothing durable.
   */
  #quota(userId: string) {
    const namespace = this.env.USER_CONFIGURATIONS;
    return namespace.get(namespace.idFromName(userId));
  }
}
