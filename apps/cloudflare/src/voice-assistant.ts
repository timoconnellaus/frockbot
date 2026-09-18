// The account-wide voice session: one Durable Object per User.
//
// Since ADR 0031 a call is one Gemini Live session and nothing else. The
// phone's PCM goes up as `realtimeInput`, the model's own audio comes back
// down the same socket, and the model calls our functions while it carries on
// talking. This object is the bridge and the bookkeeper — who may connect,
// what costs money, what a Bot was asked to do — and it records each of those
// in the ledger before anything external runs.
//
// The client wire did not change with the model behind it: everything the
// Cloudflare voice SDK used to write is written here instead, frame for frame
// as `docs/voice.md` "Assistant protocol (v1)" describes it.
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
  parseChatCompletionStreamV1,
  renderVoiceSubagentResultV1,
  renderVoiceSystemPromptV1,
  runVoiceToolV1,
  voiceToolResponseV1,
  VOICE_ACCOUNT_FUNCTION_DECLARATIONS_V1,
  VOICE_FUNCTION_DECLARATIONS_V1,
  VOICE_PROMPT_HISTORY_MESSAGES_V1,
  type VoiceAssistantHostV1,
  type VoiceAssistantPromptInputV1,
  type VoiceBotSummaryV1,
  type VoiceCurrentBotV1,
} from "@frockbot/app/voice/assistant";
import {
  voiceTimingForV1,
  type VoiceTimingV1,
} from "@frockbot/app/voice/diagnostics";
import {
  buildGeminiLiveSetupV1,
  decodeGeminiServerFrameV1,
  encodeGeminiAudioFrameV1,
  encodeGeminiTextTurnV1,
  encodeGeminiToolResponseV1,
  geminiLiveUrlV1,
  GEMINI_LIVE_ENDPOINT_V1,
  GEMINI_LIVE_UNKNOWN_HANDLE_CLOSE_V1,
  type GeminiFunctionCallV1,
  type GeminiServerEventV1,
} from "@frockbot/app/voice/gemini-live";
import {
  resolveBotVoiceV1,
  type BotVoiceAppearanceV1,
} from "@frockbot/app/voice/appearance";
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
import {
  decodeVoiceAssistantClientMessageV1,
  VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1,
  VOICE_ASSISTANT_METER_BLOCK_SECONDS_V1,
  VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1,
  VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1,
  VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1,
  VOICE_DICTATION_LEASE_RENEW_MS_V1,
  VOICE_DICTATION_RESERVE_SECONDS_V1,
  type VoiceAssistantClientMessageV1,
  type VoiceAssistantRefusalCodeV1,
  type VoiceAssistantServerMessageV1,
  type VoiceAssistantStatusV1,
  type VoiceAssistantUpstreamStateV1,
} from "@frockbot/app/voice/shared";
import { MemoryStore } from "@frockbot/app/memory/store";
import {
  botMemoryRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
  isMemoryProjectIdV1,
} from "@frockbot/app/memory/roots";
import {
  decodeDirectoryViewV1,
  decodeFlockBootstrapViewV1,
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
import {
  userTimezoneV1,
  type BotSettingsViewV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";

export const VOICE_ASSISTANT_INTERNAL_PATH = "/internal/voice-assistant/v1";

interface DictationLeaseRequest {
  userId: string;
  action: "acquire" | "renew" | "release" | "cleanup";
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
      value.action !== "release" &&
      value.action !== "cleanup")
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

/** How far back the User Memory log is read at call start. */
export const VOICE_ASSISTANT_MEMORY_LOG_DAYS = 30;
/**
 * How long a model turn may produce no audio before the person is told.
 *
 * A turn that says nothing at all — a refused key, a session that accepted the
 * setup and then broke — used to be invisible: the call looked live and simply
 * never spoke. This is the guard the ElevenLabs TTS wrapper used to be, moved
 * to the one place that can still see it.
 */
const MODEL_SILENCE_TIMEOUT_MS = 8_000;
/** Audio held while a session is opening, and replayed in order: 10 s at 16 kHz. */
const PENDING_AUDIO_BYTES = 10 * 16_000 * 2;
/** How long a delegation look-up waits before the first check, and its ceiling. */
const DELEGATION_FIRST_CHECK_SECONDS = 8;
const DELEGATION_MAX_CHECK_SECONDS = 5 * 60;
/** How long a settled answer waits for the session to be there to tell it to. */
const ANSWER_RETRY_SECONDS = 5;

export interface VoiceAssistantEnv {
  AI?: Ai;
  OPENAI_API_KEY?: string;
  /** The Live session's key. Without it there is no voice session at all. */
  GEMINI_API_KEY?: string;
  /**
   * A stand-in Live endpoint, for tests only. Production never sets it, and
   * `production-secrets.ts` refuses a deployment that does.
   */
  VOICE_ASSISTANT_UPSTREAM_URL?: string;
  /**
   * A gateway model for the end-of-call memory update, e.g.
   * `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`; unset, it takes the
   * platform's Auto route. The call itself never goes near a chat model.
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

/**
 * True when the deployment can run the assistant at all.
 *
 * One key now: the session is the model, the ears and the mouth. The `AI`
 * binding is still wanted for the end-of-call memory update, but a deployment
 * without it can hold a conversation, so it does not gate the control.
 */
export function voiceAssistantConfiguredV1(env: {
  GEMINI_API_KEY?: string;
  VOICE_ASSISTANT_UPSTREAM_URL?: string;
}): boolean {
  return Boolean(
    env.GEMINI_API_KEY?.trim() || env.VOICE_ASSISTANT_UPSTREAM_URL?.trim(),
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
   * `switch_bot` moves all of it and the durable record together.
   */
  botId: string;
  botName: string;
  /** How this Bot sounds: the session's voice name and its delivery prose. */
  voice: BotVoiceAppearanceV1;
  /** When the call was admitted, so every later line can say how far in. */
  startedAt: number;
  /**
   * The call's place in the account's session order, as epoch milliseconds of
   * its durable start. Memory written by an older call can never overwrite a
   * newer one's correction, and this is what says which is which.
   */
  sequence: number;
  promptContext: Promise<Omit<VoiceAssistantPromptInputV1, "now">>;
  session?: GeminiSessionV1;
  /**
   * The newest resumption handle the session was given. Sleep keeps it, and
   * wake offers it back; a handle the server has forgotten closes the socket
   * with 1008, which is when the call reopens fresh with a handover instead.
   */
  resumptionHandle?: string;
  muted: boolean;
  /** The day's audio allowance ran out; the session stays shut. */
  exhausted: boolean;
  quotaSaid: boolean;
  /** What the client last saw, so a status frame is sent only on a change. */
  status: VoiceAssistantStatusV1;
  turnId?: string;
  /** The current turn's durable admission time: what a fact it produces is dated by. */
  turnAdmittedAt?: string;
  /** Its place in the call, from one: the other half of the ordering stamp. */
  turnOrdinal?: number;
  /** When the current turn began, so its lines can say how long it took. */
  turnStartedAt?: number;
  /** What the person said, as the session transcribes it. */
  transcript: string;
  /** What the model has said this turn, from its own output transcription. */
  answer: string;
  /** Audio bridged down this turn, so a turn that never spoke is on record. */
  turnAudioBytes: number;
  /** Fires when a turn has gone this long without a sound. */
  silenceTimer?: ReturnType<typeof setTimeout>;
  /** The guard already told the client about this turn. */
  silenceSaid: boolean;
  /**
   * The person talked over the reply and their client stopped its own player.
   * The model's VAD will notice in its own time; until it does, the rest of
   * this turn's audio is dropped rather than played into a moment that has
   * passed.
   */
  dropping: boolean;
  /**
   * The hand-over the model asked for, held until its turn ends (ADR 0031):
   * the model may say its sign-off before or after calling the tool, and
   * tearing the session down mid-turn would cut whichever came second.
   */
  pendingSwitch?: { botId: string; name: string };
  /**
   * Hand-offs admitted in the model's current turn, so the burst cap bites on
   * a model that calls `subagent` in a loop and not on a long conversation
   * that hands off now and then. Reset when the turn ends; the day's own cap
   * is the ledger's.
   */
  delegations: number;
  /** The newest run the host admitted, so its function call can be recorded. */
  lastDelegationRunId?: string;
  /**
   * The function call each subagent request came from, so its result goes
   * back as that call's own late response. In memory only: a session that has
   * gone cannot be answered, and the answer then waits for the ledger.
   */
  subagentCalls: Map<string, { id: string; name: string }>;
  /** Calls the model withdrew; their results are dropped rather than sent. */
  cancelledCalls: Set<string>;
  /** Bytes bridged but not yet written to the meter, each way. */
  meterInBytes: number;
  meterOutBytes: number;
  /** No audio from the client for this long and the server sleeps the session. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * The system message the call last actually sent. Kept here rather than
   * written per turn, and persisted once when the call ends, so the memory
   * request can repeat it without a storage write for every utterance.
   */
  lastSystem?: string;
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
 * One Gemini Live session, as the object drives it.
 *
 * It owns exactly one socket and the audio waiting for it to be ready. Every
 * decision — what the setup says, what to do with a frame, when to sleep —
 * belongs to the call above; this is the transport and the buffer.
 */
class GeminiSessionV1 {
  state: VoiceAssistantUpstreamStateV1 = "starting";
  private socket: WebSocket | undefined;
  private ready = false;
  private closedByUs = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Whether each of the two audio milestones has been said for this session. */
  private saidHeld = false;
  private saidSent = false;
  /**
   * Events are handled one at a time, in arrival order.
   *
   * Each handler awaits durable work — admitting a turn, settling it — and a
   * socket delivers the next frame while that is still running. Unchained, a
   * `turnComplete` could reach the object before the `audio` before it had
   * finished admitting the turn it is meant to close, and the turn would
   * never settle.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      url: string;
      setup: Record<string, unknown>;
      onEvent: (event: GeminiServerEventV1) => void | Promise<void>;
      onClosed: (code: number, reason: string) => void;
      open: (url: string) => Promise<WebSocket>;
      /**
       * Lifecycle milestones for an opt-in diagnostic trace, or absent —
       * which is every ordinary call. Never the url, which carries the key.
       */
      timing?: (event: string, fields?: Record<string, unknown>) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.options.timing?.("upstream-open-start");
    const socket = await this.options.open(this.options.url);
    this.options.timing?.("upstream-socket-open");
    if (this.closedByUs) {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
      return;
    }
    // Google sends binary JSON; Worker sockets otherwise deliver it as Blobs.
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      for (const decoded of decodeGeminiServerFrameV1(raw)) {
        if (decoded.kind === "setup-complete") {
          this.ready = true;
          this.state = "awake";
          this.options.timing?.("upstream-setup-ack");
          this.drain();
        }
        const event = decoded;
        this.chain = this.chain
          .then(() => this.options.onEvent(event))
          .catch(() => undefined);
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.state = "asleep";
      this.socket = undefined;
      if (!this.closedByUs) {
        this.options.onClosed(event.code, event.reason ?? "");
      }
    });
    socket.addEventListener("error", () => {
      if (this.closedByUs) return;
      this.state = "asleep";
      this.options.onClosed(1006, "the voice service connection failed");
    });
    this.send(this.options.setup);
    this.options.timing?.("upstream-setup-sent");
  }

  send(frame: Record<string, unknown>): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // A socket that has gone is handled by its own close event.
    }
  }

  /**
   * The person's microphone. Audio that arrives before `setupComplete` is
   * held in order and sent the moment the session is ready, so the first
   * syllable after a wake is not the one that goes missing.
   */
  sendAudio(pcm: Uint8Array): void {
    if (!this.ready) {
      // Held, not sent: the first frame the session actually puts on the wire
      // is reported below, and the gap between the two is the setup this
      // audio was waiting on. Said once per session, not once per frame.
      if (!this.saidHeld) {
        this.saidHeld = true;
        this.options.timing?.("upstream-audio-held");
      }
      this.pending.push(pcm);
      this.pendingBytes += pcm.byteLength;
      while (
        this.pendingBytes > PENDING_AUDIO_BYTES &&
        this.pending.length > 0
      ) {
        this.pendingBytes -= this.pending.shift()!.byteLength;
      }
      return;
    }
    this.sent(false);
    this.send(encodeGeminiAudioFrameV1(pcm));
  }

  /** The first frame this session put on the wire, and whether it waited. */
  private sent(buffered: boolean): void {
    if (this.saidSent) return;
    this.saidSent = true;
    this.options.timing?.("upstream-audio-sent", { buffered });
  }

  private drain(): void {
    const held = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (held.length > 0) this.sent(true);
    for (const chunk of held) this.send(encodeGeminiAudioFrameV1(chunk));
  }

  isOpen(): boolean {
    return this.ready && Boolean(this.socket);
  }

  close(): void {
    this.closedByUs = true;
    this.state = "asleep";
    this.ready = false;
    this.pending = [];
    this.pendingBytes = 0;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Says when one read of the prompt context finished, for a call that asked
 * for diagnostics.
 *
 * The promise is returned as it was given when nothing is listening, so an
 * ordinary call adds not even a `then`. When something is listening the extra
 * link is a microtask on a promise that was already being awaited in a
 * `Promise.all`: nothing is serialised, nothing is reordered, and a read that
 * fails still fails to exactly the same place.
 */
function timed<T>(
  timing:
    ((event: string, fields?: Record<string, unknown>) => void) | undefined,
  event: string,
  work: Promise<T>,
): Promise<T> {
  if (!timing) return work;
  const started = performance.now();
  const fields = () => ({
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  });
  return work.then(
    (value) => {
      timing(event, fields());
      return value;
    },
    (error: unknown) => {
      timing(event, { ...fields(), failed: true });
      throw error;
    },
  );
}

/** What a client may say, beside the custom `voice/*` messages. */
type VoiceClientFrameV1 =
  | { type: "hello" }
  | { type: "start_call" }
  | { type: "end_call" }
  | { type: "interrupt" }
  | { type: "text_message"; text: string };

/**
 * Sorts one JSON frame from a client. Unknown types answer undefined rather
 * than throwing: a client a release ahead may send something this object has
 * no opinion about, and that is not a reason to drop a call.
 */
function decodeVoiceClientFrameV1(
  value: Record<string, unknown>,
): VoiceClientFrameV1 | undefined {
  switch (value.type) {
    case "hello":
      return { type: "hello" };
    case "start_call":
      return { type: "start_call" };
    case "end_call":
      return { type: "end_call" };
    case "interrupt":
      return { type: "interrupt" };
    case "text_message":
      return typeof value.text === "string" && value.text.trim()
        ? { type: "text_message", text: value.text.trim() }
        : undefined;
    default:
      return undefined;
  }
}

// `Cloudflare.Env` is what a test harness augments with its own bindings;
// intersecting it keeps this class valid under both the Worker's and the
// suite's declarations.
export class VoiceAssistant extends Agent<Cloudflare.Env & VoiceAssistantEnv> {
  #calls = new Map<string, LiveCall>();
  /**
   * The Bot a socket asked for before its call was admitted (ADR 0029).
   *
   * The `start_call` frame carries only a preferred format, so the target
   * arrives as its own message just before it. Held per connection until the
   * call is admitted, then it lives in the call record.
   */
  #targets = new Map<string, string>();
  /**
   * Answers being handed to the session right now, by run id. Two signals for
   * one answer — the Bot's wake and the scheduled look-up — arrive together;
   * the second finds the first here and does nothing.
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
      /** Audio handed down this socket, so silence has a number. */
      audioChunks: number;
      audioBytes: number;
      turns: number;
    }
  >();

  /**
   * Latency diagnostics for the sockets that asked for them, by connection id.
   *
   * Ephemeral and separate from `#calls` on purpose: the correlation has to
   * exist from `onConnect`, which is long before a call record does, and every
   * milestone before `start_call` is admitted is exactly the part of a slow
   * call nothing else can see. Dropped in `onClose` with the connection, so a
   * reconnect is a new entry under whatever id that socket carried and an id
   * is never reused or persisted. Empty for every ordinary call.
   */
  #timings = new Map<string, VoiceTimingV1>();

  // -- seams a test subclass overrides ---------------------------------------

  /**
   * The Live endpoint, with this deployment's key on it.
   *
   * `VOICE_ASSISTANT_UPSTREAM_URL` points the session at a fake, which is what
   * the workerd suite drives: the object's own behaviour is the thing under
   * test, and Google answering is not.
   */
  protected geminiUrl(): string | undefined {
    const stand = this.env.VOICE_ASSISTANT_UPSTREAM_URL?.trim();
    if (stand)
      return geminiLiveUrlV1(this.env.GEMINI_API_KEY?.trim() ?? "", stand);
    const key = this.env.GEMINI_API_KEY?.trim();
    return key ? geminiLiveUrlV1(key, GEMINI_LIVE_ENDPOINT_V1) : undefined;
  }

  /** Opens the upstream socket. One seam, so a test can refuse or script it. */
  protected openGeminiSocket(url: string): Promise<WebSocket> {
    return fetchVoiceUpstreamSocketV1(url, {});
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
   * The model the end-of-call memory update is asked. The call itself has no
   * chat model any more, so this pins one request a call rather than every
   * turn of it.
   */
  protected voiceModel(): string | undefined {
    const pinned = this.env.VOICE_ASSISTANT_MODEL?.trim();
    return pinned ? pinned : undefined;
  }

  protected now(): Date {
    return new Date();
  }

  /** How long a silent turn is given before the client is told; a test shortens it. */
  protected modelSilenceTimeoutMs(): number {
    return MODEL_SILENCE_TIMEOUT_MS;
  }

  /** How long the server waits for audio before sleeping; a test shortens it. */
  protected serverIdleSleepMs(): number {
    return VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1;
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
      const turns = await this.ledger().turnsForCall(callId);
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

  private identity(connection: Connection): ConnectionIdentity | undefined {
    const state = connection.state as ConnectionIdentity | null;
    return state && typeof state.userId === "string" ? state : undefined;
  }

  /**
   * One line per step of a call, as `wrangler tail` and Workers Logs show it.
   * Nothing else logs: a refusal reaches the client without a trace, and a
   * call that went nowhere would otherwise look, from every log, like a call
   * nobody made. Never the words spoken: lengths and ids only.
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
   * One milestone of a call that asked for diagnostics, and nothing at all
   * for one that did not.
   *
   * Separate from `trace`, which is the ordinary operational record every call
   * writes. These lines are opt-in, correlated with the client's own by the
   * `trace` the socket carried, and exist to say which step of a slow start
   * took the time. The same rule holds as for `trace`: ids, counts and enums,
   * never a word spoken and never a credential.
   *
   * Every elapsed millisecond here is the server's own clock from the moment
   * the socket connected. A client's are its own from the person's press; the
   * two sequences are read beside each other, never subtracted.
   */
  protected timing(
    connection: Connection,
    event: string,
    fields: Record<string, unknown> = {},
    once = false,
  ): void {
    const timing = this.#timings.get(connection.id);
    if (!timing) return;
    if (once) timing.markOnce(event, fields);
    else timing.mark(event, fields);
  }

  /**
   * The timing sink for one connection as a plain callback, or undefined —
   * what the prompt context and the upstream session take, so neither has to
   * know about connections or about diagnostics being off.
   */
  private timingSink(
    connection: Connection,
  ): ((event: string, fields?: Record<string, unknown>) => void) | undefined {
    if (!this.#timings.has(connection.id)) return undefined;
    return (event, fields) => this.timing(connection, event, fields ?? {});
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
    // The socket's own id, if it brought one this object recognises as a
    // UUID. Read only once identity has been accepted: a socket that is not
    // this account's is closed above and gets no diagnostics.
    const timing = voiceTimingForV1(new URL(context.request.url));
    if (timing) this.#timings.set(connection.id, timing);
    this.trace(connection, "connected");
    this.timing(connection, "connected", { device: deviceKey });
    // Protocol v1's opening: the client waits for both of these before it
    // says `hello`, and nothing about them depends on a call existing.
    this.sendRaw(connection, { type: "welcome", protocol_version: 1 });
    this.sendRaw(connection, { type: "status", status: "idle" });
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
    this.timing(connection, "closed", { code, wasClean });
    // A socket going is not the person hanging up. The session is closed and
    // its meter settled at once, but the call record stays: a client that
    // comes straight back from a network change continues this conversation
    // rather than starting a new one with nothing behind it. The alarm below
    // is what ends it, and hands it to memory, if nobody comes back.
    await this.releaseCallResources(connection.id);
    const current = await this.ledger().currentCall();
    if (current && current.connectionId === connection.id) {
      await this.scheduleCallAbandon(current.callId);
    }
    this.#traced.delete(connection.id);
    this.#targets.delete(connection.id);
    // The id goes with the socket: nothing about this call outlives it, and a
    // reconnect brings its own or none.
    this.#timings.delete(connection.id);
  }

  override async onMessage(
    connection: Connection,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") {
      await this.onClientAudio(connection, message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const custom = decodeVoiceAssistantClientMessageV1(parsed);
    if (custom) {
      await this.onCustomMessage(connection, custom);
      return;
    }
    const frame = decodeVoiceClientFrameV1(parsed as Record<string, unknown>);
    if (!frame) return;
    switch (frame.type) {
      case "hello":
        // Nothing to answer: the welcome went out on connect, and the call
        // starts on the frame after this one.
        return;
      case "start_call":
        await this.startCall(connection);
        return;
      case "end_call":
        await this.endCall(connection);
        return;
      case "interrupt": {
        const call = this.#calls.get(connection.id);
        if (!call) return;
        // The person talked over the reply. Their own player has already
        // stopped; the model's voice detector will reach the same conclusion
        // in its own time, and until it does this call drops what is left of
        // the turn rather than playing it into a moment that has passed.
        this.trace(connection, "interrupted", { source: "client" });
        call.dropping = true;
        this.setStatus(connection, call, "listening");
        return;
      }
      case "text_message": {
        const call = this.#calls.get(connection.id);
        if (!call?.session?.isOpen()) return;
        call.transcript = frame.text;
        call.session.send(encodeGeminiTextTurnV1(frame.text));
        return;
      }
    }
  }

  private async onCustomMessage(
    connection: Connection,
    custom: VoiceAssistantClientMessageV1,
  ): Promise<void> {
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
      const switched = await this.turnHost(
        identity.userId,
        live,
        `target-${crypto.randomUUID()}`,
        undefined,
      ).switchBot(custom.botId);
      // Asked on the screen rather than in words, so nothing is mid-sentence:
      // the session moves now instead of waiting for a turn to end.
      if (switched.status === "switched") {
        await this.applySwitch(connection, live);
      }
      return;
    }
    const call = this.#calls.get(connection.id);
    if (!call) return;
    switch (custom.type) {
      case "voice/sleep":
        await this.sleepSession(connection, call);
        break;
      case "voice/wake":
        if (!call.muted && !call.exhausted) {
          await this.wakeSession(connection, call);
        }
        break;
      case "voice/mute":
        call.muted = custom.muted;
        if (custom.muted) await this.sleepSession(connection, call);
        this.sendState(connection, call);
        break;
      case "voice/speech":
        // What the speaker is doing, as the device knows it. Since the model
        // runs its own barge-in there is nothing durable to decide here, and
        // the report is kept only for the trace.
        break;
    }
  }

  // -- frames ---------------------------------------------------------------

  /** One protocol-v1 frame. `send` below is for this object's own messages. */
  private sendRaw(connection: Connection, message: Record<string, unknown>) {
    try {
      connection.send(JSON.stringify(message));
    } catch {
      // A socket that is already gone is cleaned up by onClose.
    }
  }

  private send(connection: Connection, message: VoiceAssistantServerMessageV1) {
    this.sendRaw(connection, message as unknown as Record<string, unknown>);
  }

  private sendBinary(connection: Connection, audio: Uint8Array) {
    try {
      // A copy, not a view: a view over a larger buffer would put whatever
      // else is in that buffer on the wire.
      connection.send(
        audio.buffer.slice(
          audio.byteOffset,
          audio.byteOffset + audio.byteLength,
        ) as ArrayBuffer,
      );
    } catch {
      // A socket that is already gone is cleaned up by onClose.
    }
  }

  /** The pipeline status, sent only when it actually changes. */
  private setStatus(
    connection: Connection,
    call: LiveCall,
    status: VoiceAssistantStatusV1,
  ) {
    if (call.status === status) return;
    call.status = status;
    this.sendRaw(connection, { type: "status", status });
  }

  private refuse(
    connection: Connection,
    code: VoiceAssistantRefusalCodeV1,
    message: string,
  ) {
    this.trace(connection, "refused", { code, message });
    // The code, never the sentence: the sentence is for the person.
    this.timing(connection, "refused", { code });
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/refusal",
      code,
      message,
    });
  }

  /**
   * A sentence the person should see, with the call left open.
   *
   * Protocol v1 says an error with no `code` is a turn that failed while the
   * call goes on; the client shows it for a few seconds and keeps listening.
   */
  private sendError(connection: Connection, message: string) {
    this.sendRaw(connection, { type: "error", message });
  }

  /**
   * Tells the client which Bot it is talking to (ADR 0029).
   *
   * Sent when a call is admitted and again whenever the call is handed over,
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

  /**
   * `start_call`: admits the call in the ledger, then opens the session.
   *
   * Everything durable happens before the socket to Google does, because the
   * record is what an eviction leaves behind and the socket is not.
   */
  private async startCall(connection: Connection): Promise<void> {
    if (this.#calls.has(connection.id)) return;
    // Before the first awaited read, so the gap to `cap-checked` below is
    // storage and not this method being entered late.
    this.timing(connection, "start-call");
    const identity = this.identity(connection);
    if (!identity) {
      this.refuse(
        connection,
        "unconfigured",
        "This voice session is not signed in.",
      );
      return;
    }
    if (!this.geminiUrl()) {
      this.refuse(
        connection,
        "unconfigured",
        "Voice isn't set up on this deployment yet.",
      );
      return;
    }
    const ledger = this.ledger();
    const now = this.now();
    if (await ledger.exceededCap(now)) {
      this.refuse(
        connection,
        "quota",
        "Today's voice allowance is used up. It resets at midnight UTC.",
      );
      return;
    }
    this.timing(connection, "cap-checked");
    // A call about to be displaced has its memory work recorded *before* the
    // record naming it is replaced. Written the other way round, an eviction
    // in between would leave a call nothing remembers it has to finish. The
    // rejoin rule is the ledger's own, asked here rather than repeated.
    const displaced = await ledger.currentCall();
    if (displaced && !(await ledger.rejoins(identity.deviceKey, now))) {
      await this.beginMemoryFinalization(displaced);
    }
    this.timing(connection, "ledger-checked", {
      displaced: Boolean(displaced),
    });
    // ADR 0029: a call addresses one Bot. The client says which before it
    // says `start_call`, and that is what the call opens on whether it is a
    // new call or a rejoin — the person pressed voice on a Bot just now, and
    // a dropped call coming back on the Bot they left is not what they asked
    // for. A rejoin that names none keeps the Bot its record has, and a
    // client that names none — or names one this account does not own —
    // gets General, so there is always somebody on the line.
    const requested = this.#targets.get(connection.id);
    const admission = await ledger.beginCall({
      callId: crypto.randomUUID(),
      deviceKey: identity.deviceKey,
      connectionId: connection.id,
      at: now,
      ...(requested ? { botId: requested } : {}),
    });
    this.timing(connection, "call-admitted", { admission: admission.status });
    const target = await this.resolveCallTarget(
      identity.userId,
      admission.call.botId ?? requested,
    );
    this.timing(connection, "target-resolved");
    // Whatever this admission displaced — another device's call, or this
    // device's own earlier socket rejoining the same call — is ended now, so
    // one account never holds two live sessions.
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
        this.sendRaw(other, { type: "status", status: "idle" });
      }
    }
    const call: LiveCall = {
      callId: admission.call.callId,
      connectionId: connection.id,
      botId: target.botId,
      botName: target.name,
      voice: target.voice,
      startedAt: Date.now(),
      sequence: Date.parse(admission.call.startedAt),
      promptContext: this.buildPromptContext(
        identity.userId,
        target.botId,
        this.timingSink(connection),
      ),
      muted: false,
      exhausted: false,
      quotaSaid: false,
      status: "idle",
      transcript: "",
      answer: "",
      turnAudioBytes: 0,
      silenceSaid: false,
      dropping: false,
      delegations: 0,
      subagentCalls: new Map(),
      cancelledCalls: new Set(),
      meterInBytes: 0,
      meterOutBytes: 0,
    };
    this.#calls.set(connection.id, call);
    this.#traced.set(connection.id, {
      callId: call.callId,
      startedAt: call.startedAt,
      audioChunks: 0,
      audioBytes: 0,
      turns: 0,
    });
    this.trace(connection, "call-admitted", {
      admission: admission.status,
      rejoined: admission.status === "admitted" && admission.rejoined,
      replaced: admission.replaced?.connectionId,
      ...(call.botId ? { bot: call.botId } : {}),
      voice: call.voice.voiceName,
    });
    // The choice is spent: from here the Bot lives in the call record, and a
    // later `voice/target` on this socket is a hand-over, not a preference.
    this.#targets.delete(connection.id);
    if (call.botId) this.sendTarget(connection, call.botId);
    // The rate the client will be played at, said once and before any audio.
    this.sendRaw(connection, {
      type: "audio_config",
      format: "pcm16",
      sampleRate: VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
    });
    await this.openSession(connection, call, {});
  }

  /** `end_call`, and the hang-up's own bookkeeping. */
  private async endCall(connection: Connection): Promise<void> {
    const traced = this.#traced.get(connection.id);
    this.trace(connection, "call-ended", {
      audioChunks: traced?.audioChunks ?? 0,
      audioBytes: traced?.audioBytes ?? 0,
      turns: traced?.turns ?? 0,
    });
    await this.releaseCall(connection);
    this.sendRaw(connection, { type: "status", status: "idle" });
  }

  /**
   * Opens the session this call talks through.
   *
   * The instruction is rendered here rather than per turn, because a Live
   * session is instructed once: everything the model will need for the whole
   * call — the Bot, its memory, its thread, the directory, the clock — goes
   * in now. A wake offers the resumption handle; a wake the server has
   * forgotten comes back through `onSessionClosed` and reopens with a
   * handover instead.
   */
  private async openSession(
    connection: Connection,
    call: LiveCall,
    options: { handle?: string; handover?: boolean },
  ): Promise<void> {
    const url = this.geminiUrl();
    if (!url) return;
    const context = await call.promptContext;
    // The prompt context as this session sees it: `prompt-context-ready` said
    // when the reads finished, which for the first session of a call is
    // usually before this line was reached at all.
    this.timing(connection, "prompt-context-awaited");
    const handover = options.handover
      ? await this.callHistory(call.callId)
      : [];
    const instruction = renderVoiceSystemPromptV1({
      ...context,
      session: await timed(
        this.timingSink(connection),
        "session-voice-memory",
        this.sessionMemoryContext(),
      ),
      now: this.now(),
      ...(handover.length > 0 ? { handover } : {}),
    });
    // The system message this call actually sent, kept for the end-of-call
    // request's prefix. In memory only: a storage write per call for a cache
    // hint would cost more than the hint is worth.
    call.lastSystem = instruction;
    const setup = buildGeminiLiveSetupV1({
      systemInstruction: instruction,
      voiceName: call.voice.voiceName,
      functionDeclarations: call.botId
        ? VOICE_FUNCTION_DECLARATIONS_V1
        : VOICE_ACCOUNT_FUNCTION_DECLARATIONS_V1,
      googleSearch: true,
      ...(options.handle ? { resumptionHandle: options.handle } : {}),
    });
    const timing = this.timingSink(connection);
    const session = new GeminiSessionV1({
      url,
      setup,
      onEvent: (event) =>
        this.onSessionEvent(connection.id, call.callId, event),
      onClosed: (code, reason) => {
        void this.onSessionClosed(connection.id, call.callId, code, reason);
      },
      open: (target) => this.openGeminiSocket(target),
      ...(timing ? { timing } : {}),
    });
    call.session = session;
    this.trace(connection, "upstream", {
      state: "starting",
      ...(options.handle ? { resumed: true } : {}),
      ...(handover.length > 0 ? { handover: handover.length } : {}),
    });
    this.sendState(connection, call);
    try {
      await session.start();
    } catch (error) {
      this.trace(connection, "upstream-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      // The milestone, never the upstream's message: that text comes from
      // outside and the url it was raised for carries the key.
      this.timing(connection, "upstream-failed");
      call.session = undefined;
      this.sendState(connection, call);
      this.sendError(
        connection,
        "The voice service could not be reached. Try again in a moment.",
      );
      return;
    }
    this.armIdleSleep(connection, call);
  }

  /** The person's microphone, on its way to the model. */
  private async onClientAudio(
    connection: Connection,
    message: Exclude<WSMessage, string>,
  ): Promise<void> {
    const call = this.#calls.get(connection.id);
    if (!call || call.muted || call.exhausted) return;
    const session = call.session;
    if (!session) return;
    const bytes =
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(
            (message as ArrayBufferView).buffer,
            (message as ArrayBufferView).byteOffset,
            (message as ArrayBufferView).byteLength,
          );
    if (bytes.byteLength === 0) return;
    // The first frame of the person's microphone to reach this object, and
    // nothing about the frames after it: this is a milestone, not a meter.
    this.timing(
      connection,
      "client-audio-first",
      { bytes: bytes.byteLength },
      true,
    );
    session.sendAudio(bytes);
    this.armIdleSleep(connection, call);
    await this.meterAudio(connection, call, "in", bytes.byteLength);
  }

  /**
   * Counts audio actually bridged, in blocks.
   *
   * Every frame written straight through would be a storage write forty times
   * a second in each direction, so bytes accumulate and the meter is written
   * a block at a time. A block that takes the day past its cap shuts the
   * session and tells the client, which is a bound to within one block rather
   * than to the second — and the block is five seconds.
   */
  private async meterAudio(
    connection: Connection,
    call: LiveCall,
    direction: "in" | "out",
    bytes: number,
  ): Promise<void> {
    const perSecond =
      direction === "in"
        ? VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1
        : VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1;
    const block = VOICE_ASSISTANT_METER_BLOCK_SECONDS_V1 * perSecond;
    if (direction === "in") call.meterInBytes += bytes;
    else call.meterOutBytes += bytes;
    const held = direction === "in" ? call.meterInBytes : call.meterOutBytes;
    if (held < block) return;
    const blocks = Math.floor(held / block);
    const seconds = blocks * VOICE_ASSISTANT_METER_BLOCK_SECONDS_V1;
    if (direction === "in") call.meterInBytes -= blocks * block;
    else call.meterOutBytes -= blocks * block;
    const ledger = this.ledger();
    await ledger.addMeter(
      this.now(),
      direction === "in"
        ? { audioInSeconds: seconds }
        : { audioOutSeconds: seconds },
    );
    const cap = await ledger.exceededCap(this.now());
    if (cap !== "audioInSeconds" && cap !== "audioOutSeconds") return;
    call.exhausted = true;
    await this.sleepSession(connection, call);
    if (call.quotaSaid) return;
    call.quotaSaid = true;
    this.refuse(
      connection,
      "quota",
      "Today's voice allowance is used up. It resets at midnight UTC.",
    );
  }

  /** Writes the part-block each way that the meter has not seen yet. */
  private async settleMeter(call: LiveCall): Promise<void> {
    const inSeconds =
      call.meterInBytes / VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1;
    const outSeconds =
      call.meterOutBytes / VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1;
    call.meterInBytes = 0;
    call.meterOutBytes = 0;
    if (inSeconds < 0.5 && outSeconds < 0.5) return;
    await this.ledger().addMeter(this.now(), {
      audioInSeconds: Math.round(inSeconds),
      audioOutSeconds: Math.round(outSeconds),
    });
  }

  /**
   * The server's own sleep. A client that never says `voice/sleep` — an app
   * killed mid-call, a socket held open by a proxy — still stops the meter.
   */
  private armIdleSleep(connection: Connection, call: LiveCall): void {
    if (call.idleTimer) clearTimeout(call.idleTimer);
    call.idleTimer = setTimeout(() => {
      call.idleTimer = undefined;
      if (this.#calls.get(connection.id) !== call) return;
      void this.sleepSession(connection, call);
    }, this.serverIdleSleepMs());
  }

  /**
   * Closes the session and keeps the handle (ADR 0031, decision 3).
   *
   * Nothing listens and nothing is billed in between. A subagent already
   * admitted finishes as any Turn would, and its answer waits for the wake.
   */
  private async sleepSession(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    if (call.idleTimer) {
      clearTimeout(call.idleTimer);
      call.idleTimer = undefined;
    }
    if (!call.session) return;
    call.session.close();
    call.session = undefined;
    this.clearSilenceGuard(call);
    await this.settleMeter(call);
    await this.settleOpenTurn(call, { failure: "the call was paused" });
    this.trace(connection, "upstream", { state: "asleep" });
    this.sendState(connection, call);
  }

  /** The other half: reopen, resuming where the conversation was. */
  private async wakeSession(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    if (call.session) return;
    await this.openSession(connection, call, {
      ...(call.resumptionHandle ? { handle: call.resumptionHandle } : {}),
    });
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

  /** Closes the session and settles its meters; the call record is separate. */
  private async releaseCallResources(connectionId: string): Promise<void> {
    const call = this.#calls.get(connectionId);
    if (!call) return;
    this.#calls.delete(connectionId);
    if (call.idleTimer) clearTimeout(call.idleTimer);
    this.clearSilenceGuard(call);
    call.session?.close();
    call.session = undefined;
    await this.settleOpenTurn(call, { failure: "the call ended" });
    await this.settleMeter(call);
  }

  // -- the session's own events ---------------------------------------------

  private live(
    connectionId: string,
    callId: string,
  ): { connection: Connection; call: LiveCall } | undefined {
    const call = this.#calls.get(connectionId);
    if (!call || call.callId !== callId) return undefined;
    const connection = this.connectionFor(connectionId);
    return connection ? { connection, call } : undefined;
  }

  /**
   * One fact off the session's socket.
   *
   * Everything the person hears or the ledger records passes through here, so
   * the order matters: a turn is admitted before the first sound of it
   * reaches the client, and it is settled before the next one can begin.
   */
  private async onSessionEvent(
    connectionId: string,
    callId: string,
    event: GeminiServerEventV1,
  ): Promise<void> {
    const live = this.live(connectionId, callId);
    if (!live) return;
    const { connection, call } = live;
    switch (event.kind) {
      case "setup-complete":
        this.trace(connection, "upstream", { state: "awake" });
        this.trace(connection, "listening");
        this.timing(connection, "listening", {}, true);
        this.setStatus(connection, call, "listening");
        this.sendState(connection, call);
        return;
      case "audio": {
        // The model's first sound, before the turn it belongs to is admitted:
        // the await below is durable work, and a line written after it would
        // charge that work to Google.
        this.timing(
          connection,
          "upstream-audio-first",
          { bytes: event.pcm.byteLength },
          true,
        );
        if (!(await this.ensureTurn(connection, call))) return;
        if (call.dropping) return;
        this.clearSilenceGuard(call);
        this.setStatus(connection, call, "speaking");
        call.turnAudioBytes += event.pcm.byteLength;
        const traced = this.#traced.get(connectionId);
        if (traced) {
          traced.audioChunks += 1;
          traced.audioBytes += event.pcm.byteLength;
        }
        this.sendBinary(connection, event.pcm);
        // Handed to the client's socket. What the gap to the line above holds
        // is this object's own work — admitting the turn — and nothing else.
        this.timing(connection, "client-audio-out-first", {}, true);
        await this.meterAudio(connection, call, "out", event.pcm.byteLength);
        return;
      }
      case "output-transcript":
        if (!(await this.ensureTurn(connection, call))) return;
        call.answer += event.text;
        this.sendRaw(connection, {
          type: "transcript_delta",
          text: event.text,
        });
        return;
      case "input-transcript":
        // What the person said, as the session heard it. It often arrives
        // after the model has started answering, which is why the turn's
        // transcript is written again when the turn settles.
        call.transcript =
          `${call.transcript}${call.transcript ? " " : ""}${event.text}`.trim();
        this.sendRaw(connection, {
          type: "transcript",
          role: "user",
          text: event.text,
        });
        return;
      case "interrupted":
        // The model's own detector heard the person. Everything queued on the
        // client is for a moment that has passed.
        this.trace(connection, "interrupted", { source: "model" });
        call.dropping = true;
        this.sendRaw(connection, { type: "playback_interrupt" });
        this.setStatus(connection, call, "listening");
        return;
      case "generation-complete":
      case "turn-complete":
        await this.finishTurn(connection, call);
        return;
      case "tool-call":
        await this.runToolCalls(connection, call, event.calls);
        return;
      case "tool-cancel":
        for (const id of event.ids) call.cancelledCalls.add(id);
        this.trace(connection, "tool-cancelled", { calls: event.ids.length });
        return;
      case "resumption":
        if (event.handle) call.resumptionHandle = event.handle;
        return;
      case "go-away":
        // The server is about to close this connection. Reopening with the
        // handle now keeps the conversation rather than losing it to a close
        // the person would hear as silence.
        this.trace(connection, "upstream-goaway", {
          ...(event.timeLeft ? { timeLeft: event.timeLeft } : {}),
        });
        call.session?.close();
        call.session = undefined;
        await this.openSession(connection, call, {
          ...(call.resumptionHandle ? { handle: call.resumptionHandle } : {}),
        });
        return;
      case "usage":
        this.trace(connection, "usage", {
          promptTokens: event.usage.promptTokens,
          responseTokens: event.usage.responseTokens,
        });
        return;
    }
  }

  /**
   * The session's socket went away on its own.
   *
   * A handle the server has forgotten closes with 1008, which is the only
   * signal that the resumption window has passed: that one reopens fresh with
   * a handover so the person is not asked to start again. Anything else is a
   * failure the person is told about, with the call left open.
   */
  private async onSessionClosed(
    connectionId: string,
    callId: string,
    code: number,
    reason: string,
  ): Promise<void> {
    const live = this.live(connectionId, callId);
    if (!live) return;
    const { connection, call } = live;
    call.session = undefined;
    this.clearSilenceGuard(call);
    await this.settleOpenTurn(call, {
      failure: `the session closed (${code})`,
    });
    this.trace(connection, "upstream-closed", {
      code,
      reason: reason.slice(0, 200),
    });
    if (call.exhausted || call.muted) {
      this.sendState(connection, call);
      return;
    }
    if (code === GEMINI_LIVE_UNKNOWN_HANDLE_CLOSE_V1 && call.resumptionHandle) {
      call.resumptionHandle = undefined;
      await this.openSession(connection, call, { handover: true });
      return;
    }
    this.sendState(connection, call);
    this.sendError(
      connection,
      "The voice connection dropped. Say that again and I'll pick it up.",
    );
    this.setStatus(connection, call, "listening");
  }

  // -- turns ----------------------------------------------------------------

  /**
   * Opens a turn the moment the model starts answering.
   *
   * The ledger's turn is what the day's allowance counts and what memory
   * reads, and it is written before the first sound reaches the client. A
   * refusal here is the day's cap biting: the session is shut so nothing more
   * is spent, and the person is told why.
   */
  private async ensureTurn(
    connection: Connection,
    call: LiveCall,
  ): Promise<boolean> {
    if (call.turnId) return true;
    if (call.exhausted) return false;
    const admitted = await this.ledger().admitTurn({
      connectionId: connection.id,
      transcript: call.transcript.trim(),
      at: this.now(),
    });
    if (admitted.status === "refused") {
      call.exhausted = true;
      await this.sleepSession(connection, call);
      if (!call.quotaSaid) {
        call.quotaSaid = true;
        this.refuse(connection, "quota", admitted.reason);
      }
      return false;
    }
    const turnId = admitted.turn.turnId;
    call.turnId = turnId;
    call.turnAdmittedAt = admitted.turn.admittedAt;
    // `<callId>:<sequence>`: the ledger's own count of this call's turns, and
    // half of the stamp that orders every memory write against every other.
    call.turnOrdinal = voiceTurnOrdinalV1(turnId);
    call.turnStartedAt = Date.now();
    call.answer = "";
    call.turnAudioBytes = 0;
    call.silenceSaid = false;
    call.dropping = false;
    const traced = this.#traced.get(connection.id);
    if (traced) traced.turns += 1;
    this.setStatus(connection, call, "thinking");
    this.trace(connection, "turn", {
      turn: turnId,
      chars: call.transcript.length,
    });
    // A turn that never makes a sound used to be invisible. The guard is what
    // the speech-provider wrapper was: one sentence to the client, and the
    // call goes on.
    call.silenceTimer = setTimeout(() => {
      call.silenceTimer = undefined;
      if (this.#calls.get(connection.id) !== call || call.turnId !== turnId) {
        return;
      }
      call.silenceSaid = true;
      this.trace(connection, "turn-silent", { turn: turnId });
      this.sendError(
        connection,
        "I couldn't get that answer out loud. Say that again?",
      );
      this.setStatus(connection, call, "listening");
    }, this.modelSilenceTimeoutMs());
    return true;
  }

  private clearSilenceGuard(call: LiveCall): void {
    if (!call.silenceTimer) return;
    clearTimeout(call.silenceTimer);
    call.silenceTimer = undefined;
  }

  /** Closes an open turn out without a live socket to say anything on. */
  private async settleOpenTurn(
    call: LiveCall,
    outcome: { answer: string } | { failure: string },
  ): Promise<void> {
    const turnId = call.turnId;
    if (!turnId) return;
    call.turnId = undefined;
    await this.ledger().settleTurn(turnId, outcome, call.transcript.trim());
  }

  /**
   * The model's turn is over.
   *
   * Two frames can say so — `generationComplete` and `turnComplete` — and an
   * interrupted turn may send neither, so whichever arrives first settles the
   * turn and the second finds nothing to do. A hand-over waiting on this turn
   * happens here, which is what ADR 0031 means by honouring `switch_bot`
   * after the spoken turn ends.
   */
  private async finishTurn(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    const turnId = call.turnId;
    if (turnId) {
      this.clearSilenceGuard(call);
      const spoken = call.answer.trim();
      const silent = call.turnAudioBytes === 0 && !call.dropping;
      call.turnId = undefined;
      await this.ledger().settleTurn(
        turnId,
        spoken ? { answer: spoken } : { failure: "no_output" },
        call.transcript.trim(),
      );
      this.trace(connection, "turn-settled", {
        turn: turnId,
        ms: Math.max(0, Date.now() - (call.turnStartedAt ?? Date.now())),
        answerChars: spoken.length,
        audioBytes: call.turnAudioBytes,
      });
      if (silent && !call.silenceSaid) {
        // The turn finished having made no sound at all. The old TTS guard
        // caught this; it is still the person's evidence that something went
        // wrong rather than that nobody answered.
        this.sendError(
          connection,
          "I couldn't get that answer out loud. Say that again?",
        );
      }
      // The next turn is the next thing the person says, so what they said
      // for this one is spent, and so is this turn's hand-off burst.
      call.transcript = "";
      call.dropping = false;
      call.delegations = 0;
      const spokenText = spoken;
      if (spokenText) {
        this.sendRaw(connection, { type: "transcript_end", text: spokenText });
      }
    }
    this.setStatus(connection, call, "listening");
    if (call.pendingSwitch) await this.applySwitch(connection, call);
  }

  /**
   * Moves the call to the Bot the person asked to be put through to.
   *
   * The ledger record moved when the tool ran; this is the session, which
   * waits for the model's own turn to end so its sign-off is not cut off. The
   * new session is fresh — a different Bot, a different instruction and a
   * different voice — and carries the tail of the call so nothing is lost.
   */
  private async applySwitch(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    const target = call.pendingSwitch;
    call.pendingSwitch = undefined;
    call.session?.close();
    call.session = undefined;
    // A resumption handle belongs to the session that issued it, and that
    // session was another Bot. Nothing is resumed across a hand-over.
    call.resumptionHandle = undefined;
    this.clearSilenceGuard(call);
    await this.settleOpenTurn(call, { failure: "the call was handed over" });
    this.sendTarget(connection, call.botId);
    this.trace(connection, "call-switched", {
      bot: call.botId,
      voice: call.voice.voiceName,
      ...(target ? { requested: target.botId } : {}),
    });
    await this.openSession(connection, call, { handover: true });
  }

  /**
   * Runs what the model asked for and answers it.
   *
   * Every declaration is non-blocking, so the model is still talking while
   * this runs and the answer is scheduled `WHEN_IDLE`: it is spoken at the
   * next pause rather than over whatever is being said now.
   */
  private async runToolCalls(
    connection: Connection,
    call: LiveCall,
    calls: readonly GeminiFunctionCallV1[],
  ): Promise<void> {
    const identity = this.identity(connection);
    if (!identity) return;
    await this.ensureTurn(connection, call);
    const turnId = call.turnId ?? `${call.callId}:tool`;
    const host = this.turnHost(
      identity.userId,
      call,
      turnId,
      (await call.promptContext).timezone,
    );
    for (const request of calls) {
      this.trace(connection, "tool", { tool: request.name, call: request.id });
      const outcome = await runVoiceToolV1(
        host,
        { name: request.name, args: request.args },
        { botId: call.botId, delegationsThisCall: call.delegations },
      );
      if (outcome.delegated) {
        call.delegations += 1;
        // Whatever the host admitted is the newest delegation of this call;
        // it is answered under this function call's own id when it settles.
        const latest = call.lastDelegationRunId;
        call.lastDelegationRunId = undefined;
        if (latest) {
          call.subagentCalls.set(latest, {
            id: request.id,
            name: request.name,
          });
        }
      }
      if (outcome.switchedTo) {
        // Durable now, spoken later: the session moves when this turn ends.
        call.pendingSwitch = outcome.switchedTo;
      }
      if (call.cancelledCalls.delete(request.id)) continue;
      call.session?.send(
        encodeGeminiToolResponseV1([
          {
            id: request.id,
            name: request.name,
            response: voiceToolResponseV1(outcome),
            scheduling: "WHEN_IDLE",
          },
        ]),
      );
    }
  }

  /**
   * This call's conversation so far, newest last, bounded to what a handover
   * carries. Built from the ledger's own turn records, which are written
   * before the model says anything, so it is exactly what this call admitted
   * — no more, and nothing from any other call.
   */
  private async callHistory(
    callId: string,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const turns = await this.ledger().turnsForCall(callId);
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (const turn of turns) {
      if (turn.transcript.trim()) {
        history.push({ role: "user", content: turn.transcript });
      }
      if (turn.answer) {
        history.push({ role: "assistant", content: turn.answer });
      }
    }
    return history.slice(-VOICE_PROMPT_HISTORY_MESSAGES_V1);
  }

  /**
   * Which Bot a call opens on (ADR 0029).
   *
   * The client's choice wins when it names a Bot this account owns. Anything
   * else — no choice, a deleted Bot, another account's — falls back to the
   * account's General Bot: a Bot the person never asked for would answer in
   * its own name, memory and thread with nothing saying it is not the one
   * they wanted. An account with no General still has Bots — one that owned
   * Bots before the bootstrap is never given General, and deleting General
   * does not bring it back — so the directory is asked before a call is
   * called Bot-less. Only an account with no Bots at all is answered by the
   * account-wide assistant.
   */
  private async resolveCallTarget(
    userId: string,
    botId: string | undefined,
  ): Promise<{ botId: string; name: string; voice: BotVoiceAppearanceV1 }> {
    if (botId) {
      try {
        const owned = await this.ownedBot(userId, botId);
        return {
          botId: owned.botId,
          name: owned.name,
          voice: await this.voiceForBot(userId, owned.botId),
        };
      } catch {
        // Fall through to the account's default.
      }
    }
    // Which Bot is General is recorded by the flock bootstrap, not spelled by
    // a display name a person is free to change.
    const generalBotId = await this.generalBotId(userId);
    if (generalBotId) {
      try {
        const general = await this.ownedBot(userId, generalBotId);
        return {
          botId: general.botId,
          name: general.name,
          voice: await this.voiceForBot(userId, general.botId),
        };
      } catch {
        // General has been deleted. The directory below still answers.
      }
    }
    // No General marker does not mean no Bots: an account that already owned
    // Bots when the bootstrap ran is never given one, and deleting General
    // does not bring it back. Only the directory can say the account is
    // empty, and only then is the call Bot-less.
    try {
      const directory = await this.directory(userId);
      for (const entry of directory.bots) {
        try {
          const owned = await this.ownedBot(userId, entry.botId);
          return {
            botId: owned.botId,
            name: owned.name,
            voice: await this.voiceForBot(userId, owned.botId),
          };
        } catch {
          // That Bot cannot be read; try the next one.
        }
      }
    } catch {
      // No directory to read: the call opens without a Bot.
    }
    return { botId: "", name: "", voice: resolveBotVoiceV1({}) };
  }

  /**
   * How a Bot sounds (ADR 0031, decision 6).
   *
   * Its own stored voice if it has one, else its character's default with no
   * delivery presets, so a Bot whose owner has only ever picked a look
   * already sounds unlike its siblings. The character is read from the
   * account directory's avatar mirror, which is already the authority for
   * what a Bot wears.
   */
  private async voiceForBot(
    userId: string,
    botId: string,
  ): Promise<BotVoiceAppearanceV1> {
    try {
      const directory = await this.directory(userId);
      const entry = directory.bots.find((bot) => bot.botId === botId);
      const chosen = entry?.voice;
      return resolveBotVoiceV1({
        ...(chosen ? { chosen } : {}),
        ...(entry ? { characterId: entry.avatar.characterId } : {}),
      });
    } catch {
      // No directory, no character: the default voice still speaks.
      return resolveBotVoiceV1({});
    }
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
      said: call.transcript,
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
          this.sendDelegationState(
            botId,
            bot.name,
            admission.delegation.runId,
            "asked",
          );
          return `${bot.name} was already asked this; its answer will be read out when it settles.`;
        }
        this.sendDelegationState(
          botId,
          bot.name,
          admission.delegation.runId,
          "asked",
        );
        // Which function call this answers is decided by the caller, which
        // holds the id; this is the newest request it admitted.
        call.lastDelegationRunId = admission.delegation.runId;
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
        // The voice moves with the Bot: once the session reopens the person
        // hears somebody else, which is the whole point of the hand-over.
        call.voice = await this.voiceForBot(userId, bot.botId);
        // The Bot's own context is what the next turn wears, so it is read
        // now rather than left to the next turn's critical path.
        call.promptContext = this.buildPromptContext(userId, bot.botId);
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
    // The hand-off's own two ends, for a call that asked: when the Turn was
    // sent, and — in `announceDelegation` — when its answer reached the
    // session. Carried by the connection this call is on rather than by the
    // request, so the Bot's own RPC shape is untouched: a Turn's payload is
    // durable and a diagnostic id has no business in it.
    void this.ledger().noteDelegationDispatch(delegation.runId, this.now());
    const live = this.liveCallFor(delegation.callId);
    const dispatched = live && this.connectionFor(live.connectionId);
    if (dispatched) {
      this.timing(dispatched, "delegation-dispatched", {
        run: delegation.runId,
      });
    }
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

  /**
   * A settled answer, handed back to the session it was asked from.
   *
   * It goes as that function call's own late response, scheduled `WHEN_IDLE`,
   * so the model says it at the next pause and decides for itself whether it
   * is worth saying at all. With no live session — the call is paused, the
   * device is away — the answer waits and this runs again; with a different
   * call it is dropped, because the call that asked is over and the answer is
   * still in the Bot's own conversation. Public because the scheduler calls
   * it by name.
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
      if (
        !live ||
        live.call.callId !== delegation.callId ||
        !live.call.session?.isOpen()
      ) {
        // The call is on record but nothing is listening: paused, or a socket
        // away inside the rejoin window. The answer waits; if nobody comes
        // back the abandoned-call alarm cancels it with the call.
        await this.scheduleAnnounce(runId);
        return;
      }
      const { connection, call } = live;
      if (!(await ledger.markDelegationSpoken(runId, this.now()))) return;
      const own = delegation.botId === call.botId;
      const told = renderVoiceSubagentResultV1({
        botName: delegation.botName,
        own,
        ...(delegation.answer ? { answer: delegation.answer } : {}),
        ...(delegation.failure ? { failure: delegation.failure } : {}),
      });
      const asked = call.subagentCalls.get(runId);
      call.subagentCalls.delete(runId);
      if (asked) {
        call.session?.send(
          encodeGeminiToolResponseV1([
            {
              id: asked.id,
              name: asked.name,
              response: { result: told },
              scheduling: "WHEN_IDLE",
            },
          ]),
        );
      } else {
        // The session that made the call has been replaced — a wake, a
        // hand-over — so there is no function call left to answer. The result
        // goes in as a turn instead; it says in its own words that it is a
        // Bot's answer quoted as data.
        call.session?.send(encodeGeminiTextTurnV1(told));
      }
      this.trace(connection, "answer-told", {
        run: runId,
        ...(asked ? { call: asked.id } : { asTurn: true }),
      });
      this.timing(connection, "delegation-answered", {
        run: runId,
        asTurn: !asked,
      });
      this.sendDelegationState(
        delegation.botId,
        delegation.botName,
        runId,
        "finished",
      );
    } finally {
      this.#announcing.delete(runId);
    }
  }

  /**
   * Books the next attempt to tell the session. A fresh row every time, never
   * `idempotent`: from inside the callback an idempotent insert would dedup
   * onto the executing row, which the scheduler then deletes. The method
   * re-reads the record and stops once it is no longer `settled`, so an extra
   * row is a harmless no-op and a cancelled answer ends the chain.
   */
  private async scheduleAnnounce(runId: string): Promise<void> {
    await this.schedule<AnnounceDelegationPayload>(
      ANSWER_RETRY_SECONDS,
      "announceDelegation",
      { runId },
      { idempotent: false },
    );
  }

  /** The connection holding the live call, when one is here. */
  private liveCall(): { connection: Connection; call: LiveCall } | undefined {
    for (const [connectionId, call] of this.#calls) {
      const connection = this.connectionFor(connectionId);
      if (connection) return { connection, call };
    }
    return undefined;
  }

  private sendDelegationState(
    botId: string,
    botName: string,
    runId: string,
    state: "asked" | "answering" | "finished",
  ): void {
    for (const connection of this.getConnections()) {
      this.send(connection, {
        schemaVersion: 1,
        type: "voice/delegation",
        botId,
        botName,
        runId,
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
    | { status: "cleanup"; admitted: boolean }
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
    if (request.action === "cleanup") {
      // Booked here rather than in the relay so the account's whole day is
      // counted in one place, next to the seconds the same capture spent.
      const admitted = await ledger.admitDictationCleanup(at);
      return { status: "cleanup", admitted: admitted.status === "admitted" };
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
      readFlockBootstrap(input: unknown): Promise<unknown>;
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
   * Which Bot the account's authority provisioned as General. The bootstrap
   * marker is the only thing that says so: names are the person's to change,
   * and a Bot they call "General" is not the one the account bootstrapped.
   */
  private async generalBotId(userId: string): Promise<string | undefined> {
    try {
      const bootstrap = decodeFlockBootstrapViewV1(
        rpcJsonSnapshotV1(
          await this.userRpc(userId).readFlockBootstrap({
            schemaVersion: 1,
            userId,
          }),
        ),
      );
      return bootstrap.generalBotId ?? undefined;
    } catch {
      return undefined;
    }
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
    timing?: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<Omit<VoiceAssistantPromptInputV1, "now">> {
    // The start is marked where the reads are actually issued, which is here
    // — not where `openSession` later awaits the answer. The two are far
    // apart, and a line that said otherwise would put the fan-out's time in
    // the wrong place.
    timing?.("prompt-context-start");
    // One directory read serves both the prompt's `<bots>` list and the
    // current Bot's activity; asked twice it would double the per-Bot RPC
    // fan-out on exactly this path.
    const directory = this.listBots(userId).catch(
      () => [] as VoiceBotSummaryV1[],
    );
    const [bots, memory, timezone, session, bot] = await Promise.all([
      timed(timing, "prompt-directory", directory),
      timed(
        timing,
        "prompt-user-memory",
        (async () => {
          const store = this.memoryStore(userId);
          if (!store) return undefined;
          try {
            return await store.read(
              userMemoryRootV1({ userId, botId: "voice" }),
            );
          } catch (error) {
            return {
              root: userMemoryRootV1({ userId, botId: "voice" }),
              profile: [],
              recent: [],
              sources: [],
              documents: [],
              logTotal: 0,
              unavailable:
                error instanceof Error ? error.message : String(error),
            };
          }
        })(),
      ),
      timed(timing, "prompt-timezone", this.userTimezone(userId)),
      timed(timing, "prompt-voice-memory", this.sessionMemoryContext()),
      this.buildCurrentBotContext(userId, botId, directory, timing),
    ]);
    timing?.("prompt-context-ready");
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
    directory: Promise<VoiceBotSummaryV1[]>,
    timing?: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<VoiceCurrentBotV1 | undefined> {
    if (!botId) return undefined;
    let bot: { botId: string; name: string; description?: string };
    try {
      bot = await timed(
        timing,
        "prompt-bot-identity",
        this.ownedBot(userId, botId),
      );
    } catch {
      // The Bot was deleted, or never belonged to this User. The call keeps
      // going as the account-wide assistant rather than failing.
      return undefined;
    }
    const [memory, thread, bots] = await Promise.all([
      timed(
        timing,
        "prompt-bot-memory",
        (async () => {
          const store = this.memoryStore(userId);
          if (!store) return undefined;
          try {
            return await store.read(botMemoryRootV1({ userId, botId }));
          } catch {
            return undefined;
          }
        })(),
      ),
      timed(
        timing,
        "prompt-bot-history",
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
      ),
      // The directory is already being read for the prompt's `<bots>` list;
      // this takes the live activity for the current Bot out of the same
      // answer rather than asking its object again.
      directory,
    ]);
    const activity = bots.find((row) => row.botId === botId)?.activity;
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
