// The seam a voice call's model sits behind.
//
// A call is one bidirectional session with a speech-to-speech model: the
// person's PCM goes up, the model's own audio comes down, and the model calls
// our functions while it talks. Gemini Live and OpenAI Realtime both do that
// and disagree about every frame, so each is a provider here: where it
// connects, which key it needs, how a frame is written and read, and what it
// cannot do. `apps/cloudflare/src/voice-assistant.ts` owns the socket and every
// decision; it only ever speaks the events and commands below.
//
// Everything here is pure. A codec is stateful only because OpenAI's protocol
// is: which response is running, which function calls are still owed an
// answer, how much of a reply was sent before the person talked over it.

/** Every provider a deployment may choose. */
export type VoiceProviderIdV1 = "gemini-live" | "openai-realtime";

export const VOICE_PROVIDER_IDS_V1: readonly VoiceProviderIdV1[] = [
  "gemini-live",
  "openai-realtime",
];

/** The provider a deployment that chose nothing runs. */
export const DEFAULT_VOICE_PROVIDER_V1: VoiceProviderIdV1 = "gemini-live";

export function isVoiceProviderIdV1(
  value: unknown,
): value is VoiceProviderIdV1 {
  return (
    typeof value === "string" &&
    (VOICE_PROVIDER_IDS_V1 as readonly string[]).includes(value)
  );
}

/**
 * One function the model may call. The parameters are written in Gemini's
 * schema dialect (`OBJECT`, `STRING`), which is where they started; a
 * provider that wants JSON Schema converts them.
 */
export interface VoiceFunctionDeclarationV1 {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Gemini's hint that the model need not wait. Others ignore it. */
  behavior?: "NON_BLOCKING";
}

export interface VoiceFunctionCallV1 {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceUsageV1 {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

/**
 * One fact off the wire, in the object's own words.
 *
 * These are Gemini Live's boundaries, because that is what the object was
 * built against; a provider that frames a reply differently translates into
 * them. `setup-complete` is the one that gates audio: nothing goes up before
 * it. `interrupted` means the person talked over the reply and whatever the
 * client still has queued is for a moment that has passed.
 */
export type VoiceSessionEventV1 =
  | { kind: "setup-complete" }
  | { kind: "audio"; pcm: Uint8Array; mimeType: string }
  | { kind: "output-transcript"; text: string }
  | { kind: "input-transcript"; text: string }
  | { kind: "input-transcript-interim"; text: string }
  | { kind: "generation-complete" }
  | { kind: "turn-complete" }
  | { kind: "interrupted" }
  | { kind: "tool-call"; calls: VoiceFunctionCallV1[] }
  | { kind: "tool-cancel"; ids: string[] }
  | { kind: "resumption"; handle?: string; resumable: boolean }
  | { kind: "go-away"; timeLeft?: string }
  | { kind: "usage"; usage: VoiceUsageV1 }
  /** The provider refused something without closing. Traced, never shown. */
  | { kind: "provider-error"; message: string };

/**
 * An answer to one function call.
 *
 * `whenIdle` asks for it to be spoken at the next pause rather than across
 * whatever the model is saying; a provider without that notion waits for the
 * reply in progress to finish.
 */
export interface VoiceToolAnswerV1 {
  id: string;
  name: string;
  response: Record<string, unknown>;
  whenIdle?: boolean;
}

export interface VoiceSessionSetupV1 {
  /** The rendered per-Bot instruction: persona, then rules, then guardrails. */
  instruction: string;
  /**
   * The Bot's voice, as a name from Gemini's list (ADR 0029): that list is
   * what a Bot's appearance stores. A provider with its own voices maps it.
   */
  voiceName?: string;
  functions: readonly VoiceFunctionDeclarationV1[];
  /** A handle from a previous session. Only offered to a provider that resumes. */
  resumptionHandle?: string;
}

/** What one decoded frame means, and anything the codec must say back. */
export interface VoiceSessionDecodedV1 {
  events: VoiceSessionEventV1[];
  /** Frames the protocol itself owes the server now, in order. */
  replies: string[];
}

/**
 * One session's frames. A fresh codec per socket: its state is that
 * session's and nothing outlives it.
 */
export interface VoiceSessionCodecV1 {
  /** Sent once the socket is open. Audio waits for `setup-complete`. */
  setup(options: VoiceSessionSetupV1): string[];
  /** The person's microphone, one chunk of PCM16 mono at 16 kHz. */
  audio(pcm: Uint8Array): string[];
  /** A whole turn in text, answered as if it had been said. */
  textTurn(text: string): string[];
  toolAnswers(answers: readonly VoiceToolAnswerV1[]): string[];
  decode(raw: string): VoiceSessionDecodedV1;
}

/** Where a session connects. The key is in one of the two, never elsewhere. */
export interface VoiceProviderEndpointV1 {
  url: string;
  headers: Record<string, string>;
}

/**
 * The secret each provider's session is opened with. A deployment secret
 * today; the person's own key, later, arrives as the same string.
 */
export type VoiceProviderKeyNameV1 = "GEMINI_API_KEY" | "OPENAI_API_KEY";

/**
 * What one provider's audio costs, in micro-dollars per second each way,
 * from its published per-token price and the audio tokens a second carries.
 * The daily caps are derived from these, so a provider that costs more gets
 * fewer seconds for the same money.
 */
export interface VoiceProviderRatesV1 {
  inputMicrosPerSecond: number;
  outputMicrosPerSecond: number;
}

export interface VoiceProviderV1 {
  id: VoiceProviderIdV1;
  /** The model a session runs, as its API names it. */
  model: string;
  keyName: VoiceProviderKeyNameV1;
  rates: VoiceProviderRatesV1;
  /**
   * Whether the server hands out handles a later session can resume with.
   * Without them every wake opens fresh and carries the call's own turns.
   */
  resumes: boolean;
  /**
   * The close code for a handle the server no longer knows, so a wake can
   * tell a forgotten handle from a failure. Absent for a provider that does
   * not resume.
   */
  unknownHandleCloseCode?: number;
  /** Whether the session grounds answers in a web search it runs itself. */
  webSearch: boolean;
  /** `standIn` replaces the provider's own endpoint, for tests only. */
  endpoint(key: string, standIn?: string): VoiceProviderEndpointV1;
  codec(): VoiceSessionCodecV1;
}

/**
 * The reference the daily audio caps are written against: Gemini Live's
 * published audio price ($3 and $12 per million tokens, 25 tokens a second),
 * which is what the cap of four hours each way was set for.
 */
export const VOICE_REFERENCE_RATES_V1: VoiceProviderRatesV1 = {
  inputMicrosPerSecond: 75,
  outputMicrosPerSecond: 300,
};

/**
 * The day's audio cap for a provider: the same money the reference cap
 * allows, in that provider's seconds, and never more seconds than the
 * reference. A cheaper provider does not buy a longer day.
 */
export function voiceProviderDailyAudioSecondsV1(
  rates: VoiceProviderRatesV1,
  reference: { audioInSeconds: number; audioOutSeconds: number },
): { audioInSeconds: number; audioOutSeconds: number } {
  const scale = (seconds: number, referenceRate: number, rate: number) =>
    rate <= referenceRate
      ? seconds
      : Math.floor((seconds * referenceRate) / rate);
  return {
    audioInSeconds: scale(
      reference.audioInSeconds,
      VOICE_REFERENCE_RATES_V1.inputMicrosPerSecond,
      rates.inputMicrosPerSecond,
    ),
    audioOutSeconds: scale(
      reference.audioOutSeconds,
      VOICE_REFERENCE_RATES_V1.outputMicrosPerSecond,
      rates.outputMicrosPerSecond,
    ),
  };
}
