// How a timbre preview is minted (ADR 0031).
//
// Gemini Live has no sample endpoint. The same thirty `voiceName`s are
// accepted by Gemini TTS over ordinary `generateContent`, which recites a
// line in that mouth and answers with PCM. The native picker plays the
// resulting clip; a call still uses Live. Style in the line is kept out of
// it so the thirty files are comparable.

import { decodeGeminiBase64V1 } from "./gemini-live.js";

/** TTS model that shares Live's thirty prebuilt voices. */
export const GEMINI_TTS_MODEL_V1 = "gemini-2.5-flash-preview-tts";

export const GEMINI_TTS_ENDPOINT_V1 =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent";

/** The line every clip recites, so two mouths are compared on the same words. */
export const VOICE_PREVIEW_LINE_V1 = "Say: Hi. This is how I sound.";

/** TTS output, and Live's downstream rate, so the native speaker needs no resample. */
export const VOICE_PREVIEW_SAMPLE_RATE_V1 = 24_000;

/** Where the native app loads a minted clip from. */
export function voicePreviewAssetV1(voiceName: string): string {
  return `assets/voices/${voiceName}.wav`;
}

/**
 * The one `generateContent` body that recites [VOICE_PREVIEW_LINE_V1] in
 * `voiceName`. Same `speechConfig` shape Live uses for timbre.
 */
export function buildGeminiTtsPreviewRequestV1(
  voiceName: string,
): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: VOICE_PREVIEW_LINE_V1 }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };
}

export class GeminiTtsPreviewError extends Error {
  override readonly name = "GeminiTtsPreviewError";
}

/**
 * How long to wait after a 429. Prefers `Retry-After`, then the model's
 * "retry in Ns" sentence, then a minute — the free-tier TTS window.
 */
export function retryDelayFromTtsErrorV1(input: {
  status: number;
  message: string;
  retryAfter?: string | null;
}): number | undefined {
  if (input.status !== 429) return undefined;
  const header = input.retryAfter?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const match = /retry in ([0-9.]+)\s*s/i.exec(input.message);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sampleRateFromMimeV1(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return VOICE_PREVIEW_SAMPLE_RATE_V1;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0
    ? rate
    : VOICE_PREVIEW_SAMPLE_RATE_V1;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * PCM16 little-endian mono from a canonical WAV, or empty when the bytes
 * are not one. Used when the model answers with a container instead of raw
 * L16.
 */
export function wavToPcmV1(wav: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
} | null {
  if (wav.length < 44) return null;
  if (readString(wav, 0, 4) !== "RIFF" || readString(wav, 8, 4) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let sampleRate = VOICE_PREVIEW_SAMPLE_RATE_V1;
  let pcm: Uint8Array | undefined;
  while (offset + 8 <= wav.length) {
    const id = readString(wav, offset, 4);
    const size = new DataView(
      wav.buffer,
      wav.byteOffset + offset + 4,
      4,
    ).getUint32(0, true);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);
    if (id === "fmt " && end - start >= 16) {
      const view = new DataView(
        wav.buffer,
        wav.byteOffset + start,
        end - start,
      );
      sampleRate = view.getUint32(4, true) || sampleRate;
    } else if (id === "data") {
      pcm = wav.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  if (!pcm) return null;
  return { pcm, sampleRate };
}

/** A canonical PCM16 mono WAV, the shape the native decoder expects. */
export function pcmToWavV1(
  pcm: Uint8Array,
  sampleRate: number = VOICE_PREVIEW_SAMPLE_RATE_V1,
): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/**
 * The audio part of a TTS `generateContent` response, rewritten as a
 * canonical WAV. An error payload or a missing part throws.
 */
export function wavFromGeminiTtsResponseV1(payload: unknown): Uint8Array {
  if (!isRecord(payload)) {
    throw new GeminiTtsPreviewError("TTS response must be an object");
  }
  if (isRecord(payload.error)) {
    const message =
      typeof payload.error.message === "string" && payload.error.message
        ? payload.error.message
        : "TTS request failed";
    throw new GeminiTtsPreviewError(message);
  }
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new GeminiTtsPreviewError("TTS response has no candidates");
  }
  const content = isRecord(candidates[0]) ? candidates[0].content : undefined;
  const parts = isRecord(content) ? content.parts : undefined;
  if (!Array.isArray(parts)) {
    throw new GeminiTtsPreviewError("TTS response has no audio part");
  }
  for (const part of parts) {
    if (!isRecord(part) || !isRecord(part.inlineData)) continue;
    const data = part.inlineData.data;
    if (typeof data !== "string" || !data) continue;
    const mime =
      typeof part.inlineData.mimeType === "string"
        ? part.inlineData.mimeType
        : "";
    const bytes = decodeGeminiBase64V1(data);
    if (bytes.length === 0) {
      throw new GeminiTtsPreviewError("TTS audio was empty");
    }
    const wav = wavToPcmV1(bytes);
    if (wav) return pcmToWavV1(wav.pcm, wav.sampleRate);
    return pcmToWavV1(bytes, sampleRateFromMimeV1(mime));
  }
  throw new GeminiTtsPreviewError("TTS response has no audio part");
}
