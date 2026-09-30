// OpenAI Realtime as a voice call's provider, as a pure module.
//
// One `/v1/realtime` socket carries a whole call, as Gemini Live's does: a
// `session.update` configures it, the person's audio goes up as
// `input_audio_buffer.append`, the model's audio comes down as
// `response.output_audio.delta`, and function calls arrive in `response.done`.
// The shapes are the GA Realtime API's (`session.type: "realtime"`), from
// OpenAI's realtime conversations guide as of 2026-09-30. Dictation speaks the
// transcription-only side of the same protocol in `openai-realtime.ts`.
//
// Where it differs from Gemini, the codec absorbs it so the object does not
// have to know:
//
// - **Rate.** The socket takes PCM16 at 24 kHz and nothing else; the client
//   captures at 16 kHz. Audio is resampled here, going up. Coming down it is
//   24 kHz already, which is the client's own rate.
// - **Responses.** A function result does not make the model speak: the
//   client asks with `response.create`, once every call of the response has
//   its answer, and only while no response is running. The codec keeps which
//   calls are owed and whether a response is live, and asks when it may.
// - **Barge-in.** The server's detector cancels a reply the person talks
//   over, but the client has usually been sent seconds the speaker has not
//   played yet. The codec says `interrupted` whenever speech starts while
//   the last reply could still be audible, and truncates the model's item to
//   what could have been heard so the model does not think it said the rest.
// - **No resumption, no search.** A session is fresh every time; the object
//   carries the call's turns into the instruction instead. Web questions go
//   to `subagent` — the prompt is told so.
// - **Session end.** OpenAI ends a session at sixty minutes with an error;
//   that is read as Gemini's `goAway`, so the object reopens rather than
//   telling the person the line dropped.

import { decodeGeminiBase64V1 } from "./gemini-live.js";
import {
  voiceRealtimeAppendV1,
  VOICE_REALTIME_PCM_RATE_V1,
} from "./openai-realtime.js";
import type {
  VoiceFunctionCallV1,
  VoiceFunctionDeclarationV1,
  VoiceProviderV1,
  VoiceSessionCodecV1,
  VoiceSessionDecodedV1,
  VoiceSessionEventV1,
  VoiceSessionSetupV1,
  VoiceToolAnswerV1,
} from "./provider.js";
import {
  VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
  VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1,
} from "./shared.js";

export const OPENAI_REALTIME_VOICE_MODEL_V1 = "gpt-realtime-2.1";

export const OPENAI_REALTIME_VOICE_ENDPOINT_V1 =
  "wss://api.openai.com/v1/realtime";

/**
 * What hears the person, for the transcript. Not dictation's streaming model:
 * that one refuses any turn detection (`dictation-upstream.ts`), and a call
 * runs on the server's detector.
 */
export const OPENAI_REALTIME_VOICE_TRANSCRIPTION_MODEL_V1 = "gpt-4o-transcribe";

const OUTPUT_BYTES_PER_MS = VOICE_ASSISTANT_OUTPUT_BYTES_PER_SECOND_V1 / 1000;
const OUTPUT_MIME = `audio/pcm;rate=${VOICE_REALTIME_PCM_RATE_V1}`;
/** The upsampler's step, in thirds of an input sample: 2 for 16 kHz to 24 kHz. */
const UPSAMPLE_STEP =
  (VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 * 3) / VOICE_REALTIME_PCM_RATE_V1;

/** The voice a Bot gets when its own has no counterpart here. */
export const DEFAULT_OPENAI_REALTIME_VOICE_V1 = "marin";

/**
 * A Bot's voice is a name from Gemini's thirty (ADR 0029); OpenAI has ten.
 * Each Gemini voice maps by the character Google gives it, so a Bot keeps
 * roughly how it sounded, and the character defaults
 * (`GEMINI_VOICE_BY_CHARACTER_V1`) land on ten different voices out of
 * eleven — Sunny and Rabbit share `shimmer`, the bright one.
 */
export const OPENAI_VOICE_BY_GEMINI_VOICE_V1: Readonly<Record<string, string>> =
  {
    Zephyr: "shimmer", // bright
    Puck: "shimmer", // upbeat
    Charon: "echo", // informative
    Kore: "ash", // firm
    Fenrir: "verse", // excitable
    Leda: "shimmer", // youthful
    Orus: "ash", // firm
    Aoede: "marin", // breezy
    Callirrhoe: "marin", // easy-going
    Autonoe: "shimmer", // bright
    Enceladus: "ballad", // breathy
    Iapetus: "echo", // clear
    Umbriel: "marin", // easy-going
    Algieba: "cedar", // smooth
    Despina: "echo", // smooth
    Erinome: "echo", // clear
    Algenib: "ash", // gravelly
    Rasalgethi: "echo", // informative
    Laomedeia: "shimmer", // upbeat
    Achernar: "sage", // soft
    Alnilam: "ash", // firm
    Schedar: "alloy", // even
    Gacrux: "ballad", // mature
    Pulcherrima: "coral", // forward
    Achird: "coral", // friendly
    Zubenelgenubi: "verse", // casual
    Vindemiatrix: "sage", // gentle
    Sadachbia: "verse", // lively
    Sadaltager: "cedar", // knowledgeable
    Sulafat: "cedar", // warm
  };

export function openAiVoiceForV1(geminiVoiceName: string | undefined): string {
  return (
    (geminiVoiceName
      ? OPENAI_VOICE_BY_GEMINI_VOICE_V1[geminiVoiceName]
      : undefined) ?? DEFAULT_OPENAI_REALTIME_VOICE_V1
  );
}

/**
 * The declarations are written in Gemini's dialect; OpenAI takes JSON Schema,
 * which differs in the case of its type names and nothing else we use.
 */
export function openAiToolSchemaV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(openAiToolSchemaV1);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      key === "type" && typeof entry === "string"
        ? entry.toLowerCase()
        : key === "properties" && entry && typeof entry === "object"
          ? Object.fromEntries(
              Object.entries(entry as Record<string, unknown>).map(
                ([name, schema]) => [name, openAiToolSchemaV1(schema)],
              ),
            )
          : openAiToolSchemaV1(entry);
  }
  return out;
}

export function buildOpenAiRealtimeSessionV1(
  options: VoiceSessionSetupV1,
): Record<string, unknown> {
  const format = { type: "audio/pcm", rate: VOICE_REALTIME_PCM_RATE_V1 };
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: OPENAI_REALTIME_VOICE_MODEL_V1,
      instructions: options.instruction,
      output_modalities: ["audio"],
      audio: {
        input: {
          format,
          transcription: {
            model: OPENAI_REALTIME_VOICE_TRANSCRIPTION_MODEL_V1,
          },
          // The semantic detector waits for a finished thought rather than a
          // pause, which is the nearest thing to Gemini's own; a cough is not
          // a thought.
          turn_detection: {
            type: "semantic_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format, voice: openAiVoiceForV1(options.voiceName) },
      },
      tools: options.functions.map(
        (declaration: VoiceFunctionDeclarationV1) => ({
          type: "function",
          name: declaration.name,
          description: declaration.description,
          parameters: openAiToolSchemaV1(declaration.parameters),
        }),
      ),
      tool_choice: "auto",
    },
  };
}

/**
 * 16 kHz to 24 kHz, linear, across chunk boundaries. Positions are kept in
 * thirds of an input sample so the 2:3 step never drifts.
 */
export class OpenAiRealtimeUpsamplerV1 {
  private previous: number | undefined;
  private position = 0;

  push(pcm: Uint8Array): Uint8Array {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const offset = this.previous === undefined ? 0 : 1;
    const length = Math.floor(pcm.byteLength / 2) + offset;
    if (length === 0) return new Uint8Array(0);
    const previous = this.previous ?? 0;
    const sample = (index: number): number =>
      index < offset ? previous : view.getInt16((index - offset) * 2, true);
    // `position` is in thirds; the last sample is only interpolated from once
    // the next chunk supplies its neighbour, so the last output lands on it.
    const last = (length - 1) * 3;
    const count =
      this.position > last
        ? 0
        : Math.floor((last - this.position) / UPSAMPLE_STEP) + 1;
    const bytes = new Uint8Array(count * 2);
    const out = new DataView(bytes.buffer);
    for (let written = 0; written < count; written += 1) {
      const index = Math.floor(this.position / 3);
      const fraction = (this.position % 3) / 3;
      const value =
        fraction === 0
          ? sample(index)
          : sample(index) * (1 - fraction) + sample(index + 1) * fraction;
      out.setInt16(written * 2, Math.round(value), true);
      this.position += UPSAMPLE_STEP;
    }
    this.position -= last;
    this.previous = sample(length - 1);
    return bytes;
  }
}

const ACTIVE_RESPONSE_CODE = "conversation_already_has_active_response";
const QUIET_ERROR_CODES = new Set([
  ACTIVE_RESPONSE_CODE,
  "response_cancel_not_active",
]);
const SESSION_EXPIRED_CODE = "session_expired";

/**
 * One session's state. `now` is injected so a test can say how much of a
 * reply the speaker could have played.
 */
export class OpenAiRealtimeVoiceCodecV1 implements VoiceSessionCodecV1 {
  private configured = false;
  private responding = false;
  /** A turn or an answer wants a response once the running one is done. */
  private respondAfter = false;
  /** Function calls from the last response that have no answer yet. */
  private owed = new Set<string>();
  /** Calls already answered, so a second answer goes in as a turn. */
  private answered = new Set<string>();
  /** The reply the speaker may still be playing. */
  private reply: { itemId: string; bytes: number; firstAt: number } | undefined;
  private readonly upsampler = new OpenAiRealtimeUpsamplerV1();

  constructor(private readonly now: () => number = () => Date.now()) {}

  setup(options: VoiceSessionSetupV1): string[] {
    return [JSON.stringify(buildOpenAiRealtimeSessionV1(options))];
  }

  audio(pcm: Uint8Array): string[] {
    const upsampled = this.upsampler.push(pcm);
    if (upsampled.byteLength === 0) return [];
    return [voiceRealtimeAppendV1(upsampled)];
  }

  textTurn(text: string): string[] {
    return [this.message(text), ...this.respond()];
  }

  toolAnswers(answers: readonly VoiceToolAnswerV1[]): string[] {
    const frames: string[] = [];
    let late = false;
    for (const answer of answers) {
      if (this.owed.delete(answer.id) || !this.answered.has(answer.id)) {
        this.answered.add(answer.id);
        frames.push(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: answer.id,
              output: JSON.stringify(answer.response),
            },
          }),
        );
        continue;
      }
      // The call was answered once already — `subagent` says it has started
      // — and a function call takes one output. Its real result is a turn.
      const result = answer.response.result;
      frames.push(
        this.message(
          typeof result === "string" ? result : JSON.stringify(answer.response),
        ),
      );
      late = true;
    }
    if (this.owed.size === 0 || late) frames.push(...this.respond());
    return frames;
  }

  decode(raw: string): VoiceSessionDecodedV1 {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { events: [], replies: [] };
    }
    if (!isRecord(parsed)) return { events: [], replies: [] };
    const events: VoiceSessionEventV1[] = [];
    const replies: string[] = [];
    const type = typeof parsed.type === "string" ? parsed.type : "";
    switch (type) {
      case "session.updated":
        if (!this.configured) {
          this.configured = true;
          events.push({ kind: "setup-complete" });
        }
        break;
      case "response.created":
        this.responding = true;
        this.reply = undefined;
        break;
      case "response.output_audio.delta": {
        if (typeof parsed.delta !== "string") break;
        const pcm = decodeGeminiBase64V1(parsed.delta);
        if (pcm.byteLength === 0) break;
        const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
        if (!this.reply || this.reply.itemId !== itemId) {
          this.reply = { itemId, bytes: 0, firstAt: this.now() };
        }
        this.reply.bytes += pcm.byteLength;
        events.push({
          kind: "audio",
          pcm,
          mimeType: OUTPUT_MIME,
        });
        break;
      }
      case "response.output_audio_transcript.delta":
        if (typeof parsed.delta === "string" && parsed.delta) {
          events.push({ kind: "output-transcript", text: parsed.delta });
        }
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof parsed.delta === "string" && parsed.delta) {
          events.push({ kind: "input-transcript-interim", text: parsed.delta });
        }
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text =
          typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
        if (text) events.push({ kind: "input-transcript", text });
        break;
      }
      case "input_audio_buffer.speech_started": {
        const heard = this.audibleMs();
        if (heard === undefined || !this.reply) break;
        events.push({ kind: "interrupted" });
        if (this.reply.itemId) {
          replies.push(
            JSON.stringify({
              type: "conversation.item.truncate",
              item_id: this.reply.itemId,
              content_index: 0,
              audio_end_ms: heard,
            }),
          );
        }
        this.reply = undefined;
        break;
      }
      case "response.done": {
        this.responding = false;
        const response = isRecord(parsed.response) ? parsed.response : {};
        const status =
          typeof response.status === "string" ? response.status : "completed";
        const calls =
          status === "completed" ? functionCalls(response.output) : [];
        if (calls.length > 0) {
          for (const call of calls) this.owed.add(call.id);
          events.push({ kind: "tool-call", calls });
        }
        const usage = isRecord(response.usage) ? response.usage : undefined;
        if (usage) {
          events.push({
            kind: "usage",
            usage: {
              promptTokens: count(usage.input_tokens),
              responseTokens: count(usage.output_tokens),
              totalTokens: count(usage.total_tokens),
            },
          });
        }
        events.push({ kind: "turn-complete" });
        if (this.respondAfter && this.owed.size === 0) {
          replies.push(...this.respond());
        }
        break;
      }
      case "error": {
        const error = isRecord(parsed.error) ? parsed.error : {};
        const code = typeof error.code === "string" ? error.code : "";
        if (code === ACTIVE_RESPONSE_CODE) this.respondAfter = true;
        if (code === SESSION_EXPIRED_CODE) {
          events.push({ kind: "go-away" });
          break;
        }
        if (QUIET_ERROR_CODES.has(code)) break;
        events.push({
          kind: "provider-error",
          message:
            typeof error.message === "string"
              ? error.message
              : "the voice service refused a request",
        });
        break;
      }
    }
    return { events, replies };
  }

  /**
   * How much of the last reply the speaker could have played, while it could
   * still be playing; undefined once it has all been heard.
   */
  private audibleMs(): number | undefined {
    if (!this.reply) return undefined;
    const sent = Math.floor(this.reply.bytes / OUTPUT_BYTES_PER_MS);
    const elapsed = Math.max(0, this.now() - this.reply.firstAt);
    if (elapsed >= sent && !this.responding) return undefined;
    return Math.min(sent, elapsed);
  }

  private message(text: string): string {
    return JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  }

  private respond(): string[] {
    if (this.responding) {
      this.respondAfter = true;
      return [];
    }
    this.respondAfter = false;
    this.responding = true;
    return [JSON.stringify({ type: "response.create" })];
  }
}

function functionCalls(output: unknown): VoiceFunctionCallV1[] {
  if (!Array.isArray(output)) return [];
  const calls: VoiceFunctionCallV1[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    if (typeof item.name !== "string" || !item.name) continue;
    if (typeof item.call_id !== "string" || !item.call_id) continue;
    let args: Record<string, unknown> = {};
    if (typeof item.arguments === "string" && item.arguments) {
      try {
        const value = JSON.parse(item.arguments) as unknown;
        if (isRecord(value)) args = value;
      } catch {
        // Unreadable arguments are no arguments; the tool refuses them.
      }
    }
    calls.push({ id: item.call_id, name: item.name, args });
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const openAiRealtimeVoiceProviderV1: VoiceProviderV1 = {
  id: "openai-realtime",
  model: OPENAI_REALTIME_VOICE_MODEL_V1,
  keyName: "OPENAI_API_KEY",
  // $32 and $64 per million audio tokens; a second of the person is ten
  // tokens and a second of the model twenty.
  rates: { inputMicrosPerSecond: 320, outputMicrosPerSecond: 1280 },
  resumes: false,
  webSearch: false,
  endpoint(key, standIn) {
    const base = standIn ?? OPENAI_REALTIME_VOICE_ENDPOINT_V1;
    const separator = base.includes("?") ? "&" : "?";
    return {
      url: `${base}${separator}model=${encodeURIComponent(OPENAI_REALTIME_VOICE_MODEL_V1)}`,
      headers: { Authorization: `Bearer ${key}` },
    };
  },
  codec: () => new OpenAiRealtimeVoiceCodecV1(),
};
