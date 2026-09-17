// The account-wide voice session: one Durable Object per User.
//
// This is the one place the Cloudflare Agents SDK is used. `withVoice` gives
// the object its wire protocol, the per-call transcriber session, sentence
// chunking and streaming TTS; everything FrockBot cares about — who may
// connect, what costs money, what a Bot was asked to do — is decided here and
// recorded in the ledger before anything external runs. The Bot runtime is
// unchanged: voice requests use its existing agent lane and never supersede
// a User turn or routine.
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
import { ElevenLabsSTT, ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";
import {
  parseChatCompletionStreamV1,
  renderVoiceBotAnswerEventV1,
  renderVoiceSystemPromptV1,
  pickVoiceBridgeV1,
  runVoiceTurnV1,
  VOICE_PROMPT_HISTORY_MESSAGES_V1,
  type VoiceAssistantHostV1,
  type VoiceAssistantPromptInputV1,
  type VoiceBotSummaryV1,
  type VoiceCurrentBotV1,
} from "@frockbot/app/voice/assistant";
import {
  VoiceLedgerV1,
  voiceCallIsStaleV1,
  voiceTurnOrdinalV1,
  type VoiceCallRecordV1,
  type VoiceDelegationRecordV1,
  type VoiceLedgerDebugSnapshotV1,
  type VoiceLedgerStorageV1,
} from "@frockbot/app/voice/ledger";
import {
  renderVoiceBotStatusV1,
  VOICE_HISTORY_DEFAULT_LIMIT_V1,
  VOICE_HISTORY_MAX_LIMIT_V1,
} from "@frockbot/app/voice/history";
import type { SearchIndexResultsV1 } from "@frockbot/app/search/shared";
import {
  decodeVoiceMemoryUpdateV1,
  emptyVoiceMemoryRecordV1,
  matchVoiceMemoryV1,
  pruneVoiceMemoryV1,
  renderVoiceMemoryRequestMessagesV1,
  VoiceMemoryLedgerV1,
  voiceMemoryCorrectionTargetsV1,
  voiceMemoryTextKeyV1,
  VOICE_MEMORY_MAX_OUTPUT_CHARS_V1,
  VOICE_MEMORY_MAX_OPERATIONS_V1,
  VOICE_MEMORY_MAX_TEXT_CHARS_V1,
  type VoiceMemoryChunkV1,
  type VoiceMemoryJobV1,
  type VoiceMemoryOperationV1,
  type VoiceMemoryRecordV1,
  type VoiceMemorySourceReaderV1,
  type VoiceMemorySourceTurnV1,
} from "@frockbot/app/voice/memory";
import { refuseMemorySecretV1 } from "@frockbot/app/memory/secrets";
import { VOICE_REALTIME_TRANSCRIPTION_URL_V1 } from "@frockbot/app/voice/openai-realtime";
import {
  createOpenAiTranscriberV1,
  type VoiceRealtimeSocketV1,
} from "@frockbot/app/voice/openai-transcriber";
import {
  createSleepingTranscriberV1,
  type SleepingTranscriberSessionV1,
  type VoiceTranscriberV1,
} from "@frockbot/app/voice/sleeping-transcriber";
import { guardSpeechProviderV1 } from "@frockbot/app/voice/tts-guard";
import {
  VOICE_ASSISTANT_SCRIBE_OPTIONS_V1,
  voiceAssistantSttKeyV1,
  voiceAssistantSttProviderV1,
  type VoiceAssistantSttEnvV1,
} from "@frockbot/app/voice/scribe-transcriber";
import {
  decodeVoiceAssistantClientMessageV1,
  VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1,
  VOICE_ASSISTANT_STT_RESERVE_SECONDS_V1,
  VOICE_ASSISTANT_PLAYBACK_ACK_TIMEOUT_MS_V1,
  VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1,
  VOICE_DICTATION_LEASE_RENEW_MS_V1,
  VOICE_DICTATION_RESERVE_SECONDS_V1,
  type VoiceAssistantRefusalCodeV1,
  type VoiceAssistantServerMessageV1,
  type VoiceAssistantUpstreamStateV1,
} from "@frockbot/app/voice/shared";
import { MemoryStore } from "@frockbot/app/memory/store";
import {
  botMemoryRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
  isMemoryProjectIdV1,
} from "@frockbot/app/memory/roots";
import { decodeDirectoryViewV1 } from "@frockbot/app/flock/shared";
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
import {
  userTimezoneV1,
  type BotSettingsViewV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";

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
/**
 * The answer a Bot addressed to its voice caller on this Turn, if it did.
 *
 * The projected run carries the exchange in order, and this reads the last
 * `reply_to_request` out of it. Correlation is the whole point: it is this
 * run's own answer, not the Bot's latest send to its User, and not a Turn the
 * person never asked for.
 */
function voiceReplyTextOfRunV1(run: ClientRunV1): string | undefined {
  for (const event of [...run.events].reverse()) {
    if (event.type !== "reply/to-caller") continue;
    const text = (event as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return undefined;
}

/** What `debugSnapshot` returns: the ledger plus the memory jobs owed. */
export interface VoiceAssistantDebugSnapshotV1 extends VoiceLedgerDebugSnapshotV1 {
  capturedAt: string;
  memoryJobs: VoiceMemoryJobV1[];
}

interface VoiceReplyDeliveryV1 {
  userId: string;
  requestId: string;
}

/** The Bot's hand-off, decoded at the door like every other inbound value. */
function decodeVoiceReplyDeliveryV1(input: unknown): VoiceReplyDeliveryV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("voice reply delivery is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    !value.userId ||
    typeof value.requestId !== "string" ||
    !/^voice-[0-9a-f]{32}$/.test(value.requestId)
  ) {
    throw new Error("voice reply delivery is invalid");
  }
  return { userId: value.userId, requestId: value.requestId };
}

export const VOICE_ASSISTANT_USER_HEADER = "x-frockbot-user-id";
export const VOICE_ASSISTANT_DEVICE_HEADER = "x-frockbot-voice-device";

/** The default ElevenLabs voice, "George", when the deployment names none. */
export const VOICE_ASSISTANT_DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const VOICE_ASSISTANT_TTS_MODEL = "eleven_flash_v2_5";
/** How far back the User Memory log is read at call start. */
export const VOICE_ASSISTANT_MEMORY_LOG_DAYS = 30;
/** Pending audio held while a slept transcriber reopens: 10 s at 16 kHz. */
const PENDING_AUDIO_BYTES = 10 * 16_000 * 2;
/** How long a delegation look-up waits before the first check, and its ceiling. */
const DELEGATION_FIRST_CHECK_SECONDS = 8;
const DELEGATION_MAX_CHECK_SECONDS = 5 * 60;
/**
 * How long after a turn settles its speech is assumed to still be draining.
 * The SDK's `speak` aborts whatever reply is in flight, and it has no hook
 * for the moment the last chunk leaves, so a Bot answer that lands inside
 * this window is held rather than read out over the reply it would cut.
 */
const REPLY_DRAIN_QUIET_MS = 6_000;
/**
 * How long a Bot answer's event turn may take before it is abandoned. It
 * holds the announce floor while it runs, and a request that never comes back
 * would hold it for the rest of the call: every later answer would be held,
 * and nothing would ever be told. Generous enough for a slow model, finite
 * because the floor must always come back.
 */
const BOT_ANSWER_TURN_DEADLINE_MS = 20_000;
export interface VoiceAssistantEnv {
  AI?: Ai;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  /** `scribe` (default) or `openai`: which provider the assistant listens through. */
  VOICE_ASSISTANT_STT?: string;
  /**
   * A gateway model to answer voice turns with, e.g.
   * `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` or
   * `openai/gpt-5-mini`; unset, turns go to the platform's Auto route.
   */
  VOICE_ASSISTANT_MODEL?: string;
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
export function voiceAssistantConfiguredV1(
  env: { AI?: unknown } & VoiceAssistantSttEnvV1,
): boolean {
  return (
    Boolean(env.AI) &&
    Boolean(voiceAssistantSttKeyV1(env)) &&
    Boolean(env.ELEVENLABS_API_KEY?.trim())
  );
}

interface ConnectionIdentity {
  userId: string;
  deviceKey: string;
}

interface LiveCall {
  callId: string;
  /** The socket that holds this call, so a switch can retarget its record. */
  connectionId: string;
  /**
   * The Bot this call is talking to (ADR 0029): who the voice layer is
   * wearing, whose tools the narrowed ones mean, and whose voice speaks.
   * `switch_bot` moves both of these and the durable record together.
   */
  botId: string;
  botName: string;
  /** When the call was admitted, so every later line can say how far in. */
  startedAt: number;
  /**
   * The call's place in the account's session order, as epoch milliseconds of
   * its durable start. Memory written by an older call can never overwrite a
   * newer one's correction, and this is what says which is which.
   */
  sequence: number;
  promptContext: Promise<Omit<VoiceAssistantPromptInputV1, "now">>;
  session?: SleepingTranscriberSessionV1;
  /** Awake seconds already reconciled against the meter. */
  lastAwakeSeconds: number;
  /** Seconds booked for the window the upstream is currently in. */
  reservedSeconds: number;
  renewTimer?: ReturnType<typeof setTimeout>;
  muted: boolean;
  /** The last filler this call spoke, so the next one is a different one. */
  lastBridge?: string;
  /** The day's transcription allowance ran out; the upstream stays shut. */
  exhausted: boolean;
  turnId?: string;
  /** The current turn's durable admission time: what a fact it produces is dated by. */
  turnAdmittedAt?: string;
  /** The current turn's words, so a `remember` can be grounded in them. */
  turnTranscript?: string;
  /** Its place in the call, from one: the other half of the ordering stamp. */
  turnOrdinal?: number;
  /**
   * The system message the call last actually sent. Kept here rather than
   * written per turn, and persisted once when the call ends, so the memory
   * request can repeat it without a storage write for every utterance.
   */
  lastSystem?: string;
  /** When the current or last turn began, so its lines can say how long it took. */
  turnStartedAt?: number;
  /** When that turn's model finished; unset while it is in flight. */
  turnSettledAt?: number;
  /**
   * When the client last reported its own speaker as playing, unset once it
   * reports quiet. A stamp rather than a flag because a report that is never
   * withdrawn — a device whose completion never came back — must not hold
   * every Bot answer back for the rest of the call.
   */
  playingSince?: number;
  synthesizing: number;
  /**
   * Bumped every time what this call is saying changes: a new spoken turn, an
   * interruption. A Bot answer whose words were being written when it changed
   * is stale — the person has moved on — and is dropped rather than spoken
   * into what is happening now.
   */
  speechGeneration: number;
  /**
   * The Bot-answer turn in flight, if one is: aborted when the person speaks,
   * interrupts, or hangs up, because an answer being put into words for a
   * moment that has passed is not worth finishing.
   */
  announcing?: AbortController;
  quotaSaid: boolean;
}

interface AnnounceDelegationPayload {
  runId: string;
}

/** Look-ups a delegation gets before it is settled as never accepted. */
const DELEGATION_MAX_ATTEMPTS = 40;
/** A dispatch younger than this is still in flight; a check waits, not resends. */
const DELEGATION_REDISPATCH_AFTER_MS = 30_000;

interface DelegationCheckPayload {
  runId: string;
}

interface MemoryFinalizationPayload {
  callId: string;
}

/**
 * How long after a call ends its memory work starts. Short — the person is
 * gone, and the next call must not find it still queued — but not zero: the
 * hang-up and the socket close arrive together, and one scheduled row for the
 * two of them is the point.
 */
const MEMORY_FINALIZE_DELAY_SECONDS = 2;
/**
 * Room for the whole update the instruction authorises, not less: an answer
 * cut off mid-array is unreadable, and asking again only truncates again at
 * the same place. Derived from the caps the instruction states — every
 * operation at its full text, plus its envelope and the turn id it cites —
 * so the two cannot drift apart.
 */
const MEMORY_UPDATE_MAX_TOKENS = Math.ceil(
  (VOICE_MEMORY_MAX_OPERATIONS_V1 * (VOICE_MEMORY_MAX_TEXT_CHARS_V1 + 128) +
    64) /
    3,
);
/**
 * How long the memory request may take before its stream is cancelled. A
 * request past this is abandoned, not retried: it has already been dispatched
 * and may have been paid for.
 */
const MEMORY_UPDATE_DEADLINE_MS = 60_000;

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
  /**
   * The Bot a socket asked for before its call was admitted (ADR 0029).
   *
   * The SDK's `start_call` frame carries only a preferred format, so the
   * target arrives as its own message just before it. Held per connection
   * until the call is admitted, then it lives in the call record.
   */
  #targets = new Map<string, string>();
  /**
   * Answers being handed to the assistant right now, by run id. Two signals
   * for one answer — the Bot's wake and the scheduled look-up — arrive
   * together; the second finds the first here and does nothing.
   */
  #announcing = new Set<string>();

  /**
   * What the trace still needs after the call record is gone: the ordinary
   * hang-up releases the call on `end_call` and only then closes the socket,
   * so the `closed` line would otherwise name no call and measure nothing.
   * Dropped at the end of `onClose`, once that line is written.
   */
  #traced = new Map<
    string,
    {
      callId: string;
      startedAt: number;
      /** Synthesized audio handed down this socket, so silence has a number. */
      audioChunks: number;
      audioBytes: number;
      sentencesSpoken: number;
      /**
       * Sentences accepted for synthesis whose first chunk has not arrived,
       * counted per sentence: the SDK pumps several sentences at once, so
       * their chunks interleave and the previous chunk's text says nothing
       * about which sentence this one starts.
       */
      awaitingFirstChunk: Map<string, number>;
    }
  >();

  tts: (TTSProvider & Partial<StreamingTTSProvider>) | undefined =
    this.guardTts(this.createTts());

  /**
   * The provider never answers with silence: a sentence that produces no
   * audio throws, the SDK tells the client and moves to the next sentence,
   * and the line below names the sentence that went unheard.
   */
  private guardTts(
    inner: (TTSProvider & Partial<StreamingTTSProvider>) | undefined,
  ): (TTSProvider & Partial<StreamingTTSProvider>) | undefined {
    if (!inner) return undefined;
    const guarded = guardSpeechProviderV1(inner, (text) =>
      this.synthesisFailed(text),
    );
    const self = this;
    const wrapped: TTSProvider & Partial<StreamingTTSProvider> = {
      async synthesize(text, signal) {
        const finish = self.beginSpeechSynthesis(text);
        try {
          return await guarded.synthesize(text, signal);
        } catch (error) {
          if (!signal?.aborted) self.synthesisFailed(text);
          throw error;
        } finally {
          finish();
        }
      },
    };
    const stream = guarded.synthesizeStream;
    if (stream)
      wrapped.synthesizeStream = async function* (text, signal) {
        const finish = self.beginSpeechSynthesis(text);
        try {
          yield* stream(text, signal);
        } catch (error) {
          if (!signal?.aborted) self.synthesisFailed(text);
          throw error;
        } finally {
          finish();
        }
      };
    return wrapped;
  }

  private beginSpeechSynthesis(text: string): () => void {
    for (const [connectionId, call] of this.#calls) {
      if (!this.#traced.get(connectionId)?.awaitingFirstChunk.has(text))
        continue;
      const generation = call.speechGeneration;
      call.synthesizing += 1;
      return () => {
        if (
          this.#calls.get(connectionId) !== call ||
          call.speechGeneration !== generation
        )
          return;
        call.synthesizing -= 1;
        // Cover the handoff from the last PCM chunk to the client's playing report.
        if (call.turnSettledAt !== undefined) call.turnSettledAt = Date.now();
      };
    }
    return () => undefined;
  }

  private synthesisFailed(text: string): void {
    for (const connection of this.getConnections()) {
      const traced = this.#traced.get(connection.id);
      const awaiting = traced?.awaitingFirstChunk.get(text) ?? 0;
      if (!traced || awaiting === 0) continue;
      if (awaiting > 1) traced.awaitingFirstChunk.set(text, awaiting - 1);
      else traced.awaitingFirstChunk.delete(text);
      this.trace(connection, "tts-failed", { chars: text.length });
      return;
    }
  }

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
    const apiKey = voiceAssistantSttKeyV1(this.env);
    if (!apiKey) return undefined;
    if (voiceAssistantSttProviderV1(this.env) === "openai") {
      return createOpenAiTranscriberV1({
        openSocket: () =>
          openVoiceUpstreamSocket(VOICE_REALTIME_TRANSCRIPTION_URL_V1, {
            authorization: `Bearer ${apiKey}`,
          }),
      });
    }
    // The SDK's `Transcriber` and this module's `VoiceTranscriberV1` are the
    // same shape; the adapter opens its own socket with a `fetch` upgrade.
    return new ElevenLabsSTT({
      apiKey,
      ...VOICE_ASSISTANT_SCRIBE_OPTIONS_V1,
    }) as VoiceTranscriberV1;
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
      this.voiceModel() ??
        gatewayModelForFrockRequestV1(
          FROCK_AI_DEFAULT_MODEL,
          false,
          host.autoRoute,
        ),
      body,
      signal,
    );
  }

  /**
   * The model pinned for voice turns, if the deployment pinned one. A voice
   * turn wants a fast first token above all, which the platform's Auto route
   * does not promise; the pin is a Worker var so it can follow what the
   * `model-first-text` lines show without a code change.
   */
  protected voiceModel(): string | undefined {
    const pinned = this.env.VOICE_ASSISTANT_MODEL?.trim();
    return pinned ? pinned : undefined;
  }

  protected now(): Date {
    return new Date();
  }

  /** Seconds of transcription booked per window; a test shortens it. */
  protected sttWindowSeconds(): number {
    return VOICE_ASSISTANT_STT_RESERVE_SECONDS_V1;
  }

  /** How long a settled reply is left to finish playing; a test shortens it. */
  protected replyDrainQuietMs(): number {
    return REPLY_DRAIN_QUIET_MS;
  }

  /** How long a Bot answer's event turn may hold the floor; a test shortens it. */
  protected botAnswerDeadlineMs(): number {
    return BOT_ANSWER_TURN_DEADLINE_MS;
  }

  /**
   * How long an unwithdrawn playback report holds the floor; a test shortens
   * it. It covers a speaker the client never reported quiet again.
   */
  protected playbackAckTimeoutMs(): number {
    return VOICE_ASSISTANT_PLAYBACK_ACK_TIMEOUT_MS_V1;
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

  /**
   * The session's own memory. One instance per object, not one per call: the
   * instance holds the chain that serializes read-modify-write, so a spoken
   * `remember` and a background finalization cannot interleave inside one.
   */
  protected memory(): VoiceMemoryLedgerV1 {
    if (!this.#memory) {
      const storage = this.ctx.storage;
      this.#memory = new VoiceMemoryLedgerV1({
        get: <T>(key: string) => storage.get<T>(key),
        put: <T>(key: string, value: T) => storage.put<T>(key, value),
        delete: (key: string) => storage.delete(key),
        list: <T>(options: { prefix: string }) => storage.list<T>(options),
      });
    }
    return this.#memory;
  }

  #memory: VoiceMemoryLedgerV1 | undefined;

  async onStart(): Promise<void> {
    const now = this.now();
    const memory = this.memory();
    // A model request that was in flight when this object went away has an
    // unknown outcome and no idempotency key at the gateway. It is never
    // re-issued: it is recorded as failed, and the turns it was reading stay
    // in the ledger for the next call's finalization to read.
    for (const callId of await memory.failUncertainJobs(now)) {
      this.traceMemory("memory-uncertain", { call: callId }, "warn");
    }
    // A call whose socket died, or that was live when the object was evicted.
    // Inside the rejoin window it is left alone and given an alarm, because a
    // client that comes straight back continues it; past the window it ends
    // here and its turns go to memory. Either way there is a scheduled path
    // to finishing: nothing waits for a future request to notice it.
    const current = await this.ledger().currentCall();
    if (current) {
      if (voiceCallIsStaleV1(current, now)) {
        await this.beginMemoryFinalization(current);
        await this.ledger().endStaleCall(now);
      } else {
        await this.scheduleCallAbandon(current.callId);
      }
    }
    const protectedCalls = new Set(
      (await memory.unsummarisedJobs()).map((job) => job.callId),
    );
    if (current) protectedCalls.add(current.callId);
    const recovered = await this.ledger().recover(now, protectedCalls);
    for (const delegation of recovered.pending) {
      await this.scheduleDelegationCheck(
        delegation.runId,
        delegation.attempts,
        true,
      );
    }
    for (const job of await memory.pendingJobs()) {
      await this.scheduleMemoryFinalization(job.callId);
    }
  }

  // -- session memory -------------------------------------------------------

  /**
   * Reads one call's admitted turns as memory source material.
   *
   * Nothing is copied into the job: these records are the source, and the
   * ledger's retention sweep leaves the turns of a call with unfinished
   * memory work alone. So a call of any length costs one small job record,
   * and what the person said is never clipped to fit one.
   */
  private memorySource(): VoiceMemorySourceReaderV1 {
    return async (callId: string) => {
      const job = await this.memory().readJob(callId);
      const sequence = job?.sequence ?? 0;
      const turns = (await this.ledger().turnsForCall(callId)).filter(
        // A Bot's answer arriving is not something the person said; what the
        // assistant made of it, if it spoke, is not theirs either.
        (turn) => !turn.event,
      );
      return turns.map((turn) => ({
        id: turn.turnId,
        // The ledger's own turn sequence, not a place in this filtered list:
        // an in-call memory write stamps the same number, and the two must
        // order against each other.
        ordinal: voiceTurnOrdinalV1(turn.turnId),
        callId,
        sequence,
        at: turn.admittedAt,
        said: turn.transcript,
        ...(turn.answer ? { answered: turn.answer } : {}),
      }));
    };
  }

  /**
   * Records the intent to remember this call, and schedules the work.
   *
   * The job is written *before* the call record is deleted, so an eviction in
   * between leaves the intent durable rather than losing the only marker that
   * a call ever needs finalizing. Idempotent by call id: the hang-up, the
   * abandoned-call alarm and a supersession all land here, and only the first
   * writes anything. The model call happens later, on the scheduler, so
   * hanging up stays as quick as it was.
   */
  private async beginMemoryFinalization(
    call: VoiceCallRecordV1,
  ): Promise<void> {
    const live = this.liveCallFor(call.callId);
    const created = await this.memory().createJob({
      callId: call.callId,
      sequence: Date.parse(call.startedAt),
      // The call's own last system prompt, kept in memory turn by turn and
      // written here once. Without it — an eviction, a call with no turns —
      // the request carries no prefix and simply loses the cache hint.
      ...(live?.lastSystem ? { system: live.lastSystem } : {}),
      at: this.now(),
    });
    if (created.status === "created") {
      const retired = await this.memory().retireJobs(this.now());
      this.traceMemory("memory-queued", {
        call: call.callId,
        ...(retired.length > 0 ? { retired } : {}),
      });
    }
    await this.scheduleMemoryFinalization(call.callId);
  }

  private liveCallFor(callId: string): LiveCall | undefined {
    for (const call of this.#calls.values()) {
      if (call.callId === callId) return call;
    }
    return undefined;
  }

  private async scheduleMemoryFinalization(
    callId: string,
    idempotent = true,
  ): Promise<void> {
    await this.schedule<MemoryFinalizationPayload>(
      MEMORY_FINALIZE_DELAY_SECONDS,
      "finalizeVoiceMemory",
      { callId },
      // A continuation needs a new row: the scheduler deletes the running
      // row when its callback returns, even if a request deduplicated onto it.
      { idempotent },
    );
  }

  /**
   * A socket closed without the person ending the call. The call is left
   * live for the rejoin window — a network change must not cost them the
   * conversation — and this alarm is what finishes it if nobody comes back.
   */
  private async scheduleCallAbandon(
    callId: string,
    idempotent = true,
  ): Promise<void> {
    await this.schedule<MemoryFinalizationPayload>(
      Math.ceil(VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1 / 1000) + 5,
      "abandonVoiceCall",
      { callId },
      { idempotent },
    );
  }

  /**
   * The rejoin window passed with nobody back. Ends the call and hands its
   * turns to memory. Public because the scheduler calls it by name.
   */
  async abandonVoiceCall(payload: MemoryFinalizationPayload): Promise<void> {
    const call = await this.ledger().currentCall();
    if (!call || call.callId !== payload.callId) return;
    // A connection still holding this call is a live conversation: the
    // person is talking, and this alarm is about a socket that went away.
    if (this.liveCallFor(call.callId)) return;
    if (!voiceCallIsStaleV1(call, this.now())) {
      // Somebody rejoined and has spoken since. Look again after the window.
      await this.scheduleCallAbandon(call.callId, false);
      return;
    }
    this.traceMemory("call-abandoned", { call: call.callId });
    await this.beginMemoryFinalization(call);
    await this.ledger().endStaleCall(this.now());
  }

  /**
   * One chunk of one ended call, folded into memory. Public because the
   * scheduler calls it by name.
   *
   * Three durable steps. Claiming is what stops a duplicate end notification
   * from spending twice. The spend is written before the request leaves, so a
   * request whose answer never arrives is an explicit failure and not a
   * guess — and such a request is never made again, because the gateway holds
   * no idempotency key for it and a retry may pay for a call that already
   * ran. Only an answer that arrived whole and could not be read is asked for
   * again. Whatever happens, the turns stay in the ledger until they have
   * actually been read.
   */
  async finalizeVoiceMemory(payload: MemoryFinalizationPayload): Promise<void> {
    const memory = this.memory();
    const chunk = await memory.claimChunk({
      callId: payload.callId,
      at: this.now(),
      read: this.memorySource(),
    });
    if (!chunk) return;
    let answer: string;
    try {
      answer = await this.runMemoryUpdate(chunk);
    } catch (error) {
      // The request left and did not come back whole. Its outcome is unknown,
      // so it is not repeated; the source is kept and the next call reads it.
      await memory.abandonChunk(
        payload.callId,
        error instanceof Error ? error.message : String(error),
        this.now(),
      );
      this.traceMemory(
        "memory-abandoned",
        { call: payload.callId, attempt: chunk.job.attempts },
        "warn",
      );
      return;
    }
    const update = decodeVoiceMemoryUpdateV1(answer);
    if (update.malformed) {
      // A complete answer that is not an update: the call is known to have
      // finished, so asking again is a new request, not a second payment.
      const again = await memory.retryChunk(
        payload.callId,
        update.refusals[0] ?? "the update could not be read",
        this.now(),
      );
      this.traceMemory(
        "memory-malformed",
        { call: payload.callId, attempt: chunk.job.attempts, again },
        "warn",
      );
      if (again) await this.scheduleMemoryFinalization(payload.callId, false);
      return;
    }
    const applied = await memory.applyChunk({
      callId: payload.callId,
      chunk,
      update,
      timezone: await this.userTimezone(this.name),
      at: this.now(),
    });
    this.traceMemory("memory-updated", {
      call: payload.callId,
      status: applied.status,
      operations: update.operations.length,
      refused: update.refusals.length,
      ...(applied.status === "applied"
        ? { done: applied.done, skipped: applied.skipped.length }
        : {}),
    });
    if (applied.status === "applied" && !applied.done) {
      await this.scheduleMemoryFinalization(payload.callId, false);
    }
  }

  /**
   * The memory request: the same configured model the call itself used, the
   * call's own last system message in front, the conversation, and the
   * instruction last.
   *
   * Only the system message is shared with the call's own requests, so a
   * provider that caches prompt prefixes can match that much and no more —
   * the turns below it are the whole conversation rather than the twelve the
   * live prompt carried, and the system message itself carries a per-turn
   * clock. The cache hit is a bonus, never something correctness rests on.
   *
   * The request has its own deadline and its own bound: the stream is
   * cancelled when either is reached, rather than read to the end first.
   */
  protected async runMemoryUpdate(chunk: VoiceMemoryChunkV1): Promise<string> {
    const messages = renderVoiceMemoryRequestMessagesV1({
      ...(chunk.job.system ? { system: chunk.job.system } : {}),
      turns: chunk.turns,
      record: await this.memory().read(),
      progress: { from: chunk.from, to: chunk.to, total: chunk.total },
    });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), MEMORY_UPDATE_DEADLINE_MS);
    try {
      const stream = await this.chatCompletion(
        {
          messages,
          stream: true,
          max_tokens: MEMORY_UPDATE_MAX_TOKENS,
          temperature: 0,
        },
        abort.signal,
      );
      let text = "";
      for await (const event of parseChatCompletionStreamV1(stream)) {
        if (event.type === "text") text += event.text;
        if (text.length >= VOICE_MEMORY_MAX_OUTPUT_CHARS_V1) {
          // Past the bound the stream is cut and the answer refused. It is
          // not handed back as if it were complete: half an answer that
          // happens to parse would be read as the whole of what to remember,
          // and asking again would pay a second time for a call that ran.
          abort.abort();
          throw new Error("the memory update ran past its output bound");
        }
        if (abort.signal.aborted) {
          throw new Error("the memory update ran past its deadline");
        }
      }
      if (abort.signal.aborted) {
        throw new Error("the memory update was cut short");
      }
      return text;
    } finally {
      clearTimeout(deadline);
    }
  }

  // -- connections ----------------------------------------------------------

  private identity(connection: Connection): ConnectionIdentity | undefined {
    const state = connection.state as ConnectionIdentity | null;
    return state && typeof state.userId === "string" ? state : undefined;
  }

  /**
   * One line per step of a call, as `wrangler tail` and Workers Logs show
   * it. The happy path is otherwise silent — the SDK logs only its own
   * failures, and a refusal reaches the client without a trace — so a call
   * that went nowhere used to look, from every log, like a call nobody made.
   * Never the words spoken: lengths and ids only.
   */
  protected trace(
    connection: Connection,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    const call =
      this.#calls.get(connection.id) ?? this.#traced.get(connection.id);
    const line = {
      event,
      connection: connection.id,
      device: this.identity(connection)?.deviceKey,
      ...(call
        ? {
            call: call.callId,
            elapsedMs: Math.max(0, Date.now() - call.startedAt),
          }
        : {}),
      ...fields,
    };
    (event.startsWith("refused") ||
      event === "stt-failed" ||
      event === "tts-failed"
      ? console.warn
      : console.info)("voice assistant", JSON.stringify(line));
  }

  /**
   * A line about the session's memory. Separate from `trace` because this
   * work outlives the socket: the scheduler runs it with no connection, and
   * a call that ended is exactly when it happens. Never the words remembered:
   * counts, ids and outcomes only.
   */
  protected traceMemory(
    event: string,
    fields: Record<string, unknown> = {},
    level: "info" | "warn" = "info",
  ): void {
    (level === "warn" ? console.warn : console.info)(
      "voice assistant",
      JSON.stringify({ event, ...fields }),
    );
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
      this.trace(connection, "refused-identity", { device: deviceKey });
      connection.close(4403, "voice session is not yours");
      return;
    }
    connection.setState({ userId, deviceKey } satisfies ConnectionIdentity);
    this.trace(connection, "connected");
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // The client names its own reason for going: a close code above 4000 and
    // the path that closed it (docs/voice.md). This is the line that says
    // whether the person hung up, the app left the foreground, or the
    // client failed on its own.
    this.trace(connection, "closed", {
      code,
      reason: reason.slice(0, 200),
      wasClean,
    });
    // A socket going is not the person hanging up. The upstream is closed and
    // its meter settled at once, but the call record stays: a client that
    // comes straight back from a network change continues this conversation
    // rather than starting a new one with nothing behind it. The alarm below
    // is what ends it, and hands it to memory, if nobody comes back — so an
    // abandoned call always has a scheduled path to being finished, and never
    // waits for some future request to notice it.
    await this.releaseCallResources(connection.id);
    const current = await this.ledger().currentCall();
    if (current && current.connectionId === connection.id) {
      await this.scheduleCallAbandon(current.callId);
    }
    this.#traced.delete(connection.id);
    this.#targets.delete(connection.id);
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
    // The target is the one message that arrives before the call exists: the
    // client says who it wants, then `start_call`. Once a call is live the
    // same message is a hand-over the person asked for on the screen rather
    // than in words, so it goes the same way `switch_bot` does.
    if (custom.type === "voice/target") {
      const live = this.#calls.get(connection.id);
      if (!live) {
        this.#targets.set(connection.id, custom.botId);
        return;
      }
      const identity = this.identity(connection);
      if (!identity) return;
      await this.turnHost(
        identity.userId,
        live,
        `target-${crypto.randomUUID()}`,
        undefined,
      ).switchBot(custom.botId);
      return;
    }
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
      case "voice/speech":
        // The speaker, as the device knows it. Nothing durable turns on this:
        // it is only what decides whether now is a pause.
        call.playingSince = custom.playing ? Date.now() : undefined;
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
    this.trace(connection, "refused", { code, message });
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/refusal",
      code,
      message,
    });
  }

  /**
   * Which Bot a call opens on (ADR 0029).
   *
   * The client's choice wins when it names a Bot this account owns. Anything
   * else — no choice, a deleted Bot, another account's — falls back to the
   * account's General Bot, and failing that the first Bot in the directory,
   * because a call with nobody on the other end is worse than a call with
   * the wrong somebody. An account with no Bots at all is answered by the
   * account-wide assistant, as before.
   */
  private async resolveCallTarget(
    userId: string,
    botId: string | undefined,
  ): Promise<{ botId: string; name: string }> {
    if (botId) {
      try {
        const owned = await this.ownedBot(userId, botId);
        return { botId: owned.botId, name: owned.name };
      } catch {
        // Fall through to the account's default.
      }
    }
    const bots = await this.listBots(userId).catch(
      () => [] as VoiceBotSummaryV1[],
    );
    const general =
      bots.find((bot) => bot.name.trim().toLowerCase() === "general") ??
      bots[0];
    return general
      ? { botId: general.botId, name: general.name }
      : { botId: "", name: "" };
  }

  /**
   * Tells the client which Bot it is talking to (ADR 0029).
   *
   * Sent when a call is admitted and again whenever `switch_bot` moves it,
   * so the screen follows the voice rather than the person having to guess
   * who answered.
   */
  private sendTarget(connection: Connection, botId: string) {
    this.send(connection, { schemaVersion: 1, type: "voice/target", botId });
  }

  /** The live socket with this id, if it is still one of ours. */
  private connectionFor(connectionId: string): Connection | undefined {
    for (const connection of this.getConnections()) {
      if (connection.id === connectionId) return connection;
    }
    return undefined;
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
    // A call about to be displaced has its memory work recorded *before* the
    // record naming it is replaced. Written the other way round, an eviction
    // in between would leave a call nothing remembers it has to finish. The
    // rejoin rule is the ledger's own, asked here rather than repeated.
    const displaced = await ledger.currentCall();
    if (displaced && !(await ledger.rejoins(identity.deviceKey, now))) {
      await this.beginMemoryFinalization(displaced);
    }
    // ADR 0029: a call addresses one Bot. The client says which before it
    // says `start_call`; a rejoin keeps the Bot its record already has, and
    // a client that names none — or names one this account does not own —
    // gets General, so there is always somebody on the line.
    const requested = this.#targets.get(connection.id);
    const admission = await ledger.beginCall({
      callId: crypto.randomUUID(),
      deviceKey: identity.deviceKey,
      connectionId: connection.id,
      at: now,
      ...(requested ? { botId: requested } : {}),
    });
    const target = await this.resolveCallTarget(
      identity.userId,
      admission.call.botId ?? requested,
    );
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
    const call: LiveCall = {
      callId: admission.call.callId,
      connectionId: connection.id,
      botId: target.botId,
      botName: target.name,
      startedAt: Date.now(),
      sequence: Date.parse(admission.call.startedAt),
      promptContext: this.buildPromptContext(identity.userId, target.botId),
      lastAwakeSeconds: 0,
      reservedSeconds: 0,
      muted: false,
      exhausted: false,
      synthesizing: 0,
      speechGeneration: 0,
      quotaSaid: false,
    };
    this.#calls.set(connection.id, call);
    this.#traced.set(connection.id, {
      callId: call.callId,
      startedAt: call.startedAt,
      audioChunks: 0,
      audioBytes: 0,
      sentencesSpoken: 0,
      awaitingFirstChunk: new Map(),
    });
    this.trace(connection, "call-admitted", {
      admission: admission.status,
      rejoined: admission.status === "admitted" && admission.rejoined,
      replaced: admission.replaced?.connectionId,
      ...(call.botId ? { bot: call.botId } : {}),
    });
    // The choice is spent: from here the Bot lives in the call record, and a
    // later `voice/target` on this socket is a hand-over, not a preference.
    this.#targets.delete(connection.id);
    if (call.botId) this.sendTarget(connection, call.botId);
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
          onSpeechStart: () => {
            // The upstream's own voice detector heard someone. While the
            // assistant is speaking this is the barge-in that aborts the
            // reply, so it is the line that says why synthesis stopped.
            this.trace(connection, "speech-started");
            options.onSpeechStart?.();
          },
          onFatalError: (error) => {
            // The SDK logs its own record of any transcriber fatal; this one
            // names it as the assistant's ears and, sitting outside the
            // sleeping wrapper, also catches an upgrade that never became a
            // session. Without it a call that loses its ears looks, from
            // every log, like a person who said nothing.
            this.trace(connection, "stt-failed", { message: error.message });
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
    this.trace(connection, "upstream", { state });
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
    if (!call) {
      this.trace(connection, "listening-without-call");
      return;
    }
    this.trace(connection, "listening");
    this.sendState(connection, call);
  }

  override async onCallEnd(connection: Connection): Promise<void> {
    const traced = this.#traced.get(connection.id);
    this.trace(connection, "call-ended", {
      audioChunks: traced?.audioChunks ?? 0,
      audioBytes: traced?.audioBytes ?? 0,
      sentencesSpoken: traced?.sentencesSpoken ?? 0,
    });
    await this.releaseCall(connection);
  }

  /**
   * The SDK stopped a reply. It does this for the upstream's own detector
   * (a `speech-started` line lands just before) and for the phone's local
   * energy gate sending `interrupt` (no such line: the SDK consumes that
   * frame before `onMessage`). Between the two the log names which side
   * cut a reply short.
   */
  override onInterrupt(connection: Connection): void {
    this.trace(connection, "interrupted");
    const call = this.#calls.get(connection.id);
    if (!call) return;
    // The client stops its own player, so the speaker is quiet from here. A
    // Bot answer being put into words is for a moment that has passed.
    call.playingSince = undefined;
    call.speechGeneration += 1;
    call.synthesizing = 0;
    this.#traced.get(connection.id)?.awaitingFirstChunk.clear();
    call.announcing?.abort();
  }

  /**
   * Every chunk of synthesized audio on its way down, counted; the first
   * chunk of each sentence is traced on its own so the tail shows whether
   * speech ever left the object and how long the first byte took.
   */
  override async afterSynthesize(
    audio: ArrayBuffer,
    text: string,
    connection: Connection,
  ): Promise<ArrayBuffer | null> {
    const traced = this.#traced.get(connection.id);
    if (!traced) return audio;
    traced.audioChunks += 1;
    traced.audioBytes += audio.byteLength;
    const awaiting = traced.awaitingFirstChunk.get(text) ?? 0;
    if (awaiting > 0) {
      if (awaiting > 1) traced.awaitingFirstChunk.set(text, awaiting - 1);
      else traced.awaitingFirstChunk.delete(text);
      traced.sentencesSpoken += 1;
      const call = this.#calls.get(connection.id);
      this.trace(connection, "audio", {
        chars: text.length,
        bytes: audio.byteLength,
        chunk: traced.audioChunks,
        ...(call?.turnId ? { turn: call.turnId } : {}),
        ...(call?.turnStartedAt
          ? { sinceTurnMs: Math.max(0, Date.now() - call.turnStartedAt) }
          : {}),
      });
    }
    return audio;
  }

  /**
   * Ends the call this connection held and hands its turns to memory.
   *
   * `endCall` answers the record only for the connection that actually held
   * the call, so the hang-up and the socket close that follows it produce one
   * finalization and not two — and a socket that was already superseded ends
   * nothing here, because the call it used to hold now belongs elsewhere.
   */
  private async releaseCall(connection: Connection): Promise<void> {
    // The live call goes last. Releasing its resources drops it from `#calls`,
    // and with it the system message the memory request wants for its prefix,
    // so the job is written while that is still in hand.
    const call = await this.ledger().currentCall();
    if (call && call.connectionId === connection.id) {
      await this.beginMemoryFinalization(call);
    }
    await this.releaseCallResources(connection.id);
    if (!call || call.connectionId !== connection.id) return;
    // The job was written first, the call record goes second. An eviction
    // between the two leaves a durable intent to finish and a call record
    // that waking will end; the other order leaves a call nobody remembers
    // has to be read.
    await this.ledger().endCall(connection.id);
    this.trace(connection, "call-memory", { call: call.callId });
  }

  /** Closes the upstream and settles its meter; the call record is separate. */
  private async releaseCallResources(connectionId: string): Promise<void> {
    const call = this.#calls.get(connectionId);
    if (!call) return;
    this.#calls.delete(connectionId);
    call.announcing?.abort();
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
    const accepted = trimmed.length >= 2;
    this.trace(_connection, "utterance", {
      chars: transcript.length,
      accepted,
    });
    return accepted ? transcript.trim() : null;
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
      this.trace(connection, "speech-suppressed", {
        cap,
        chars: text.length,
      });
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
    const traced = this.#traced.get(connection.id);
    if (traced) {
      traced.awaitingFirstChunk.set(
        text,
        (traced.awaitingFirstChunk.get(text) ?? 0) + 1,
      );
    }
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
    if (!identity || !call) {
      this.trace(connection, "turn-dropped", {
        reason: identity ? "no-call" : "no-identity",
      });
      return "";
    }
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
    const startedAt = Date.now();
    // The person is talking, so anything being composed for them to hear is
    // already about a moment that has passed.
    call.speechGeneration += 1;
    call.synthesizing = 0;
    this.#traced.get(connection.id)?.awaitingFirstChunk.clear();
    call.announcing?.abort();
    call.turnId = turnId;
    call.turnAdmittedAt = admitted.turn.admittedAt;
    call.turnTranscript = transcript;
    // `<callId>:<sequence>`: the ledger's own count of this call's turns, and
    // half of the stamp that orders every memory write against every other.
    call.turnOrdinal = voiceTurnOrdinalV1(turnId);
    call.turnStartedAt = startedAt;
    call.turnSettledAt = undefined;
    this.trace(connection, "turn", {
      turn: turnId,
      chars: transcript.length,
      model: this.voiceModel() ?? "auto",
    });
    const system = call.promptContext.then(async (promptContext) => {
      // The session's own memory is read again for every turn, not once at
      // the call's start: a `remember` or a `forget` said thirty seconds ago
      // has to be in front of the model now, long after it has fallen out of
      // the history window. Everything expensive — the Bot directory, the
      // account memory, the timezone — stays in the snapshot.
      const rendered = renderVoiceSystemPromptV1({
        ...promptContext,
        session: await this.sessionMemoryContext(),
        now: this.now(),
      });
      // The system message this call actually sent, kept for the end-of-call
      // request's prefix. In memory only: a storage write per utterance for a
      // cache hint would cost more than the hint is worth.
      call.lastSystem = rendered;
      return rendered;
    });
    // The conversation is this call's own turns, read from the ledger rather
    // than the SDK's account-wide message table: a Bot answer that settles
    // late, or anything said in a previous call, must not arrive in this one
    // as if it had just been said.
    const history = await this.callHistory(call.callId, turnId);
    const host = this.turnHost(
      identity.userId,
      call,
      turnId,
      (await call.promptContext).timezone,
    );
    const self = this;
    // The SDK consumes this generator sentence by sentence into TTS; the
    // settlement callback runs when the model is done, whether it spoke or
    // handed the work on.
    return (async function* () {
      let settlement: { answer: string } | { failure: string } = {
        failure: "no settlement",
      };
      let traced: Record<string, string | number> = {
        failure: "no settlement",
      };
      let firstText = true;
      try {
        const bridge = pickVoiceBridgeV1(call.lastBridge);
        for await (const chunk of runVoiceTurnV1(
          host,
          {
            system,
            history,
            transcript,
            signal: context.signal,
            botId: call.botId,
            bridge,
          },
          (result) => {
            const spoke =
              result.outcome === "answered" || result.delegations > 0;
            settlement = spoke
              ? { answer: result.answer }
              : { failure: result.outcome };
            traced = spoke
              ? {
                  outcome: result.outcome,
                  delegations: result.delegations,
                  answerChars: result.answer.length,
                }
              : { failure: result.outcome };
          },
        )) {
          if (chunk.kind === "bridge") {
            call.lastBridge = bridge;
            // The filler, not the model: timed on its own line so the
            // model's own first word stays one measurement.
            self.trace(connection, "turn-bridge", {
              turn: turnId,
              ms: Date.now() - startedAt,
            });
          } else if (firstText) {
            // The model's first word: everything before it is what the
            // person waited through in silence.
            firstText = false;
            self.trace(connection, "model-first-text", {
              turn: turnId,
              ms: Date.now() - startedAt,
            });
          }
          yield chunk.text;
        }
      } catch (error) {
        settlement = {
          failure: error instanceof Error ? error.message : String(error),
        };
        traced = {
          failure: "exception",
          error: error instanceof Error ? error.name : typeof error,
        };
        throw error;
      } finally {
        if (call.turnId === turnId) call.turnSettledAt = Date.now();
        // Durable before the generator returns, so the SDK's own history
        // write and the ledger never disagree about whether this turn ended.
        await ledger.settleTurn(turnId, settlement);
        // The trace carries a length or a classification, never the
        // settlement's own failure sentence: that sentence can be a
        // provider's echo of the request, and the request carries what the
        // person said.
        self.trace(connection, "turn-settled", {
          turn: turnId,
          ms: Date.now() - startedAt,
          ...traced,
        });
      }
    })();
  }

  /**
   * This call's conversation so far, newest last, bounded to what the prompt
   * carries. Built from the ledger's own turn records, which are written
   * before the model is asked anything, so the history is exactly what this
   * call admitted — no more, and nothing from any other call.
   */
  private async callHistory(
    callId: string,
    currentTurnId: string,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const turns = await this.ledger().turnsForCall(callId);
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (const turn of turns) {
      if (turn.turnId === currentTurnId) continue;
      history.push({ role: "user", content: turn.transcript });
      if (turn.answer)
        history.push({ role: "assistant", content: turn.answer });
    }
    return history.slice(-VOICE_PROMPT_HISTORY_MESSAGES_V1);
  }

  /**
   * The client says its speaker is playing, recently enough to believe it.
   * A device whose completion report never comes back — a route change part
   * way through an answer, a dropped callback — would otherwise hold every
   * Bot answer for the rest of the call. The bound only frees the floor: it
   * says nothing about whether anything was heard.
   */
  private speakerPlaying(call: LiveCall): boolean {
    return (
      call.playingSince !== undefined &&
      Date.now() - call.playingSince < this.playbackAckTimeoutMs()
    );
  }

  /**
   * Whether something is still being said, so a Bot answer would cut it off.
   *
   * Two things count. A model still producing a reply is in flight by
   * definition. A speaker the client reports as playing is in flight because
   * the person is hearing it — bounded by a clock, because a client that
   * cannot report the end of a sound must not be able to hold every Bot
   * answer back for the rest of the call.
   */
  private replyInFlight(call: LiveCall): boolean {
    // A Bot answer already being told is a reply in flight from the moment it
    // claims the floor, which is before its turn is admitted: two event turns
    // at once would abort each other, and the one that loses is already
    // marked spoken, so nobody would ever hear it.
    if (call.announcing) return true;
    if (call.turnStartedAt !== undefined && call.turnSettledAt === undefined) {
      return true;
    }
    if (this.speakerPlaying(call) || call.synthesizing > 0) return true;
    // A settled reply whose audio the client never reported on at all: the
    // short drain window is the only evidence there is, and it is treated as
    // exactly that — a guess that keeps two sentences from colliding, not a
    // claim that anything was heard.
    return (
      call.turnSettledAt !== undefined &&
      Date.now() - call.turnSettledAt < this.replyDrainQuietMs()
    );
  }

  private turnHost(
    userId: string,
    call: LiveCall,
    turnId: string,
    timezone: string | undefined,
  ): VoiceAssistantHostV1 {
    // Every memory write this turn makes is grounded in the turn itself: its
    // durable admission time is the date the fact carries, its place in the
    // call orders it against every other write, and its id is the provenance.
    // A model cannot date a fact here, and it cannot cite a turn that was
    // never admitted.
    const source: VoiceMemorySourceTurnV1 = {
      id: turnId,
      ordinal: call.turnOrdinal ?? 1,
      callId: call.callId,
      sequence: call.sequence,
      at: call.turnAdmittedAt ?? new Date(call.startedAt).toISOString(),
      said: call.turnTranscript ?? "",
    };
    const write = (operations: VoiceMemoryOperationV1[]) =>
      this.memory().apply({
        operations,
        sources: [source],
        ...(timezone ? { timezone } : {}),
        now: this.now(),
      });
    return {
      remember: async ({ text, kind, replaces, until }) => {
        const sentence = text.trim().slice(0, VOICE_MEMORY_MAX_TEXT_CHARS_V1);
        if (!sentence) return "Refused: there was nothing to remember.";
        const secret = refuseMemorySecretV1(sentence);
        if (secret) return `Refused: ${secret.reason}`;
        const id = voiceMemoryTextKeyV1(sentence);
        const operations: VoiceMemoryOperationV1[] = [];
        if (replaces) {
          // A correction leaves one answer, not two: whatever it named is
          // dropped in the same write that adds its replacement.
          const record = await this.memory().read();
          for (const target of voiceMemoryCorrectionTargetsV1(
            record,
            replaces,
          )) {
            operations.push({
              kind: `${target.kind}/remove`,
              id: target.id,
              source: turnId,
            });
          }
        }
        // "Just for today" has to stop tomorrow. The horizon is named here
        // and dated by the applier from this turn's own time and the
        // person's zone — the same policy the end-of-call update goes
        // through, so a spoken one and a summarised one expire alike.
        operations.push(
          kind === "open"
            ? { kind: "ongoing/add", id, text: sentence, source: turnId }
            : kind === "temporary"
              ? {
                  kind: "recent/add",
                  text: sentence,
                  source: turnId,
                  until: until ?? "today",
                }
              : { kind: "durable/add", id, text: sentence, source: turnId },
        );
        const result = await write(operations);
        const kept =
          kind === "open"
            ? result.record.ongoing.some((entry) => entry.id === id)
            : kind === "temporary"
              ? result.record.recent.some((entry) => entry.text === sentence)
              : result.record.durable.some((entry) => entry.id === id);
        if (!kept) {
          return `Refused: ${result.skipped[0] ?? "that could not be kept"}.`;
        }
        this.traceMemory("memory-write", {
          call: call.callId,
          turn: turnId,
          kind,
          replaced: Boolean(replaces),
        });
        return kind === "temporary"
          ? "Kept for now. Acknowledge it plainly and follow it from here."
          : "Kept. Acknowledge it plainly and follow it from here.";
      },
      forget: async (text) => {
        const wanted = text.trim();
        if (!wanted) return "Nothing was named.";
        const record = await this.memory().read();
        const targets = matchVoiceMemoryV1(record, wanted);
        if (targets.length === 0) {
          return "There is nothing like that in what you remember. Say so.";
        }
        const result = await write(
          targets.map((target): VoiceMemoryOperationV1 =>
            target.kind === "durable"
              ? { kind: "durable/remove", id: target.id, source: turnId }
              : target.kind === "ongoing"
                ? { kind: "ongoing/remove", id: target.id, source: turnId }
                : { kind: "recent/remove", id: target.id, source: turnId },
          ),
        );
        const remaining = matchVoiceMemoryV1(result.record, wanted);
        if (remaining.length === targets.length) {
          return `Refused: ${result.skipped[0] ?? "that could not be dropped"}.`;
        }
        this.traceMemory("memory-forget", {
          call: call.callId,
          turn: turnId,
          dropped: targets.length - remaining.length,
        });
        return "Dropped. Acknowledge it plainly and do not do it any more.";
      },
      chat: (body, signal) => this.chatCompletion(body, signal),
      listBots: () => this.listBots(userId),
      botStatus: async (botId) => {
        const bot = await this.ownedBot(userId, botId);
        const runs = await this.recentRuns(userId, botId);
        return renderVoiceBotStatusV1({
          botId,
          botName: bot.name,
          runs,
        });
      },
      readBotHistory: async (botId, limit) => {
        const bot = await this.ownedBot(userId, botId);
        const page = await this.botDoor(userId, botId).listRuns();
        const runs = page.runs.slice(
          -Math.max(1, Math.min(limit, VOICE_HISTORY_MAX_LIMIT_V1)),
        );
        return {
          botId,
          botName: bot.name,
          runs,
          hasMore: page.page.truncated || page.runs.length > runs.length,
        };
      },
      searchBotHistory: async (botId, query, limit) => {
        const bot = await this.ownedBot(userId, botId);
        const results = rpcJsonSnapshotV1(
          await this.userRpc(userId).searchTranscripts({
            schemaVersion: 1,
            userId,
            query: {
              schemaVersion: 1,
              query,
              botId,
              kinds: ["user", "assistant"],
            },
          }),
        ) as SearchIndexResultsV1;
        const runIds = [
          ...new Set(
            results.hits
              .filter((hit) => hit.botId === botId)
              .map((hit) => hit.runId),
          ),
        ].slice(0, Math.min(limit, VOICE_HISTORY_MAX_LIMIT_V1));
        const lookups = await Promise.all(
          runIds.map((runId) =>
            this.botDoor(userId, botId).lookupRun({ schemaVersion: 1, runId }),
          ),
        );
        return {
          botId,
          botName: bot.name,
          results,
          runs: lookups.flatMap((lookup) =>
            lookup.state === "not-admitted" ? [] : [lookup.run],
          ),
        };
      },
      askBot: async (botId, message) => {
        // Both reads go out together: the directory says the Bot is the
        // person's, its own object says what it is doing, and the sentence the
        // model speaks has to be true about both.
        const [bot, busy] = await Promise.all([
          this.ownedBot(userId, botId),
          this.botIsBusy(userId, botId),
        ]);
        const admission = await this.ledger().admitDelegation({
          turnId,
          botId,
          botName: bot.name,
          text: message,
          at: this.now(),
        });
        if (admission.status === "refused")
          return `Refused: ${admission.reason}`;
        if (admission.status === "duplicate") {
          this.sendDelegationState(botId, bot.name, "asked");
          return `${bot.name} was already asked this; its answer will be read out when it settles.`;
        }
        this.sendDelegationState(botId, bot.name, "asked");
        this.dispatchDelegation(userId, admission.delegation);
        await this.scheduleDelegationCheck(admission.delegation.runId, 0);
        // Never a blanket "working". A Bot that is mid-Turn queues this behind
        // what it is already doing, and saying otherwise would be a claim the
        // person could watch turn out to be false.
        return busy
          ? `Asked ${bot.name}. It is busy with something else right now, so this is queued behind it; you will hear the answer when it gets to it.`
          : `Asked ${bot.name}. It is working on it in its own conversation; you will hear the answer when it settles.`;
      },
      cancelBot: async (botId) => {
        const bot = await this.ownedBot(userId, botId);
        const runs = await this.recentRuns(userId, botId);
        const running = runs.find((run) => run.status === "running");
        if (!running) return `${bot.name} is not running anything.`;
        const receipt = await this.botDoor(userId, botId).stopRun({
          schemaVersion: 1,
          action: "stop",
          commandId: `voice-stop-${turnId}-${running.runId}`,
          runId: running.runId,
        });
        void receipt;
        return `Asked ${bot.name} to stop.`;
      },
      // ADR 0029: the conversation is handed to another Bot. The record is
      // written before the live call moves, so an eviction between the two
      // leaves the call on the Bot the person was last told they had — and
      // the client is told too, because the screen follows the voice.
      switchBot: async (botId) => {
        const target = botId.trim();
        if (!target || target === call.botId) {
          return {
            status: "refused",
            message: "You are already the one talking to them.",
          };
        }
        let bot: { botId: string; name: string };
        try {
          bot = await this.ownedBot(userId, target);
        } catch {
          return {
            status: "refused",
            message: `There is no Bot called ${target} on this account.`,
          };
        }
        const retargeted = await this.ledger().retargetCall(
          call.connectionId,
          bot.botId,
          this.now(),
        );
        if (!retargeted) {
          return {
            status: "refused",
            message: "This call is no longer the live one, so it cannot move.",
          };
        }
        call.botId = bot.botId;
        call.botName = bot.name;
        // The Bot's own context is what the next turn wears, so it is read
        // now rather than left to the next turn's critical path.
        call.promptContext = this.buildPromptContext(userId, bot.botId);
        const connection = this.connectionFor(call.connectionId);
        if (connection) {
          this.sendTarget(connection, bot.botId);
          this.trace(connection, "call-switched", { bot: bot.botId });
        }
        return {
          status: "switched",
          botId: bot.botId,
          name: bot.name,
          message: `Handed over. You are ${bot.name} from here, speaking in your own voice; say so in your reply.`,
        };
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
   * Admits the Bot Turn on the agent lane, under the return address this
   * request was admitted with.
   *
   * Detached from the spoken turn on purpose: the Bot's door answers only when
   * the Turn settles, which may be minutes, and the voice pipeline must not
   * wait. The lane is what keeps a person mid-conversation with that Bot, or a
   * Routine it is running, from being interrupted — a voice request queues
   * behind them and never supersedes.
   *
   * Three things carry the answer back, and none of them is load-bearing on
   * its own: the Bot's own durable outbox wakes this object the moment the
   * answer is recorded, this call settling here checks immediately (which is
   * what makes a failure prompt rather than a poll away), and the scheduled
   * look-up below recovers whatever both of those lost.
   */
  protected dispatchDelegation(
    userId: string,
    delegation: VoiceDelegationRecordV1,
  ): void {
    const door = this.botDoor(userId, delegation.botId);
    void this.ledger().noteDelegationDispatch(delegation.runId, this.now());
    const run = door
      .runVoice({
        runId: delegation.runId,
        sessionId: `${userId}:${delegation.botId}`,
        acceptedAt: delegation.admittedAt,
        text: delegation.text,
        source: {
          kind: "voice",
          callId: delegation.callId,
          voiceTurnId: delegation.turnId,
          requestId: delegation.runId,
        },
      })
      .then(
        () => this.checkDelegation({ runId: delegation.runId }),
        () => this.checkDelegation({ runId: delegation.runId }),
      )
      .catch(() => undefined);
    this.ctx.waitUntil(run);
  }

  /**
   * Books the next look-up.
   *
   * `dedupe` is the whole of the difference between the two callers, and it is
   * not a preference. An idempotent insert matches on callback and payload
   * alone, so a reschedule made from *inside* `checkDelegation` dedups onto the
   * very row the scheduler is executing — and then deletes it. The chain stops
   * after one attempt, the ledger keeps `attempts: 1` for ever, and the answer
   * is never read out. Every reschedule from the callback books a fresh row.
   *
   * Waking the object is the other case: `onStart` re-books every pending
   * delegation from the ledger with nothing executing, and there an idempotent
   * insert is what keeps a cold start from stacking a row per wake.
   */
  /**
   * Whether the Bot has a Turn running right now, read from its own object.
   *
   * A read, never a claim: a Bot that cannot be reached is reported as not
   * busy, because the acknowledgement then falls back to the ordinary wording
   * and the transcript still shows the truth.
   */
  private async botIsBusy(userId: string, botId: string): Promise<boolean> {
    try {
      const runs = await this.recentRuns(userId, botId);
      return runs.some((run) => run.status === "running");
    } catch {
      return false;
    }
  }

  /**
   * The ledger as the operator sees it on `/api/debug/voice`. A read of
   * storage and nothing else: no call is ended and no delegation is checked or
   * expired. The object waking to answer it runs its ordinary `onStart`
   * recovery, which is the same thing any request does.
   */
  async debugSnapshot(): Promise<VoiceAssistantDebugSnapshotV1> {
    const ledger = await this.ledger().debugSnapshot();
    const memoryJobs = await this.memory().jobs();
    return {
      ...ledger,
      capturedAt: new Date(this.now()).toISOString(),
      memoryJobs,
    };
  }

  /**
   * The Bot saying an answer is recorded. Its own durable outbox drains into
   * this, so the wake-up costs one round trip from the settling transaction
   * rather than a poll interval. It does exactly what the scheduled look-up
   * does — reads the authoritative run record and settles the request against
   * it — so a duplicate delivery, or one that races the poll, is a no-op.
   */
  async deliverVoiceReply(input: unknown): Promise<{ status: "accepted" }> {
    const request = decodeVoiceReplyDeliveryV1(input);
    if (request.userId !== this.name) {
      throw new Error("not this account's voice object");
    }
    await this.checkDelegation({ runId: request.requestId });
    return { status: "accepted" };
  }

  private async scheduleDelegationCheck(
    runId: string,
    attempts: number,
    dedupe = false,
  ) {
    const seconds = Math.min(
      DELEGATION_MAX_CHECK_SECONDS,
      DELEGATION_FIRST_CHECK_SECONDS * 2 ** Math.min(attempts, 8),
    );
    await this.schedule<DelegationCheckPayload>(
      seconds,
      "checkDelegation",
      { runId },
      { idempotent: dedupe },
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
        await this.announceDelegation({ runId: delegation.runId });
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
    // Only a reply addressed to voice answers this request.
    const answered = voiceReplyTextOfRunV1(run);
    const settled = await ledger.settleDelegation(
      delegation.runId,
      answered
        ? { answer: answered }
        : outcome?.type === "completed"
          ? { failure: "the Bot finished without answering the voice request" }
          : run.status === "cancelled" || run.status === "superseded"
            ? { cancelled: true }
            : { failure: outcome ? outcome.message : run.status },
      this.now(),
    );
    if (!settled || settled.state !== "settled") return;
    await this.announceDelegation({ runId: settled.runId });
  }

  /**
   * A settled answer, handed to the assistant on the call it was asked on.
   *
   * Unless something is still being said — then it waits and this runs again
   * once the call is quiet, so an answer never talks over a reply. With no
   * live call, or a different one, the answer is dropped: the call that
   * asked is over, and the next call is a fresh conversation. The Bot's
   * answer is still in the Bot's own conversation for the person to read.
   * Public because the scheduler calls it by name.
   */
  async announceDelegation(payload: AnnounceDelegationPayload): Promise<void> {
    const { runId } = payload;
    if (this.#announcing.has(runId)) return;
    this.#announcing.add(runId);
    try {
      const ledger = this.ledger();
      const delegation = await ledger.readDelegation(runId);
      if (!delegation || delegation.state !== "settled") return;
      const current = await ledger.currentCall();
      if (!current || current.callId !== delegation.callId) {
        // The call that asked is over — or was never ended cleanly and a
        // newer one has taken its place. Either way this answer has no call.
        await ledger.dropDelegation(runId);
        const other = this.liveCall();
        if (other) {
          this.trace(other.connection, "answer-dropped", {
            run: runId,
            reason: "another-call",
          });
        }
        return;
      }
      const live = this.liveCall();
      if (!live || live.call.callId !== delegation.callId) {
        // The call is on record but its socket is away: a network change,
        // inside the rejoin window. The answer waits for the person to come
        // back to this same conversation; if nobody does, the abandoned-call
        // alarm ends the call and cancels this with it.
        await this.scheduleAnnounce(runId);
        return;
      }
      if (this.replyInFlight(live.call)) {
        this.trace(live.connection, "delegation-held", {
          reason: this.speakerPlaying(live.call)
            ? "speaker-playing"
            : "reply-in-flight",
        });
        // A fresh row every hold, never `idempotent`: an idempotent insert
        // matches on callback and payload alone, so a re-hold from inside
        // this very wake-up would dedup onto the row being executed, which
        // the scheduler then deletes — and the answer would never be told.
        // This method re-reads the record and returns unless it is still
        // `settled`, so an extra row is a harmless no-op.
        await this.scheduleAnnounce(runId);
        return;
      }
      await this.tellAssistant(live.connection, live.call, delegation);
    } finally {
      this.#announcing.delete(runId);
    }
  }

  /**
   * Books the next attempt to tell the assistant. A fresh row every time,
   * never `idempotent`: from inside the callback an idempotent insert would
   * dedup onto the executing row, which the scheduler then deletes. The
   * method re-reads the record and stops once it is no longer `settled`, so
   * an extra row is a harmless no-op and a cancelled answer ends the chain.
   */
  private async scheduleAnnounce(runId: string): Promise<void> {
    await this.schedule<AnnounceDelegationPayload>(
      Math.max(1, Math.ceil(this.replyDrainQuietMs() / 1000)),
      "announceDelegation",
      { runId },
      { idempotent: false },
    );
  }

  /** The connection holding the live call, when one is here. */
  private liveCall(): { connection: Connection; call: LiveCall } | undefined {
    for (const [connectionId, call] of this.#calls) {
      for (const connection of this.getConnections()) {
        if (connection.id === connectionId) return { connection, call };
      }
    }
    return undefined;
  }

  /**
   * The request an answer is placed under, in the person's own words.
   *
   * A delegation records the assistant's paraphrase to the Bot ("Tim is asking
   * what the weather is. Please check…"), which is the right thing to hand a
   * Bot and the wrong thing to read back to the person who said "can you ask
   * Bob what the weather is?". The spoken turn keeps their words for as long
   * as the delegation is kept, so the paraphrase is only the fallback.
   *
   * When one turn asked several Bots, each answer is placed under the whole
   * sentence the person said, and the Bot's name says which request it answers.
   */
  private async delegationQuestion(
    ledger: VoiceLedgerV1,
    delegation: VoiceDelegationRecordV1,
  ): Promise<string> {
    const turn = await ledger
      .readTurn(delegation.turnId)
      .catch(() => undefined);
    return turn?.transcript.trim() || delegation.text;
  }

  /**
   * A Bot's answer, told to the assistant as one turn of the call.
   *
   * The same turn a person's utterance is — admitted and metered in the
   * ledger, the call's own history and memory in front of the model — with
   * the Bot's answer in the person's seat, marked as what it is. The
   * assistant decides what to say, and may say nothing. No bridge
   * fills the silence, because nobody asked a question just now. What it
   * says is spoken once it is whole; a person who starts talking meanwhile
   * aborts it, and their turn takes the floor.
   */
  private async tellAssistant(
    connection: Connection,
    call: LiveCall,
    delegation: VoiceDelegationRecordV1,
  ): Promise<void> {
    const identity = this.identity(connection);
    if (!identity) return;
    // The floor is claimed before the first await. Everything that decides
    // whether now is a quiet moment reads this, and a claim made after the
    // ledger reads would be judged against a call that has already moved on:
    // a second answer, or the person's own turn, would have walked in.
    const controller = new AbortController();
    call.announcing = controller;
    const release = () => {
      if (call.announcing === controller) call.announcing = undefined;
    };
    try {
      const ledger = this.ledger();
      const transcript = renderVoiceBotAnswerEventV1({
        botName: delegation.botName,
        question: await this.delegationQuestion(ledger, delegation),
        ...(delegation.answer ? { answer: delegation.answer } : {}),
        ...(delegation.failure ? { failure: delegation.failure } : {}),
      });
      const admitted = await ledger.admitTurn({
        connectionId: connection.id,
        transcript,
        at: this.now(),
        event: {
          kind: "bot-answer",
          botId: delegation.botId,
          botName: delegation.botName,
          runId: delegation.runId,
        },
      });
      if (admitted.status === "refused") {
        // The day's turns are spent. The answer is in the Bot's conversation.
        await ledger.dropDelegation(delegation.runId);
        this.trace(connection, "answer-dropped", {
          run: delegation.runId,
          reason: "quota",
        });
        this.sendDelegationState(
          delegation.botId,
          delegation.botName,
          "finished",
        );
        return;
      }
      const turnId = admitted.turn.turnId;
      // Told once: the event turn is durable before the model is asked, so an
      // eviction in between leaves a turn the history shows and no second one.
      // The mark comes before any abort check, so a person who takes the floor
      // in this window leaves one event turn and never a second admission.
      if (
        !(await ledger.markDelegationSpoken(
          delegation.runId,
          turnId,
          this.now(),
        ))
      ) {
        // The call ended between the admission and the mark, so the delegation
        // was cancelled with it. The turn is settled rather than left admitted
        // and metered against a call nobody is on.
        await ledger.settleTurn(turnId, { failure: "the call ended" });
        this.sendDelegationState(
          delegation.botId,
          delegation.botName,
          "finished",
        );
        return;
      }
      if (controller.signal.aborted) {
        await ledger.settleTurn(turnId, { failure: "aborted" });
        this.sendDelegationState(
          delegation.botId,
          delegation.botName,
          "finished",
        );
        return;
      }
      const generation = call.speechGeneration;
      const startedAt = Date.now();
      call.turnId = turnId;
      call.turnAdmittedAt = admitted.turn.admittedAt;
      call.turnTranscript = transcript;
      call.turnOrdinal = voiceTurnOrdinalV1(turnId);
      call.turnStartedAt = startedAt;
      call.turnSettledAt = undefined;
      this.sendDelegationState(
        delegation.botId,
        delegation.botName,
        "answering",
      );
      this.trace(connection, "turn", {
        turn: turnId,
        event: "bot-answer",
        run: delegation.runId,
        chars: transcript.length,
        model: this.voiceModel() ?? "auto",
      });
      const system = call.promptContext.then(async (promptContext) => {
        const rendered = renderVoiceSystemPromptV1({
          ...promptContext,
          session: await this.sessionMemoryContext(),
          now: this.now(),
        });
        call.lastSystem = rendered;
        return rendered;
      });
      const history = await this.callHistory(call.callId, turnId);
      const host = this.turnHost(
        identity.userId,
        call,
        turnId,
        (await call.promptContext).timezone,
      );
      let settlement: { answer: string } | { failure: string } = {
        failure: "no settlement",
      };
      let text = "";
      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
        controller.abort();
      }, this.botAnswerDeadlineMs());
      try {
        for await (const chunk of runVoiceTurnV1(
          host,
          {
            system,
            history,
            transcript,
            signal: controller.signal,
            botId: call.botId,
            acknowledge: false,
            tools: false,
          },
          (result) => {
            // Nothing said is a decision here, not a failure: the assistant
            // judged the answer not worth interrupting for.
            settlement =
              result.outcome === "aborted"
                ? { failure: "aborted" }
                : { answer: result.answer };
          },
        )) {
          if (chunk.kind === "text") text += chunk.text;
        }
      } catch (error) {
        settlement = {
          failure: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(deadline);
        if (expired) settlement = { failure: "timeout" };
        if (call.turnId === turnId) call.turnSettledAt = Date.now();
        release();
        await ledger.settleTurn(turnId, settlement);
      }
      const spoken = text.trim();
      this.trace(connection, "turn-settled", {
        turn: turnId,
        event: "bot-answer",
        ms: Date.now() - startedAt,
        ...("failure" in settlement
          ? { failure: settlement.failure }
          : {
              outcome: spoken ? "answered" : "silent",
              answerChars: spoken.length,
            }),
      });
      this.sendDelegationState(
        delegation.botId,
        delegation.botName,
        "finished",
      );
      if (
        !spoken ||
        controller.signal.aborted ||
        this.#calls.get(connection.id) !== call ||
        call.speechGeneration !== generation
      ) {
        return;
      }
      try {
        await this.speak(connection, spoken);
      } catch {
        // The audio never left; the words are on record in the turn. The
        // person can ask, and the Bot's conversation has the answer.
        this.trace(connection, "answer-unspoken", { turn: turnId });
      }
    } finally {
      release();
    }
  }

  private sendDelegationState(
    botId: string,
    botName: string,
    state: "asked" | "answering" | "finished",
  ): void {
    for (const connection of this.getConnections()) {
      this.send(connection, {
        schemaVersion: 1,
        type: "voice/delegation",
        botId,
        botName,
        state,
      });
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
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      searchTranscripts(input: unknown): Promise<SearchIndexResultsV1>;
    };
  }

  private botDoor(userId: string, botId: string) {
    const stub = this.env.BOT_STATES.get(
      this.env.BOT_STATES.idFromName(`${userId}:${botId}`),
    );
    // SAFETY: the binding names BotState; these are its reviewed RPC doors.
    const rpc = stub as unknown as {
      runVoice(input: unknown): Promise<unknown>;
      lookupRun(input: unknown): Promise<unknown>;
      listRuns(input: unknown): Promise<unknown>;
      stopRun(input: unknown): Promise<unknown>;
      readConfiguration(input: unknown): Promise<unknown>;
    };
    return {
      readConfiguration: async () =>
        rpcJsonSnapshotV1(
          await rpc.readConfiguration({ schemaVersion: 1, userId, botId }),
        ) as BotSettingsViewV1,
      runVoice: (command: {
        runId: string;
        sessionId: string;
        acceptedAt: string;
        text: string;
        source: {
          kind: "voice";
          callId: string;
          voiceTurnId: string;
          requestId: string;
        };
      }) => rpc.runVoice({ schemaVersion: 1, userId, botId, command }),
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
        ) as { runs: ClientRunV1[]; page: { truncated: boolean } },
      stopRun: (command: {
        schemaVersion: 1;
        action: "stop";
        commandId: string;
        runId: string;
      }) => rpc.stopRun({ schemaVersion: 1, userId, botId, command }),
    };
  }

  private async directory(userId: string) {
    return decodeDirectoryViewV1(
      rpcJsonSnapshotV1(
        await this.userRpc(userId).listBots({ schemaVersion: 1, userId }),
      ),
    );
  }

  /**
   * What a Bot is called *now*. The registration seed in the User object is
   * immutable, so a Bot the person has since renamed or re-described would be
   * announced under a name they no longer use. Its own object owns the
   * editable profile, and that is what the assistant speaks and prompts with.
   * An unreadable profile is a failed read, never permission to revive stale
   * identity from the seed.
   */
  private async botIdentity(
    userId: string,
    botId: string,
  ): Promise<{ botId: string; name: string; description?: string }> {
    const { profile } = await this.botDoor(userId, botId).readConfiguration();
    return {
      botId,
      name: profile.name,
      ...(profile.description ? { description: profile.description } : {}),
    };
  }

  /**
   * Every Bot, as it is named today, with what it is doing now. The identity
   * and activity look-ups go to each Bot's own object, so they go out
   * together: a person with a dozen Bots waits one round trip, not twelve,
   * before the first turn can start.
   */
  protected async listBots(userId: string): Promise<VoiceBotSummaryV1[]> {
    const directory = await this.directory(userId);
    return Promise.all(
      directory.bots.map(async (bot): Promise<VoiceBotSummaryV1> => {
        const [identity, activity] = await Promise.all([
          this.botIdentity(userId, bot.botId),
          (async (): Promise<VoiceBotSummaryV1["activity"]> => {
            try {
              const runs = await this.recentRuns(userId, bot.botId);
              return runs.some((run) => run.status === "running")
                ? "working"
                : "idle";
            } catch {
              return undefined;
            }
          })(),
        ]);
        return {
          ...identity,
          ...(activity ? { activity } : {}),
        };
      }),
    );
  }

  /**
   * The account's directory is the authority on membership; the Bot's own
   * object is the authority on what it is called.
   */
  private async ownedBot(userId: string, botId: string) {
    const directory = await this.directory(userId);
    const bot = directory.bots.find((entry) => entry.botId === botId);
    if (!bot) throw new Error("that Bot is not in this account");
    return this.botIdentity(userId, botId);
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

  /**
   * What this call opens with: the session's memory, aged for today, plus the
   * tail of a previous call whose summary has not landed yet.
   *
   * The pruning here is a *view*: expired handover lines are not shown and
   * are dropped from the record on the next write. A read never renews
   * anything, and a record that cannot be read says so rather than letting
   * the assistant promise to remember.
   */
  private async sessionMemoryContext(): Promise<{
    record: VoiceMemoryRecordV1;
    carried: VoiceMemorySourceTurnV1[];
    writable: boolean;
  }> {
    try {
      const memory = this.memory();
      const record = pruneVoiceMemoryV1(await memory.read(), this.now());
      return {
        record,
        carried: await memory.carriedContinuity(this.memorySource()),
        writable: true,
      };
    } catch (error) {
      this.traceMemory(
        "memory-unreadable",
        { message: error instanceof Error ? error.message : String(error) },
        "warn",
      );
      return {
        record: emptyVoiceMemoryRecordV1(),
        carried: [],
        writable: false,
      };
    }
  }

  /**
   * The person's own zone. The call reads it for its clock, and the
   * end-of-call memory work reads it again to date anything they asked for
   * "just for today" — the call is over by then, so it cannot be borrowed
   * from a live one.
   */
  private async userTimezone(userId: string): Promise<string> {
    return this.userRpc(userId)
      .readConfiguration({ schemaVersion: 1, userId })
      .then((settings) => userTimezoneV1(rpcJsonSnapshotV1(settings).profile))
      .catch(() => "UTC");
  }

  /**
   * Everything the prompt needs that does not change within a turn.
   *
   * Built once when a call is admitted and again when `switch_bot` moves it,
   * because the Bot half of it — who is speaking, their memory, their recent
   * thread — is exactly what a switch replaces. All of it is read in
   * parallel: this sits on the path between the person finishing a sentence
   * and the first sound back.
   */
  private async buildPromptContext(
    userId: string,
    botId?: string,
  ): Promise<Omit<VoiceAssistantPromptInputV1, "now">> {
    const [bots, memory, timezone, session, bot] = await Promise.all([
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
            documents: [],
            logTotal: 0,
            unavailable: error instanceof Error ? error.message : String(error),
          };
        }
      })(),
      this.userTimezone(userId),
      this.sessionMemoryContext(),
      this.buildCurrentBotContext(userId, botId),
    ]);
    return {
      bots,
      timezone,
      session,
      ...(bot ? { bot } : {}),
      memory: {
        ...(memory ? { user: memory } : {}),
        logDays: VOICE_ASSISTANT_MEMORY_LOG_DAYS,
      },
    };
  }

  /**
   * The Bot the call is wearing (ADR 0029): who it is, what it remembers and
   * what was last said to it.
   *
   * Every part is best-effort. A memory store that is down or a thread that
   * cannot be read must not stop the person being answered — the prompt is
   * simply thinner, and the model has tools to fetch what it is missing.
   */
  private async buildCurrentBotContext(
    userId: string,
    botId: string | undefined,
  ): Promise<VoiceCurrentBotV1 | undefined> {
    if (!botId) return undefined;
    let bot: { botId: string; name: string; description?: string };
    try {
      bot = await this.ownedBot(userId, botId);
    } catch {
      // The Bot was deleted, or never belonged to this User. The call keeps
      // going as the account-wide assistant rather than failing.
      return undefined;
    }
    const [memory, thread, directory] = await Promise.all([
      (async () => {
        const store = this.memoryStore(userId);
        if (!store) return undefined;
        try {
          return await store.read(botMemoryRootV1({ userId, botId }));
        } catch {
          return undefined;
        }
      })(),
      (async () => {
        try {
          const page = await this.botDoor(userId, botId).listRuns();
          const runs = page.runs.slice(-VOICE_HISTORY_DEFAULT_LIMIT_V1);
          return {
            botId,
            botName: bot.name,
            runs,
            hasMore: page.page.truncated || page.runs.length > runs.length,
          };
        } catch {
          return undefined;
        }
      })(),
      // The directory is already being read for the prompt's `<bots>` list;
      // this takes the live activity for the current Bot out of the same
      // answer rather than asking its object again.
      this.listBots(userId).catch(() => [] as VoiceBotSummaryV1[]),
    ]);
    const activity = directory.find((row) => row.botId === botId)?.activity;
    return {
      botId: bot.botId,
      name: bot.name,
      ...(bot.description ? { description: bot.description } : {}),
      ...(activity ? { activity } : {}),
      ...(memory ? { memory } : {}),
      ...(thread ? { thread } : {}),
    };
  }
}
