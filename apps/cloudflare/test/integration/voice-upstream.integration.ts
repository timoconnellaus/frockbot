// What the voice session reaches for, through the real gateway.
//
// The harness Worker carries no provider key, so each test here hands the
// running Worker the keys a deployment would have and then asks the product
// two questions a person can see the answer to: does the client see the
// assistant as available, and when a call starts, what does the session
// actually open? Nothing outbound is allowed out of the suite, so the reach
// itself is the observable — the upgrade the object attempted, recorded
// verbatim.
//
// Since ADR 0031 there is one key and one upstream. The interesting part is no
// longer which provider was chosen but where the key ends up: a browser-style
// WebSocket carries no headers of ours, so Gemini Live takes it on the query
// string, and that is exactly the kind of detail worth holding to a test.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asUser, expectJson, freshUserId } from "./fixtures.ts";

type VoiceEnv = {
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
};

const voiceEnv = env as unknown as VoiceEnv;

function withKeys(keys: VoiceEnv): void {
  voiceEnv.OPENAI_API_KEY = keys.OPENAI_API_KEY;
  voiceEnv.GEMINI_API_KEY = keys.GEMINI_API_KEY;
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

describe("what the two voice features need, through the gateway", () => {
  it("is available on the Gemini key alone, without OpenAI", async () => {
    withKeys({ GEMINI_API_KEY: "gemini-test-key" });
    expect(await capabilities("voice-gemini-only")).toEqual({
      schemaVersion: 1,
      dictation: false,
      assistant: true,
    });
  });

  it("is unavailable on the OpenAI key alone, though dictation still has its key", async () => {
    withKeys({ OPENAI_API_KEY: "openai-test-key" });
    expect(await capabilities("voice-openai-only")).toEqual({
      schemaVersion: 1,
      dictation: true,
      assistant: false,
    });
  });

  it("is unavailable with a blank Gemini key", async () => {
    withKeys({ GEMINI_API_KEY: "   " });
    expect(await assistantAvailable("voice-blank-key")).toBe(false);
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
    JSON.stringify({
      schemaVersion: 1,
      type: "voice/open",
      attemptId: crypto.randomUUID(),
      mode: "start",
      paused: false,
      muted: false,
    }),
  );
  const outcome = await settled();
  socket.close();
  // The Worker is still there afterwards, and the close is flushed.
  expect((await asUser(userId, "/api/voice/capabilities")).status).toBe(200);
  return outcome;
}

interface VoiceUpstreamUpgrade {
  url: string;
  authorization: string | null;
}

/** What the outbound seam saw the session reach for. */
async function upstreamUpgrades(): Promise<VoiceUpstreamUpgrade[]> {
  const response = await fetch("https://example.test/voice-upstream-upgrades");
  const body = (await response.json()) as {
    upgrades: VoiceUpstreamUpgrade[];
  };
  return body.upgrades;
}

async function forgetUpstreamUpgrades(): Promise<void> {
  await fetch("https://example.test/forget-voice-upstream-upgrades");
}

describe("starting a call", () => {
  it("opens one Live session, with the key on the URL and nowhere else", async () => {
    withKeys({ GEMINI_API_KEY: "gemini-test-key" });
    await forgetUpstreamUpgrades();
    const outcome = await startCall("gemini-call");
    expect(outcome.refusal).toBeUndefined();

    const [upgrade, ...rest] = await upstreamUpgrades();
    // One socket per call, not three.
    expect(rest).toEqual([]);
    const url = new URL(upgrade!.url);
    expect(url.origin).toBe("https://generativelanguage.googleapis.com");
    expect(url.pathname).toContain("BidiGenerateContent");
    expect(url.searchParams.get("key")).toBe("gemini-test-key");
    // The key rides the URL because the socket carries no headers of ours;
    // it must not also be sent as one.
    expect(upgrade?.authorization).toBeNull();
  });

  it("refuses the call with no key at all", async () => {
    withKeys({});
    const outcome = await startCall("keyless-call");
    expect(outcome.refusal?.code).toBe("unconfigured");
  });
});
