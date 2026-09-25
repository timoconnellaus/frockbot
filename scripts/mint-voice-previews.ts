// Mint the thirty Gemini timbre clips the native picker plays.
//
// Gemini TTS recites one line in each Live `voiceName` over HTTP. The clips
// live in `apps/native/assets/voices/` and are shipped with the app; this
// script is how they are remade, not a runtime path. It spends money and
// needs `GEMINI_API_KEY`, so it is never part of CI.
//
//   bun scripts/mint-voice-previews.ts
//   bun scripts/mint-voice-previews.ts --force
//   bun scripts/mint-voice-previews.ts Iapetus Puck
//
// The key is read from apps/cloudflare/.dev.vars (gitignored), the same file
// the Live probe uses. An inherited GEMINI_API_KEY does not override it.
// The CLI paces 1.5s between writes.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GEMINI_VOICES_V1 } from "../app/voice/appearance.ts";
import {
  buildGeminiTtsPreviewRequestV1,
  GEMINI_TTS_ENDPOINT_V1,
  GeminiTtsPreviewError,
  retryDelayFromTtsErrorV1,
  voicePreviewAssetV1,
  wavFromGeminiTtsResponseV1,
} from "../app/voice/preview.ts";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "apps/native/assets/voices");

function readApiKeyV1(): string {
  // The project's key lives in .dev.vars. An inherited GEMINI_API_KEY in the
  // environment is a different key (and has been a free-tier one), so the
  // file wins whenever it is present — same rule as the Live probe.
  const path = resolve(root, "apps/cloudflare/.dev.vars");
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("GEMINI_API_KEY=")) continue;
      const value = trimmed.slice("GEMINI_API_KEY=".length).trim();
      const key = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (key) return key;
    }
  } catch {
    /* Fall through to the environment. */
  }
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  throw new Error("GEMINI_API_KEY is not in apps/cloudflare/.dev.vars");
}

export interface MintVoicePreviewsOptionsV1 {
  voices: readonly string[];
  outDir: string;
  apiKey: string;
  force?: boolean;
  fetch?: typeof fetch;
  /** Pause between successful writes so a free-tier key stays under 3 RPM. */
  paceMs?: number;
  /** Floor on a 429 wait. Failed requests still occupy the RPM window. */
  minRetryMs?: number;
  /** Test seam: replace `setTimeout` so a 429 retry does not wait. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface MintVoicePreviewsResultV1 {
  written: string[];
  skipped: string[];
}

function clipPathV1(directory: string, voiceName: string): string {
  return resolve(directory, `${voiceName}.wav`);
}

async function mintOneV1(
  voiceName: string,
  options: {
    apiKey: string;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
    minRetryMs: number;
  },
): Promise<Uint8Array> {
  for (;;) {
    const response = await options.fetch(GEMINI_TTS_ENDPOINT_V1, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify(buildGeminiTtsPreviewRequestV1(voiceName)),
    });
    const payload: unknown = await response.json();
    try {
      return wavFromGeminiTtsResponseV1(payload);
    } catch (error) {
      const message =
        error instanceof GeminiTtsPreviewError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      const wait = retryDelayFromTtsErrorV1({
        status: response.status,
        message,
        retryAfter: response.headers.get("retry-after"),
      });
      if (wait !== undefined) {
        const delay = Math.max(wait, options.minRetryMs);
        options.log(`${voiceName}: quota, waiting ${Math.ceil(delay / 1000)}s`);
        await options.sleep(delay);
        continue;
      }
      if (!response.ok) {
        throw new GeminiTtsPreviewError(
          `${voiceName}: HTTP ${response.status}: ${message}`,
        );
      }
      throw error;
    }
  }
}

/** Writes each named clip unless it already exists and `--force` was not set. */
export async function mintVoicePreviewsV1(
  options: MintVoicePreviewsOptionsV1,
): Promise<MintVoicePreviewsResultV1> {
  mkdirSync(options.outDir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.log;
  for (const voiceName of options.voices) {
    const path = clipPathV1(options.outDir, voiceName);
    if (!options.force && existsSync(path)) {
      skipped.push(voiceName);
      continue;
    }
    const wav = await mintOneV1(voiceName, {
      apiKey: options.apiKey,
      fetch: fetchImpl,
      sleep,
      log,
      minRetryMs: options.minRetryMs ?? 0,
    });
    writeFileSync(path, wav);
    written.push(voiceName);
    log(`wrote ${voicePreviewAssetV1(voiceName)}`);
    const remaining = options.voices.length - skipped.length - written.length;
    if ((options.paceMs ?? 0) > 0 && remaining > 0) {
      log(`pacing ${Math.ceil((options.paceMs ?? 0) / 1000)}s`);
      await sleep(options.paceMs ?? 0);
    }
  }
  return { written, skipped };
}

function redact(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("<key>") : text;
}

async function main(apiKey: string): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const named = argv.filter((arg) => arg !== "--force");
  const voices =
    named.length > 0 ? named : GEMINI_VOICES_V1.map((voice) => voice.voiceName);
  const unknown = voices.filter(
    (name) => !GEMINI_VOICES_V1.some((voice) => voice.voiceName === name),
  );
  if (unknown.length > 0) {
    throw new Error(`not a Gemini voice: ${unknown.join(", ")}`);
  }
  const result = await mintVoicePreviewsV1({
    voices,
    outDir,
    apiKey,
    force,
    // Free-tier TTS is 3 RPM on this model; stay under it. 429s count
    // against that window, so a retry waits at least 75s.
    // Paid keys are not the free-tier 3 RPM; keep a small gap so a burst
    // of thirty still does not trip the next limit up.
    paceMs: 1_500,
    minRetryMs: 15_000,
  });
  for (const name of result.skipped) {
    console.log(`skipped ${voicePreviewAssetV1(name)}`);
  }
  console.log(
    `${result.written.length} written, ${result.skipped.length} skipped`,
  );
}

const isMain = import.meta.main;
if (isMain) {
  let apiKey = "";
  Promise.resolve()
    .then(() => {
      apiKey = readApiKeyV1();
      return main(apiKey);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(redact(message, apiKey));
      process.exit(1);
    });
}
