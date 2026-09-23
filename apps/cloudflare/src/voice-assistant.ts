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
  listDirectoryActivityV1,
  projectOpeningDirectoryV1,
} from "@frockbot/app/voice/directory";
import {
  parseChatCompletionStreamV1,
  renderVoiceChatResultV1,
  renderVoiceSubagentResultV1,
  renderVoiceToolResultTurnV1,
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
  type VoiceToolOutcomeV1,
} from "@frockbot/app/voice/assistant";
import { voiceCallTranscriptTurnsV1 } from "@frockbot/app/voice/call-transcript";
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
  GEMINI_LIVE_MODEL_V1,
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
  voiceCallRejoinWindowMsV1,
  voiceTurnOrdinalV1,
  type VoiceCallRecordV1,
  type VoiceDelegationRecordV1,
  type VoiceLedgerDebugSnapshotV1,
  type VoiceLedgerStorageV1,
} from "@frockbot/app/voice/ledger";
import {
  beginVoiceActivationV1,
  dueVoiceWorkV1,
  sealVoiceCallV1,
  VoiceMaintenanceSchedulerV1,
  VOICE_MAINTENANCE_BATCH_V1,
  VOICE_SEALED_CALL_PREFIX_V1,
  voiceDeliveryBackoffSecondsV1,
  type VoiceSealedCallV1,
} from "@frockbot/app/voice/recovery";
import {
  renderVoiceBotStatusV1,
  VOICE_HISTORY_DEFAULT_LIMIT_V1,
  VOICE_HISTORY_MAX_LIMIT_V1,
  type VoiceBotHistorySourceV1,
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
import { VoiceMemoryPrefetchCacheV1 } from "@frockbot/app/voice/memory-recall";
import { isControlOnlyMemoryInputV1 } from "@frockbot/app/memory/policy";
import {
  productScopeToEngineV1,
  type MemoryAuthorityV1,
} from "@frockbot/app/memory/records";
import { refuseMemorySecretV1 } from "@frockbot/app/memory/secrets";
import {
  decodeVoiceAssistantClientMessageV1,
  VOICE_ASSISTANT_INPUT_BYTES_PER_SECOND_V1,
  VOICE_ASSISTANT_METER_BLOCK_SECONDS_V1,
  VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1,
  VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1,
  VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1,
  VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_SERVER_IDLE_SLEEP_MS_V1,
  VOICE_DICTATION_LEASE_RENEW_MS_V1,
  VOICE_DICTATION_RESERVE_SECONDS_V1,
  type VoiceAssistantClientMessageV1,
  type VoiceAssistantRefusalCodeV1,
  type VoiceAssistantServerMessageV1,
  type VoiceAssistantStatusV1,
  type VoiceAssistantUpstreamStateV1,
  type VoiceControlActionV1,
  type VoiceOpeningFailCodeV1,
  type VoiceOpeningModeV1,
} from "@frockbot/app/voice/shared";
import {
  decodeVoiceAssistantPcmEnvelopeV1,
  decideVoicePcmSequenceV1,
  encodeVoiceAssistantPcmEnvelopeV1,
  isVoiceAttemptIdV1,
  voiceSetupFingerprintV1,
  type VoiceOpeningPhaseV1,
} from "@frockbot/app/voice/opening";
import {
  offerVoiceResumptionV1,
  voiceMemoryIdentityV1,
  type VoiceResumptionOfferV1,
  type VoiceResumptionRecordV1,
  type VoiceResumptionRejectV1,
} from "@frockbot/app/voice/resumption";
import { MemoryStore } from "@frockbot/app/memory/store";
import { voiceOpeningRereadsSessionMemoryV1 } from "@frockbot/app/voice/session-memory";
import {
  decodeDirectoryViewV1,
  decodeFlockBootstrapViewV1,
  type BotDirectoryViewV1,
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
/** Audio held while a session is opening, as bounded defense: 10 s at 16 kHz. */
const PENDING_AUDIO_BYTES = VOICE_ASSISTANT_OPENING_BUFFER_BYTES_V1;
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

interface VoiceCallTargetV1 {
  botId: string;
  name: string;
  description?: string;
  voice: BotVoiceAppearanceV1;
  /** A successful membership/appearance snapshot that admitted this target. */
  directory?: BotDirectoryViewV1;
  /** The actual identity read reused by prompt assembly. */
  identityReadDurationMs?: number;
}

interface VoiceCurrentHistoryV1 {
  thread: VoiceBotHistorySourceV1;
  activity: "idle" | "working";
}

export interface VoiceBotReuseContextV1 {
  target: VoiceBotSummaryV1 & { directory?: BotDirectoryViewV1 };
  history: Promise<{ activity: "idle" | "working" } | undefined>;
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
   * wake offers it back when it may be offered; otherwise, and when the server
   * has forgotten it (a 1008 close), the call reopens fresh with a handover.
   */
  resumptionHandle?: string;
  /** False once the provider said this handle must not be offered. */
  resumable: boolean;
  /** Semantic setup identity this handle was issued for. */
  setupFingerprint?: string;
  /** The opening attempt currently bound to inbound and outbound PCM. */
  attemptId?: string;
  inboundSequence?: number;
  outboundSequence: number;
  muted: boolean;
  /**
   * The person paused. Distinct from a quiet-room sleep: a finished task
   * must not unhibernate a call they put to sleep on purpose.
   */
  paused: boolean;
  /** One in-flight reopen, so two finished tasks do not open two sessions. */
  waking?: Promise<void>;
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
  /**
   * The generation that called functions this turn has not closed. Gemini
   * 3.8 says nothing before a tool: that generation ends in silence and the
   * answer is a fresh one after the results, so until its `turnComplete` a
   * silent boundary is the calling generation's, not the end of the turn.
   */
  callingGenerationOpen: boolean;
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
   * tearing the session down mid-turn would cut whichever came second. A
   * session that goes before the turn ends takes the reason to wait with it
   * (`honourTurnIntents`).
   */
  pendingSwitch?: { botId: string; name: string };
  /**
   * The model called `end_call`. Same wait as a hand-over: hang-up is after
   * this turn, so a goodbye is not cut off — and, the same way, no later.
   */
  pendingEnd?: boolean;
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
 * What a session carries of the call it reopens. A call's first session
 * carries neither. `resume` continues the call — its handle when that may be
 * offered, its own turns otherwise — for a wake or a goAway. `handover` opens
 * fresh with the turns: a hand-over, a memory write, a forgotten handle.
 */
interface SessionContinuityV1 {
  resume?: boolean;
  handover?: boolean;
}

/**
 * One opening: start, wake, rejoin, handover, rotation, or control-only.
 *
 * The slot is allocated before the first await so a later command can cancel
 * this attempt even while admission or Gemini is still in flight.
 */
class OpeningAttempt {
  phase: VoiceOpeningPhaseV1 = "admitting";
  cancelled = false;
  owningCallId?: string;
  session?: GeminiSessionV1;
  lastControlSequence = 0;
  lastControl?: { action: VoiceControlActionV1; muted?: boolean };
  readonly abort = new AbortController();
  readonly completion: Promise<void>;
  private settleCompletion!: () => void;
  deadline?: ReturnType<typeof setTimeout>;

  constructor(
    readonly id: string,
    readonly connectionId: string,
    readonly botId: string,
    readonly mode: VoiceOpeningModeV1,
    readonly paused: boolean,
    readonly muted: boolean,
  ) {
    this.completion = new Promise((resolve) => {
      this.settleCompletion = resolve;
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.phase = "closed";
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
    try {
      this.abort.abort();
    } catch {
      // Already aborted.
    }
    this.session?.close();
    this.session = undefined;
    this.settleCompletion();
  }

  finish(): void {
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
    this.settleCompletion();
  }
}

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
      onEvent: (event: GeminiServerEventV1) => void | Promise<void>;
      onClosed: (code: number, reason: string) => void;
      open: (url: string, signal?: AbortSignal) => Promise<WebSocket>;
      signal?: AbortSignal;
      /**
       * Lifecycle milestones for an opt-in diagnostic trace, or absent —
       * which is every ordinary call. Never the url, which carries the key.
       */
      timing?: (event: string, fields?: Record<string, unknown>) => void;
    },
  ) {}

  /**
   * Transport only. Error and close handlers attach immediately; setup is
   * sent later so prompt assembly can run beside the upgrade.
   */
  async connect(): Promise<void> {
    this.options.timing?.("upstream-open-start");
    const socket = await this.options.open(
      this.options.url,
      this.options.signal,
    );
    this.options.timing?.("upstream-socket-open");
    if (this.closedByUs || this.options.signal?.aborted) {
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
          this.openedAck();
        }
        const next = decoded;
        this.chain = this.chain
          .then(() => this.options.onEvent(next))
          .catch(() => undefined);
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.state = "asleep";
      this.socket = undefined;
      if (!this.closedByUs) {
        this.openedFail(
          new Error(event.reason || "the voice service connection closed"),
        );
        this.options.onClosed(event.code, event.reason ?? "");
      } else {
        this.openedAck();
      }
    });
    socket.addEventListener("error", () => {
      if (this.closedByUs) {
        this.openedAck();
        return;
      }
      this.state = "asleep";
      this.openedFail(new Error("the voice service connection failed"));
      this.options.onClosed(1006, "the voice service connection failed");
    });
  }

  /**
   * Sends setup once the prompt is ready and waits for the acknowledgement.
   * Audio, text and tool responses stay gated on `ready`.
   */
  async configure(setup: Record<string, unknown>): Promise<void> {
    if (!this.socket || this.closedByUs) {
      throw new Error("the voice service connection closed");
    }
    this.send(setup);
    this.options.timing?.("upstream-setup-sent");
    if (this.closedByUs) {
      this.openedAck();
      return;
    }
    await this.opened;
  }

  private openedAck: () => void = () => undefined;
  private openedFail: (error: Error) => void = () => undefined;
  private readonly opened = new Promise<void>((resolve, reject) => {
    this.openedAck = () => resolve();
    this.openedFail = (error) => reject(error);
  });

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
   * The current opening attempt per connection. Allocated synchronously
   * before the first await so pause/mute/end can cancel a start that has
   * not yet admitted a LiveCall.
   */
  #opening = new Map<string, OpeningAttempt>();
  /** Attempts by id, so a duplicate `voice/open` joins the same promise. */
  #attempts = new Map<string, OpeningAttempt>();
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
  protected openGeminiSocket(
    url: string,
    signal?: AbortSignal,
  ): Promise<WebSocket> {
    return fetchVoiceUpstreamSocketV1(url, {}, signal);
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

  /** How long one opening may take; a test shortens it. */
  protected openingDeadlineMs(): number {
    return VOICE_ASSISTANT_OPENING_DEADLINE_MS_V1;
  }

  private workerVar(name: `FROCK_AI_${string}`): string | undefined {
    const twin =
      `FLOCK_AI_${name.slice("FROCK_AI_".length)}` as keyof VoiceAssistantEnv;
    const value = this.env[name as keyof VoiceAssistantEnv] ?? this.env[twin];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  // -- ledger ---------------------------------------------------------------

  protected ledger(): VoiceLedgerV1 {
    return new VoiceLedgerV1(this.voiceStorage(), this.name);
  }

  private voiceStorage(): VoiceLedgerStorageV1 {
    const storage = this.ctx.storage;
    const surface: VoiceLedgerStorageV1 = {
      get: <T>(key: string) => storage.get<T>(key),
      put: <T>(key: string, value: T) => storage.put<T>(key, value),
      delete: (key: string) => storage.delete(key),
      list: <T>(options: {
        prefix: string;
        start?: string;
        end?: string;
        reverse?: boolean;
        limit?: number;
      }) => storage.list<T>(options),
      transaction: <T>(run: (tx: VoiceLedgerStorageV1) => Promise<T>) =>
        storage.transaction(async (tx) =>
          run({
            get: <V>(key: string) => tx.get<V>(key),
            put: <V>(key: string, value: V) => tx.put<V>(key, value),
            delete: (key: string) => tx.delete(key),
            list: <V>(options: {
              prefix: string;
              start?: string;
              end?: string;
              reverse?: boolean;
              limit?: number;
            }) => tx.list<V>(options),
          }),
        ),
    };
    return surface;
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
        list: <T>(options: {
          prefix: string;
          start?: string;
          end?: string;
          reverse?: boolean;
          limit?: number;
        }) => storage.list<T>(options),
      });
    }
    return this.#memory;
  }

  #memory: VoiceMemoryLedgerV1 | undefined;
  readonly #memoryPrefetch = new VoiceMemoryPrefetchCacheV1<string>();

  async onStart(): Promise<void> {
    await this.memory().retireLongTermFacts();
    const now = this.now();
    // Indexed active paid work only. A full history scan is not startup.
    const activation = crypto.randomUUID();
    const fenced = await beginVoiceActivationV1(
      this.voiceStorage(),
      activation,
    );
    for (const id of fenced.fenced) {
      this.traceMemory("memory-uncertain", { call: id }, "warn");
      await this.memory().abandonChunk(
        id,
        "the previous activation ended before the outcome was known",
        now,
      );
    }
    const current = await this.ledger().currentCall();
    if (current) {
      if (voiceCallIsStaleV1(current, now)) {
        await this.sealCall(current, now);
        await this.beginMemoryFinalization(current);
        await this.deliverCallTranscript(current);
        await this.ledger().endStaleCall(now);
      } else {
        await this.scheduleCallAbandon(current);
      }
    }
    await this.armMaintenance();
  }

  private maintenanceScheduler(): VoiceMaintenanceSchedulerV1 {
    return new VoiceMaintenanceSchedulerV1(async (delaySeconds, token) => {
      await this.schedule(
        delaySeconds,
        "drainVoiceMaintenance",
        { token },
        { idempotent: false },
      );
    });
  }

  /** Books the drain before any new obligation is visible to it. */
  private async armMaintenance(): Promise<void> {
    const due = await dueVoiceWorkV1(
      this.voiceStorage(),
      this.now().getTime(),
      1,
    );
    if (due.length === 0) return;
    await this.maintenanceScheduler().commit(async () => undefined);
  }

  /**
   * One bounded maintenance pass. The successor is armed before the drain
   * claims work, and an empty queue ends the chain.
   */
  async drainVoiceMaintenance(): Promise<void> {
    const storage = this.voiceStorage();
    const now = this.now().getTime();
    await this.maintenanceScheduler().onCallback({
      pending: async () => (await dueVoiceWorkV1(storage, now, 1)).length > 0,
      drain: async () => {
        const batch = await dueVoiceWorkV1(
          storage,
          now,
          VOICE_MAINTENANCE_BATCH_V1,
        );
        const external = batch.find(
          (work) => work.kind === "transcript" || work.kind === "delegation",
        );
        for (const work of batch) {
          if (work !== external && work.kind !== "memory") continue;
          if (work.kind === "memory") {
            await this.scheduleMemoryFinalization(work.callId, false);
          }
        }
        if (external?.kind === "transcript") {
          const sealed = await storage.get<{
            callId: string;
            botId?: string;
            startedAt: string;
            endedAt: string;
            turnSequence: number;
          }>(`voice:call:sealed:${external.callId}`);
          if (sealed?.botId) {
            try {
              await this.deliverCallTranscript({
                schemaVersion: 1,
                callId: sealed.callId,
                deviceKey: "",
                connectionId: "",
                startedAt: sealed.startedAt,
                lastSeenAt: sealed.endedAt,
                turnSequence: sealed.turnSequence,
                botId: sealed.botId,
              });
            } catch (error) {
              const attempts = external.attempts + 1;
              await storage.put(`work:transcript:${external.id}`, {
                ...external,
                attempts,
                nextAt: now + voiceDeliveryBackoffSecondsV1(attempts) * 1000,
                lastError:
                  error instanceof Error ? error.message : String(error),
              });
            }
          }
        } else if (external?.kind === "delegation") {
          await this.scheduleDelegationCheck(
            external.id,
            external.attempts,
            false,
          );
        }
      },
    });
  }

  private async sealCall(call: VoiceCallRecordV1, at: Date): Promise<void> {
    await sealVoiceCallV1(this.voiceStorage(), {
      callId: call.callId,
      ...(call.botId ? { botId: call.botId } : {}),
      startedAt: call.startedAt,
      endedAt: at.toISOString(),
      turnSequence: call.turnSequence,
      now: at.getTime(),
    });
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

  /**
   * Writes this call's spoken turns onto the Bot's thread as one collapsible
   * section. Idempotent by call id: hang-up and the abandoned-call alarm
   * both land here. A call that never said anything writes nothing. A failed
   * write is traced and the call still ends — the ledger keeps the turns.
   */
  private async deliverCallTranscript(call: VoiceCallRecordV1): Promise<void> {
    if (!call.botId) return;
    const turns = voiceCallTranscriptTurnsV1(
      await this.ledger().turnsForCall(call.callId),
    );
    if (turns.length === 0) return;
    try {
      await this.botDoor(this.name, call.botId).deliverVoiceCallTranscript({
        callId: call.callId,
        startedAt: call.startedAt,
        endedAt: this.now().toISOString(),
        turns,
      });
      this.traceMemory("call-transcript", { call: call.callId });
    } catch {
      this.traceMemory("call-transcript-failed", { call: call.callId }, "warn");
    }
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
   * live for its rejoin window — a network change must not cost them the
   * conversation, and a Pause whose socket the OS then killed is still
   * that call — and this alarm is what finishes it if nobody comes back.
   */
  private async scheduleCallAbandon(
    call: VoiceCallRecordV1,
    idempotent = true,
  ): Promise<void> {
    const remaining =
      Date.parse(call.lastSeenAt) +
      voiceCallRejoinWindowMsV1(call) -
      this.now().getTime();
    await this.schedule<MemoryFinalizationPayload>(
      Math.max(1, Math.ceil(remaining / 1000)) + 5,
      "abandonVoiceCall",
      { callId: call.callId },
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
      await this.scheduleCallAbandon(call, false);
      return;
    }
    this.traceMemory("call-abandoned", { call: call.callId });
    await this.sealCall(call, this.now());
    await this.armMaintenance();
    await this.beginMemoryFinalization(call);
    await this.deliverCallTranscript(call);
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
    const standing = update.operations.filter((operation) =>
      operation.kind.startsWith("durable/"),
    );
    const botId = await this.standingMemoryBotId(payload.callId);
    if (standing.length > 0 && botId) {
      for (const operation of standing) {
        try {
          const outcome =
            operation.kind === "durable/add"
              ? await this.writeCanonicalMemory(
                  this.name,
                  botId,
                  operation.text,
                )
              : operation.kind === "durable/remove"
                ? await this.forgetCanonicalMemory(
                    this.name,
                    botId,
                    operation.id,
                  )
                : undefined;
          if (outcome?.startsWith("Refused")) {
            this.traceMemory(
              "canonical-memory-refused",
              { call: payload.callId, message: outcome },
              "warn",
            );
          }
        } catch (error) {
          // The voice ledger still holds the fact. A cross-object write that
          // fails must not abandon the turns that produced it.
          this.traceMemory(
            "canonical-memory-failed",
            {
              call: payload.callId,
              message: error instanceof Error ? error.message : String(error),
            },
            "warn",
          );
        }
      }
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
    // rather than starting a new one with nothing behind it. A Pause whose
    // socket the OS then killed is the same record, on the long window,
    // written here before the in-memory call is dropped so a race with the
    // sleep frame cannot expire it in a minute.
    const live = this.#calls.get(connection.id);
    if (live?.paused) {
      await this.ledger().setCallPaused(connection.id, true, this.now());
    }
    await this.releaseCallResources(connection.id);
    const current = await this.ledger().currentCall();
    if (current && current.connectionId === connection.id) {
      await this.scheduleCallAbandon(current);
    }
    this.#traced.delete(connection.id);
    this.cancelOpening(connection.id);
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
        // starts on `voice/open`.
        return;
      case "end_call":
        // Retired admission path: hang-up is `voice/control` action end.
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
      case "start_call":
        return;
    }
  }

  private async onCustomMessage(
    connection: Connection,
    custom: VoiceAssistantClientMessageV1,
  ): Promise<void> {
    if (custom.type === "voice/open") {
      await this.onOpen(connection, custom);
      return;
    }
    if (custom.type === "voice/control") {
      await this.onControl(connection, custom);
      return;
    }
    if (custom.type === "voice/target") {
      const live = this.#calls.get(connection.id);
      if (!live) return;
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
        await this.applySwitch(connection, live, { reopen: true });
      }
      return;
    }
    const call = this.#calls.get(connection.id);
    if (!call) return;
    switch (custom.type) {
      case "voice/sleep":
        call.paused = custom.paused === true;
        await this.ledger().setCallPaused(
          connection.id,
          call.paused,
          this.now(),
        );
        await this.sleepSession(connection, call);
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

  private sendBinary(
    connection: Connection,
    call: LiveCall,
    audio: Uint8Array,
  ) {
    const attemptId = call.attemptId;
    if (!attemptId) return;
    const sequence = call.outboundSequence;
    call.outboundSequence += 1;
    let frame: Uint8Array;
    try {
      frame = encodeVoiceAssistantPcmEnvelopeV1({
        attemptId,
        sequence,
        pcm: audio,
      });
    } catch {
      return;
    }
    try {
      // A copy, not a view: a view over a larger buffer would put whatever
      // else is in that buffer on the wire.
      connection.send(
        frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
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

  private cancelOpening(connectionId: string): void {
    const attempt = this.#opening.get(connectionId);
    if (!attempt) return;
    this.#opening.delete(connectionId);
    this.#attempts.delete(attempt.id);
    attempt.cancel();
  }

  private beginAttempt(
    connection: Connection,
    input: {
      attemptId: string;
      mode: VoiceOpeningModeV1;
      botId: string;
      paused: boolean;
      muted: boolean;
    },
  ): OpeningAttempt {
    const existing = this.#attempts.get(input.attemptId);
    if (existing && existing.connectionId === connection.id) return existing;
    const previous = this.#opening.get(connection.id);
    if (previous && previous.id !== input.attemptId) {
      this.send(connection, {
        schemaVersion: 1,
        type: "voice/open-failed",
        attemptId: previous.id,
        code: "cancelled",
      });
      previous.cancel();
      this.#memoryPrefetch.cancel(previous.id);
      this.#attempts.delete(previous.id);
    }
    const attempt = new OpeningAttempt(
      input.attemptId,
      connection.id,
      input.botId,
      input.mode,
      input.paused,
      input.muted,
    );
    this.#opening.set(connection.id, attempt);
    this.#attempts.set(attempt.id, attempt);
    attempt.deadline = setTimeout(() => {
      if (attempt.cancelled || attempt.phase === "ready") return;
      void this.failOpen(connection, attempt, "timeout");
    }, this.openingDeadlineMs());
    return attempt;
  }

  private stillOpening(
    connection: Connection,
    attempt: OpeningAttempt,
  ): boolean {
    return (
      !attempt.cancelled &&
      this.#opening.get(connection.id) === attempt &&
      this.#attempts.get(attempt.id) === attempt
    );
  }

  /** Pause/mute sent against this attempt overlay the original open intent. */
  private openingIntent(attempt: OpeningAttempt): {
    paused: boolean;
    muted: boolean;
  } {
    let paused = attempt.paused;
    let muted = attempt.muted;
    const control = attempt.lastControl;
    if (control?.action === "pause") paused = true;
    if (control?.action === "mute") muted = control.muted === true;
    return { paused, muted };
  }

  private finishWithoutGemini(
    connection: Connection,
    call: LiveCall,
    attempt: OpeningAttempt,
  ): void {
    call.session?.close();
    call.session = undefined;
    attempt.session = undefined;
    attempt.phase = "ready";
    this.setStatus(connection, call, "listening");
    this.sendState(connection, call);
    attempt.finish();
  }

  private sendAdmitted(
    connection: Connection,
    attempt: OpeningAttempt,
    call: { callId: string; paused: boolean; muted: boolean },
  ): void {
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/admitted",
      attemptId: attempt.id,
      callId: call.callId,
      paused: call.paused,
      muted: call.muted,
    });
  }

  private sendReady(
    connection: Connection,
    attempt: OpeningAttempt,
    callId: string,
  ): void {
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/ready",
      attemptId: attempt.id,
      callId,
    });
  }

  private async failOpen(
    connection: Connection,
    attempt: OpeningAttempt,
    code: VoiceOpeningFailCodeV1,
  ): Promise<void> {
    if (attempt.cancelled) return;
    this.trace(connection, "open-failed", { code, attempt: attempt.id });
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/open-failed",
      attemptId: attempt.id,
      code,
    });
    if (code === "quota" || code === "unconfigured" || code === "exclusive") {
      this.refuse(
        connection,
        code === "quota"
          ? "quota"
          : code === "exclusive"
            ? "exclusive"
            : "unconfigured",
        code === "quota"
          ? "Today's voice allowance is used up. It resets at midnight UTC."
          : code === "exclusive"
            ? "Voice is already running on another device."
            : "Voice isn't set up on this deployment yet.",
      );
    }
    this.cancelOpening(connection.id);
  }

  // -- call lifecycle -------------------------------------------------------

  /**
   * `voice/open`: admits the attempt synchronously, then opens Gemini unless
   * this is a paused, muted, or control-only reconnect.
   */
  private async onOpen(
    connection: Connection,
    custom: Extract<VoiceAssistantClientMessageV1, { type: "voice/open" }>,
  ): Promise<void> {
    if (!isVoiceAttemptIdV1(custom.attemptId)) return;
    const duplicate = this.#attempts.get(custom.attemptId);
    if (duplicate && duplicate.connectionId === connection.id) {
      await duplicate.completion;
      return;
    }
    const attempt = this.beginAttempt(connection, {
      attemptId: custom.attemptId,
      mode: custom.mode,
      botId: custom.botId ?? "",
      paused: custom.paused,
      muted: custom.muted,
    });
    this.timing(connection, "start-call");
    try {
      if (custom.mode === "control") {
        await this.admitControlOnly(connection, attempt, custom);
        return;
      }
      if (custom.mode === "wake") {
        await this.wakeFromOpen(connection, attempt);
        return;
      }
      await this.startCall(connection, attempt, custom);
    } catch (error) {
      if (!this.stillOpening(connection, attempt)) return;
      this.trace(connection, "open-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      await this.failOpen(connection, attempt, "upstream");
    }
  }

  private async admitControlOnly(
    connection: Connection,
    attempt: OpeningAttempt,
    custom: Extract<VoiceAssistantClientMessageV1, { type: "voice/open" }>,
  ): Promise<void> {
    const identity = this.identity(connection);
    if (!identity) {
      await this.failOpen(connection, attempt, "unconfigured");
      return;
    }
    const ledger = this.ledger();
    const current = await ledger.currentCall();
    if (current && current.deviceKey === identity.deviceKey) {
      attempt.owningCallId = current.callId;
      attempt.phase = "ready";
      this.sendAdmitted(connection, attempt, {
        callId: current.callId,
        paused: current.paused === true,
        muted: custom.muted,
      });
      attempt.finish();
      return;
    }
    const ended = await ledger.endedReceipt();
    if (
      ended &&
      ended.deviceKey === identity.deviceKey &&
      (!custom.callId || custom.callId === ended.callId)
    ) {
      attempt.owningCallId = ended.callId;
      attempt.phase = "closed";
      this.sendAdmitted(connection, attempt, {
        callId: ended.callId,
        paused: false,
        muted: custom.muted,
      });
      attempt.finish();
      return;
    }
    await this.failOpen(connection, attempt, "ended");
  }

  private async wakeFromOpen(
    connection: Connection,
    attempt: OpeningAttempt,
  ): Promise<void> {
    const call = this.#calls.get(connection.id);
    if (!call) {
      await this.failOpen(connection, attempt, "protocol");
      return;
    }
    call.paused = false;
    const intent = this.openingIntent(attempt);
    call.muted = intent.muted;
    call.attemptId = attempt.id;
    call.inboundSequence = undefined;
    call.outboundSequence = 0;
    attempt.owningCallId = call.callId;
    await this.ledger().setCallPaused(connection.id, false, this.now());
    this.sendAdmitted(connection, attempt, {
      callId: call.callId,
      paused: false,
      muted: call.muted,
    });
    if (call.muted || call.exhausted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    await this.openSession(connection, call, attempt, { resume: true });
  }

  private async onControl(
    connection: Connection,
    custom: Extract<VoiceAssistantClientMessageV1, { type: "voice/control" }>,
  ): Promise<void> {
    const attempt =
      this.#attempts.get(custom.attemptId) ?? this.#opening.get(connection.id);
    if (attempt) {
      if (custom.sequence < attempt.lastControlSequence) {
        this.send(connection, {
          schemaVersion: 1,
          type: "voice/control-ack",
          attemptId: attempt.id,
          sequence: attempt.lastControlSequence,
        });
        return;
      }
      attempt.lastControlSequence = custom.sequence;
      attempt.lastControl = { action: custom.action, muted: custom.muted };
      if (custom.action === "end") attempt.cancel();
    }
    const call = this.#calls.get(connection.id);
    if (call && custom.action === "pause") call.paused = true;
    if (call && custom.action === "mute") call.muted = custom.muted === true;
    if (custom.action === "end") {
      const ended = await this.ledger().endedReceipt();
      if (
        !call &&
        ended &&
        (!custom.attemptId || attempt?.owningCallId === ended.callId)
      ) {
        this.send(connection, {
          schemaVersion: 1,
          type: "voice/control-ack",
          attemptId: custom.attemptId,
          sequence: custom.sequence,
        });
        return;
      }
      await this.endCall(connection);
      this.send(connection, {
        schemaVersion: 1,
        type: "voice/control-ack",
        attemptId: custom.attemptId,
        sequence: custom.sequence,
      });
      return;
    }
    if (custom.action === "pause") {
      if (call) {
        call.paused = true;
        await this.ledger().setCallPaused(connection.id, true, this.now());
        await this.sleepSession(connection, call);
      }
    } else if (custom.action === "mute") {
      const muted = custom.muted === true;
      if (call) {
        call.muted = muted;
        if (muted) await this.sleepSession(connection, call);
        this.sendState(connection, call);
      }
    }
    this.send(connection, {
      schemaVersion: 1,
      type: "voice/control-ack",
      attemptId: custom.attemptId,
      sequence: custom.sequence,
    });
  }

  /**
   * Admits the call in the ledger, then opens the session unless this is a
   * Pause coming back — Gemini stays closed until Resume.
   */
  private async startCall(
    connection: Connection,
    attempt: OpeningAttempt,
    custom: Extract<VoiceAssistantClientMessageV1, { type: "voice/open" }>,
  ): Promise<void> {
    const intent = this.openingIntent(attempt);
    if (this.#calls.has(connection.id) && custom.mode !== "rejoin") {
      const live = this.#calls.get(connection.id)!;
      live.attemptId = attempt.id;
      live.inboundSequence = undefined;
      live.outboundSequence = 0;
      live.paused = intent.paused || live.paused;
      live.muted = intent.muted;
      attempt.owningCallId = live.callId;
      this.sendAdmitted(connection, attempt, {
        callId: live.callId,
        paused: live.paused,
        muted: live.muted,
      });
      if (live.paused || live.muted || live.exhausted) {
        this.finishWithoutGemini(connection, live, attempt);
        return;
      }
      await this.openSession(connection, live, attempt, {});
      return;
    }
    const identity = this.identity(connection);
    if (!identity) {
      await this.failOpen(connection, attempt, "unconfigured");
      return;
    }
    if (!this.geminiUrl()) {
      await this.failOpen(connection, attempt, "unconfigured");
      return;
    }
    const ledger = this.ledger();
    const now = this.now();
    if (await ledger.exceededCap(now)) {
      await this.failOpen(connection, attempt, "quota");
      return;
    }
    this.timing(connection, "cap-checked");
    if (!this.stillOpening(connection, attempt)) return;
    const directory = await this.callDirectory(identity.userId);
    if (!this.stillOpening(connection, attempt)) return;
    if (!directory) {
      await this.failOpen(connection, attempt, "unconfigured");
      return;
    }
    // A call about to be displaced has its memory work recorded *before* the
    // record naming it is replaced. Written the other way round, an eviction
    // in between would leave a call nothing remembers it has to finish. The
    // rejoin rule is the ledger's own, asked here rather than repeated.
    const displaced = await ledger.currentCall();
    if (!this.stillOpening(connection, attempt)) return;
    if (displaced && !(await ledger.rejoins(identity.deviceKey, now))) {
      await this.beginMemoryFinalization(displaced);
    }
    this.timing(connection, "ledger-checked", {
      displaced: Boolean(displaced),
    });
    const requested = custom.botId;
    const admission = await ledger.beginCall({
      callId: crypto.randomUUID(),
      deviceKey: identity.deviceKey,
      connectionId: connection.id,
      at: now,
      ...(requested ? { botId: requested } : {}),
    });
    if (!this.stillOpening(connection, attempt)) return;
    this.timing(connection, "call-admitted", { admission: admission.status });
    const target = await this.resolveCallTarget(
      identity.userId,
      admission.call.botId ?? requested,
      directory,
    );
    if (!this.stillOpening(connection, attempt)) return;
    this.timing(connection, "target-resolved");
    // The client often names no Bot. The resolved one — General, usually —
    // has to be on the ledger before hang-up, or the sealed call cannot say
    // which Memory the standing preference belongs to.
    if (target.botId && admission.call.botId !== target.botId) {
      await ledger.retargetCall(connection.id, target.botId, now);
    }
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
    const latest = this.openingIntent(attempt);
    const paused = latest.paused || admission.call.paused === true;
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
        target,
        this.timingSink(connection),
      ),
      resumable: false,
      attemptId: attempt.id,
      outboundSequence: 0,
      muted: latest.muted,
      paused,
      exhausted: false,
      quotaSaid: false,
      status: "idle",
      transcript: "",
      answer: "",
      turnAudioBytes: 0,
      callingGenerationOpen: false,
      silenceSaid: false,
      dropping: false,
      delegations: 0,
      subagentCalls: new Map(),
      cancelledCalls: new Set(),
      meterInBytes: 0,
      meterOutBytes: 0,
    };
    this.#calls.set(connection.id, call);
    attempt.owningCallId = call.callId;
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
    if (paused) {
      await ledger.setCallPaused(connection.id, true, now);
    }
    this.sendAdmitted(connection, attempt, {
      callId: call.callId,
      paused,
      muted: call.muted,
    });
    if (call.botId) this.sendTarget(connection, call.botId);
    this.sendRaw(connection, {
      type: "audio_config",
      format: "pcm16",
      sampleRate: VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1,
    });
    // A Pause coming back is still that call, and Gemini stays closed until
    // Resume: opening it here would bill the empty room. Listening is the
    // call being up, not the model being on the line.
    if (paused || call.muted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    await this.openSession(connection, call, attempt, {});
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
   * After admission, prompt assembly and the upstream upgrade run together.
   * Setup is sent only when both finish, and audio waits for the
   * acknowledgement. A cancelled attempt never starts a paid session.
   */
  private async openSession(
    connection: Connection,
    call: LiveCall,
    attempt: OpeningAttempt,
    options: SessionContinuityV1,
  ): Promise<void> {
    const url = this.geminiUrl();
    if (!url) {
      await this.failOpen(connection, attempt, "unconfigured");
      return;
    }
    if (!this.stillOpening(connection, attempt)) return;
    if (call.paused || call.muted || call.exhausted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    attempt.phase = "preparing";
    call.attemptId = attempt.id;
    call.inboundSequence = undefined;
    call.outboundSequence = 0;
    const timing = this.timingSink(connection);
    const session = new GeminiSessionV1({
      url,
      onEvent: (event) =>
        this.onSessionEvent(connection.id, call.callId, event, attempt.id),
      onClosed: (code, reason) => {
        void this.onSessionClosed(
          connection.id,
          call.callId,
          attempt.id,
          code,
          reason,
        );
      },
      open: (target, signal) => this.openGeminiSocket(target, signal),
      signal: attempt.abort.signal,
      ...(timing ? { timing } : {}),
    });
    attempt.session = session;
    call.session = session;
    this.trace(connection, "upstream", {
      state: "starting",
      attempt: attempt.id,
    });
    this.sendState(connection, call);

    const prompt = this.prepareSessionSetup(connection, call, options);
    try {
      await Promise.all([prompt, session.connect()]);
    } catch (error) {
      if (!this.stillOpening(connection, attempt)) return;
      if (call.paused || call.muted || call.exhausted) {
        this.finishWithoutGemini(connection, call, attempt);
        return;
      }
      this.trace(connection, "upstream-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.timing(connection, "upstream-failed");
      call.session = undefined;
      this.sendState(connection, call);
      await this.failOpen(connection, attempt, "upstream");
      return;
    }
    if (!this.stillOpening(connection, attempt)) {
      session.close();
      return;
    }
    if (call.paused || call.muted || call.exhausted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    const setup = await prompt;
    if (!this.stillOpening(connection, attempt)) {
      session.close();
      return;
    }
    if (call.paused || call.muted || call.exhausted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    this.trace(connection, "upstream-setup", {
      resumed: setup.resumed,
      handover: setup.handover,
      ...(setup.refused ? { reason: setup.refused } : {}),
    });
    if (!setup.resumed) {
      // A function call belongs to the session that issued it, and only a
      // resumed one still knows its id. Answers still owed go in as turns.
      call.subagentCalls.clear();
      call.cancelledCalls.clear();
    }
    attempt.phase = "configuring";
    try {
      await session.configure(setup.frame);
    } catch (error) {
      if (!this.stillOpening(connection, attempt)) return;
      if (call.paused || call.muted || call.exhausted) {
        this.finishWithoutGemini(connection, call, attempt);
        return;
      }
      this.trace(connection, "upstream-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.timing(connection, "upstream-failed");
      call.session = undefined;
      this.sendState(connection, call);
      await this.failOpen(connection, attempt, "upstream");
      return;
    }
    if (!this.stillOpening(connection, attempt)) {
      session.close();
      return;
    }
    if (call.paused || call.muted || call.exhausted) {
      this.finishWithoutGemini(connection, call, attempt);
      return;
    }
    call.setupFingerprint = setup.fingerprint;
    call.lastSystem = setup.instruction;
    attempt.phase = "ready";
    this.sendReady(connection, attempt, call.callId);
    attempt.finish();
    for (const delegation of await this.ledger().unspokenDelegations()) {
      await this.announceDelegation({ runId: delegation.runId });
    }
    this.armIdleSleep(connection, call);
  }

  private async prepareSessionSetup(
    connection: Connection,
    call: LiveCall,
    options: SessionContinuityV1,
  ): Promise<{
    frame: Record<string, unknown>;
    instruction: string;
    fingerprint: string;
    resumed: boolean;
    handover: number;
    refused?: VoiceResumptionRejectV1;
  }> {
    const context = await call.promptContext;
    this.timing(connection, "prompt-context-awaited");
    const runningTasks = (await this.ledger().pendingDelegations()).map(
      (delegation) => ({
        botName: delegation.botName,
        own: delegation.botId === call.botId,
        text: delegation.text,
      }),
    );
    const sessionMemory = voiceOpeningRereadsSessionMemoryV1(options)
      ? await timed(
          this.timingSink(connection),
          "session-voice-memory",
          this.sessionMemoryContext(),
        )
      : context.session;
    const tools = call.botId
      ? VOICE_FUNCTION_DECLARATIONS_V1.map((item) => item.name)
      : VOICE_ACCOUNT_FUNCTION_DECLARATIONS_V1.map((item) => item.name);
    const fingerprint = await voiceSetupFingerprintV1({
      botId: call.botId,
      model: GEMINI_LIVE_MODEL_V1,
      voiceName: call.voice.voiceName,
      tools,
      googleSearch: true,
      memoryIdentity: voiceMemoryIdentityV1({
        durableIds: (sessionMemory?.record.durable ?? []).map(
          (entry) => entry.id,
        ),
        forgottenIds: (sessionMemory?.record.forgotten ?? []).map(
          (entry) => entry.id,
        ),
      }),
    });
    const offer = options.resume
      ? await this.resumptionOffer(call, fingerprint)
      : undefined;
    const handle = offer?.status === "offer" ? offer.handle : undefined;
    // A call that goes on keeps its conversation one way or the other: the
    // handle when it may be offered, and otherwise its own turns so far.
    // Without either the model starts again from nothing mid-call.
    const handover =
      options.handover || (options.resume && !handle)
        ? await this.callHistory(call.callId)
        : [];
    const instruction = renderVoiceSystemPromptV1({
      ...context,
      session: sessionMemory,
      now: this.now(),
      ...(handover.length > 0 ? { handover } : {}),
      ...(runningTasks.length > 0 ? { runningTasks } : {}),
    });
    return {
      instruction,
      fingerprint,
      resumed: Boolean(handle),
      handover: handover.length,
      ...(offer?.status === "fresh" ? { refused: offer.reason } : {}),
      frame: buildGeminiLiveSetupV1({
        systemInstruction: instruction,
        voiceName: call.voice.voiceName,
        functionDeclarations: call.botId
          ? VOICE_FUNCTION_DECLARATIONS_V1
          : VOICE_ACCOUNT_FUNCTION_DECLARATIONS_V1,
        googleSearch: true,
        ...(handle ? { resumptionHandle: handle } : {}),
      }),
    };
  }

  /** Whether this call's stored handle may be offered to the next session. */
  private async resumptionOffer(
    call: LiveCall,
    fingerprint: string,
  ): Promise<VoiceResumptionOfferV1> {
    if (!call.resumptionHandle || !call.resumable) {
      return { status: "fresh", reason: "not-resumable" };
    }
    return offerVoiceResumptionV1({
      record: await this.ledger().resumption(call.callId),
      callId: call.callId,
      botId: call.botId,
      model: GEMINI_LIVE_MODEL_V1,
      fingerprint,
      uncertainEffects: await this.hasUncertainEffects(call),
    });
  }

  private async hasUncertainEffects(call: LiveCall): Promise<boolean> {
    if (call.turnId) return true;
    const pending = await this.ledger().pendingDelegations();
    return pending.some(
      (delegation) =>
        delegation.callId === call.callId &&
        (delegation.state === "admitted" || delegation.state === "settled"),
    );
  }

  private async persistResumption(call: LiveCall): Promise<void> {
    if (!call.setupFingerprint) return;
    const record: VoiceResumptionRecordV1 = {
      schemaVersion: 1,
      callId: call.callId,
      botId: call.botId,
      model: GEMINI_LIVE_MODEL_V1,
      fingerprint: call.setupFingerprint,
      ...(call.resumptionHandle ? { handle: call.resumptionHandle } : {}),
      resumable: call.resumable === true,
      updatedAt: this.now().toISOString(),
      lastSettledTurnSequence: call.turnOrdinal ?? 0,
    };
    await this.ledger().putResumption(record);
  }

  private announceAttempt(
    connection: Connection,
    call: LiveCall,
    mode: VoiceOpeningModeV1,
  ): OpeningAttempt {
    const attempt = this.beginAttempt(connection, {
      attemptId: crypto.randomUUID(),
      mode,
      botId: call.botId,
      paused: call.paused,
      muted: call.muted,
    });
    attempt.owningCallId = call.callId;
    call.attemptId = attempt.id;
    call.inboundSequence = undefined;
    call.outboundSequence = 0;
    this.sendAdmitted(connection, attempt, {
      callId: call.callId,
      paused: call.paused,
      muted: call.muted,
    });
    return attempt;
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
    const envelope = decodeVoiceAssistantPcmEnvelopeV1(bytes);
    if (!envelope) return;
    if (!call.attemptId || envelope.attemptId !== call.attemptId) return;
    const decision = decideVoicePcmSequenceV1(
      call.inboundSequence,
      envelope.sequence,
    );
    if (decision.kind === "drop") return;
    if (decision.kind === "gap") {
      this.trace(connection, "audio-gap", {
        sequence: decision.sequence,
        attempt: envelope.attemptId,
      });
      call.dropping = true;
      this.sendRaw(connection, { type: "playback_interrupt" });
      this.sendError(
        connection,
        "That audio didn’t come through. Say it again.",
      );
      return;
    }
    call.inboundSequence = decision.sequence;
    this.timing(
      connection,
      "client-audio-first",
      { bytes: envelope.pcm.byteLength },
      true,
    );
    session.sendAudio(envelope.pcm);
    this.armIdleSleep(connection, call);
    await this.meterAudio(connection, call, "in", envelope.pcm.byteLength);
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
   * admitted finishes as any Turn would; when it settles, the object wakes
   * this session unless the person paused or muted.
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
    if (await this.honourTurnIntents(connection, call, { reopen: false })) {
      return;
    }
    this.sendState(connection, call);
  }

  /** The other half: reopen, resuming where the conversation was. */
  private async wakeSession(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    if (call.session?.isOpen()) return;
    if (call.waking) {
      await call.waking;
      return;
    }
    if (call.session) return;
    const attempt = this.announceAttempt(connection, call, "wake");
    const opening = this.openSession(connection, call, attempt, {
      resume: true,
    });
    call.waking = opening.finally(() => {
      call.waking = undefined;
    });
    await call.waking;
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
      await this.sealCall(call, this.now());
      await this.armMaintenance();
      await this.beginMemoryFinalization(call);
    }
    await this.releaseCallResources(connection.id);
    if (!call || call.connectionId !== connection.id) return;
    await this.deliverCallTranscript(call);
    // The job was written first, the call record goes second. An eviction
    // between the two leaves a durable intent to finish and a call record
    // that waking will end; the other order leaves a call nobody remembers
    // has to be read.
    await this.ledger().endCall(connection.id);
    await this.ledger().putEndedReceipt({
      schemaVersion: 1,
      callId: call.callId,
      deviceKey: call.deviceKey,
      endedAt: this.now().toISOString(),
    });
    await this.ledger().clearResumption(call.callId);
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
    // What the model asked of this turn goes with the call's memory. A
    // hand-over is already on the ledger, which a rejoin opens on; a goodbye
    // cut off with the socket leaves the call to its rejoin window like any
    // other drop.
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
    attemptId: string,
  ): Promise<void> {
    const live = this.live(connectionId, callId);
    if (!live) return;
    const { connection, call } = live;
    if (call.attemptId && call.attemptId !== attemptId) return;
    switch (event.kind) {
      case "setup-complete":
        this.trace(connection, "upstream", { state: "awake" });
        this.trace(connection, "listening");
        this.timing(connection, "listening", {}, true);
        this.setStatus(connection, call, "listening");
        this.sendState(connection, call);
        return;
      case "audio": {
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
        this.sendBinary(connection, call, event.pcm);
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
      case "input-transcript-interim":
        // Hypothesis while the person is still speaking. Not the ledger.
        this.sendRaw(connection, {
          type: "transcript_interim",
          text: event.text,
        });
        return;
      case "input-transcript":
        // The authoritative SMART final. It often arrives after the model
        // has started answering, which is why the turn's transcript is
        // written again when the turn settles.
        call.transcript =
          `${call.transcript}${call.transcript ? " " : ""}${event.text}`.trim();
        this.prefetchMemory(call, event.text);
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
        await this.finishTurn(connection, call, event.kind);
        return;
      case "tool-call":
        await this.runToolCalls(connection, call, event.calls);
        return;
      case "tool-cancel":
        for (const id of event.ids) call.cancelledCalls.add(id);
        this.trace(connection, "tool-cancelled", { calls: event.ids.length });
        return;
      case "resumption":
        call.resumable = event.resumable;
        if (event.handle) call.resumptionHandle = event.handle;
        if (!event.resumable) call.resumptionHandle = event.handle;
        await this.persistResumption(call);
        return;
      case "go-away":
        this.trace(connection, "upstream-goaway", {
          ...(event.timeLeft ? { timeLeft: event.timeLeft } : {}),
        });
        call.session?.close();
        call.session = undefined;
        // The turn being said cannot go on in another session: an open turn
        // refuses the handle. So whatever it asked for is due now.
        if (await this.honourTurnIntents(connection, call, { reopen: true })) {
          return;
        }
        {
          const next = this.announceAttempt(connection, call, "wake");
          await this.openSession(connection, call, next, { resume: true });
        }
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
    attemptId: string,
    code: number,
    reason: string,
  ): Promise<void> {
    const live = this.live(connectionId, callId);
    if (!live) return;
    const { connection, call } = live;
    if (call.attemptId && call.attemptId !== attemptId) return;
    call.session = undefined;
    this.clearSilenceGuard(call);
    await this.settleOpenTurn(call, {
      failure: `the session closed (${code})`,
    });
    this.trace(connection, "upstream-closed", {
      code,
      reason: reason.slice(0, 200),
    });
    if (await this.honourTurnIntents(connection, call, { reopen: true })) {
      return;
    }
    if (call.exhausted || call.muted || call.paused) {
      this.sendState(connection, call);
      return;
    }
    if (code === GEMINI_LIVE_UNKNOWN_HANDLE_CLOSE_V1 && call.resumptionHandle) {
      call.resumptionHandle = undefined;
      call.resumable = false;
      await this.ledger().clearResumption(call.callId);
      const next = this.announceAttempt(connection, call, "rejoin");
      await this.openSession(connection, call, next, { handover: true });
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
    call.callingGenerationOpen = false;
    call.silenceSaid = false;
    call.dropping = false;
    const traced = this.#traced.get(connection.id);
    if (traced) traced.turns += 1;
    this.setStatus(connection, call, "thinking");
    this.trace(connection, "turn", {
      turn: turnId,
      chars: call.transcript.length,
    });
    this.armSilenceGuard(connection, call);
    return true;
  }

  /**
   * A turn that never makes a sound used to be invisible. The guard is what
   * the speech-provider wrapper was: one sentence to the client, and the
   * call goes on.
   *
   * A function call's results start it again, because the model says
   * nothing until they are back.
   */
  private armSilenceGuard(connection: Connection, call: LiveCall): void {
    this.clearSilenceGuard(call);
    const turnId = call.turnId;
    if (!turnId) return;
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
    call.callingGenerationOpen = false;
    await this.ledger().settleTurn(turnId, outcome, call.transcript.trim());
  }

  /**
   * The model's turn is over.
   *
   * Two frames can say so — `generationComplete` and `turnComplete` — and an
   * interrupted turn may send neither, so whichever arrives first settles the
   * turn and the second finds nothing to do. A hand-over waiting on this turn
   * happens here, which is what ADR 0031 means by honouring `switch_bot`
   * after the spoken turn ends. `end_call` waits the same way.
   *
   * A generation that only called functions does not end the turn. Gemini
   * 3.8 speaks after a tool, never during it: that generation's two frames
   * arrive with nothing said, and the answer is a fresh generation once the
   * results are back. One ledger turn covers both, so what the person said
   * stays with what answered it, the day's allowance counts one question
   * once, and the hand-off burst spans the round trip. Only the calling
   * generation's own frames are passed over; the next generation ends the
   * turn whether or not it says anything.
   */
  private async finishTurn(
    connection: Connection,
    call: LiveCall,
    boundary: "generation-complete" | "turn-complete",
  ): Promise<void> {
    const turnId = call.turnId;
    if (turnId) {
      const silent = call.turnAudioBytes === 0 && !call.dropping;
      if (silent && call.callingGenerationOpen) {
        if (boundary === "turn-complete") call.callingGenerationOpen = false;
        this.trace(connection, "turn-held", { turn: turnId });
        return;
      }
      this.clearSilenceGuard(call);
      const spoken = call.answer.trim();
      const leaving = Boolean(call.pendingEnd || call.pendingSwitch);
      call.turnId = undefined;
      call.callingGenerationOpen = false;
      await this.ledger().settleTurn(
        turnId,
        spoken ? { answer: spoken } : { failure: "no_output" },
        call.transcript.trim(),
      );
      await this.persistResumption(call);
      this.trace(connection, "turn-settled", {
        turn: turnId,
        ms: Math.max(0, Date.now() - (call.turnStartedAt ?? Date.now())),
        answerChars: spoken.length,
        audioBytes: call.turnAudioBytes,
      });
      if (silent && !call.silenceSaid && !leaving) {
        // The turn finished having made no sound at all. The old TTS guard
        // caught this; it is still the person's evidence that something went
        // wrong rather than that nobody answered. A call that is hanging up
        // or moving on has had its answer, even unspoken.
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
      if (spoken) {
        this.sendRaw(connection, { type: "transcript_end", text: spoken });
      }
    }
    if (call.pendingEnd) {
      await this.hangUpForModel(connection, call);
      return;
    }
    this.setStatus(connection, call, "listening");
    if (call.pendingSwitch) {
      await this.applySwitch(connection, call, { reopen: true });
    }
  }

  /**
   * The session went before the turn that asked to hang up or hand over had
   * ended: a sleep, a pause, the allowance, a close, a goAway, a memory write.
   *
   * `end_call` and `switch_bot` wait for their turn only so its last words
   * are heard. With the session gone there is nothing left to hear, so they
   * happen now rather than when some later, unrelated turn ends. The person
   * asked to hang up, so the call ends. The ledger record moved when the tool
   * ran, so the call moves to match, opening the new Bot only if `reopen`
   * and the call may open at all; otherwise the next wake opens it. True
   * when either happened, so the caller does not reopen as well.
   */
  private async honourTurnIntents(
    connection: Connection,
    call: LiveCall,
    options: { reopen: boolean },
  ): Promise<boolean> {
    if (call.pendingEnd) {
      await this.hangUpForModel(connection, call);
      return true;
    }
    if (!call.pendingSwitch) return false;
    await this.applySwitch(connection, call, options);
    return true;
  }

  /** `end_call`, once nothing is left of the goodbye to hear. */
  private async hangUpForModel(
    connection: Connection,
    call: LiveCall,
  ): Promise<void> {
    call.pendingEnd = false;
    await this.endCall(connection);
    try {
      connection.close(1000, "end_call");
    } catch {
      // The client already closed.
    }
  }

  /**
   * Moves the call to the Bot the person asked to be put through to.
   *
   * The ledger record moved when the tool ran; this is the session, which
   * waits for the model's own turn to end so its sign-off is not cut off. The
   * new session is fresh — a different Bot, a different instruction and a
   * different voice — and carries the tail of the call so nothing is lost. A
   * call that may not open one now moves without it: the next wake opens the
   * new Bot, and with no handle to offer carries the same tail.
   */
  private async applySwitch(
    connection: Connection,
    call: LiveCall,
    options: { reopen: boolean },
  ): Promise<void> {
    const target = call.pendingSwitch;
    call.pendingSwitch = undefined;
    // Choosing another Bot on the screen is newer than a goodbye the model
    // agreed to, so the new Bot's first turn does not hang up.
    call.pendingEnd = false;
    call.session?.close();
    call.session = undefined;
    // A resumption handle belongs to the session that issued it, and that
    // session was another Bot. Nothing is resumed across a hand-over.
    call.resumptionHandle = undefined;
    call.resumable = false;
    this.clearSilenceGuard(call);
    await this.settleOpenTurn(call, { failure: "the call was handed over" });
    this.sendTarget(connection, call.botId);
    this.trace(connection, "call-switched", {
      bot: call.botId,
      voice: call.voice.voiceName,
      ...(target ? { requested: target.botId } : {}),
    });
    await this.ledger().clearResumption(call.callId);
    if (!options.reopen || call.paused || call.muted || call.exhausted) {
      this.sendState(connection, call);
      return;
    }
    const next = this.announceAttempt(connection, call, "start");
    await this.openSession(connection, call, next, { handover: true });
  }

  /**
   * Runs what the model asked for and answers it.
   *
   * Answers other than memory's are scheduled `WHEN_IDLE`, so a result never
   * cuts across speech. Gemini 3.8 says nothing until the results are back,
   * so the turn waits for what the model says with them, and the silence
   * guard starts again once they have gone.
   *
   * An answer goes back under its call id only to the session that issued
   * it. A memory write means that session must go once the batch has run,
   * and a sleep or close may take it sooner; either way the turn that asked
   * is over, and what it asked for happens then. The session never spoke
   * again — its frames wait behind this batch — so every answer, including
   * any it was sent, goes in as one turn to the session opened in its place.
   */
  private async runToolCalls(
    connection: Connection,
    call: LiveCall,
    calls: readonly GeminiFunctionCallV1[],
  ): Promise<void> {
    const identity = this.identity(connection);
    if (!identity) return;
    const asker = call.session;
    await this.ensureTurn(connection, call);
    const turnId = call.turnId ?? `${call.callId}:tool`;
    const host = this.turnHost(
      identity.userId,
      call,
      turnId,
      (await call.promptContext).timezone,
    );
    const answered: {
      request: GeminiFunctionCallV1;
      outcome: VoiceToolOutcomeV1;
    }[] = [];
    let invalidated = false;
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
      if (outcome.endCall) {
        call.pendingEnd = true;
      }
      if (call.cancelledCalls.delete(request.id)) continue;
      answered.push({ request, outcome });
      if (outcome.memoryInvalidated) invalidated = true;
      if (invalidated || call.session !== asker) continue;
      const memoryTool = request.name.startsWith("memory_");
      asker?.send(
        encodeGeminiToolResponseV1([
          {
            id: request.id,
            name: request.name,
            response: voiceToolResponseV1(outcome),
            ...(memoryTool ? {} : { scheduling: "WHEN_IDLE" as const }),
          },
        ]),
      );
      if (asker && call.turnId === turnId) call.callingGenerationOpen = true;
    }
    const kept =
      !invalidated &&
      asker !== undefined &&
      call.session === asker &&
      asker.isOpen();
    if (!kept) {
      const live = call.session !== undefined;
      if (invalidated) await this.retireSessionForMemory(call);
      let replaced = await this.honourTurnIntents(connection, call, {
        reopen: live,
      });
      if (!replaced && invalidated && live) {
        const next = this.announceAttempt(connection, call, "start");
        await this.openSession(connection, call, next, { handover: true });
        replaced = true;
      }
      // The session that called is gone, and its generation's boundaries
      // with it: what the replacement says with the results is the answer.
      if (call.turnId === turnId) call.callingGenerationOpen = false;
      if (!replaced || answered.length === 0 || !call.session?.isOpen()) return;
      call.session.send(
        encodeGeminiTextTurnV1(
          renderVoiceToolResultTurnV1(
            answered.map(({ request, outcome }) => ({
              name: request.name,
              args: request.args,
              result: outcome.result,
            })),
          ),
        ),
      );
      this.trace(connection, "tool-results-relayed", {
        calls: answered.length,
      });
    }
    if (
      call.turnId === turnId &&
      call.turnAudioBytes === 0 &&
      !call.silenceSaid
    ) {
      this.armSilenceGuard(connection, call);
    }
  }

  /**
   * Injected memory cannot be withdrawn from a live Gemini session, so it
   * goes, and so does its handle: whatever opens next opens fresh.
   */
  private async retireSessionForMemory(call: LiveCall): Promise<void> {
    if (call.attemptId) this.#memoryPrefetch.cancel(call.attemptId);
    call.session?.close();
    call.session = undefined;
    call.resumptionHandle = undefined;
    call.resumable = false;
    await this.ledger().clearResumption(call.callId);
  }

  private prefetchMemory(call: LiveCall, transcript: string): void {
    const query = transcript.trim();
    if (!call.attemptId || !call.botId || isControlOnlyMemoryInputV1(query)) {
      return;
    }
    const attemptId = call.attemptId;
    const userId = this.name;
    this.#memoryPrefetch.start(attemptId, query, () =>
      this.searchCanonicalMemory(userId, call.botId, query),
    );
  }

  private async searchCanonicalMemory(
    userId: string,
    botId: string,
    query: string,
  ): Promise<string> {
    const authority = voiceMemoryAuthorityV1(userId, botId);
    const result = (await this.botDoor(userId, botId).operateMemory("recall", {
      authority,
      query,
      scopes: [
        productScopeToEngineV1("bot", { userId, botId }),
        productScopeToEngineV1("user", { userId, botId }),
      ],
      effort: "automatic",
    })) as { hits?: Array<{ item?: { text?: string } }>; status?: string };
    const hits = result.hits ?? [];
    if (hits.length === 0)
      return `No memory matches (${result.status ?? "empty"}).`;
    return hits
      .map((hit, index) => `[${index + 1}] ${hit.item?.text ?? ""}`)
      .join("\n");
  }

  private async standingMemoryBotId(
    callId: string,
  ): Promise<string | undefined> {
    const call = await this.ledger().currentCall();
    if (call?.callId === callId && call.botId) return call.botId;
    const sealed = await this.voiceStorage().get<VoiceSealedCallV1>(
      `${VOICE_SEALED_CALL_PREFIX_V1}${callId}`,
    );
    return sealed?.botId;
  }

  private async preparedCoreText(
    userId: string,
    botId: string,
  ): Promise<string | undefined> {
    if (!botId) return undefined;
    try {
      const core = (await this.botDoor(userId, botId).operateMemory(
        "preparedCore",
        {
          authority: voiceMemoryAuthorityV1(userId, botId),
          scopes: [
            productScopeToEngineV1("bot", { userId, botId }),
            productScopeToEngineV1("user", { userId, botId }),
          ],
        },
      )) as { blocks?: Array<{ text?: string }> };
      const text = (core.blocks ?? [])
        .map((block) => block.text ?? "")
        .filter((line) => line.length > 0)
        .join("\n");
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCanonicalMemory(
    userId: string,
    botId: string,
    text: string,
    replaces?: string,
  ): Promise<string> {
    const sentence = text.trim();
    if (!sentence) return "Refused: there was nothing to remember.";
    const secret = refuseMemorySecretV1(sentence);
    if (secret) return `Refused: ${secret.reason}`;
    const result = (await this.botDoor(userId, botId).operateMemory("write", {
      authority: voiceMemoryAuthorityV1(userId, botId),
      scope: productScopeToEngineV1("user", { userId, botId }),
      content: sentence,
      operationKey: `voice:${botId}:${sentence}`,
      subjectKey: "preference",
      ...(replaces ? { replaces } : {}),
      kind: "fact",
    })) as { status?: string; reason?: string };
    if (result.status !== "ok") {
      return `Refused: ${result.reason ?? result.status ?? "memory write failed"}.`;
    }
    return "Kept. Acknowledge it plainly and follow it from here.";
  }

  private async forgetCanonicalMemory(
    userId: string,
    botId: string,
    text: string,
  ): Promise<string> {
    const result = (await this.botDoor(userId, botId).operateMemory("forget", {
      authority: voiceMemoryAuthorityV1(userId, botId),
      scope: productScopeToEngineV1("user", { userId, botId }),
      operationKey: `voice-forget:${botId}:${text}`,
      exactKey: text,
    })) as { status?: string; reason?: string };
    if (result.status !== "ok") {
      return `Refused: ${result.reason ?? "that could not be dropped"}.`;
    }
    return "Dropped. Acknowledge it plainly and do not do it any more.";
  }

  private async expandCanonicalMemory(
    userId: string,
    botId: string,
    itemId: string,
  ): Promise<string> {
    const result = (await this.botDoor(userId, botId).operateMemory("expand", {
      authority: voiceMemoryAuthorityV1(userId, botId),
      sourceRefs: [
        {
          scope: productScopeToEngineV1("user", { userId, botId }),
          itemId,
        },
        {
          scope: productScopeToEngineV1("bot", { userId, botId }),
          itemId,
        },
      ],
    })) as {
      evidence?: Array<{ excerpt?: string; unavailable?: string }>;
      status?: string;
    };
    const lines = (result.evidence ?? []).map(
      (item) => item.excerpt ?? item.unavailable ?? "",
    );
    if (lines.length === 0) return `No evidence (${result.status ?? "empty"}).`;
    return lines.join("\n");
  }

  private async browseCanonicalMemory(
    userId: string,
    botId: string,
    topic?: string,
  ): Promise<string> {
    const result = (await this.botDoor(userId, botId).operateMemory("browse", {
      authority: voiceMemoryAuthorityV1(userId, botId),
      scope: productScopeToEngineV1("user", { userId, botId }),
      ...(topic ? { topic } : {}),
    })) as { sections?: Array<{ title?: string; summary?: string }> };
    const sections = result.sections ?? [];
    if (sections.length === 0) return "Nothing to browse.";
    return sections
      .map(
        (section) => `${section.title ?? "Memory"}: ${section.summary ?? ""}`,
      )
      .join("\n");
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
    directory: BotDirectoryViewV1,
  ): Promise<VoiceCallTargetV1> {
    const attempted = new Set<string>();
    const resolve = async (
      candidate: string | undefined,
    ): Promise<VoiceCallTargetV1 | undefined> => {
      if (!candidate || attempted.has(candidate)) return undefined;
      attempted.add(candidate);
      try {
        return await this.targetFromDirectory(userId, directory, candidate);
      } catch {
        return undefined;
      }
    };
    const requested = await resolve(botId);
    if (requested) return requested;
    // Which Bot is General is recorded by the flock bootstrap, not spelled by
    // a display name a person is free to change.
    const general = await resolve(await this.generalBotId(userId));
    if (general) return general;
    // No General marker does not mean no Bots. Try the remaining membership
    // entries using the directory already read for ownership and voice.
    for (const entry of directory.bots) {
      const fallback = await resolve(entry.botId);
      if (fallback) return fallback;
    }
    return {
      botId: "",
      name: "",
      voice: resolveBotVoiceV1({}),
      directory,
    };
  }

  /** Reads call authority once on the fast path and retries one real failure. */
  private async callDirectory(
    userId: string,
  ): Promise<BotDirectoryViewV1 | undefined> {
    try {
      return await this.directory(userId);
    } catch {
      // Admission is a narrow critical path, but one transient authority read
      // must not silently move an explicitly selected Bot onto the generic
      // identity and omit its Memory. Retry only after a real failure.
      try {
        return await this.directory(userId);
      } catch {
        // Unreadable authority is not an authoritatively empty account. The
        // caller refuses before recording or displacing a call.
        return undefined;
      }
    }
  }

  /**
   * Keeps ownership, voice and prompt preparation on one directory revision.
   * The Bot object remains the authority for its editable identity.
   */
  private async targetFromDirectory(
    userId: string,
    directory: BotDirectoryViewV1,
    botId: string,
  ): Promise<VoiceCallTargetV1> {
    const entry = directory.bots.find((candidate) => candidate.botId === botId);
    if (!entry) throw new Error("that Bot is not in this account");
    const identityStarted = performance.now();
    const identity = await this.botIdentity(userId, botId);
    return {
      ...identity,
      voice: resolveBotVoiceV1({
        ...(entry.voice ? { chosen: entry.voice } : {}),
        characterId: entry.avatar.characterId,
      }),
      directory,
      identityReadDurationMs: Math.max(
        0,
        Math.round(performance.now() - identityStarted),
      ),
    };
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
      rememberLongTerm: async (text, replaces) =>
        this.writeCanonicalMemory(userId, call.botId, text, replaces),
      memorySearch: async (query) => {
        const cached = call.attemptId
          ? this.#memoryPrefetch.take(call.attemptId, query)
          : undefined;
        if (cached) return cached;
        return this.searchCanonicalMemory(userId, call.botId, query);
      },
      memoryExpand: (itemId) =>
        this.expandCanonicalMemory(userId, call.botId, itemId),
      memoryBrowse: (topic) =>
        this.browseCanonicalMemory(userId, call.botId, topic),
      memoryWrite: (text, replaces) =>
        this.writeCanonicalMemory(userId, call.botId, text, replaces),
      memoryForget: (text) =>
        this.forgetCanonicalMemory(userId, call.botId, text),
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
        const count = Math.max(1, Math.min(limit, VOICE_HISTORY_MAX_LIMIT_V1));
        const excerpt = (await this.botDoor(userId, botId).readVoiceContext({
          schemaVersion: 1,
          userId,
          botId,
          limit: count,
        })) as {
          lines: Array<{
            role: "user" | "assistant";
            text: string;
            turn: number;
            at: string;
            runId?: string;
            to?: "user" | "voice" | "bot";
          }>;
        };
        return {
          botId,
          botName: bot.name,
          runs: excerpt.lines.map((line) => ({
            schemaVersion: 4 as const,
            runId: line.runId ?? `turn-${line.turn}`,
            admittedAt: line.at,
            input: line.role === "user" ? line.text : "",
            status: "completed" as const,
            events:
              line.role === "assistant"
                ? [
                    {
                      type: "reply/to-caller" as const,
                      caller:
                        line.to === "bot"
                          ? ("bot" as const)
                          : ("voice" as const),
                      text: line.text,
                    },
                  ]
                : [],
          })),
          hasMore: false,
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
        let bot: VoiceCallTargetV1;
        try {
          const directory = await this.directory(userId);
          bot = await this.targetFromDirectory(userId, directory, target);
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
        call.voice = bot.voice;
        // The Bot's own context is what the next turn wears, so it is read
        // now rather than left to the next turn's critical path.
        call.promptContext = this.buildPromptContext(userId, bot);
        return {
          status: "switched",
          botId: bot.botId,
          name: bot.name,
          message: `Handed over. You are ${bot.name} from here, speaking in your own voice; say so in your reply.`,
        };
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
   * behind them and never makes them yield.
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
          : run.status === "cancelled"
            ? { cancelled: true }
            : { failure: outcome ? outcome.message : run.status },
      this.now(),
    );
    if (!settled || settled.state !== "settled") return;
    await this.announceDelegation({ runId: settled.runId });
  }

  /**
   * A settled answer, handed back to whoever is listening.
   *
   * A live session — the call that asked, or a later one — gets it as that
   * function call's late response, or as a turn when the function call is
   * gone. A quiet-room sleep is still a live call: the object wakes Gemini
   * and then tells it, so a finished task unhibernates. Pause and mute wait
   * for the person. A call that is still on record but has no socket waits
   * inside the rejoin window. With no live call the Bot writes the answer
   * into chat. Public because the scheduler calls it by name.
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
      const live = this.liveCall();
      if (live && (await this.tellLiveSession(live, delegation))) return;
      if (
        live &&
        !live.call.muted &&
        !live.call.exhausted &&
        !live.call.paused &&
        !live.call.session?.isOpen()
      ) {
        await this.wakeSession(live.connection, live.call);
        if (await this.tellLiveSession(live, delegation)) return;
      }
      if (current) {
        await this.scheduleAnnounce(runId);
        return;
      }
      try {
        await this.deliverDelegationToChat(delegation);
      } catch {
        await this.scheduleAnnounce(runId);
        return;
      }
      if (!(await ledger.markDelegationSpoken(runId, this.now()))) return;
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
   * Hands a settled answer to an open Live session, once. False when there
   * is no session to tell, or another writer already marked it spoken.
   */
  private async tellLiveSession(
    live: { connection: Connection; call: LiveCall },
    delegation: VoiceDelegationRecordV1,
  ): Promise<boolean> {
    const { connection, call } = live;
    const session = call.session;
    if (!session?.isOpen()) return false;
    if (
      !(await this.ledger().markDelegationSpoken(delegation.runId, this.now()))
    ) {
      return false;
    }
    const own = delegation.botId === call.botId;
    const told = renderVoiceSubagentResultV1({
      botName: delegation.botName,
      own,
      ...(delegation.answer ? { answer: delegation.answer } : {}),
      ...(delegation.failure ? { failure: delegation.failure } : {}),
    });
    const asked = call.subagentCalls.get(delegation.runId);
    call.subagentCalls.delete(delegation.runId);
    if (asked) {
      session.send(
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
      session.send(encodeGeminiTextTurnV1(told));
    }
    this.trace(connection, "answer-told", {
      run: delegation.runId,
      ...(asked ? { call: asked.id } : { asTurn: true }),
    });
    this.timing(connection, "delegation-answered", {
      run: delegation.runId,
      asTurn: !asked,
    });
    this.sendDelegationState(
      delegation.botId,
      delegation.botName,
      delegation.runId,
      "finished",
    );
    return true;
  }

  /**
   * The hang-up path: the Bot writes the settled answer into its thread so
   * the person can read it after the call.
   */
  private async deliverDelegationToChat(
    delegation: VoiceDelegationRecordV1,
  ): Promise<void> {
    const door = this.botDoor(this.name, delegation.botId);
    const lookup = await door.lookupRun({
      schemaVersion: 1,
      runId: delegation.runId,
    });
    const ordinal =
      lookup.state === "not-admitted"
        ? 0
        : lookup.run.events.filter((event) => event.type === "send/to-user")
            .length;
    await door.deliverVoiceChatResult({
      runId: delegation.runId,
      body: renderVoiceChatResultV1({
        botName: delegation.botName,
        own: true,
        ...(delegation.answer ? { answer: delegation.answer } : {}),
        ...(delegation.failure ? { failure: delegation.failure } : {}),
      }),
      ordinal,
    });
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
      readVoiceContext(input: unknown): Promise<unknown>;
      stopRun(input: unknown): Promise<unknown>;
      readConfiguration(input: unknown): Promise<unknown>;
      deliverVoiceChatResult(input: unknown): Promise<unknown>;
      deliverVoiceCallTranscript(input: unknown): Promise<unknown>;
      operateMemory(input: unknown): Promise<unknown>;
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
      deliverVoiceChatResult: (command: {
        runId: string;
        body: string;
        ordinal: number;
      }) =>
        rpc.deliverVoiceChatResult({
          schemaVersion: 1,
          userId,
          botId,
          command,
        }),
      deliverVoiceCallTranscript: (command: {
        callId: string;
        startedAt: string;
        endedAt: string;
        turns: { transcript: string; answer?: string }[];
      }) =>
        rpc.deliverVoiceCallTranscript({
          schemaVersion: 1,
          userId,
          botId,
          command,
        }),
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
      readVoiceContext: (input: unknown) => rpc.readVoiceContext(input),
      stopRun: (command: {
        schemaVersion: 1;
        action: "stop";
        commandId: string;
        runId: string;
      }) => rpc.stopRun({ schemaVersion: 1, userId, botId, command }),
      operateMemory: (action: string, request: unknown) =>
        rpc.operateMemory({
          schemaVersion: 1,
          userId,
          botId,
          action,
          request,
        }),
    };
  }

  protected async directory(userId: string) {
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
   * What the selected Bot is called, read from its own settings. Opening uses
   * this for the Bot the call is wearing. Other Bots keep the directory
   * projection, which is not a live read.
   */
  protected async botIdentity(
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
   * Opening reuses the directory admission already read. `list_bots` is the
   * path that asks each Bot what it is doing, with bounded concurrency.
   */
  protected async listBots(
    userId: string,
    reuse?: VoiceBotReuseContextV1,
  ): Promise<VoiceBotSummaryV1[]> {
    if (reuse) {
      const directory =
        reuse.target.directory ?? (await this.directory(userId));
      return projectOpeningDirectoryV1({
        directory,
        target: reuse.target,
      });
    }
    const directory = await this.directory(userId);
    return listDirectoryActivityV1(
      projectOpeningDirectoryV1({
        directory,
        target: { botId: "", name: "" },
      }),
      (botId) => this.recentRuns(userId, botId),
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

  protected async recentRuns(
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
    target: VoiceCallTargetV1,
    timing?: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<Omit<VoiceAssistantPromptInputV1, "now">> {
    // The start is marked where the reads are actually issued, which is here
    // — not where `openSession` later awaits the answer. The two are far
    // apart, and a line that said otherwise would put the fan-out's time in
    // the wrong place.
    timing?.("prompt-context-start");
    // Target admission already read membership, appearance and the selected
    // Bot's identity. Reuse that exact snapshot instead of making prompt
    // preparation repeat them.
    const history = timed(
      timing,
      "prompt-bot-history",
      this.loadCurrentBotHistory(userId, target),
    );
    const directory = this.listBots(userId, { target, history }).catch(
      () => [] as VoiceBotSummaryV1[],
    );
    const [bots, memory, timezone, session, bot] = await Promise.all([
      timed(timing, "prompt-directory", directory),
      timed(
        timing,
        "prompt-user-memory",
        this.preparedCoreText(userId, target.botId),
      ),
      timed(timing, "prompt-timezone", this.userTimezone(userId)),
      timed(timing, "prompt-voice-memory", this.sessionMemoryContext()),
      this.buildCurrentBotContext(userId, target, history, timing),
    ]);
    timing?.("prompt-context-ready");
    return {
      bots,
      timezone,
      session,
      ...(bot ? { bot } : {}),
      ...(memory ? { preparedCore: memory } : {}),
      memory: {
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
    target: VoiceCallTargetV1,
    history: Promise<VoiceCurrentHistoryV1 | undefined>,
    timing?: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<VoiceCurrentBotV1 | undefined> {
    const botId = target.botId;
    if (!botId) return undefined;
    const bot = target;
    // Identity was read while resolving the call target. Report that actual
    // cost while reusing the value, rather than measuring an already-resolved
    // Promise and hiding the read behind `target-resolved`.
    timing?.("prompt-bot-identity", {
      durationMs: target.identityReadDurationMs ?? 0,
    });
    const [loadedHistory] = await Promise.all([history]);
    timing?.("prompt-bot-memory", { durationMs: 0 });
    return {
      botId: bot.botId,
      name: bot.name,
      ...(bot.description ? { description: bot.description } : {}),
      ...(loadedHistory?.activity ? { activity: loadedHistory.activity } : {}),
      ...(loadedHistory?.thread ? { thread: loadedHistory.thread } : {}),
    };
  }

  private async loadCurrentBotHistory(
    userId: string,
    target: VoiceCallTargetV1,
  ): Promise<VoiceCurrentHistoryV1 | undefined> {
    if (!target.botId) return undefined;
    try {
      const page = await this.botDoor(userId, target.botId).listRuns();
      const runs = page.runs.slice(-VOICE_HISTORY_DEFAULT_LIMIT_V1);
      return {
        thread: {
          botId: target.botId,
          botName: target.name,
          runs,
          hasMore: page.page.truncated || page.runs.length > runs.length,
        },
        activity: page.runs.some((run) => run.status === "running")
          ? "working"
          : "idle",
      };
    } catch {
      return undefined;
    }
  }
}

function voiceMemoryAuthorityV1(
  userId: string,
  botId: string,
): MemoryAuthorityV1 {
  return {
    userId,
    botId,
    actor: "bot",
    joinedGroupChatIds: [],
    membershipRevision: "0",
  };
}
