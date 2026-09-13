import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import {
  VOICE_ASSISTANT_DEVICE_HEADER,
  VOICE_ASSISTANT_INTERNAL_PATH,
  VOICE_ASSISTANT_USER_HEADER,
} from "../src/voice-assistant.ts";
import {
  VOICE_METER_CAPS_V1,
  voiceMeterDayV1,
  type VoiceDelegationRecordV1,
  type VoiceMeterV1,
} from "@frockbot/app/voice/ledger";
import { provisionBot } from "./provision-bot.ts";
import { VOICE_TURN_BRIDGE_V1 } from "@frockbot/app/voice/assistant";

const touched = new Set<string>();
const sockets = new Set<WebSocket>();

function assistant(userId: string) {
  touched.add(userId);
  return env.VOICE_ASSISTANTS.getByName(userId);
}

// A scheduled look-up or a keep-alive heartbeat that fires after the suite
// ends would reconstruct the object while the runner is tearing down. Every
// object a test touched is quietened before the next test.
afterEach(async () => {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
  sockets.clear();
  for (const userId of touched) {
    await runInDurableObject(
      env.VOICE_ASSISTANTS.getByName(userId),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
      },
    );
  }
  touched.clear();
});

interface Opened {
  socket: WebSocket;
  /** Every text frame in arrival order, parsed. */
  frames: Record<string, unknown>[];
  /** Every binary frame's byte length in arrival order. */
  audio: number[];
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
}

async function open(
  userId: string,
  headers: Record<string, string> = {},
  device = "phone",
): Promise<Opened> {
  const url = new URL(VOICE_ASSISTANT_INTERNAL_PATH, "https://voice.internal");
  url.searchParams.set("version", "1");
  const response = await assistant(userId).fetch(
    new Request(url, {
      headers: {
        upgrade: "websocket",
        [VOICE_ASSISTANT_USER_HEADER]: userId,
        [VOICE_ASSISTANT_DEVICE_HEADER]: device,
        ...headers,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("upgrade returned no WebSocket");
  socket.accept();
  sockets.add(socket);
  const frames: Record<string, unknown>[] = [];
  const audio: number[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      audio.push((event.data as ArrayBuffer).byteLength);
      return;
    }
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });
  return {
    socket,
    frames,
    audio,
    closed,
    waitFor(predicate, label, timeoutMs = 8_000) {
      const seen = frames.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

const status = (value: string) => (frame: Record<string, unknown>) =>
  frame.type === "status" && frame.status === value;
const state = (upstream: string) => (frame: Record<string, unknown>) =>
  frame.type === "voice/state" && frame.upstream === upstream;

function pcm(tag: number, bytes = 1280): ArrayBuffer {
  const buffer = new Uint8Array(bytes);
  buffer[0] = tag;
  return buffer.buffer;
}

async function startCall(opened: Opened): Promise<void> {
  await opened.waitFor((f) => f.type === "welcome", "welcome");
  opened.socket.send(JSON.stringify({ type: "hello", protocol_version: 1 }));
  opened.socket.send(
    JSON.stringify({ type: "start_call", preferred_format: "pcm16" }),
  );
  await opened.waitFor(status("listening"), "listening");
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps asking until the probe is satisfied or the time is up. The library
 * sends the idle status frame before it awaits `onCallEnd`, so a frame on the
 * socket does not yet mean the assistant's own bookkeeping has finished.
 */
async function eventually<T>(
  probe: () => Promise<T>,
  satisfied: (value: T) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!satisfied(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${label}: ${JSON.stringify(value)}`,
      );
    }
    await settle(20);
    value = await probe();
  }
  return value;
}

describe("the voice session object", () => {
  test("refreshes the User's local clock for each turn of an open call", async () => {
    const userId = `voice-clock-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const configuration = env.USER_CONFIGURATIONS.getByName(userId);
    // SAFETY: name only the field read here to avoid the recursive RPC stub type.
    const settingsRpc = configuration as unknown as {
      readConfiguration(input: unknown): Promise<{ revision: number }>;
    };
    const current = await settingsRpc.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    await configuration.executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "set-timezone",
        expectedRevision: current.revision,
        profile: { name: "Tim", timezone: "Australia/Sydney" },
      },
    });
    await stub.probeSetNow("2026-09-12T13:59:00.000Z");
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    for (const [now, transcript, local] of [
      ["2026-09-12T13:59:00.000Z", "what time is it", "2026-09-12, 23:59:00"],
      [
        "2026-09-12T14:01:00.000Z",
        "what time is it now",
        "2026-09-13, 00:01:00",
      ],
    ]) {
      await stub.probeSetNow(now!);
      const after = opened.frames.length;
      await stub.probeUtterance(transcript!);
      await opened.waitFor(
        (f) => opened.frames.indexOf(f) >= after && f.type === "transcript_end",
        "spoken answer",
      );
      await opened.waitFor(
        (f) => opened.frames.indexOf(f) >= after && status("listening")(f),
        "ready for next turn",
      );
      const prompt = (await stub.probeSystemPrompts()).at(-1)!;
      expect(prompt).toContain(now!);
      expect(prompt).toContain(local!);
      expect(prompt).toContain("Australia/Sydney");
    }
    expect(await stub.probeChats()).toBe(2);
  });

  test("sends acknowledgment audio while the model is still pending", async () => {
    const userId = `voice-ack-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    await stub.probeStallChat();
    await stub.probeUtterance("what emails do I have today");
    try {
      await eventually(
        () => stub.probeSynthesized(),
        (sentences) => sentences.includes(VOICE_TURN_BRIDGE_V1),
        "acknowledgment before the model answers",
      );
      await eventually(
        async () => opened.audio.length,
        (count) => count > 0,
        "acknowledgment audio",
      );
      expect(await stub.probeChats()).toBe(1);
      expect(opened.frames.some((f) => f.type === "transcript_end")).toBe(
        false,
      );
    } finally {
      await stub.probeReleaseChat();
    }
    await opened.waitFor((f) => f.type === "transcript_end", "finished reply");
    const turns = Object.values(await stub.probeStorage("voice:turn:")) as {
      answer?: string;
    }[];
    expect(turns[0]?.answer).toBe("You said: what emails do I have today.");
    expect(
      (await stub.probeSynthesized()).filter(
        (sentence) => sentence === VOICE_TURN_BRIDGE_V1,
      ),
    ).toHaveLength(1);
  });

  test("refuses a socket for anyone but the User it is named for", async () => {
    const userId = `voice-owner-${crypto.randomUUID()}`;
    const intruder = await open(userId, {
      [VOICE_ASSISTANT_USER_HEADER]: "someone-else",
    });
    const closed = await intruder.closed;
    expect(closed.code).toBe(4403);
  });

  test("starts a call, feeds audio in order, sleeps and wakes without losing a frame", async () => {
    const userId = `voice-flow-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId);
    await startCall(opened);
    expect(opened.frames.find((f) => f.type === "audio_config")).toMatchObject({
      format: "pcm16",
      sampleRate: 24000,
    });
    // The upstream opens at call start so the first words are not late.
    await opened.waitFor(state("awake"), "awake");

    opened.socket.send(pcm(1));
    opened.socket.send(pcm(2));
    await settle();
    let sessions = await stub.probeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.fed).toEqual([1, 2]);

    // The client says the room went quiet: the upstream closes, the socket
    // and the call stay.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/sleep" }),
    );
    await opened.waitFor(state("asleep"), "asleep");
    sessions = await stub.probeSessions();
    expect(sessions[0]!.closed).toBe(true);

    // Wake: the pre-roll goes first, then live audio, all in order on a
    // fresh upstream session.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/wake" }),
    );
    opened.socket.send(pcm(10));
    opened.socket.send(pcm(11));
    opened.socket.send(pcm(12));
    await opened.waitFor(
      (f) =>
        f.type === "voice/state" &&
        f.upstream === "awake" &&
        opened.frames.filter(state("awake")).length >= 2,
      "second awake",
    );
    await settle();
    sessions = await stub.probeSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.fed).toEqual([10, 11, 12]);

    // Mute closes the upstream at once and says so.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/mute", muted: true }),
    );
    await opened.waitFor(
      (f) =>
        f.type === "voice/state" && f.muted === true && f.upstream === "asleep",
      "muted",
    );
    // A wake while muted is ignored.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/wake" }),
    );
    await settle();
    expect((await stub.probeSessions()).filter((s) => !s.closed)).toHaveLength(
      0,
    );

    // The idle frame precedes the call-end hook, so the record is asked for
    // until it is gone rather than read once.
    opened.socket.send(JSON.stringify({ type: "end_call" }));
    await opened.waitFor(status("idle"), "idle");
    const calls = await eventually(
      async (): Promise<string[]> =>
        Object.keys(await stub.probeStorage("voice:call:")),
      (keys) => keys.length === 0,
      "the call record to be released",
    );
    expect(calls).toEqual([]);
    opened.socket.close();
  });

  test("the closing trace still names the call after end_call released it", async () => {
    const userId = `voice-trace-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    const admitted = await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line),
      "the call-admitted trace",
    );
    // The ordinary hang-up: end_call releases the call record, and only then
    // does the socket close. The closing line must still say which call it
    // was and how long it ran.
    opened.socket.send(JSON.stringify({ type: "end_call" }));
    await opened.waitFor(status("idle"), "idle");
    opened.socket.close(1000, "end-button");
    const closed = await eventually(
      async () => (await stub.probeTraces()).find((t) => t.event === "closed"),
      (line) => Boolean(line),
      "the closed trace",
    );
    expect(closed).toMatchObject({
      call: admitted!.call,
      device: "phone",
      code: 1000,
      reason: "end-button",
    });
    expect(closed!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("an utterance becomes a ledgered turn, a spoken reply, and metered speech", async () => {
    const userId = `voice-turn-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    // Noise never reaches the model.
    expect(await stub.probeUtterance("…")).toBe(true);
    await settle(100);
    expect(await stub.probeChats()).toBe(0);

    expect(await stub.probeUtterance("what time is it")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" &&
        String(f.text).startsWith("You said: what time"),
      "spoken reply",
    );
    await opened.waitFor(status("speaking"), "speaking");
    const spokeAt = opened.frames.findIndex(status("speaking"));
    await opened.waitFor(
      (f) => status("listening")(f) && opened.frames.indexOf(f) > spokeAt,
      "back to listening after speaking",
    );
    expect(opened.audio.length).toBeGreaterThan(0);
    expect(await stub.probeSynthesized()).toEqual([
      "You said: what time is it.",
    ]);
    const turns = Object.values(await stub.probeStorage("voice:turn:")) as {
      state: string;
      key: string;
      transcript: string;
    }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      state: "answered",
      transcript: "what time is it",
    });
    expect(turns[0]!.key).toMatch(new RegExp(`^voice-turn:${userId}:`));
    const meters = Object.values(await stub.probeStorage("voice:meter:")) as {
      turns: number;
      ttsCharacters: number;
    }[];
    expect(meters[0]).toMatchObject({ turns: 1 });
    expect(meters[0]!.ttsCharacters).toBeGreaterThan(0);
    // The tail can prove speech left the object: one `audio` line per
    // sentence, and the call's total on the way out.
    const audio = (await stub.probeTraces()).filter((t) => t.event === "audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({
      chars: "You said: what time is it.".length,
      chunk: 1,
    });
    expect(Number(audio[0]!.bytes)).toBeGreaterThan(0);
    // The phone's interrupt is on record, with no upstream `speech-started`
    // before it: that is how the tail tells the two detectors apart.
    opened.socket.send(JSON.stringify({ type: "interrupt" }));
    await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "interrupted"),
      (line) => Boolean(line),
      "the interrupted trace",
    );
    expect(
      (await stub.probeTraces()).some((t) => t.event === "speech-started"),
    ).toBe(false);
    opened.socket.send(JSON.stringify({ type: "end_call" }));
    await opened.waitFor(status("idle"), "idle");
    const ended = (await stub.probeTraces()).find(
      (t) => t.event === "call-ended",
    );
    expect(ended).toMatchObject({ sentencesSpoken: 1 });
    expect(Number(ended!.audioChunks)).toBeGreaterThan(0);
    opened.socket.close();
  });

  test("a repeated sentence is still traced, and a superseded call keeps its totals", async () => {
    const userId = `voice-audio-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    // Two sentences the reply says identically: the audio line has to come
    // from the sentence being accepted, not from the previous chunk's text.
    await stub.probeSetScript({ reply: "Right away. Right away." });
    const phone = await open(userId, {}, "phone");
    await startCall(phone);
    await phone.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("say it twice")).toBe(true);
    await eventually(
      async () => await stub.probeSynthesized(),
      (spoken) => spoken.length === 2,
      "both sentences synthesized",
    );
    expect(await stub.probeSynthesized()).toEqual([
      "Right away.",
      "Right away.",
    ]);
    const audio = (await stub.probeTraces()).filter((t) => t.event === "audio");
    expect(audio).toHaveLength(2);
    expect(audio.map((t) => t.chars)).toEqual([11, 11]);
    expect(audio.map((t) => t.chunk)).toEqual([1, 2]);
    // And every chunk the lines count is a frame the phone received: the
    // hook that counts them hands the chunk back as it found it.
    await eventually(
      async () => phone.audio.length,
      (frames) => frames === audio.length,
      "an audio frame on the socket for every counted chunk",
    );

    // The laptop displaces the phone: the phone's call record is released
    // before the SDK ends the call, so its totals have to outlive it.
    const laptop = await open(userId, {}, "laptop");
    await startCall(laptop);
    await phone.waitFor(
      (f) => f.type === "voice/refusal" && f.code === "superseded",
      "superseded refusal",
    );
    const ended = await eventually(
      async () =>
        (await stub.probeTraces()).find(
          (t) => t.event === "call-ended" && t.device === "phone",
        ),
      (line) => Boolean(line),
      "the phone's call-ended trace",
    );
    expect(ended).toMatchObject({ audioChunks: 2, sentencesSpoken: 2 });
    expect(Number(ended!.audioBytes)).toBeGreaterThan(0);
    for (const opened of [phone, laptop]) opened.socket.close();
  });

  test("the upstream's own detector is on record before the reply stops", async () => {
    const userId = `voice-vad-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    // The transcription service heard someone. That line is what tells the
    // pair apart later: an `interrupted` with this line before it is the
    // upstream's barge-in, without it the phone's own energy gate.
    expect(await stub.probeSpeechStart()).toBe(true);
    const started = await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "speech-started"),
      (line) => Boolean(line),
      "the speech-started trace",
    );
    expect(started).toMatchObject({ device: "phone" });
    expect(started!.call).toBeTruthy();
    expect(started!.elapsedMs).toBeGreaterThanOrEqual(0);
    // The utterance still lands: the trace wrapper passes the hook through.
    expect(await stub.probeUtterance("what time is it")).toBe(true);
    await opened.waitFor(status("speaking"), "speaking");
    opened.socket.send(JSON.stringify({ type: "interrupt" }));
    const tail = await eventually(
      async () => await stub.probeTraces(),
      (lines) => lines.some((t) => t.event === "interrupted"),
      "the interrupted trace",
    );
    expect(tail.findIndex((t) => t.event === "speech-started")).toBeLessThan(
      tail.findIndex((t) => t.event === "interrupted"),
    );
    opened.socket.close();
  });

  test("a newer device takes the call and the older one is told", async () => {
    const userId = `voice-exclusive-${crypto.randomUUID()}`;
    const first = await open(userId, {}, "phone");
    await startCall(first);
    const second = await open(userId, {}, "laptop");
    await startCall(second);
    await first.waitFor(
      (f) => f.type === "voice/refusal" && f.code === "superseded",
      "superseded refusal",
    );
    await first.waitFor(status("idle"), "first idle");
    const calls = Object.values(
      await assistant(userId).probeStorage("voice:call:"),
    ) as { deviceKey: string }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.deviceKey).toBe("laptop");
    // The same device reconnecting within the window rejoins its own call.
    const again = await open(userId, {}, "laptop");
    await startCall(again);
    const rejoined = Object.values(
      await assistant(userId).probeStorage("voice:call:"),
    ) as { callId: string }[];
    expect(rejoined[0]!.callId).toBe(
      (calls[0] as unknown as { callId: string }).callId,
    );
    for (const opened of [first, second, again]) opened.socket.close();
  });

  test("a delegation is a durable Bot Turn that survives the voice object being evicted", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-delegate-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });

    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("please plan my week")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).includes("Done: Asked"),
      "delegation acknowledged aloud",
    );
    const delegations = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(delegations).toHaveLength(1);
    const delegation = delegations[0]!;
    expect(delegation).toMatchObject({
      botId: identity.botId,
      text: "please plan my week",
    });
    expect(delegation.runId).toMatch(/^voice-[0-9a-f]{32}$/);

    // The voice object goes away mid-flight. The Bot's Turn is its own.
    opened.socket.close();
    await settle(100);
    await evictDurableObject(stub);

    // The Bot admitted the Turn under the run id the ledger chose, on the
    // user lane, so it is in the Bot's own thread.
    const bot = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );
    // SAFETY: names only the read this test makes.
    const botRpc = bot as unknown as {
      lookupRun(
        input: unknown,
      ): Promise<{ state: string; run?: { status: string } }>;
    };
    let lookup = await botRpc.lookupRun({
      schemaVersion: 1,
      ...identity,
      query: { schemaVersion: 1, runId: delegation.runId },
    });
    for (
      let attempt = 0;
      attempt < 40 && lookup.state !== "terminal";
      attempt += 1
    ) {
      await settle(250);
      lookup = await botRpc.lookupRun({
        schemaVersion: 1,
        ...identity,
        query: { schemaVersion: 1, runId: delegation.runId },
      });
    }
    expect(lookup.state).toBe("terminal");

    // The scheduled look-up, run after eviction, settles the delegation from
    // the Bot's durable answer; a second run changes nothing.
    await stub.probeCheckDelegation(delegation.runId);
    await stub.probeCheckDelegation(delegation.runId);
    const settled = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(settled).toHaveLength(1);
    expect(settled[0]!.state).toBe("settled");
    expect(
      typeof settled[0]!.answer === "string" ||
        typeof settled[0]!.failure === "string",
    ).toBe(true);

    // The next call reads the answer out first and marks it spoken.
    const next = await open(identity.userId);
    await startCall(next);
    await next.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).startsWith("Workerd Bot"),
      "answer read out",
    );
    await settle(100);
    const spoken = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(spoken[0]!.state).toBe("spoken");
    next.socket.close();
  });

  test("a sentence that never becomes sound is on record, told to the phone, and the call goes on", async () => {
    const userId = `voice-silent-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ reply: "Right away.", silentTts: true });
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("say something")).toBe(true);
    // The SDK's own error frame reaches the phone, and the call is still
    // listening afterwards rather than over.
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(String(error.message)).toContain("produced no audio");
    await opened.waitFor(
      (f) =>
        status("listening")(f) &&
        opened.frames.indexOf(f) > opened.frames.indexOf(error),
      "listening again",
    );
    const failed = await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "tts-failed"),
      (line) => Boolean(line),
      "the tts-failed trace",
    );
    expect(failed).toMatchObject({ chars: "Right away.".length });
    const traces = await stub.probeTraces();
    expect(traces.some((t) => t.event === "audio")).toBe(false);
    // The turn's own timing is on the settled line and on the model's first
    // word, so a slow reply can be blamed on the right stage.
    const settled = traces.find((t) => t.event === "turn-settled");
    expect(settled).toMatchObject({ outcome: "answered" });
    expect(Number(settled!.ms)).toBeGreaterThanOrEqual(0);
    const firstText = traces.find((t) => t.event === "model-first-text");
    expect(firstText!.turn).toBe(settled!.turn);
    expect(Number(firstText!.ms)).toBeLessThanOrEqual(Number(settled!.ms));

    // The provider recovers: the next reply is heard, and its first chunk
    // says how long after the turn began it left.
    await stub.probeSetScript({ reply: "Right away." });
    expect(await stub.probeUtterance("say it again")).toBe(true);
    const audio = await eventually(
      async () => (await stub.probeTraces()).find((t) => t.event === "audio"),
      (line) => Boolean(line),
      "the audio trace",
    );
    expect(Number(audio!.sinceTurnMs)).toBeGreaterThanOrEqual(0);
    expect(audio!.turn).toBeTruthy();
    expect(audio!.turn).not.toBe(settled!.turn);
    opened.socket.close();
  });

  test("a Bot answer that lands mid-reply is held, then read out", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-hold-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("please plan my week")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).includes("Done: Asked"),
      "delegation acknowledged aloud",
    );
    const [delegation] = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    const bot = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );
    // SAFETY: names only the read this test makes.
    const botRpc = bot as unknown as {
      lookupRun(input: unknown): Promise<{ state: string }>;
    };
    await eventually(
      () =>
        botRpc.lookupRun({
          schemaVersion: 1,
          ...identity,
          query: { schemaVersion: 1, runId: delegation!.runId },
        }),
      (lookup) => lookup.state === "terminal",
      "the Bot's Turn to settle",
      12_000,
    );
    // Settled inside the reply's drain window: held, not spoken over it.
    await stub.probeCheckDelegation(delegation!.runId);
    const held = (await stub.probeTraces()).find(
      (t) => t.event === "delegation-held",
    );
    expect(held).toMatchObject({ reason: "reply-in-flight" });
    expect(
      (await stub.probeSynthesized()).some((t) => t.startsWith("Workerd Bot")),
    ).toBe(false);
    // Once the window has passed the scheduled read-out lands.
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).startsWith("Workerd Bot"),
      "answer read out",
      10_000,
    );
    await settle(100);
    const [spoken] = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(spoken!.state).toBe("spoken");
    // The read-out is nobody's turn: it must not borrow the last turn's
    // clock and report a time to first word of minutes.
    const audioLines = (await stub.probeTraces()).filter(
      (t) => t.event === "audio",
    );
    expect(audioLines.some((t) => t.turn !== undefined)).toBe(true);
    expect(audioLines.at(-1)!.turn).toBeUndefined();
    expect(audioLines.at(-1)!.sinceTurnMs).toBeUndefined();
    opened.socket.close();
  });

  test("a Bot answer held over two replies is still read out", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-rehold-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("please plan my week")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).includes("Done: Asked"),
      "delegation acknowledged aloud",
    );
    const [delegation] = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    const bot = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );
    // SAFETY: names only the read this test makes.
    const botRpc = bot as unknown as {
      lookupRun(input: unknown): Promise<{ state: string }>;
    };
    await eventually(
      () =>
        botRpc.lookupRun({
          schemaVersion: 1,
          ...identity,
          query: { schemaVersion: 1, runId: delegation!.runId },
        }),
      (lookup) => lookup.state === "terminal",
      "the Bot's Turn to settle",
      12_000,
    );

    // The person has asked something else and that answer is still being
    // produced, so the Bot's answer is held — and is held a second time when
    // its own wake-up lands with the reply still going. A re-hold that
    // deduped onto the row being executed would lose the wake-up outright.
    await stub.probeStallChat();
    await stub.probeSetScript({ reply: "Right away." });
    expect(await stub.probeUtterance("what else is on today")).toBe(true);
    await eventually(
      async () => (await stub.probeTraces()).filter((t) => t.event === "turn"),
      (turns) => turns.length >= 2,
      "the second question's turn",
    );
    await stub.probeCheckDelegation(delegation!.runId);
    await eventually(
      async () =>
        (await stub.probeTraces()).filter((t) => t.event === "delegation-held"),
      (held) => held.length >= 2,
      "a second hold from the scheduled wake-up",
    );
    expect(
      (await stub.probeSynthesized()).some((t) => t.startsWith("Workerd Bot")),
    ).toBe(false);

    // The reply finishes: the answer the person asked the Bot for is read out
    // on this call, not left for the next one.
    await stub.probeReleaseChat();
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).startsWith("Workerd Bot"),
      "answer read out after the second hold",
      12_000,
    );
    await settle(100);
    const [spoken] = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(spoken!.state).toBe("spoken");
    opened.socket.close();
  });

  test("asking the same thing again in one turn admits one Bot Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-dedup-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("plan the trip")).toBe(true);
    await opened.waitFor(
      (f) => f.type === "transcript_end" && String(f.text).includes("Done:"),
      "first ask",
    );
    const first = Object.keys(await stub.probeStorage("voice:delegation:"));
    expect(first).toHaveLength(1);
    // The same words again are a new spoken turn and a new key, so a new run;
    // but a retried tool call inside one turn (same turn, Bot, text) is not.
    // That path is covered in the ledger's unit tests; here the durable
    // count after two distinct turns is two, never three.
    expect(await stub.probeUtterance("plan the trip")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" &&
        opened.frames.filter(
          (x) =>
            x.type === "transcript_end" && String(x.text).includes("Done:"),
        ).length >= 2,
      "second ask",
    );
    expect(
      Object.keys(await stub.probeStorage("voice:delegation:")),
    ).toHaveLength(2);
    opened.socket.close();
  });

  test("a newer socket from the same device rejoins the call and the earlier socket is ended", async () => {
    const userId = `voice-rejoin-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const first = await open(userId, {}, "phone");
    await startCall(first);
    await first.waitFor(state("awake"), "first awake");
    const second = await open(userId, {}, "phone");
    await startCall(second);
    const refusal = await first.waitFor(
      (f) => f.type === "voice/refusal" && f.code === "superseded",
      "first told",
    );
    expect(String(refusal.message)).toContain("newer connection");
    await first.waitFor(status("idle"), "first idle");
    await second.waitFor(state("awake"), "second awake");
    // One call record, one live upstream: the first socket's session closed.
    const calls = Object.values(await stub.probeStorage("voice:call:")) as {
      callId: string;
      connectionId: string;
    }[];
    expect(calls).toHaveLength(1);
    const sessions = await stub.probeSessions();
    expect(sessions.filter((s) => !s.closed)).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(true);
  });

  test("transcription is booked in windows before it is spent, reconciled on sleep, and kept across eviction", async () => {
    const userId = `voice-meter-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const today = voiceMeterDayV1(new Date());
    const meter = async () =>
      (
        (await stub.probeStorage("voice:meter:"))[`voice:meter:${today}`] as
          VoiceMeterV1 | undefined
      )?.sttSeconds ?? 0;
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    // The probe's window is one second: booked as soon as the upstream opens.
    expect(await meter()).toBe(1);
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/sleep" }),
    );
    await opened.waitFor(state("asleep"), "asleep");
    await settle();
    // Reconciled: only the part of the window actually awake stays charged.
    const reconciled = await meter();
    expect(reconciled).toBeGreaterThan(0);
    expect(reconciled).toBeLessThan(1);
    // Awake again, then evicted mid-window: the booking is durable already.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/wake" }),
    );
    opened.socket.send(pcm(1));
    await opened.waitFor(
      (f) =>
        state("awake")(f) && opened.frames.filter(state("awake")).length >= 2,
      "awake again",
    );
    const booked = await meter();
    expect(booked).toBeGreaterThanOrEqual(reconciled + 1);
    opened.socket.close();
    await settle(100);
    await evictDurableObject(stub);
    expect(await meter()).toBeGreaterThanOrEqual(booked - 1);
  });

  test("a day that runs out shuts the upstream during continuous audio and refuses to reopen", async () => {
    const userId = `voice-cap-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const today = voiceMeterDayV1(new Date());
    // Room for the first one-second window but not the second.
    await stub.probePutStorage(`voice:meter:${today}`, {
      schemaVersion: 1,
      day: today,
      sttSeconds: VOICE_METER_CAPS_V1.sttSeconds - 1.5,
      ttsCharacters: 0,
      turns: 0,
      delegations: 0,
      dictationSeconds: 0,
    } satisfies VoiceMeterV1);
    const opened = await open(userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    // Continuous audio: frames every 40 ms while the window renews.
    const feeder = setInterval(() => {
      try {
        opened.socket.send(pcm(9));
      } catch {
        // Closed.
      }
    }, 40);
    const refusal = await opened.waitFor(
      (f) => f.type === "voice/refusal" && f.code === "quota",
      "quota refusal",
    );
    clearInterval(feeder);
    expect(String(refusal.message)).toContain("listening allowance");
    await opened.waitFor(state("asleep"), "asleep");
    await settle();
    const sessions = await stub.probeSessions();
    expect(sessions.filter((s) => !s.closed)).toHaveLength(0);
    // Neither a wake nor more audio reopens the upstream today.
    opened.socket.send(
      JSON.stringify({ schemaVersion: 1, type: "voice/wake" }),
    );
    opened.socket.send(pcm(10));
    await settle(100);
    expect((await stub.probeSessions()).filter((s) => !s.closed)).toHaveLength(
      0,
    );
    const meter = (await stub.probeStorage("voice:meter:"))[
      `voice:meter:${today}`
    ] as VoiceMeterV1;
    expect(meter.sttSeconds).toBeLessThanOrEqual(
      VOICE_METER_CAPS_V1.sttSeconds,
    );
    opened.socket.close();
  });

  test("a delegation whose dispatch is lost is sent again under the same run id until the Bot takes it", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-retry-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    await stub.probeDropDispatches(2);
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("plan the launch")).toBe(true);
    await opened.waitFor(
      (f) => f.type === "transcript_end" && String(f.text).includes("Done:"),
      "acknowledged",
    );
    opened.socket.close();
    const [runId] = Object.keys(
      await stub.probeStorage("voice:delegation:"),
    ).map((key) => key.slice("voice:delegation:".length));
    expect(runId).toBeDefined();
    // The first send was lost. Each look-up finds the Bot never took it and
    // sends the same intent again; the second loss is survived the same way.
    await stub.probeCheckDelegation(runId!);
    await stub.probeCheckDelegation(runId!);
    expect(await stub.probeDispatched()).toEqual([
      `dropped:${runId}`,
      `dropped:${runId}`,
      `sent:${runId}`,
    ]);
    const bot = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );
    // SAFETY: names only the read this test makes.
    const botRpc = bot as unknown as {
      lookupRun(input: unknown): Promise<{ state: string }>;
    };
    let lookup = await botRpc.lookupRun({
      schemaVersion: 1,
      ...identity,
      query: { schemaVersion: 1, runId },
    });
    for (
      let attempt = 0;
      attempt < 40 && lookup.state !== "terminal";
      attempt += 1
    ) {
      await settle(250);
      lookup = await botRpc.lookupRun({
        schemaVersion: 1,
        ...identity,
        query: { schemaVersion: 1, runId },
      });
    }
    expect(lookup.state).toBe("terminal");
    await stub.probeCheckDelegation(runId!);
    const settled = (await stub.probeStorage("voice:delegation:"))[
      `voice:delegation:${runId}`
    ] as VoiceDelegationRecordV1;
    expect(settled.state).toBe("settled");
    expect(settled.attempts).toBe(3);
  });

  // The `agents` 0.23 upgrade moves scheduled work into a new `cf_agents_jobs`
  // queue on a Durable Object's first wake and drops the legacy table, so a
  // schedule can be stranded — by that one-way migration, or by a rollback
  // across it. What makes that safe is that the schedule is disposable:
  // `onStart` re-books every pending delegation from the ledger. This drives
  // that against the real scheduler — the queue is emptied under the object's
  // feet, and nothing below runs the look-up by hand.
  test("a delegation whose scheduled check is lost is re-booked on the next call and settled by the alarm", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-reschedule-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("please plan my week")).toBe(true);
    await opened.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).includes("Done: Asked"),
      "delegation acknowledged aloud",
    );
    const [delegation] = Object.values(
      await stub.probeStorage("voice:delegation:"),
    ) as VoiceDelegationRecordV1[];
    expect(delegation!.state).toBe("admitted");
    opened.socket.close();
    await settle(100);

    // Every trace of the scheduled look-up goes: the queue rows the SDK keeps
    // and the alarm that would run them.
    const emptied = await runInDurableObject(
      stub,
      async (_instance, doState) => {
        const before = [
          ...doState.storage.sql.exec<{ fn: string }>(
            "SELECT fn FROM cf_agents_jobs",
          ),
        ].map((row) => row.fn);
        doState.storage.sql.exec("DELETE FROM cf_agents_jobs");
        await doState.storage.deleteAlarm();
        return before;
      },
    );
    console.log("[evidence] scheduled work deleted:", JSON.stringify(emptied));
    expect(emptied).toContain("checkDelegation");
    await evictDurableObject(stub);

    // The person calls back. The call is the wake-up, and `onStart` books the
    // look-up again from the ledger alone.
    const next = await open(identity.userId);
    await startCall(next);
    const rebooked = await eventually(
      () =>
        runInDurableObject(stub, (_instance, doState) =>
          [
            ...doState.storage.sql.exec<{ fn: string; payload: string | null }>(
              "SELECT fn, payload FROM cf_agents_jobs",
            ),
          ].map((row) => ({ callback: row.fn, payload: row.payload ?? "" })),
        ),
      (rows) =>
        rows.some(
          (row) =>
            row.callback === "checkDelegation" &&
            row.payload.includes(delegation!.runId),
        ),
      "the look-up to be booked again on wake",
      10_000,
    );
    console.log("[evidence] re-booked on wake:", JSON.stringify(rebooked));

    // Nothing here runs the look-up: the delegation settles only if the 0.23
    // scheduler fires the named callback with its payload, and the answer is
    // then read out on the live call.
    await next.waitFor(
      (f) =>
        f.type === "transcript_end" && String(f.text).startsWith("Workerd Bot"),
      "answer read out after the scheduled look-up",
      60_000,
    );
    const settled = await eventually(
      async () =>
        (
          Object.values(
            await stub.probeStorage("voice:delegation:"),
          ) as VoiceDelegationRecordV1[]
        )[0]!,
      (record) => record.state === "spoken",
      "the delegation to be marked spoken",
      10_000,
    );
    console.log(
      "[evidence] settled and spoken with no hand-run look-up:",
      JSON.stringify({
        state: settled.state,
        attempts: settled.attempts,
        answer: settled.answer,
      }),
    );
    expect(typeof settled.answer).toBe("string");
    next.socket.close();
  });

  test("a delegation no Bot ever accepts is settled as a failure the person hears", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `voice-never-${suffix}`,
      botId: `voice-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = assistant(identity.userId);
    await stub.probeSetScript({ delegateWord: "plan", botId: identity.botId });
    await stub.probeDropDispatches(1_000);
    const opened = await open(identity.userId);
    await startCall(opened);
    await opened.waitFor(state("awake"), "awake");
    expect(await stub.probeUtterance("plan the launch")).toBe(true);
    await opened.waitFor(
      (f) => f.type === "transcript_end" && String(f.text).includes("Done:"),
      "acknowledged",
    );
    opened.socket.close();
    const key = Object.keys(await stub.probeStorage("voice:delegation:"))[0]!;
    const runId = key.slice("voice:delegation:".length);
    const record = (await stub.probeStorage("voice:delegation:"))[
      key
    ] as VoiceDelegationRecordV1;
    // Skip to the last permitted look-up.
    await stub.probePutStorage(key, { ...record, attempts: 39 });
    await stub.probeCheckDelegation(runId);
    const settled = (await stub.probeStorage("voice:delegation:"))[
      key
    ] as VoiceDelegationRecordV1;
    expect(settled.state).toBe("settled");
    expect(settled.failure).toContain("never accepted");
    // The next call reads the failure out rather than staying silent.
    const next = await open(identity.userId);
    await startCall(next);
    await next.waitFor(
      (f) =>
        f.type === "transcript_end" &&
        String(f.text).includes("could not finish"),
      "failure read out",
    );
    next.socket.close();
  });
});

describe("what the session remembers between calls", () => {
  /**
   * Ends the call the way the person does — `end_call`, then the socket —
   * and runs the scheduled finalization by hand, as the alarm would.
   */
  async function hangUpAndFinalize(
    stub: ReturnType<typeof assistant>,
    opened: Opened,
  ): Promise<string> {
    const callId = (await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line?.call),
      "the call-admitted trace",
    ))!.call!;
    opened.socket.send(JSON.stringify({ type: "end_call" }));
    await opened.waitFor(status("idle"), "idle");
    opened.socket.close(1000, "end-button");
    await eventually(
      async () => await stub.probeMemoryJobs(),
      (jobs) => jobs.some((job) => job.callId === callId),
      "the memory job",
    );
    await stub.probeFinalizeMemory(callId);
    return callId;
  }

  test("a preference said in one call is in the next call's prompt", async () => {
    const userId = `voice-memory-across-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({
      reply: "Of course.",
      memory: {
        operations: [
          {
            kind: "durable/add",
            id: "short-answers",
            text: "Keep answers to one sentence.",
            source: "SOURCE",
          },
        ],
      },
    });
    const first = await open(userId, {}, "phone");
    await startCall(first);
    await stub.probeUtterance("keep your answers to one sentence from now on");
    await first.waitFor((f) => f.type === "transcript_end", "spoken answer");
    // The operation cites the turn it came from; the probe cannot know the
    // id in advance, so it is filled in from the request the object made.
    const callId = (await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line?.call),
      "the call-admitted trace",
    ))!.call!;
    await stub.probeSetScript({
      reply: "Of course.",
      memory: {
        operations: [
          {
            kind: "durable/add",
            id: "short-answers",
            text: "Keep answers to one sentence.",
            source: `${callId}:1`,
          },
        ],
      },
    });
    await hangUpAndFinalize(stub, first);

    const remembered = await stub.probeMemory();
    expect(remembered.durable).toHaveLength(1);
    expect(remembered.durable[0]).toMatchObject({
      id: "short-answers",
      sourceTurnId: `${callId}:1`,
    });

    // A new call, from another device so it is a new call and not a rejoin.
    const second = await open(userId, {}, "laptop");
    await startCall(second);
    await stub.probeUtterance("hello again");
    await second.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const prompt = (await stub.probeSystemPrompts()).at(-1)!;
    expect(prompt).toContain("(short-answers) Keep answers to one sentence.");
    second.socket.close();
  });

  test("a new call starts fresh, and a rejoin keeps the conversation", async () => {
    const userId = `voice-memory-fresh-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ reply: "Right." });
    const first = await open(userId, {}, "phone");
    await startCall(first);
    await stub.probeUtterance("the first thing I said");
    await first.waitFor((f) => f.type === "transcript_end", "spoken answer");

    // The same device, straight back: the same call, and the conversation is
    // still behind it.
    const rejoined = await open(userId, {}, "phone");
    await startCall(rejoined);
    await stub.probeUtterance("and the second thing");
    await rejoined.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const admissions = (await stub.probeTraces()).filter(
      (t) => t.event === "call-admitted",
    );
    expect(admissions[1]).toMatchObject({ rejoined: true });
    expect(JSON.stringify(await stub.probeChatMessages())).toContain(
      "the first thing I said",
    );

    await hangUpAndFinalize(stub, rejoined);
    first.socket.close();

    // Another device is a new call: nothing that was said before is in it.
    const fresh = await open(userId, {}, "laptop");
    await startCall(fresh);
    const before = await stub.probeChats();
    await stub.probeUtterance("a brand new conversation");
    await fresh.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const messages = (await stub.probeChatMessages()).slice(before);
    expect(JSON.stringify(messages)).not.toContain("the first thing I said");
    expect(JSON.stringify(messages)).toContain("a brand new conversation");
    fresh.socket.close();
  });

  test("hanging up mid-answer still gives memory what was said", async () => {
    const userId = `voice-memory-unanswered-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ memory: { operations: [] } });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    // The model never answers this one; the person hangs up over the top.
    await stub.probeStallChat();
    await stub.probeUtterance("remember that I prefer mornings");
    await eventually(
      async () => await stub.probeChats(),
      (count) => count > 0,
      "the turn to reach the model",
    );
    // The stall is on the model seam, which the memory request shares: it is
    // released before the finalization, not after it.
    opened.socket.send(JSON.stringify({ type: "end_call" }));
    await opened.waitFor(status("idle"), "idle");
    opened.socket.close(1000, "end-button");
    const callId = await eventually(
      async () => (await stub.probeMemoryJobs())[0]?.callId,
      (id) => Boolean(id),
      "the memory job",
    );
    await stub.probeReleaseChat();
    await stub.probeFinalizeMemory(callId!);

    const requests = await stub.probeMemoryRequests();
    expect(requests).toHaveLength(1);
    // The transcript was admitted before the model was asked anything, so it
    // is source material even though nothing ever answered it.
    expect(requests[0]!.contents).toContain("remember that I prefer mornings");
    expect(requests[0]!.instruction).toContain(`${callId!}:1`);
  });

  test("the hang-up and the close that follows it queue one job", async () => {
    const userId = `voice-memory-once-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ reply: "Sure.", memory: { operations: [] } });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("something worth remembering");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const callId = await hangUpAndFinalize(stub, opened);
    await settle(100);

    expect(await stub.probeMemoryJobs()).toHaveLength(1);
    expect(
      (await stub.probeSchedules()).filter(
        (row) => row.callback === "finalizeVoiceMemory",
      ).length,
    ).toBeLessThanOrEqual(1);
    // A second finalization for the same call finds nothing left to claim.
    await stub.probeFinalizeMemory(callId);
    expect(await stub.probeMemoryRequests()).toHaveLength(1);
  });

  test("a socket that just drops keeps the call, and the alarm finishes it", async () => {
    const userId = `voice-memory-abandoned-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ reply: "Mm.", memory: { operations: [] } });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("something said before the network went");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const callId = (await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line?.call),
      "the call-admitted trace",
    ))!.call!;

    // No end_call: the socket simply goes.
    opened.socket.close(4001, "network lost");
    await settle(100);
    // The call is still there, so a client coming straight back rejoins it.
    expect(Object.keys(await stub.probeStorage("voice:call:"))).toHaveLength(1);
    expect(await stub.probeMemoryJobs()).toEqual([]);
    // An alarm was scheduled for it rather than left to a future request.
    expect(
      (await stub.probeSchedules()).some(
        (row) => row.callback === "abandonVoiceCall",
      ),
    ).toBe(true);

    // Nobody comes back, and the rejoin window passes.
    await stub.probeSetNow(new Date(Date.now() + 10 * 60_000).toISOString());
    await stub.probeAbandonCall(callId);
    expect(Object.keys(await stub.probeStorage("voice:call:"))).toEqual([]);
    const jobs = await stub.probeMemoryJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ callId, state: "pending" });
    await stub.probeFinalizeMemory(callId);
    expect((await stub.probeMemoryRequests())[0]!.contents).toContain(
      "something said before the network went",
    );
  });

  test("a request whose answer never came is never sent again", async () => {
    const userId = `voice-memory-uncertain-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({ reply: "Mm.", memory: { fail: true } });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("something worth remembering");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const callId = await hangUpAndFinalize(stub, opened);

    const failed = (await stub.probeMemoryJobs())[0]!;
    expect(failed).toMatchObject({ callId, state: "failed", cursor: 0 });
    expect(await stub.probeMemoryRequests()).toHaveLength(1);
    // Asked again — by an alarm, by waking, by anything — it stays put.
    await stub.probeFinalizeMemory(callId);
    await stub.probeRestart();
    await stub.probeFinalizeMemory(callId);
    expect(await stub.probeMemoryRequests()).toHaveLength(1);
    expect((await stub.probeMemoryJobs())[0]).toMatchObject({
      state: "failed",
    });

    // The next conversation carries what was never summarised.
    await stub.probeSetScript({ reply: "Mm.", memory: { operations: [] } });
    const next = await open(userId, {}, "laptop");
    await startCall(next);
    await stub.probeUtterance("hello again");
    await next.waitFor((f) => f.type === "transcript_end", "spoken answer");
    expect((await stub.probeSystemPrompts()).at(-1)).toContain(
      "something worth remembering",
    );
    next.socket.close();
  });

  test("an answer that is not an update is asked again, then given up on", async () => {
    const userId = `voice-memory-malformed-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({
      reply: "Mm.",
      memory: { raw: "I don't think there's anything to record." },
    });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("something worth remembering");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const callId = await hangUpAndFinalize(stub, opened);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await stub.probeFinalizeMemory(callId);
    }
    // Bounded: a complete answer may be asked for again, but not forever.
    expect((await stub.probeMemoryRequests()).length).toBe(3);
    expect((await stub.probeMemoryJobs())[0]).toMatchObject({
      state: "failed",
      cursor: 0,
    });
    expect((await stub.probeMemory()).durable).toEqual([]);
  });

  test("a credential the model tried to remember is refused", async () => {
    const userId = `voice-memory-secret-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeSetScript({ reply: "Mm." });
    await stub.probeUtterance("my key is sk-proj-abcdef");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    const callId = (await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line?.call),
      "the call-admitted trace",
    ))!.call!;
    await stub.probeSetScript({
      reply: "Mm.",
      memory: {
        operations: [
          {
            kind: "durable/add",
            id: "key",
            text: "Their key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
            source: `${callId}:1`,
          },
          {
            kind: "durable/add",
            id: "mornings",
            text: "Prefers mornings.",
            source: `${callId}:1`,
          },
        ],
      },
    });
    await hangUpAndFinalize(stub, opened);
    const remembered = await stub.probeMemory();
    expect(remembered.durable.map((entry) => entry.id)).toEqual(["mornings"]);
  });

  test("a spoken remember holds for the rest of the call and is acknowledged", async () => {
    const userId = `voice-memory-tool-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({
      rememberWord: "remember",
      remember: {
        text: "Keep answers to one sentence.",
        kind: "preference",
      },
    });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("please remember to keep answers short");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    expect((await stub.probeMemory()).durable[0]).toMatchObject({
      text: "Keep answers to one sentence.",
    });

    // The next turn of the same call already carries it, without waiting for
    // the call to end and without depending on the history window.
    await stub.probeSetScript({ reply: "Right." });
    await stub.probeUtterance("what next");
    await opened.waitFor(
      (f) => f.type === "transcript_end" && String(f.text).includes("Right."),
      "the next answer",
    );
    expect((await stub.probeSystemPrompts()).at(-1)).toContain(
      "Keep answers to one sentence.",
    );
    opened.socket.close();
  });

  test("a just-for-today request holds today and is not made permanent", async () => {
    const userId = `voice-memory-today-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetNow("2026-09-12T03:00:00.000Z");
    await stub.probeSetScript({
      rememberWord: "today",
      remember: {
        text: "Skip the small talk.",
        kind: "temporary",
        until: "today",
      },
    });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("just for today, skip the small talk");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");

    const spoken = await stub.probeMemory();
    expect(spoken.durable).toEqual([]);
    expect(spoken.recent).toHaveLength(1);
    const expiresAt = spoken.recent[0]!.expiresAt!;
    expect(expiresAt).toBeTruthy();

    // The end-of-call update reads the same turn and must not promote it.
    const callId = (await eventually(
      async () =>
        (await stub.probeTraces()).find((t) => t.event === "call-admitted"),
      (line) => Boolean(line?.call),
      "the call-admitted trace",
    ))!.call!;
    await stub.probeSetScript({
      memory: {
        operations: [
          {
            kind: "recent/add",
            text: "Skip the small talk.",
            source: `${callId}:1`,
            until: "today",
          },
        ],
      },
    });
    await hangUpAndFinalize(stub, opened);
    const summarised = await stub.probeMemory();
    expect(summarised.durable).toEqual([]);
    expect(summarised.recent).toHaveLength(1);
    expect(summarised.recent[0]?.expiresAt).toBe(expiresAt);

    // A later call the same day still has it; the next day does not.
    await stub.probeSetNow("2026-09-12T09:00:00.000Z");
    const sameDay = await open(userId, {}, "laptop");
    await startCall(sameDay);
    await stub.probeSetScript({ reply: "Right." });
    await stub.probeUtterance("hello");
    await sameDay.waitFor((f) => f.type === "transcript_end", "spoken answer");
    expect((await stub.probeSystemPrompts()).at(-1)).toContain(
      "Skip the small talk.",
    );
    sameDay.socket.close();

    await stub.probeSetNow("2026-09-14T09:00:00.000Z");
    const nextDay = await open(userId, {}, "desktop");
    await startCall(nextDay);
    await stub.probeUtterance("hello again");
    await nextDay.waitFor((f) => f.type === "transcript_end", "spoken answer");
    expect((await stub.probeSystemPrompts()).at(-1)).not.toContain(
      "Skip the small talk.",
    );
    nextDay.socket.close();
  });

  test("a spoken forget takes effect at once", async () => {
    const userId = `voice-memory-forget-${crypto.randomUUID()}`;
    const stub = assistant(userId);
    await stub.probeSetScript({
      rememberWord: "remember",
      remember: { text: "Drinks flat whites.", kind: "preference" },
    });
    const opened = await open(userId, {}, "phone");
    await startCall(opened);
    await stub.probeUtterance("remember that I drink flat whites");
    await opened.waitFor((f) => f.type === "transcript_end", "spoken answer");
    expect((await stub.probeMemory()).durable).toHaveLength(1);

    await stub.probeSetScript({
      forgetWord: "forget",
      forget: "flat whites",
    });
    await stub.probeUtterance("forget the flat whites thing");
    await opened.waitFor(
      (f) => f.type === "transcript_end" && String(f.text).includes("Dropped"),
      "the acknowledgment",
    );
    const after = await stub.probeMemory();
    expect(after.durable).toEqual([]);
    expect(after.forgotten).toHaveLength(1);
    opened.socket.close();
  });
});
