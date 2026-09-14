// Which ears the deployment gets, through the real gateway.
//
// The harness Worker carries no provider key, so each test here hands the
// running Worker the keys a deployment would have and then asks the product
// two questions a person can see the answer to: does the client see the
// assistant as available, and when a call starts, which provider does the
// session actually reach for? Nothing outbound is allowed out of the suite,
// so the reach itself is the observable: the trace line the object emits when
// its ears fail names the provider that refused.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asUser, expectJson, freshUserId } from "./fixtures.ts";

type VoiceEnv = {
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  VOICE_ASSISTANT_STT?: string;
};

const voiceEnv = env as unknown as VoiceEnv;

function withKeys(keys: VoiceEnv): void {
  voiceEnv.OPENAI_API_KEY = keys.OPENAI_API_KEY;
  voiceEnv.ELEVENLABS_API_KEY = keys.ELEVENLABS_API_KEY;
  voiceEnv.VOICE_ASSISTANT_STT = keys.VOICE_ASSISTANT_STT;
}

afterEach(() => {
  withKeys({});
  vi.restoreAllMocks();
});

interface VoiceCapabilities {
  schemaVersion: number;
  dictation: boolean;
  assistant: boolean;
}

async function capabilities(label: string): Promise<VoiceCapabilities> {
  const probe = await asUser(freshUserId(label), "/api/voice/capabilities");
  expect(probe.status).toBe(200);
  return (await expectJson(probe)) as VoiceCapabilities;
}

async function assistantAvailable(label: string): Promise<boolean> {
  return (await capabilities(label)).assistant;
}

describe("the assistant's ears, through the gateway", () => {
  it("is available on the ElevenLabs key alone, without OpenAI", async () => {
    withKeys({ ELEVENLABS_API_KEY: "eleven-test-key" });
    expect(await assistantAvailable("stt-scribe-only")).toBe(true);
  });

  it("is unavailable on the OpenAI key alone, though dictation still has its key", async () => {
    withKeys({ OPENAI_API_KEY: "openai-test-key" });
    expect(await capabilities("stt-openai-only")).toEqual({
      schemaVersion: 1,
      dictation: true,
      assistant: false,
    });
  });

  it("falls back to OpenAI when the deployment asks for it", async () => {
    withKeys({
      VOICE_ASSISTANT_STT: "openai",
      OPENAI_API_KEY: "openai-test-key",
      ELEVENLABS_API_KEY: "eleven-test-key",
    });
    expect(await assistantAvailable("stt-openai-chosen")).toBe(true);
  });

  it("refuses the fallback when the OpenAI key it names is missing", async () => {
    withKeys({
      VOICE_ASSISTANT_STT: "openai",
      ELEVENLABS_API_KEY: "eleven-test-key",
    });
    expect(await assistantAvailable("stt-openai-keyless")).toBe(false);
  });

  it("reads only the exact word `openai`, so a near miss stays on Scribe", async () => {
    withKeys({
      VOICE_ASSISTANT_STT: " OpenAI ",
      OPENAI_API_KEY: "openai-test-key",
    });
    expect(await assistantAvailable("stt-openai-misspelled")).toBe(false);
  });

  it("is unavailable with a blank ElevenLabs key", async () => {
    withKeys({ ELEVENLABS_API_KEY: "   " });
    expect(await assistantAvailable("stt-blank-key")).toBe(false);
  });
});

interface CallOutcome {
  /** The frames the client saw, in order. */
  seen: Record<string, unknown>[];
  refusal?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

/** Opens the assistant socket as a device would and starts one call. */
async function startCall(label: string): Promise<CallOutcome> {
  const userId = freshUserId(label);
  const response = await SELF.fetch(
    `https://bot.frockbot.com/api/voice/assistant?version=1&device=${label}`,
    { headers: { upgrade: "websocket", "x-frockbot-user-id": userId } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const seen: Record<string, unknown>[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    seen.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  const settled = async (): Promise<CallOutcome> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const refusal = seen.find((f) => f.type === "voice/refusal");
      const status = seen.find(
        (f) => f.type === "status" && f.status !== "idle",
      );
      if (refusal || status) return { seen, refusal, status };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { seen };
  };
  socket.send(JSON.stringify({ type: "hello", protocol_version: 1 }));
  socket.send(
    JSON.stringify({ type: "start_call", preferred_format: "pcm16" }),
  );
  const outcome = await settled();
  socket.close();
  // The Worker is still there afterwards, and the close is flushed.
  expect((await asUser(userId, "/api/voice/capabilities")).status).toBe(200);
  return outcome;
}

interface SttUpgrade {
  url: string;
  xiApiKey: string | null;
  authorization: string | null;
}

/** What the outbound seam saw the session's ears reach for. */
async function sttUpgrades(): Promise<SttUpgrade[]> {
  const response = await fetch("https://example.test/voice-stt-upgrades");
  const body = (await response.json()) as { upgrades: SttUpgrade[] };
  return body.upgrades;
}

async function forgetSttUpgrades(): Promise<void> {
  await fetch("https://example.test/forget-voice-stt-upgrades");
}

describe("starting a call with each provider's key", () => {
  it("starts on the ElevenLabs key alone — OpenAI is no longer required", async () => {
    withKeys({ ELEVENLABS_API_KEY: "eleven-test-key" });
    await forgetSttUpgrades();
    const outcome = await startCall("scribe-call");
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.status?.status).toBeDefined();

    // The ears it reached for, and on what terms.
    const [upgrade, ...rest] = await sttUpgrades();
    expect(rest).toEqual([]);
    expect(upgrade?.xiApiKey).toBe("eleven-test-key");
    const url = new URL(upgrade!.url);
    expect(url.origin).toBe("https://api.elevenlabs.io");
    expect(url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      vad_silence_threshold_secs: "0.5",
      vad_threshold: "0.4",
      min_speech_duration_ms: "100",
      min_silence_duration_ms: "100",
      enable_logging: "false",
    });
  });

  it("reaches OpenAI instead when the deployment names the fallback", async () => {
    withKeys({
      VOICE_ASSISTANT_STT: "openai",
      OPENAI_API_KEY: "openai-test-key",
      ELEVENLABS_API_KEY: "eleven-test-key",
    });
    await forgetSttUpgrades();
    const outcome = await startCall("openai-call");
    expect(outcome.refusal).toBeUndefined();
    const [upgrade, ...rest] = await sttUpgrades();
    expect(rest).toEqual([]);
    expect(new URL(upgrade!.url).origin).toBe("https://api.openai.com");
    expect(upgrade?.authorization).toBe("Bearer openai-test-key");
  });

  it("refuses the call when the chosen fallback's key is missing", async () => {
    withKeys({
      VOICE_ASSISTANT_STT: "openai",
      ELEVENLABS_API_KEY: "eleven-test-key",
    });
    const outcome = await startCall("openai-keyless-call");
    expect(outcome.refusal?.code).toBe("unconfigured");
  });
});
