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
// The assistant's browser leg uses the Hibernation API, so a refresh is only a
// detached observer. The outgoing Gemini socket keeps an active session
// resident; if the object is reconstructed, the browser attachment identifies
// the User-owned session and its durable resumption handle opens Gemini again.
// Dictation remains deliberately short-lived and uses an ordinary socket.
import { DurableObject } from "cloudflare:workers";
import {
  decodeVoiceAssistantClientFrameV1,
  VOICE_ASSISTANT_VERSION_V1,
  type VoiceAssistantServerFrameV1,
  decodeVoiceDictationClientFrameV1,
  VOICE_DICTATION_VERSION_V1,
  type VoiceDictationServerFrameV1,
} from "@frockbot/protocol";
import { answeredEntryV1, loggedEntryV1 } from "./entry-boundary.js";
import type { UserConfiguration } from "./user-configuration.js";
import {
  decodeVoiceAssistantQuotaReceiptV1,
  decodeVoiceQuotaReceiptV1,
  voiceQuotaMonthV1,
  type VoiceAssistantQuotaReceiptV1,
  voiceQuotaDayV1,
  type VoiceQuotaReceiptV1,
} from "./voice-quota.js";
import {
  translateVoiceUpstreamFrameV1,
  VOICE_UPSTREAM_REFUSAL_MESSAGE_V1,
  voiceUpstreamSessionUpdateV1,
  voiceUpstreamTargetV1,
  type VoiceSessionEnvV1,
  type VoiceUpstreamTargetV1,
} from "./voice-upstream.js";
import {
  parseVoiceAssistantUpstreamFrameV1,
  voiceAssistantAnswerV1,
  voiceAssistantAudioInputV1,
  voiceAssistantKickoffV1,
  voiceAssistantSetupV1,
  voiceAssistantToolResponseV1,
  voiceAssistantUpstreamTargetV1,
  VOICE_ASSISTANT_UPSTREAM_ERROR_V1,
  type VoiceAssistantUpstreamTargetV1,
} from "./voice-assistant-upstream.js";
import { VOICE_IDLE_TIMEOUT_MS_V1 } from "@frockbot/plugin-voice";
import {
  decodeVoicePendingAnswerV1,
  type VoicePendingAnswerV1,
} from "@frockbot/plugin-voice/shared";
import {
  decodeRpcEnvelopeV1,
  rpcDecoded,
  rpcIdentifier,
  rpcString,
} from "./durable-rpc.js";

export const VOICE_DICTATION_INTERNAL_PATH = "/internal/voice-dictation/v1";
export const VOICE_ASSISTANT_INTERNAL_PATH = "/internal/voice-assistant/v1";

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

interface AssistantSocketAttachmentV1 {
  kind: "assistant";
  userId: string;
  sessionId: string;
  deviceId: string;
  month: string;
  startedAt: number;
}

interface LiveAssistant {
  userId: string;
  sessionId: string;
  deviceId: string;
  month: string;
  client?: WebSocket;
  upstream: WebSocket;
  startedAt: number;
  remainingSeconds: number;
  settled: boolean;
  reconnecting: boolean;
  kickoffPending: boolean;
  inputTranscript: string;
  outputTranscript: string;
  kickoffAnswers: VoicePendingAnswerV1[];
  briefingAnswerIds: string[];
  idleGuard?: ReturnType<typeof setTimeout>;
  quotaGuard?: ReturnType<typeof setTimeout>;
}

interface VoiceAssistantStartReceiptV1 {
  schemaVersion: 1;
  quota: VoiceAssistantQuotaReceiptV1;
  state?: { resumptionHandle?: string };
  replacedSessionId?: string;
  pendingAnswers?: VoicePendingAnswerV1[];
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

function bytesOfBase64V1(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function rpcSnapshotV1<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class VoiceSession extends DurableObject<VoiceSessionBindings> {
  #capture: LiveCapture | undefined;
  #assistant: LiveAssistant | undefined;
  /** Invalidates any slower socket setup as soon as a newer device arrives. */
  #voiceEpoch = 0;

  /**
   * This object's one HTTP door, and it exists for the socket alone: a 101
   * response and its `webSocket` cross a stub boundary only over `fetch`.
   */
  override fetch(request: Request): Promise<Response> {
    return answeredEntryV1("voice session failed", () => this.#open(request));
  }

  async #open(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname !== VOICE_DICTATION_INTERNAL_PATH &&
      url.pathname !== VOICE_ASSISTANT_INTERNAL_PATH
    ) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }
    const expectedVersion =
      url.pathname === VOICE_ASSISTANT_INTERNAL_PATH
        ? VOICE_ASSISTANT_VERSION_V1
        : VOICE_DICTATION_VERSION_V1;
    if (url.searchParams.get("version") !== String(expectedVersion)) {
      return Response.json(
        { error: "unsupported voice protocol" },
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

    if (url.pathname === VOICE_ASSISTANT_INTERNAL_PATH) {
      return this.#openAssistant(request, url, userId);
    }

    const voiceEpoch = ++this.#voiceEpoch;
    // Newest capture wins (D10's rule, one session per User): a second tab
    // takes the microphone rather than fighting the first for the budget.
    if (this.#assistant) {
      await this.#settleAssistant(
        this.#assistant,
        "replaced",
        "Voice moved to dictation on your newer device.",
      );
    }
    if (voiceEpoch !== this.#voiceEpoch) {
      return Response.json(
        { error: "a newer Voice session is already opening" },
        { status: 409 },
      );
    }
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
      this.#start(server, userId, voiceEpoch),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async #openAssistant(
    request: Request,
    url: URL,
    userId: string,
  ): Promise<Response> {
    const deviceId = url.searchParams.get("device") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId)) {
      return Response.json({ error: "invalid Voice device" }, { status: 400 });
    }
    const voiceEpoch = ++this.#voiceEpoch;
    if (this.#assistant) {
      await this.#settleAssistant(
        this.#assistant,
        "replaced",
        "Voice moved to your newer device.",
      );
    }
    if (voiceEpoch !== this.#voiceEpoch) {
      return Response.json(
        { error: "a newer Voice session is already opening" },
        { status: 409 },
      );
    }
    this.#endCapture("Voice assistant started");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.binaryType = "arraybuffer";
    this.ctx.acceptWebSocket(server, ["assistant"]);
    void loggedEntryV1("voice assistant start", () =>
      this.#startAssistant(server, userId, deviceId, voiceEpoch),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async #startAssistant(
    client: WebSocket,
    userId: string,
    deviceId: string,
    voiceEpoch: number,
  ): Promise<void> {
    const sessionId = crypto.randomUUID();
    const month = voiceQuotaMonthV1();
    let start: VoiceAssistantStartReceiptV1;
    try {
      start = rpcSnapshotV1(
        await this.#user(userId).startVoiceAssistant({
          schemaVersion: 1,
          userId,
          month,
          sessionId,
          deviceId,
          at: new Date().toISOString(),
        }),
      );
      start.quota = decodeVoiceAssistantQuotaReceiptV1(start.quota);
    } catch (error) {
      return this.#refuseAssistant(
        client,
        "error",
        `Voice is unavailable right now: ${
          error instanceof Error ? error.message : "its state could not be read"
        }`,
      );
    }
    if (start.quota.status === "refused") {
      return this.#refuseAssistant(
        client,
        "quota",
        start.quota.reason ?? "Voice is unavailable until next month.",
      );
    }
    if (voiceEpoch !== this.#voiceEpoch) {
      return this.#discardAssistantStart(client, userId, month, sessionId);
    }
    const target = voiceAssistantUpstreamTargetV1(this.env);
    if (target.path === "unconfigured") {
      await this.#user(userId).endVoiceAssistant({
        schemaVersion: 1,
        userId,
        month,
        sessionId,
        at: new Date().toISOString(),
        reason: "error",
        seconds: 0,
      });
      return this.#refuseAssistant(client, "error", target.message);
    }
    let upstream: WebSocket;
    try {
      upstream = await this.#connectAssistantUpstream(target);
    } catch (error) {
      console.error("Voice assistant upstream connection failed", error);
      await this.#user(userId).endVoiceAssistant({
        schemaVersion: 1,
        userId,
        month,
        sessionId,
        at: new Date().toISOString(),
        reason: "error",
        seconds: 0,
      });
      return this.#refuseAssistant(
        client,
        "error",
        VOICE_ASSISTANT_UPSTREAM_ERROR_V1,
      );
    }
    if (voiceEpoch !== this.#voiceEpoch) {
      return this.#discardAssistantStart(
        client,
        userId,
        month,
        sessionId,
        upstream,
      );
    }
    const assistant: LiveAssistant = {
      userId,
      sessionId,
      deviceId,
      month,
      client,
      upstream,
      startedAt: Date.now(),
      remainingSeconds: Math.max(
        0,
        start.quota.limitSeconds - start.quota.usedSeconds,
      ),
      settled: false,
      reconnecting: false,
      kickoffPending:
        !start.state?.resumptionHandle ||
        (start.pendingAnswers?.length ?? 0) > 0,
      inputTranscript: "",
      outputTranscript: "",
      kickoffAnswers: (start.pendingAnswers ?? []).map(
        decodeVoicePendingAnswerV1,
      ),
      briefingAnswerIds: [],
    };
    this.#assistant = assistant;
    client.serializeAttachment({
      kind: "assistant",
      userId,
      sessionId,
      deviceId,
      month,
      startedAt: assistant.startedAt,
    } satisfies AssistantSocketAttachmentV1);
    this.#attachAssistantUpstream(assistant, upstream);
    upstream.send(
      JSON.stringify(voiceAssistantSetupV1(start.state?.resumptionHandle)),
    );
    this.#resetAssistantIdle(assistant, target);
    assistant.quotaGuard = setTimeout(
      () => {
        void loggedEntryV1("voice assistant quota ceiling", () =>
          this.#settleAssistant(
            assistant,
            "quota",
            "Voice has used this month's allowance and is now offline.",
          ),
        );
      },
      Math.max(1, assistant.remainingSeconds) * 1_000,
    );
  }

  async #connectAssistantUpstream(
    target: Exclude<VoiceAssistantUpstreamTargetV1, { path: "unconfigured" }>,
  ): Promise<WebSocket> {
    return this.#connectUpstream(target);
  }

  #attachAssistantUpstream(
    assistant: LiveAssistant,
    upstream: WebSocket,
  ): void {
    upstream.addEventListener("message", (event: MessageEvent) => {
      void loggedEntryV1("voice assistant upstream message", () =>
        this.#onAssistantUpstream(assistant, upstream, event.data),
      );
    });
    upstream.addEventListener("close", () => {
      if (assistant.upstream !== upstream || assistant.settled) return;
      void loggedEntryV1("voice assistant upstream close", () =>
        this.#reconnectAssistant(assistant),
      );
    });
    upstream.addEventListener("error", () => {
      if (assistant.upstream !== upstream || assistant.settled) return;
      void loggedEntryV1("voice assistant upstream error", () =>
        this.#reconnectAssistant(assistant),
      );
    });
  }

  /** Hibernatable browser-leg messages arrive here instead of an event listener. */
  async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    let assistant = this.#assistant;
    if (!assistant || assistant.client !== socket) {
      assistant = await this.#restoreAssistant(socket);
    }
    if (!assistant || assistant.settled) return;
    if (typeof data === "string") {
      try {
        const frame = decodeVoiceAssistantClientFrameV1(
          JSON.parse(data) as unknown,
        );
        if (frame.type === "stop") {
          await this.#settleAssistant(assistant, "stopped", "Voice is off.");
        }
      } catch {
        // Invalid controls never become commands.
      }
      return;
    }
    assistant.upstream.send(
      JSON.stringify(
        voiceAssistantAudioInputV1(base64OfV1(new Uint8Array(data))),
      ),
    );
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    if (this.#assistant?.client === socket) {
      // A refresh detaches an observer. The provider session and durable on
      // state remain until an explicit stop or the silence ceiling.
      this.#assistant.client = undefined;
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    return this.webSocketClose(socket);
  }

  async #restoreAssistant(
    socket: WebSocket,
  ): Promise<LiveAssistant | undefined> {
    const attachment = socket.deserializeAttachment() as
      AssistantSocketAttachmentV1 | undefined;
    if (!attachment || attachment.kind !== "assistant") return undefined;
    const view = rpcSnapshotV1(
      await this.#user(attachment.userId).readVoiceAssistant({
        schemaVersion: 1,
        userId: attachment.userId,
      }),
    ) as {
      ledger?: {
        state?: {
          enabled?: boolean;
          activeSessionId?: string;
          resumptionHandle?: string;
        };
        pendingAnswers?: VoicePendingAnswerV1[];
      };
      quota?: { remainingSeconds?: number };
    };
    if (
      view.ledger?.state?.enabled !== true ||
      view.ledger.state.activeSessionId !== attachment.sessionId
    ) {
      this.#close(socket, "Voice is no longer active");
      return undefined;
    }
    const target = voiceAssistantUpstreamTargetV1(this.env);
    if (target.path === "unconfigured") return undefined;
    const upstream = await this.#connectAssistantUpstream(target);
    const assistant: LiveAssistant = {
      ...attachment,
      client: socket,
      upstream,
      remainingSeconds: Math.max(0, view.quota?.remainingSeconds ?? 0),
      settled: false,
      reconnecting: false,
      kickoffPending: (view.ledger.pendingAnswers?.length ?? 0) > 0,
      inputTranscript: "",
      outputTranscript: "",
      kickoffAnswers: (view.ledger.pendingAnswers ?? []).map(
        decodeVoicePendingAnswerV1,
      ),
      briefingAnswerIds: [],
    };
    this.#assistant = assistant;
    this.#attachAssistantUpstream(assistant, upstream);
    upstream.send(
      JSON.stringify(voiceAssistantSetupV1(view.ledger.state.resumptionHandle)),
    );
    this.#resetAssistantIdle(assistant, target);
    assistant.quotaGuard = setTimeout(
      () => {
        void loggedEntryV1("restored voice assistant quota ceiling", () =>
          this.#settleAssistant(
            assistant,
            "quota",
            "Voice has used this month's allowance and is now offline.",
          ),
        );
      },
      Math.max(1, assistant.remainingSeconds) * 1_000,
    );
    return assistant;
  }

  async #onAssistantUpstream(
    assistant: LiveAssistant,
    upstream: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    if (
      this.#assistant !== assistant ||
      assistant.upstream !== upstream ||
      typeof data !== "string"
    ) {
      return;
    }
    const frame = parseVoiceAssistantUpstreamFrameV1(data);
    if (!frame) return;
    if (
      frame.inputTranscript ||
      frame.outputTranscript ||
      frame.audio.length > 0 ||
      frame.functionCalls.length > 0 ||
      frame.turnComplete ||
      frame.interrupted
    ) {
      // Raw microphone frames continue while the room is quiet. Gemini's VAD
      // is the activity signal; only provider events extend the silence timer.
      this.#resetAssistantIdle(
        assistant,
        voiceAssistantUpstreamTargetV1(this.env),
      );
    }
    if (frame.error) {
      console.error("Gemini Live returned an error", frame.error);
      await this.#settleAssistant(
        assistant,
        "error",
        VOICE_ASSISTANT_UPSTREAM_ERROR_V1,
      );
      return;
    }
    if (frame.setupComplete) {
      if (assistant.kickoffPending) {
        assistant.kickoffPending = false;
        assistant.briefingAnswerIds.push(
          ...assistant.kickoffAnswers.map((answer) => answer.answerId),
        );
        upstream.send(
          JSON.stringify(voiceAssistantKickoffV1(assistant.kickoffAnswers)),
        );
        assistant.kickoffAnswers = [];
      }
      this.#sendAssistant(assistant, {
        schemaVersion: 1,
        type: "ready",
        sessionId: assistant.sessionId,
        quotaRemainingSeconds: assistant.remainingSeconds,
      });
      this.#sendAssistant(assistant, {
        schemaVersion: 1,
        type: "state",
        state: "listening",
      });
    }
    if (frame.inputTranscript) {
      assistant.inputTranscript += frame.inputTranscript;
    }
    if (frame.outputTranscript) {
      assistant.outputTranscript += frame.outputTranscript;
    }
    if (frame.resumptionHandle) {
      await this.#user(assistant.userId).saveVoiceResumptionHandle({
        schemaVersion: 1,
        userId: assistant.userId,
        sessionId: assistant.sessionId,
        handle: frame.resumptionHandle,
        at: new Date().toISOString(),
      });
    }
    if (frame.functionCalls.length > 0) {
      await this.#flushTranscript(assistant, "user");
      for (const call of frame.functionCalls) {
        try {
          const executed = rpcSnapshotV1(
            await this.#user(assistant.userId).executeVoiceTool({
              schemaVersion: 1,
              userId: assistant.userId,
              sessionId: assistant.sessionId,
              callId: call.id,
              name: call.name,
              args: call.args,
              at: new Date().toISOString(),
            }),
          ) as { name: string; label: string; result: unknown };
          this.#sendAssistant(assistant, {
            schemaVersion: 1,
            type: "tool",
            id: call.id,
            name: executed.name,
            label: executed.label,
            at: new Date().toISOString(),
          });
          upstream.send(
            JSON.stringify(
              voiceAssistantToolResponseV1({
                id: call.id,
                name: executed.name,
                result: executed.result,
              }),
            ),
          );
        } catch (error) {
          upstream.send(
            JSON.stringify(
              voiceAssistantToolResponseV1({
                id: call.id,
                name: call.name,
                result: {
                  error:
                    error instanceof Error
                      ? error.message
                      : "The read could not be completed.",
                },
              }),
            ),
          );
        }
      }
    }
    if (frame.audio.length > 0) {
      this.#sendAssistant(assistant, {
        schemaVersion: 1,
        type: "state",
        state: "speaking",
      });
      for (const audio of frame.audio) {
        this.#sendAssistantAudio(assistant, bytesOfBase64V1(audio));
      }
    }
    if (frame.interrupted) {
      await this.#flushTranscript(assistant, "assistant");
      this.#sendAssistant(assistant, { schemaVersion: 1, type: "interrupted" });
      this.#sendAssistant(assistant, {
        schemaVersion: 1,
        type: "state",
        state: "listening",
      });
    }
    if (frame.turnComplete) {
      await this.#flushTranscript(assistant, "user");
      await this.#flushTranscript(assistant, "assistant");
      this.#sendAssistant(assistant, {
        schemaVersion: 1,
        type: "state",
        state: "listening",
      });
      if (assistant.briefingAnswerIds.length > 0) {
        const askIds = [...new Set(assistant.briefingAnswerIds)];
        try {
          await this.#user(assistant.userId).markVoiceAnswersBriefed({
            schemaVersion: 1,
            userId: assistant.userId,
            sessionId: assistant.sessionId,
            askIds,
            at: new Date().toISOString(),
          });
          assistant.briefingAnswerIds = assistant.briefingAnswerIds.filter(
            (askId) => !askIds.includes(askId),
          );
        } catch {
          // The speech happened; a later provider turn retries the durable ack.
        }
      }
    }
    if (frame.goAwayMs !== undefined) {
      await this.#reconnectAssistant(assistant);
    }
  }

  async #flushTranscript(
    assistant: LiveAssistant,
    speaker: "user" | "assistant",
  ): Promise<void> {
    const field = speaker === "user" ? "inputTranscript" : "outputTranscript";
    const text = assistant[field].trim();
    if (!text) return;
    assistant[field] = "";
    const entry = {
      schemaVersion: 1 as const,
      type: "transcript" as const,
      id: crypto.randomUUID(),
      speaker,
      text: text.slice(0, 8_192),
      at: new Date().toISOString(),
    };
    await this.#user(assistant.userId).appendVoiceTranscript({
      schemaVersion: 1,
      userId: assistant.userId,
      sessionId: assistant.sessionId,
      entryId: entry.id,
      speaker,
      text: entry.text,
      at: entry.at,
    });
    this.#sendAssistant(assistant, entry);
  }

  async #reconnectAssistant(assistant: LiveAssistant): Promise<void> {
    if (assistant.reconnecting || assistant.settled) return;
    assistant.reconnecting = true;
    try {
      const view = rpcSnapshotV1(
        await this.#user(assistant.userId).readVoiceAssistant({
          schemaVersion: 1,
          userId: assistant.userId,
        }),
      ) as { ledger?: { state?: { resumptionHandle?: string } } };
      const target = voiceAssistantUpstreamTargetV1(this.env);
      if (target.path === "unconfigured") throw new Error(target.message);
      const replacement = await this.#connectAssistantUpstream(target);
      const previous = assistant.upstream;
      assistant.upstream = replacement;
      this.#attachAssistantUpstream(assistant, replacement);
      replacement.send(
        JSON.stringify(
          voiceAssistantSetupV1(view.ledger?.state?.resumptionHandle),
        ),
      );
      this.#close(previous, "Gemini Live reconnected");
    } catch (error) {
      console.error("Voice assistant reconnection failed", error);
      await this.#settleAssistant(
        assistant,
        "error",
        VOICE_ASSISTANT_UPSTREAM_ERROR_V1,
      );
    } finally {
      assistant.reconnecting = false;
    }
  }

  /** User-authority projection of a durable answer into the live room. */
  async deliverVoiceAnswer(input: unknown): Promise<{
    schemaVersion: 1;
    status: "delivered" | "offline";
  }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      sessionId: rpcString(128),
      answer: rpcDecoded(decodeVoicePendingAnswerV1),
    });
    const assistant = this.#assistant;
    if (
      !assistant ||
      assistant.settled ||
      assistant.userId !== request.userId ||
      assistant.sessionId !== request.sessionId
    ) {
      return { schemaVersion: 1, status: "offline" };
    }
    const answer = request.answer as VoicePendingAnswerV1;
    if (!assistant.briefingAnswerIds.includes(answer.answerId)) {
      assistant.briefingAnswerIds.push(answer.answerId);
    }
    try {
      assistant.upstream.send(JSON.stringify(voiceAssistantAnswerV1(answer)));
      this.#resetAssistantIdle(
        assistant,
        voiceAssistantUpstreamTargetV1(this.env),
      );
      return { schemaVersion: 1, status: "delivered" };
    } catch {
      assistant.briefingAnswerIds = assistant.briefingAnswerIds.filter(
        (answerId) => answerId !== answer.answerId,
      );
      return { schemaVersion: 1, status: "offline" };
    }
  }

  #resetAssistantIdle(
    assistant: LiveAssistant,
    target: VoiceAssistantUpstreamTargetV1,
  ): void {
    if (assistant.idleGuard) clearTimeout(assistant.idleGuard);
    let timeout = VOICE_IDLE_TIMEOUT_MS_V1;
    if (target.path === "override") {
      const configured = Number(
        new URL(target.url).searchParams.get("frock_idle_ms"),
      );
      if (Number.isFinite(configured) && configured >= 250) {
        timeout = Math.min(VOICE_IDLE_TIMEOUT_MS_V1, configured);
      }
    }
    assistant.idleGuard = setTimeout(() => {
      void loggedEntryV1("voice assistant silence ceiling", () =>
        this.#settleAssistant(
          assistant,
          "idle",
          "Voice went offline after two quiet minutes.",
        ),
      );
    }, timeout);
  }

  async #settleAssistant(
    assistant: LiveAssistant,
    reason: "stopped" | "idle" | "quota" | "error" | "replaced",
    message: string,
  ): Promise<void> {
    if (assistant.settled) return;
    assistant.settled = true;
    if (assistant.idleGuard) clearTimeout(assistant.idleGuard);
    if (assistant.quotaGuard) clearTimeout(assistant.quotaGuard);
    await this.#flushTranscript(assistant, "user").catch(() => undefined);
    await this.#flushTranscript(assistant, "assistant").catch(() => undefined);
    const seconds = Math.max(
      0,
      Math.round((Date.now() - assistant.startedAt) / 1_000),
    );
    try {
      await this.#user(assistant.userId).endVoiceAssistant({
        schemaVersion: 1,
        userId: assistant.userId,
        month: assistant.month,
        sessionId: assistant.sessionId,
        at: new Date().toISOString(),
        reason,
        seconds,
      });
    } catch (error) {
      console.error("Voice assistant usage was not recorded", error);
    }
    this.#sendAssistant(assistant, {
      schemaVersion: 1,
      type: "offline",
      reason,
      message,
    });
    this.#close(assistant.upstream, "Voice ended");
    if (assistant.client) this.#close(assistant.client, "Voice ended");
    if (this.#assistant === assistant) this.#assistant = undefined;
  }

  #refuseAssistant(
    client: WebSocket,
    reason: "quota" | "error" | "replaced",
    message: string,
  ): void {
    try {
      client.send(
        JSON.stringify({
          schemaVersion: 1,
          type: "offline",
          reason,
          message,
        } satisfies VoiceAssistantServerFrameV1),
      );
    } finally {
      this.#close(client, "Voice unavailable");
    }
  }

  async #discardAssistantStart(
    client: WebSocket,
    userId: string,
    month: string,
    sessionId: string,
    upstream?: WebSocket,
  ): Promise<void> {
    if (upstream) this.#close(upstream, "Voice moved to a newer device");
    try {
      await this.#user(userId).endVoiceAssistant({
        schemaVersion: 1,
        userId,
        month,
        sessionId,
        at: new Date().toISOString(),
        reason: "replaced",
        seconds: 0,
      });
    } catch (error) {
      console.error("Replaced Voice assistant session was not settled", error);
    }
    this.#refuseAssistant(
      client,
      "replaced",
      "Voice moved to your newer device.",
    );
  }

  #sendAssistant(
    assistant: LiveAssistant,
    frame: VoiceAssistantServerFrameV1,
  ): void {
    if (!assistant.client) return;
    try {
      assistant.client.send(JSON.stringify(frame));
    } catch {
      assistant.client = undefined;
    }
  }

  #sendAssistantAudio(assistant: LiveAssistant, audio: Uint8Array): void {
    if (!assistant.client) return;
    try {
      const frame = new Uint8Array(audio.byteLength);
      frame.set(audio);
      assistant.client.send(frame.buffer);
    } catch {
      assistant.client = undefined;
    }
  }

  async #start(
    client: WebSocket,
    userId: string,
    voiceEpoch: number,
  ): Promise<void> {
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
    if (voiceEpoch !== this.#voiceEpoch) {
      this.#close(client, "Voice moved to a newer device");
      return;
    }

    const target = voiceUpstreamTargetV1(this.env);
    if (target.path === "unconfigured") {
      return this.#refuse(client, target.message);
    }
    let upstream: WebSocket;
    try {
      upstream = await this.#connectUpstream(target);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          message: "voice upstream connection failed",
          reason,
          sessionId,
        }),
      );
      return this.#refuse(client, VOICE_UPSTREAM_REFUSAL_MESSAGE_V1);
    }
    if (voiceEpoch !== this.#voiceEpoch) {
      this.#close(upstream, "Voice moved to a newer device");
      this.#close(client, "Voice moved to a newer device");
      return;
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
    upstream.addEventListener("error", (event: Event) => {
      void loggedEntryV1("voice upstream error", async () => {
        console.error(
          JSON.stringify({
            message: "voice upstream socket error",
            reason:
              "message" in event && typeof event.message === "string"
                ? event.message
                : "the upstream socket failed",
            sessionId: capture.sessionId,
          }),
        );
        this.#send(capture.client, {
          schemaVersion: 1,
          type: "error",
          message: VOICE_UPSTREAM_REFUSAL_MESSAGE_V1,
        });
        await this.#settle(capture);
      });
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

  async #connectUpstream(target: {
    url: string;
    headers: Record<string, string>;
  }): Promise<WebSocket> {
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
    if (translated.upstreamError) {
      console.error(
        JSON.stringify({
          message: "voice upstream refused the session",
          reason: translated.upstreamError,
          sessionId: capture.sessionId,
        }),
      );
    }
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

  #close(socket: WebSocket, reason = "dictation ended"): void {
    try {
      socket.close(1000, reason.slice(0, 123));
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

  #user(userId: string) {
    return this.#quota(userId) as unknown as {
      startVoiceAssistant(
        input: unknown,
      ): Promise<VoiceAssistantStartReceiptV1>;
      endVoiceAssistant(input: unknown): Promise<unknown>;
      readVoiceAssistant(input: unknown): Promise<unknown>;
      saveVoiceResumptionHandle(input: unknown): Promise<void>;
      appendVoiceTranscript(input: unknown): Promise<void>;
      executeVoiceTool(input: unknown): Promise<unknown>;
      markVoiceAnswersBriefed(input: unknown): Promise<number>;
    };
  }
}
