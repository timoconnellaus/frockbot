import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGeminiBase64V1 } from "../app/voice/gemini-live.ts";
import {
  buildGeminiTtsPreviewRequestV1,
  pcmToWavV1,
  wavToPcmV1,
} from "../app/voice/preview.ts";
import { mintVoicePreviewsV1 } from "./mint-voice-previews.ts";

function ttsPayload(pcm: Uint8Array): unknown {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/L16;codec=pcm;rate=24000",
                data: encodeGeminiBase64V1(pcm),
              },
            },
          ],
        },
      },
    ],
  };
}

describe("mintVoicePreviewsV1", () => {
  test("POSTs generateContent for a missing clip and writes a WAV", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "voice-preview-"));
    const seen: { url: string; body: unknown; key: string | null }[] = [];
    const pcm = new Uint8Array([1, 0, 2, 0]);
    const result = await mintVoicePreviewsV1({
      voices: ["Iapetus"],
      outDir,
      apiKey: "secret-key",
      fetch: (async (url, init) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get("x-goog-api-key"),
        });
        return Response.json(ttsPayload(pcm));
      }) as typeof fetch,
    });
    expect(result).toEqual({ written: ["Iapetus"], skipped: [] });
    expect(seen).toEqual([
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
        body: buildGeminiTtsPreviewRequestV1("Iapetus"),
        key: "secret-key",
      },
    ]);
    expect(wavToPcmV1(readFileSync(join(outDir, "Iapetus.wav")))).toEqual({
      pcm,
      sampleRate: 24_000,
    });
  });

  test("leaves an existing clip alone unless forced", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "voice-preview-"));
    const existing = pcmToWavV1(new Uint8Array([9, 9]));
    writeFileSync(join(outDir, "Puck.wav"), existing);
    let calls = 0;
    const skipped = await mintVoicePreviewsV1({
      voices: ["Puck"],
      outDir,
      apiKey: "secret-key",
      fetch: (async () => {
        calls += 1;
        return Response.json(ttsPayload(new Uint8Array([1, 1])));
      }) as typeof fetch,
    });
    expect(skipped).toEqual({ written: [], skipped: ["Puck"] });
    expect(calls).toBe(0);
    expect(readFileSync(join(outDir, "Puck.wav"))).toEqual(existing);

    const forced = await mintVoicePreviewsV1({
      voices: ["Puck"],
      outDir,
      apiKey: "secret-key",
      force: true,
      fetch: (async () =>
        Response.json(ttsPayload(new Uint8Array([3, 3])))) as typeof fetch,
    });
    expect(forced).toEqual({ written: ["Puck"], skipped: [] });
    expect(wavToPcmV1(readFileSync(join(outDir, "Puck.wav")))?.pcm).toEqual(
      new Uint8Array([3, 3]),
    );
  });

  test("waits out a 429 and writes the clip on the next try", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "voice-preview-"));
    const waits: number[] = [];
    const logs: string[] = [];
    let calls = 0;
    const result = await mintVoicePreviewsV1({
      voices: ["Kore"],
      outDir,
      apiKey: "secret-key",
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (line) => logs.push(line),
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { message: "Please retry in 1.2s." } },
            { status: 429 },
          );
        }
        return Response.json(ttsPayload(new Uint8Array([5, 5])));
      }) as typeof fetch,
    });
    expect(result).toEqual({ written: ["Kore"], skipped: [] });
    expect(waits).toEqual([1200]);
    expect(logs).toEqual([
      "Kore: quota, waiting 2s",
      "wrote assets/voices/Kore.wav",
    ]);
    expect(wavToPcmV1(readFileSync(join(outDir, "Kore.wav")))?.pcm).toEqual(
      new Uint8Array([5, 5]),
    );
  });
});
