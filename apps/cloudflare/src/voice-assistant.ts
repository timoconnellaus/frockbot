// The account-wide voice session: one Durable Object per User.
//
// This is the one place the Cloudflare Agents SDK is used. `withVoice` gives
// the object its wire protocol, the per-call transcriber session, sentence
// chunking and streaming TTS; everything FrockBot cares about — who may
// connect, what costs money, what a Bot was asked to do — is decided here and
// recorded in the ledger before anything external runs. The Bot runtime is
// untouched: a delegation is an ordinary user-lane Turn in the target Bot's
// own object, admitted through the same door the composer uses.
//
// Nothing durable lives only in this object's memory. A call is a ledger row,
// a delegation is a ledger row plus a scheduled look-up, and an eviction
// mid-answer costs the person that answer and nothing else.
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import {
  withVoice,
  type Transcriber,
  type TranscriberSession,
  type TTSProvider,
  type StreamingTTSProvider,
  type TextSource,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";
import {
  renderVoiceSystemPromptV1,
  runVoiceTurnV1,
  type VoiceAssistantHostV1,
  type VoiceBotSummaryV1,
} from "@frockbot/app/voice/assistant";
import {
  VoiceLedgerV1,
  type VoiceDelegationRecordV1,
  type VoiceLedgerStorageV1,
} from "@frockbot/app/voice/ledger";
import {
  createOpenAiTranscriberV1,
  type VoiceRealtimeSocketV1,
} from "@frockbot/app/voice/openai-transcriber";
import {
  createSleepingTranscriberV1,
  type SleepingTranscriberSessionV1,
  type VoiceTranscriberV1,
} from "@frockbot/app/voice/sleeping-transcriber";
import {
  decodeVoiceAssistantClientMessageV1,
  VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1,
  VOICE_ASSISTANT_STT_RESERVE_SECONDS_V1,
  VOICE_DICTATION_LEASE_RENEW_MS_V1,
  VOICE_DICTATION_RESERVE_SECONDS_V1,
  type VoiceAssistantRefusalCodeV1,
  type VoiceAssistantServerMessageV1,
  type VoiceAssistantUpstreamStateV1,
} from "@frockbot/app/voice/shared";
import { MemoryStore } from "@frockbot/app/memory/store";
import {
  projectMemoryRootV1,
  userMemoryRootV1,
  isMemoryProjectIdV1,
} from "@frockbot/app/memory/roots";
import {
  decodeDirectoryViewV1,
  decodeBotMembershipViewV1,
} from "@frockbot/app/flock/shared";
import type {
  ClientRunLookupV1,
  ClientRunV1,
} from "@frockbot/app/shell/run-protocol";
import {
  FROCK_AI_DEFAULT_MODEL,
  gatewayModelForFrockRequestV1,
} from "@frockbot/providers/frock-ai/catalog";
import { createFrockAiGatewayHostV1 } from "./frock-ai.js";
import {
  createUserWorkspaceGenerationsV1,
  type UserMemoryRpc,
} from "./memory.js";
import { fetchVoiceUpstreamSocketV1 } from "./voice-dictation.js";
import { createDurableWorkspaceFilesV1 } from "./workspace.js";
import { rpcJsonSnapshotV1 } from "./durable-rpc.js";

export const VOICE_ASSISTANT_INTERNAL_PATH = "/internal/voice-assistant/v1";

interface DictationLeaseRequest {
  userId: string;
  action: "acquire" | "renew" | "release";
  leaseId: string;
  activeSeconds?: number;
}

function decodeDictationLeaseRequest(input: unknown): DictationLeaseRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("dictation lease request is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    typeof value.leaseId !== "string" ||
    !/^[A-Za-z0-9-]{8,64}$/.test(value.leaseId) ||
    (value.action !== "acquire" &&
      value.action !== "renew" &&
      value.action !== "release")
  ) {
    throw new Error("dictation lease request is invalid");
  }
  return {
    userId: value.userId,
    action: value.action,
    leaseId: value.leaseId,
    ...(typeof value.activeSeconds === "number" &&
    Number.isFinite(value.activeSeconds)
      ? { activeSeconds: value.activeSeconds }
      : {}),
  };
}
export const VOICE_ASSISTANT_USER_HEADER = "x-frockbot-user-id";
export const VOICE_ASSISTANT_DEVICE_HEADER = "x-frockbot-voice-device";

/** The default ElevenLabs voice, "George", when the deployment names none. */
export const VOICE_ASSISTANT_DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const VOICE_ASSISTANT_TTS_MODEL = "eleven_flash_v2_5";
/** How far back the User Memory log is read at call start. */
export const VOICE_ASSISTANT_MEMORY_LOG_DAYS = 30;
/** Where the assistant listens. Transcription-only realtime session. */
export const VOICE_ASSISTANT_STT_URL =
  "wss://api.openai.com/v1/realtime?intent=transcription";
/** Pending audio held while a slept transcriber reopens: 10 s at 16 kHz. */
const PENDING_AUDIO_BYTES = 10 * 16_000 * 2;
/** How long a delegation look-up waits before the first check, and its ceiling. */
const DELEGATION_FIRST_CHECK_SECONDS = 8;
const DELEGATION_MAX_CHECK_SECONDS = 5 * 60;

export interface VoiceAssistantEnv {
  AI?: Ai;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  BOT_STATES: DurableObjectNamespace;
  MEMORY_FILES?: R2Bucket;
  FROCK_AI_GATEWAY_ID?: string;
  FROCK_AI_AUTO_ROUTE?: string;
  FROCK_AI_ACCOUNT_ID?: string;
  FROCK_AI_GATEWAY_TOKEN?: string;
  FLOCK_AI_GATEWAY_ID?: string;
  FLOCK_AI_AUTO_ROUTE?: string;
  FLOCK_AI_ACCOUNT_ID?: string;
  FLOCK_AI_GATEWAY_TOKEN?: string;
}

/** True when the deployment can run the assistant at all. */
export function voiceAssistantConfiguredV1(env: {
  AI?: unknown;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
}): boolean {
  return (
    Boolean(env.AI) &&
    Boolean(env.OPENAI_API_KEY?.trim()) &&
    Boolean(env.ELEVENLABS_API_KEY?.trim())
  );
}

interface ConnectionIdentity {
  userId: string;
  deviceKey: string;
}

interface LiveCall {
  callId: string;
  system: Promise<string>;
  session?: SleepingTranscriberSessionV1;
  /** Awake seconds already reconciled against the meter. */
  lastAwakeSeconds: number;
  /** Seconds booked for the window the upstream is currently in. */
  reservedSeconds: number;
  renewTimer?: ReturnType<typeof setTimeout>;
  muted: boolean;
  /** The day's transcription allowance ran out; the upstream stays shut. */
  exhausted: boolean;
  turnId?: string;
  quotaSaid: boolean;
}

/** Look-ups a delegation gets before it is settled as never accepted. */
const DELEGATION_MAX_ATTEMPTS = 40;
/** A dispatch younger than this is still in flight; a check waits, not resends. */
const DELEGATION_REDISPATCH_AFTER_MS = 30_000;

interface DelegationCheckPayload {
  runId: string;
}

/**
 * Presents the transcription upstream, opened with the `fetch` upgrade the
 * dictation relay already owns, as the plain socket the adapter drives.
 */
async function openVoiceUpstreamSocket(
  url: string,
  headers: Record<string, string>,
): Promise<VoiceRealtimeSocketV1> {
  const socket = await fetchVoiceUpstreamSocketV1(url, headers);
  return {
    send: (data: string) => socket.send(data),
    close: () => {
      try {
        socket.close();
      } catch {
        // Already gone; there is nothing to close.
      }
    },
    onMessage: (handler: (raw: string) => void) => {
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") handler(event.data);
      });
    },
    onClose: (handler: (reason: string) => void) => {
      socket.addEventListener("close", (event: CloseEvent) => {
        handler(event.reason ?? "");
      });
      socket.addEventListener("error", () => {
        handler("the speech service connection failed");
      });
    },
  };
}

const VoiceAgentBase = withVoice(Agent, {
  audioFormat: "pcm16",
  sampleRate: VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
  historyLimit: 12,
  maxMessageCount: 40,
});

// `Cloudflare.Env` is what a test harness augments with its own bindings;
// intersecting it keeps this class valid under both the Worker's and the
// suite's declarations.
export class VoiceAssistant extends VoiceAgentBase<
  Cloudflare.Env & VoiceAssistantEnv
> {
  #calls = new Map<string, LiveCall>();

  tts: (TTSProvider & Partial<StreamingTTSProvider>) | undefined =
    this.createTts();

  // -- seams a test subclass overrides ---------------------------------------

  protected createTts():
    (TTSProvider & Partial<StreamingTTSProvider>) | undefined {
    const apiKey = this.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) return undefined;
    return new ElevenLabsTTS({
      apiKey,
      voiceId:
        this.env.ELEVENLABS_VOICE_ID?.trim() ||
        VOICE_ASSISTANT_DEFAULT_VOICE_ID,
      modelId: VOICE_ASSISTANT_TTS_MODEL,
      // Raw PCM at the rate the client is told in `audio_config`, so both
      // clients play it with no decoder and can measure what they play.
      outputFormat: `pcm_${VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1}`,
    });
  }

  protected createInnerTranscriber(): VoiceTranscriberV1 | undefined {
    const apiKey = this.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return undefined;
    return createOpenAiTranscriberV1({
      openSocket: () =>
        openVoiceUpstreamSocket(VOICE_ASSISTANT_STT_URL, {
          authorization: `Bearer ${apiKey}`,
        }),
    });
  }

  protected async chatCompletion(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const ai = this.env.AI;
    if (!ai || typeof Reflect.get(ai, "gateway") !== "function") {
      throw new Error("the model gateway is unavailable");
    }
    const autoRoute = this.workerVar("FROCK_AI_AUTO_ROUTE");
    const host = createFrockAiGatewayHostV1(ai as Pick<Ai, "gateway">, {
      gatewayId: this.workerVar("FROCK_AI_GATEWAY_ID"),
      autoRoute,
      accountId: this.workerVar("FROCK_AI_ACCOUNT_ID"),
      token: this.workerVar("FROCK_AI_GATEWAY_TOKEN"),
    });
    return host.runChatCompletion(
      gatewayModelForFrockRequestV1(
        FROCK_AI_DEFAULT_MODEL,
        false,
        host.autoRoute,
      ),
      body,
      signal,
    );
  }

  protected now(): Date {
    return new Date();
  }

  /** Seconds of transcription booked per window; a test shortens it. */
  protected sttWindowSeconds(): number {
    return VOICE_ASSISTANT_STT_RESERVE_SECONDS_V1;
  }

  private workerVar(name: `FROCK_AI_${string}`): string | undefined {
    const twin =
      `FLOCK_AI_${name.slice("FROCK_AI_".length)}` as keyof VoiceAssistantEnv;
    const value = this.env[name as keyof VoiceAssistantEnv] ?? this.env[twin];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  // -- ledger ---------------------------------------------------------------

  protected ledger(): VoiceLedgerV1 {
    const storage = this.ctx.storage;
    const surface: VoiceLedgerStorageV1 = {
      get: <T>(key: string) => storage.get<T>(key),
      put: <T>(key: string, value: T) => storage.put<T>(key, value),
      delete: (key: string) => storage.delete(key),
      list: <T>(options: { prefix: string }) => storage.list<T>(options),
    };
    return new VoiceLedgerV1(surface, this.name);
  }

  async onStart(): Promise<void> {
    const recovered = await this.ledger().recover(this.now());
    for (const delegation of recovered.pending) {
      await this.scheduleDelegationCheck(delegation.runId, delegation.attempts);
    }
  }

  // -- connections ----------------------------------------------------------

  private identity(connection: Connection): ConnectionIdentity | undefined {
    const state = connection.state as ConnectionIdentity | null;
    return state && typeof state.userId === "string" ? state : undefined;
  }

  override async onConnect(
    connection: Connection,
    context: ConnectionContext,
  ): Promise<void> {
    // The gateway proved the identity and set this header itself; the object
    // is named for one User and refuses any other, so a stub reached some
    // other way still cannot listen in.
    const userId = context.request.headers.get(VOICE_ASSISTANT_USER_HEADER);
    const deviceKey =
      context.request.headers.get(VOICE_ASSISTANT_DEVICE_HEADER) ?? "unknown";
    if (!userId || userId !== this.name) {
      connection.close(4403, "voice session is not yours");
      return;
    }
    connection.setState({ userId, deviceKey } satisfies ConnectionIdentity);
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await this.releaseCall(connection);
    await super.onClose?.(connection, code, reason, wasClean);
  }

  override async onMessage(
    connection: Connection,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const custom = decodeVoiceAssistantClientMessageV1(parsed);
    if (!custom) return;
    const call = this.#calls.get(connection.id);
    if (!call) return;
    switch (custom.type) {
      case "voice/sleep":
        call.session?.sleep();
        break;
      case "voice/wake":
        if (!call.muted && !call.exhausted) call.session?.wake();
        break;
      case "voice/mute":
        call.muted = custom.muted;
        if (custom.muted) call.session?.sleep();
        this.sendState(connection, call);
        break;
    }
  }

  private send(connection: Connection, message: VoiceAssistantServerMessageV1) {
    try {
      connection.send(JSON.stringify(message));
    } catch {
      // A socket that is already gone is cleaned up by onClose.
    }
  }

  private refuse(
    connection: Connection,
    code: VoiceAssistantRefusalCodeV1,
    message: string,
  ) {
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/refusal",
      code,
      message,
    });
  }

  private sendState(connection: Connection, call: LiveCall) {
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/state",
      upstream: call.session?.state ?? "asleep",
      muted: call.muted,
    });
  }

  // -- call lifecycle -------------------------------------------------------

  override async beforeCallStart(connection: Connection): Promise<boolean> {
    const identity = this.identity(connection);
    if (!identity) {
      this.refuse(
        connection,
        "unconfigured",
        "This voice session is not signed in.",
      );
      return false;
    }
    if (!this.tts || !this.createInnerTranscriber()) {
      this.refuse(
        connection,
        "unconfigured",
        "Voice isn't set up on this deployment yet.",
      );
      return false;
    }
    const ledger = this.ledger();
    const now = this.now();
    const cap = await ledger.exceededCap(now);
    if (cap) {
      this.refuse(
        connection,
        "quota",
        "Today's voice allowance is used up. It resets at midnight UTC.",
      );
      return false;
    }
    const admission = await ledger.beginCall({
      callId: crypto.randomUUID(),
      deviceKey: identity.deviceKey,
      connectionId: connection.id,
      at: now,
    });
    // Whatever this admission displaced — another device's call, or this
    // device's own earlier socket rejoining the same call — is ended now, so
    // one account never holds two live upstream sessions.
    if (admission.replaced) {
      const replacedId = admission.replaced.connectionId;
      for (const other of this.getConnections()) {
        if (other.id !== replacedId) continue;
        this.refuse(
          other,
          "superseded",
          admission.status === "superseded"
            ? "Voice moved to another device."
            : "Voice continues on a newer connection from this device.",
        );
        await this.releaseCallResources(other.id);
        this.forceEndCall(other);
      }
    }
    const unspoken = await ledger.unspokenDelegations();
    const call: LiveCall = {
      callId: admission.call.callId,
      system: this.buildSystemPrompt(identity.userId, unspoken),
      lastAwakeSeconds: 0,
      reservedSeconds: 0,
      muted: false,
      exhausted: false,
      quotaSaid: false,
    };
    this.#calls.set(connection.id, call);
    return true;
  }

  override createTranscriber(connection: Connection): Transcriber | null {
    const inner = this.createInnerTranscriber();
    const call = this.#calls.get(connection.id);
    if (!inner || !call) return null;
    const gated: VoiceTranscriberV1 = {
      createSession: (options = {}) => {
        if (call.exhausted) {
          throw new Error("today's transcription allowance is used up");
        }
        return inner.createSession(options);
      },
    };
    const sleeping = createSleepingTranscriberV1(gated, {
      idleSleepMs: VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1,
      maxPendingBytes: PENDING_AUDIO_BYTES,
      onState: (state: VoiceAssistantUpstreamStateV1) => {
        void this.upstreamChanged(connection, call, state);
      },
    });
    // The SDK calls `createSession` once per call; the wrapper session is
    // what sleep and wake act on.
    return {
      createSession: (options = {}) => {
        const session = sleeping.createSession({
          ...options,
          onFatalError: (error) => {
            // The SDK logs its own record of any transcriber fatal; this one
            // names it as the assistant's ears and, sitting outside the
            // sleeping wrapper, also catches an upgrade that never became a
            // session. Without it a call that loses its ears looks, from
            // every log, like a person who said nothing.
            console.error("voice assistant stt failed", error.message);
            options.onFatalError?.(error);
          },
        });
        call.session = session;
        // Open at once: the first words after `listening` must not wait on a
        // cold upstream. The client's sleep message closes it when the room
        // goes quiet.
        session.wake();
        return session as TranscriberSession;
      },
    };
  }

  /**
   * The transcription meter, kept ahead of the upstream.
   *
   * A window of seconds is booked the moment the upstream starts opening and
   * again each time the window runs out while it stays awake; going to sleep
   * refunds the part of the last window not used. So a call that is evicted
   * mid-window has already paid for it, a long awake stretch is charged as
   * it happens, silence costs nothing because a sleeping upstream books
   * nothing, and a day that runs out shuts the upstream at the next window
   * rather than at the end of the call.
   */
  private async upstreamChanged(
    connection: Connection,
    call: LiveCall,
    state: VoiceAssistantUpstreamStateV1,
  ): Promise<void> {
    this.sendState(connection, call);
    if (state === "starting") {
      await this.openSttWindow(connection, call);
      return;
    }
    if (state === "asleep") {
      await this.closeSttWindow(call);
    }
  }

  private async openSttWindow(connection: Connection, call: LiveCall) {
    const window = this.sttWindowSeconds();
    const reserved = await this.ledger().reserveSeconds(
      this.now(),
      "sttSeconds",
      window,
    );
    if (reserved.status === "refused") {
      call.exhausted = true;
      call.session?.sleep();
      if (!call.quotaSaid) {
        call.quotaSaid = true;
        this.refuse(
          connection,
          "quota",
          "Today's voice listening allowance is used up. It resets at midnight UTC.",
        );
      }
      return;
    }
    call.reservedSeconds += window;
    if (call.renewTimer) clearTimeout(call.renewTimer);
    call.renewTimer = setTimeout(() => {
      call.renewTimer = undefined;
      if (!this.#calls.has(connection.id) || call.session?.state !== "awake") {
        return;
      }
      void this.openSttWindow(connection, call);
    }, window * 1000);
  }

  private async closeSttWindow(call: LiveCall) {
    if (call.renewTimer) {
      clearTimeout(call.renewTimer);
      call.renewTimer = undefined;
    }
    if (!call.session) return;
    const total = call.session.awakeSeconds();
    const used = total - call.lastAwakeSeconds;
    call.lastAwakeSeconds = total;
    const unused = call.reservedSeconds - Math.max(0, used);
    call.reservedSeconds = 0;
    if (unused > 0) {
      await this.ledger().refundSeconds(this.now(), "sttSeconds", unused);
    } else if (unused < 0) {
      // Awake longer than what was booked (a renewal that did not land in
      // time): charge the difference rather than forget it.
      await this.ledger().addMeter(this.now(), { sttSeconds: -unused });
    }
  }

  override async onCallStart(connection: Connection): Promise<void> {
    const call = this.#calls.get(connection.id);
    if (!call) return;
    this.sendState(connection, call);
    // Answers that settled while nobody was listening are read out first.
    const unspoken = await this.ledger().unspokenDelegations();
    for (const delegation of unspoken.slice(0, 3)) {
      await this.speakDelegation(connection, delegation);
    }
  }

  override async onCallEnd(connection: Connection): Promise<void> {
    await this.releaseCall(connection);
  }

  private async releaseCall(connection: Connection): Promise<void> {
    await this.releaseCallResources(connection.id);
    await this.ledger().endCall(connection.id);
  }

  /** Closes the upstream and settles its meter; the call record is separate. */
  private async releaseCallResources(connectionId: string): Promise<void> {
    const call = this.#calls.get(connectionId);
    if (!call) return;
    this.#calls.delete(connectionId);
    if (call.session) {
      await this.closeSttWindow(call);
      call.session.close();
    }
  }

  // -- turns ----------------------------------------------------------------

  override async afterTranscribe(
    transcript: string,
    _connection: Connection,
  ): Promise<string | null> {
    // A grunt, a cough, or a fragment the model would answer at length is
    // not a turn. Nothing shorter than two characters reaches the model.
    const trimmed = transcript.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return trimmed.length < 2 ? null : transcript.trim();
  }

  override async beforeSynthesize(
    text: string,
    connection: Connection,
  ): Promise<string | null> {
    const call = this.#calls.get(connection.id);
    const ledger = this.ledger();
    const now = this.now();
    const cap = await ledger.exceededCap(now);
    if (cap === "ttsCharacters") {
      if (call && !call.quotaSaid) {
        call.quotaSaid = true;
        this.refuse(
          connection,
          "quota",
          "Today's speech allowance is used up. Replies continue as text only.",
        );
      }
      return null;
    }
    await ledger.addMeter(now, { ttsCharacters: text.length });
    return text;
  }

  override async onTurn(
    transcript: string,
    context: VoiceTurnContext,
  ): Promise<TextSource> {
    const connection = context.connection;
    const identity = this.identity(connection);
    const call = this.#calls.get(connection.id);
    const ledger = this.ledger();
    if (!identity || !call) return "";
    const admitted = await ledger.admitTurn({
      connectionId: connection.id,
      transcript,
      at: this.now(),
    });
    if (admitted.status === "refused") {
      this.refuse(connection, "quota", admitted.reason);
      return "";
    }
    const turnId = admitted.turn.turnId;
    call.turnId = turnId;
    const system = await call.system;
    const host = this.turnHost(identity.userId, turnId);
    const self = this;
    // The SDK consumes this generator sentence by sentence into TTS; the
    // settlement callback runs when the model is done, whether it spoke or
    // handed the work on.
    return (async function* () {
      let settlement: { answer: string } | { failure: string } = {
        failure: "no settlement",
      };
      try {
        yield* runVoiceTurnV1(
          host,
          {
            system,
            history: context.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            transcript,
            signal: context.signal,
          },
          (result) => {
            settlement =
              result.outcome === "answered" || result.delegations > 0
                ? { answer: result.answer }
                : { failure: result.outcome };
          },
        );
      } catch (error) {
        settlement = {
          failure: error instanceof Error ? error.message : String(error),
        };
        throw error;
      } finally {
        // Durable before the generator returns, so the SDK's own history
        // write and the ledger never disagree about whether this turn ended.
        await ledger.settleTurn(turnId, settlement);
      }
      void self;
    })();
  }

  private turnHost(userId: string, turnId: string): VoiceAssistantHostV1 {
    return {
      chat: (body, signal) => this.chatCompletion(body, signal),
      listBots: () => this.listBots(userId),
      botStatus: async (botId) => {
        const bot = await this.ownedBot(userId, botId);
        const runs = await this.recentRuns(userId, botId);
        const latest = runs[0];
        if (!latest)
          return `${bot.initialName} has not been asked anything yet.`;
        const said =
          latest.outcome?.type === "completed" && latest.outcome.text
            ? ` Last it said: ${latest.outcome.text.slice(0, 400)}`
            : latest.partialText
              ? ` So far it has written: ${latest.partialText.slice(0, 400)}`
              : "";
        return `${bot.initialName} is ${latest.status === "running" ? "working" : latest.status} on "${latest.input.slice(0, 200)}".${said}`;
      },
      askBot: async (botId, message) => {
        const bot = await this.ownedBot(userId, botId);
        const admission = await this.ledger().admitDelegation({
          turnId,
          botId,
          botName: bot.initialName,
          text: message,
          at: this.now(),
        });
        if (admission.status === "refused")
          return `Refused: ${admission.reason}`;
        if (admission.status === "duplicate") {
          return `${bot.initialName} was already asked this; its answer will be read out when it settles.`;
        }
        this.dispatchDelegation(userId, admission.delegation);
        await this.scheduleDelegationCheck(admission.delegation.runId, 0);
        return `Asked ${bot.initialName}. It is working on it in its own conversation; you will hear the answer when it settles.`;
      },
      cancelBot: async (botId) => {
        const bot = await this.ownedBot(userId, botId);
        const runs = await this.recentRuns(userId, botId);
        const running = runs.find((run) => run.status === "running");
        if (!running) return `${bot.initialName} is not running anything.`;
        const receipt = await this.botDoor(userId, botId).stopRun({
          schemaVersion: 1,
          action: "stop",
          commandId: `voice-stop-${turnId}-${running.runId}`,
          runId: running.runId,
        });
        void receipt;
        return `Asked ${bot.initialName} to stop.`;
      },
      recallProject: async (projectId) => {
        if (!isMemoryProjectIdV1(projectId)) return "That is not a Project id.";
        const store = this.memoryStore(userId);
        if (!store) return "Memory is unavailable on this deployment.";
        const tier = await store.read(
          projectMemoryRootV1({ userId, botId: "voice" }, projectId),
        );
        if (tier.unavailable)
          return `Project memory could not be read: ${tier.unavailable}`;
        const lines = [
          ...tier.profile.slice(-20).map((fact) => `- ${fact.text}`),
          ...tier.recent
            .slice(-20)
            .map((fact) => `- ${fact.date}: ${fact.text}`),
        ];
        return lines.length === 0
          ? "That Project has no memory yet."
          : lines.join("\n");
      },
    };
  }

  // -- delegations ----------------------------------------------------------

  /**
   * Admits the Bot Turn. Detached from the spoken turn on purpose: the Bot's
   * `run` door answers only when the Turn settles, which may be minutes, and
   * the voice pipeline must not wait. The scheduled check below is what
   * carries the answer back, whether or not this object stays resident.
   */
  protected dispatchDelegation(
    userId: string,
    delegation: VoiceDelegationRecordV1,
  ): void {
    const door = this.botDoor(userId, delegation.botId);
    void this.ledger().noteDelegationDispatch(delegation.runId, this.now());
    const run = door
      .run({
        runId: delegation.runId,
        sessionId: `${userId}:${delegation.botId}`,
        acceptedAt: delegation.admittedAt,
        text: delegation.text,
      })
      .then(
        () => undefined,
        () => undefined,
      );
    this.ctx.waitUntil(run);
  }

  private async scheduleDelegationCheck(runId: string, attempts: number) {
    const seconds = Math.min(
      DELEGATION_MAX_CHECK_SECONDS,
      DELEGATION_FIRST_CHECK_SECONDS * 2 ** Math.min(attempts, 8),
    );
    await this.schedule<DelegationCheckPayload>(
      seconds,
      "checkDelegation",
      { runId },
      { idempotent: true },
    );
  }

  /** The scheduled look-up. Public because the scheduler calls it by name. */
  async checkDelegation(payload: DelegationCheckPayload): Promise<void> {
    const ledger = this.ledger();
    const delegation = await ledger.readDelegation(payload.runId);
    if (!delegation || delegation.state !== "admitted") return;
    const attempts = await ledger.noteDelegationAttempt(delegation.runId);
    let lookup: ClientRunLookupV1;
    try {
      lookup = await this.botDoor(this.name, delegation.botId).lookupRun({
        schemaVersion: 1,
        runId: delegation.runId,
      });
    } catch {
      await this.scheduleDelegationCheck(delegation.runId, attempts);
      return;
    }
    if (lookup.state === "not-admitted") {
      // The Bot has not taken it: the dispatch was lost, or the Bot's object
      // was unreachable. The intent is durable here, so it is sent again
      // under the same run id — the Bot's admission is the fence — with a
      // widening backoff, until the Bot answers or the bound says it never
      // will, which is an explicit failure the person hears, not silence.
      if (attempts >= DELEGATION_MAX_ATTEMPTS) {
        await ledger.settleDelegation(
          delegation.runId,
          { failure: "the Bot never accepted the request" },
          this.now(),
        );
        return;
      }
      const sentAgo = delegation.dispatchedAt
        ? this.now().getTime() - Date.parse(delegation.dispatchedAt)
        : Number.POSITIVE_INFINITY;
      if (sentAgo >= DELEGATION_REDISPATCH_AFTER_MS) {
        this.dispatchDelegation(this.name, delegation);
      }
      await this.scheduleDelegationCheck(delegation.runId, attempts);
      return;
    }
    if (lookup.state === "running") {
      await this.scheduleDelegationCheck(delegation.runId, attempts);
      return;
    }
    const run = lookup.run;
    const outcome = run.outcome;
    const settled = await ledger.settleDelegation(
      delegation.runId,
      outcome?.type === "completed"
        ? { answer: outcome.text || "(no reply)" }
        : run.status === "cancelled" || run.status === "superseded"
          ? { cancelled: true }
          : { failure: outcome ? outcome.message : run.status },
      this.now(),
    );
    if (!settled || settled.state !== "settled") return;
    for (const [connectionId] of this.#calls) {
      for (const connection of this.getConnections()) {
        if (connection.id !== connectionId) continue;
        await this.speakDelegation(connection, settled);
        return;
      }
    }
  }

  private async speakDelegation(
    connection: Connection,
    delegation: VoiceDelegationRecordV1,
  ) {
    const text = delegation.answer
      ? `${delegation.botName} says: ${delegation.answer.slice(0, 600)}`
      : `${delegation.botName} could not finish that: ${delegation.failure ?? "it stopped"}.`;
    try {
      await this.speak(connection, text);
      await this.ledger().markSpoken(delegation.runId, this.now());
    } catch {
      // Left `settled`; it is read out on the next call.
    }
  }

  // -- dictation lease ------------------------------------------------------

  /**
   * The account's dictation lease, for the relay in the Worker. One capture
   * at a time, seconds booked ahead and renewed, refunded on release. The
   * relay is the only caller and reaches this through the gateway's proved
   * identity; the object still refuses a name that is not its own.
   */
  async dictationLease(
    input: unknown,
  ): Promise<
    | { status: "acquired" }
    | { status: "refused"; reason: string }
    | { status: "renewed"; ok: boolean }
    | { status: "released" }
  > {
    const request = decodeDictationLeaseRequest(input);
    if (request.userId !== this.name) {
      return { status: "refused", reason: "not this account's voice object" };
    }
    const ledger = this.ledger();
    const at = this.now();
    if (request.action === "acquire") {
      const admitted = await ledger.acquireDictationLease({
        leaseId: request.leaseId,
        at,
        ttlMs: VOICE_DICTATION_LEASE_RENEW_MS_V1 * 3,
        reserveSeconds: VOICE_DICTATION_RESERVE_SECONDS_V1,
      });
      return admitted.status === "acquired" ? { status: "acquired" } : admitted;
    }
    if (request.action === "renew") {
      return {
        status: "renewed",
        ok: await ledger.renewDictationLease({
          leaseId: request.leaseId,
          at,
          ttlMs: VOICE_DICTATION_LEASE_RENEW_MS_V1 * 3,
          reserveSeconds: VOICE_DICTATION_RESERVE_SECONDS_V1,
        }),
      };
    }
    await ledger.releaseDictationLease({
      leaseId: request.leaseId,
      at,
      activeSeconds: request.activeSeconds ?? 0,
    });
    return { status: "released" };
  }

  // -- Bot and User doors ---------------------------------------------------

  private userRpc(userId: string) {
    const stub = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(userId),
    );
    // SAFETY: the binding names UserConfiguration; these are its reviewed RPCs.
    return stub as unknown as UserMemoryRpc & {
      listBots(input: unknown): Promise<unknown>;
      hasBot(input: unknown): Promise<unknown>;
    };
  }

  private botDoor(userId: string, botId: string) {
    const stub = this.env.BOT_STATES.get(
      this.env.BOT_STATES.idFromName(`${userId}:${botId}`),
    );
    // SAFETY: the binding names BotState; these are its reviewed RPC doors.
    const rpc = stub as unknown as {
      run(input: unknown): Promise<unknown>;
      lookupRun(input: unknown): Promise<unknown>;
      listRuns(input: unknown): Promise<unknown>;
      stopRun(input: unknown): Promise<unknown>;
    };
    return {
      run: (command: {
        runId: string;
        sessionId: string;
        acceptedAt: string;
        text: string;
      }) => rpc.run({ schemaVersion: 1, userId, botId, command }),
      lookupRun: async (query: { schemaVersion: 1; runId: string }) =>
        rpcJsonSnapshotV1(
          await rpc.lookupRun({ schemaVersion: 1, userId, botId, query }),
        ) as ClientRunLookupV1,
      listRuns: async () =>
        rpcJsonSnapshotV1(
          await rpc.listRuns({
            schemaVersion: 1,
            userId,
            botId,
            query: { schemaVersion: 1 },
          }),
        ) as { runs: ClientRunV1[] },
      stopRun: (command: {
        schemaVersion: 1;
        action: "stop";
        commandId: string;
        runId: string;
      }) => rpc.stopRun({ schemaVersion: 1, userId, botId, command }),
    };
  }

  protected async listBots(userId: string): Promise<VoiceBotSummaryV1[]> {
    const directory = decodeDirectoryViewV1(
      rpcJsonSnapshotV1(
        await this.userRpc(userId).listBots({ schemaVersion: 1, userId }),
      ),
    );
    const summaries: VoiceBotSummaryV1[] = [];
    for (const bot of directory.bots) {
      let activity: VoiceBotSummaryV1["activity"];
      try {
        const runs = await this.recentRuns(userId, bot.botId);
        activity = runs.some((run) => run.status === "running")
          ? "working"
          : "idle";
      } catch {
        activity = undefined;
      }
      summaries.push({
        botId: bot.botId,
        name: bot.initialName,
        ...(bot.initialDescription
          ? { description: bot.initialDescription }
          : {}),
        ...(activity ? { activity } : {}),
      });
    }
    return summaries;
  }

  private async ownedBot(userId: string, botId: string) {
    const membership = decodeBotMembershipViewV1(
      rpcJsonSnapshotV1(
        await this.userRpc(userId).hasBot({ schemaVersion: 1, userId, botId }),
      ),
    );
    if (!membership.registered)
      throw new Error("that Bot is not in this account");
    const directory = decodeDirectoryViewV1(
      rpcJsonSnapshotV1(
        await this.userRpc(userId).listBots({ schemaVersion: 1, userId }),
      ),
    );
    const bot = directory.bots.find((entry) => entry.botId === botId);
    if (!bot) throw new Error("that Bot is not in this account");
    return bot;
  }

  private async recentRuns(
    userId: string,
    botId: string,
  ): Promise<ClientRunV1[]> {
    const page = await this.botDoor(userId, botId).listRuns();
    return [...page.runs].sort((left, right) =>
      right.admittedAt.localeCompare(left.admittedAt),
    );
  }

  // -- memory ---------------------------------------------------------------

  protected memoryStore(userId: string): MemoryStore | undefined {
    const files = createDurableWorkspaceFilesV1(this.env, {
      owner: { userId },
      surface: "memory",
      generations: createUserWorkspaceGenerationsV1(
        this.userRpc(userId),
        userId,
      ),
    });
    if (!files) return undefined;
    return new MemoryStore({ files, owner: { userId, botId: "voice" } });
  }

  private async buildSystemPrompt(
    userId: string,
    unspoken: VoiceDelegationRecordV1[],
  ): Promise<string> {
    const [bots, memory] = await Promise.all([
      this.listBots(userId).catch(() => [] as VoiceBotSummaryV1[]),
      (async () => {
        const store = this.memoryStore(userId);
        if (!store) return undefined;
        try {
          return await store.read(userMemoryRootV1({ userId, botId: "voice" }));
        } catch (error) {
          return {
            root: userMemoryRootV1({ userId, botId: "voice" }),
            profile: [],
            recent: [],
            sources: [],
            logTotal: 0,
            unavailable: error instanceof Error ? error.message : String(error),
          };
        }
      })(),
    ]);
    return renderVoiceSystemPromptV1({
      bots,
      memory: {
        ...(memory ? { user: memory } : {}),
        logDays: VOICE_ASSISTANT_MEMORY_LOG_DAYS,
      },
      unspoken: unspoken.map((delegation) => ({
        botName: delegation.botName,
        text: delegation.answer ?? delegation.failure ?? "",
      })),
      now: this.now(),
    });
  }
}
