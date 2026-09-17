// The Gemini Live wire, as a pure module.
//
// One `bidiGenerateContent` socket carries a whole call: the setup frame, the
// person's audio going up, the model's audio coming down, its transcriptions,
// its tool calls and our answers to them. None of that needs a socket to be
// built or read, so none of it is done in the Durable Object — this file
// builds the frames and decodes the ones that come back, and
// `apps/cloudflare/src/voice-assistant.ts` does the I/O.
//
// Every shape here was observed against the live API on 2026-09-17 and is
// written down in `docs/voice-gemini-probe.md`. Where the API disagreed with
// ADR 0031 the API won; the two places it did are commented below.

/** The model one call runs on. Named with the `models/` prefix the API wants. */
export const GEMINI_LIVE_MODEL_V1 = "models/gemini-3.8-live";

export const GEMINI_LIVE_ENDPOINT_V1 =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** What the model hears: PCM16 mono, little-endian, at this rate. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE_V1 = 16_000;
/** What it answers with. The client's own downstream rate, so nothing resamples. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE_V1 = 24_000;
export const GEMINI_LIVE_INPUT_MIME_V1 = `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE_V1}`;

/**
 * The close code for a handle the server does not know, as opposed to the
 * 1007 it closes a malformed frame with. It is the only signal that a
 * resumption window has passed, so wake reads it to decide between resuming
 * and starting fresh with a handover.
 */
export const GEMINI_LIVE_UNKNOWN_HANDLE_CLOSE_V1 = 1008;

/**
 * The key goes in the query string: a WebSocket opened this way carries no
 * headers of ours, which is why the key never leaves the Durable Object.
 */
export function geminiLiveUrlV1(
  apiKey: string,
  endpoint: string = GEMINI_LIVE_ENDPOINT_V1,
): string {
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}key=${encodeURIComponent(apiKey)}`;
}

// ---------------------------------------------------------------------------
// base64

/** PCM16 bytes as the base64 the API takes. */
export function encodeGeminiBase64V1(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a whole audio part overflows
  // the argument list, and a call's audio arrives in hundreds of these.
  let binary = "";
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride));
  }
  return btoa(binary);
}

/** The reverse. An unreadable string is empty audio rather than a throw. */
export function decodeGeminiBase64V1(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Setup

/**
 * One tool the model may call, as the API declares it.
 *
 * `behavior: "NON_BLOCKING"` is accepted (probed) and is what lets the model
 * keep talking while we run the tool — the feature ADR 0031's whole design
 * rests on.
 */
export interface GeminiFunctionDeclarationV1 {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  behavior?: "NON_BLOCKING";
}

export interface GeminiLiveSetupOptionsV1 {
  /** The rendered per-Bot instruction: persona, then rules, then guardrails. */
  systemInstruction: string;
  /** One of Gemini's prebuilt voices. Absent leaves the API's own default. */
  voiceName?: string;
  functionDeclarations?: readonly GeminiFunctionDeclarationV1[];
  /** Grounding the session runs itself. */
  googleSearch?: boolean;
  /** A handle from a previous session, so wake continues rather than restarts. */
  resumptionHandle?: string;
  model?: string;
}

/**
 * The one frame that opens a session.
 *
 * Two fields the ADR asked for are deliberately absent, both because the API
 * said so (`docs/voice-gemini-probe.md`):
 *
 * - `enableAffectiveDialog`. The setup is accepted with it and then the first
 *   content frame closes the socket with 1007. Delivery goes through the
 *   persona prose instead.
 * - `speechConfig.languageCode`. This one is accepted — the ADR's premise that
 *   native audio rejects it does not hold — but the decision stands: language
 *   is pinned in prose, beside the accent it travels with.
 */
export function buildGeminiLiveSetupV1(
  options: GeminiLiveSetupOptionsV1,
): Record<string, unknown> {
  const tools: Record<string, unknown>[] = [];
  if (options.googleSearch) tools.push({ googleSearch: {} });
  if (options.functionDeclarations && options.functionDeclarations.length > 0) {
    tools.push({
      functionDeclarations: options.functionDeclarations.map(
        (declaration): Record<string, unknown> => ({
          name: declaration.name,
          description: declaration.description,
          parameters: declaration.parameters,
          ...(declaration.behavior ? { behavior: declaration.behavior } : {}),
        }),
      ),
    });
  }
  return {
    setup: {
      model: options.model ?? GEMINI_LIVE_MODEL_V1,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(options.voiceName
          ? {
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: options.voiceName },
                },
              },
            }
          : {}),
      },
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      // Both directions transcribed: the client's transcript frames are the
      // only text a call has, and the ledger's turn records are built from it.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Asking for resumption is what makes the server hand out handles at
      // all; a session that never asks cannot be woken.
      sessionResumption: options.resumptionHandle
        ? { handle: options.resumptionHandle }
        : {},
      ...(tools.length > 0 ? { tools } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Client frames

/** The person's microphone, one chunk. */
export function encodeGeminiAudioFrameV1(
  pcm: Uint8Array,
): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        data: encodeGeminiBase64V1(pcm),
        mimeType: GEMINI_LIVE_INPUT_MIME_V1,
      },
    },
  };
}

/**
 * A whole turn in text. `role` is required: without it the socket closes with
 * 1007, which is a whole call lost to a field nobody can see.
 */
export function encodeGeminiTextTurnV1(text: string): Record<string, unknown> {
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  };
}

/**
 * "Say something now, unprompted." The observed frame for an opening line: no
 * turn content at all, just the boundary.
 */
export function encodeGeminiTurnBoundaryV1(): Record<string, unknown> {
  return { clientContent: { turnComplete: true } };
}

export function encodeGeminiAudioStreamEndV1(): Record<string, unknown> {
  return { realtimeInput: { audioStreamEnd: true } };
}

/**
 * When a late answer is spoken.
 *
 * `WHEN_IDLE` waits for the floor, `INTERRUPT` takes it, `SILENT` goes into
 * the context without a word. An unknown value closes the socket, so these
 * three spellings are exact.
 */
export type GeminiToolSchedulingV1 = "WHEN_IDLE" | "INTERRUPT" | "SILENT";

export interface GeminiToolAnswerV1 {
  id: string;
  name: string;
  response: Record<string, unknown>;
  scheduling?: GeminiToolSchedulingV1;
}

export function encodeGeminiToolResponseV1(
  answers: readonly GeminiToolAnswerV1[],
): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: answers.map((answer) => ({
        id: answer.id,
        name: answer.name,
        response: answer.response,
        ...(answer.scheduling ? { scheduling: answer.scheduling } : {}),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Server frames

export interface GeminiFunctionCallV1 {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiUsageV1 {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

/**
 * One fact off the wire. A single server frame can carry several — audio and
 * a transcription fragment ride the same `serverContent`, and `turnComplete`
 * arrives with `usageMetadata` beside it — so decoding answers with a list.
 */
export type GeminiServerEventV1 =
  | { kind: "setup-complete" }
  | { kind: "audio"; pcm: Uint8Array; mimeType: string }
  | { kind: "output-transcript"; text: string }
  | { kind: "input-transcript"; text: string }
  | { kind: "generation-complete" }
  | { kind: "turn-complete" }
  | { kind: "interrupted" }
  | { kind: "tool-call"; calls: GeminiFunctionCallV1[] }
  | { kind: "tool-cancel"; ids: string[] }
  | { kind: "resumption"; handle?: string; resumable: boolean }
  | { kind: "go-away"; timeLeft?: string }
  | { kind: "usage"; usage: GeminiUsageV1 };

/**
 * Decodes one text frame.
 *
 * Bare `{}` frames arrive constantly — several between every pair of content
 * frames — and carry nothing, so anything unrecognised answers with an empty
 * list rather than a throw: a session must not die because Google added a
 * field.
 */
export function decodeGeminiServerFrameV1(raw: string): GeminiServerEventV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const value = parsed as Record<string, unknown>;
  const events: GeminiServerEventV1[] = [];
  if (isRecord(value.setupComplete)) events.push({ kind: "setup-complete" });
  const content = value.serverContent;
  if (isRecord(content)) {
    const turn = content.modelTurn;
    if (isRecord(turn) && Array.isArray(turn.parts)) {
      for (const part of turn.parts) {
        if (!isRecord(part)) continue;
        const inline = part.inlineData;
        if (!isRecord(inline)) continue;
        const data = inline.data;
        if (typeof data !== "string") continue;
        events.push({
          kind: "audio",
          pcm: decodeGeminiBase64V1(data),
          mimeType: typeof inline.mimeType === "string" ? inline.mimeType : "",
        });
      }
    }
    const output = content.outputTranscription;
    if (isRecord(output) && typeof output.text === "string" && output.text) {
      events.push({ kind: "output-transcript", text: output.text });
    }
    const input = content.inputTranscription;
    if (isRecord(input) && typeof input.text === "string" && input.text) {
      events.push({ kind: "input-transcript", text: input.text });
    }
    // `interrupted` before the boundaries: the model was cut off, and the
    // client must drop what it is playing before it is told the turn is over.
    if (content.interrupted === true) events.push({ kind: "interrupted" });
    if (content.generationComplete === true) {
      events.push({ kind: "generation-complete" });
    }
    if (content.turnComplete === true) events.push({ kind: "turn-complete" });
  }
  const toolCall = value.toolCall;
  if (isRecord(toolCall) && Array.isArray(toolCall.functionCalls)) {
    const calls: GeminiFunctionCallV1[] = [];
    for (const entry of toolCall.functionCalls) {
      if (!isRecord(entry)) continue;
      if (typeof entry.name !== "string" || !entry.name) continue;
      calls.push({
        // The server names the call; a declaration with no id is answered
        // under the empty string, which the object treats as unanswerable.
        id: typeof entry.id === "string" ? entry.id : "",
        name: entry.name,
        args: isRecord(entry.args) ? entry.args : {},
      });
    }
    if (calls.length > 0) events.push({ kind: "tool-call", calls });
  }
  const cancellation = value.toolCallCancellation;
  if (isRecord(cancellation) && Array.isArray(cancellation.ids)) {
    const ids = cancellation.ids.filter(
      (id): id is string => typeof id === "string",
    );
    if (ids.length > 0) events.push({ kind: "tool-cancel", ids });
  }
  const resumption = value.sessionResumptionUpdate;
  if (isRecord(resumption)) {
    events.push({
      kind: "resumption",
      ...(typeof resumption.newHandle === "string"
        ? { handle: resumption.newHandle }
        : {}),
      resumable: resumption.resumable === true,
    });
  }
  const goAway = value.goAway;
  if (isRecord(goAway)) {
    events.push({
      kind: "go-away",
      ...(typeof goAway.timeLeft === "string"
        ? { timeLeft: goAway.timeLeft }
        : {}),
    });
  }
  const usage = value.usageMetadata;
  if (isRecord(usage)) {
    events.push({
      kind: "usage",
      usage: {
        promptTokens: number(usage.promptTokenCount),
        responseTokens: number(usage.responseTokenCount),
        totalTokens: number(usage.totalTokenCount),
      },
    });
  }
  return events;
}

/**
 * The rate an audio part declares, or the output rate when it declares none.
 * Only ever 24 kHz in practice; read rather than assumed because the client is
 * told a rate once, in `audio_config`, and a session that started answering at
 * another one would play back wrong with nothing saying so.
 */
export function geminiAudioRateV1(mimeType: string): number {
  const matched = /rate=(\d+)/.exec(mimeType);
  return matched ? Number(matched[1]) : GEMINI_LIVE_OUTPUT_SAMPLE_RATE_V1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
