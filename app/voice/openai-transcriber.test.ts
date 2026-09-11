import { describe, expect, test } from "bun:test";
import {
  createOpenAiTranscriberV1,
  voiceAssistantSessionUpdateV1,
  VOICE_ASSISTANT_STT_MODEL_V1,
  type VoiceRealtimeSocketV1,
} from "./openai-transcriber.js";

class FakeSocket implements VoiceRealtimeSocketV1 {
  sent: string[] = [];
  closed = 0;
  #messages: ((raw: string) => void)[] = [];
  #closes: ((reason: string) => void)[] = [];

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed += 1;
  }
  onMessage(handler: (raw: string) => void) {
    this.#messages.push(handler);
  }
  onClose(handler: (reason: string) => void) {
    this.#closes.push(handler);
  }

  say(event: Record<string, unknown>) {
    for (const handler of this.#messages) handler(JSON.stringify(event));
  }
  hangUp(reason = "") {
    for (const handler of this.#closes) handler(reason);
  }
  /** The frames of audio it was given, ignoring the session configuration. */
  audio() {
    return this.sent.filter((frame) =>
      frame.includes("input_audio_buffer.append"),
    );
  }
}

function transcriber(socket: FakeSocket | Promise<never>) {
  return createOpenAiTranscriberV1({
    openSocket: () =>
      socket instanceof FakeSocket ? Promise.resolve(socket) : socket,
  });
}

const FRAME = new ArrayBuffer(640);

describe("the OpenAI assistant transcriber", () => {
  test("asks for the VAD model and 24 kHz audio", () => {
    const update = voiceAssistantSessionUpdateV1() as {
      session: { audio: { input: Record<string, Record<string, unknown>> } };
    };
    const input = update.session.audio.input;
    expect(input.transcription).toEqual({
      model: VOICE_ASSISTANT_STT_MODEL_V1,
    });
    expect(input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(input.noise_reduction).toEqual({ type: "far_field" });
    expect(input.turn_detection!.type).toBe("server_vad");
  });

  test("is ready once the session is updated, and not before", async () => {
    const socket = new FakeSocket();
    const session = transcriber(socket).createSession({});
    let ready = false;
    void session.waitUntilReady!().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[0]!).type).toBe("session.update");
    expect(ready).toBe(false);
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    expect(ready).toBe(true);
  });

  test("drops audio fed before the session is ready", async () => {
    const socket = new FakeSocket();
    const session = transcriber(socket).createSession({});
    await Promise.resolve();
    session.feed(FRAME);
    session.feed(FRAME);
    expect(socket.audio()).toHaveLength(0);
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    expect(socket.audio()).toHaveLength(0);
    session.feed(FRAME);
    expect(socket.audio()).toHaveLength(1);
    // 16 kHz in, 24 kHz out: a frame leaves larger than it arrived.
    const first = JSON.parse(socket.audio()[0]!) as { audio: string };
    expect(atob(first.audio).length).toBeGreaterThan(FRAME.byteLength);
  });

  test("sends nothing for a frame too short to resample", async () => {
    const socket = new FakeSocket();
    const session = transcriber(socket).createSession({});
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    session.feed(new ArrayBuffer(1));
    expect(socket.audio()).toHaveLength(0);
    session.feed(FRAME);
    expect(socket.audio()).toHaveLength(1);
  });

  test("reports speech starting, interim text and the utterance", async () => {
    const socket = new FakeSocket();
    const heard: string[] = [];
    const interim: string[] = [];
    let speechStarts = 0;
    const session = transcriber(socket).createSession({
      onSpeechStart: () => {
        speechStarts += 1;
      },
      onInterim: (text) => interim.push(text),
      onUtterance: (text) => heard.push(text),
    });
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();

    socket.say({ type: "input_audio_buffer.speech_started", item_id: "a" });
    expect(speechStarts).toBe(1);
    socket.say({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "a",
      delta: "hello ",
    });
    socket.say({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "a",
      delta: "there",
    });
    expect(interim).toEqual(["hello ", "hello there"]);
    socket.say({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "  Hello there.  ",
    });
    expect(heard).toEqual(["Hello there."]);
  });

  test("says nothing for an empty transcript or an item that failed", async () => {
    const socket = new FakeSocket();
    const heard: string[] = [];
    let fatal: Error | undefined;
    const session = transcriber(socket).createSession({
      onUtterance: (text) => heard.push(text),
      onFatalError: (error) => {
        fatal = error;
      },
    });
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    socket.say({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "   ",
    });
    socket.say({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "b",
      error: { message: "audio was unintelligible" },
    });
    expect(heard).toEqual([]);
    expect(fatal).toBeUndefined();
  });

  test("refuses to become ready when the upstream errors first", async () => {
    const socket = new FakeSocket();
    let fatal: Error | undefined;
    const session = transcriber(socket).createSession({
      onFatalError: (error) => {
        fatal = error;
      },
    });
    await Promise.resolve();
    socket.say({
      type: "error",
      error: { code: "invalid_request_error", message: "no such model" },
    });
    await expect(session.waitUntilReady!()).rejects.toThrow("no such model");
    // The wrapper above turns the rejection into the fatal path; the session
    // does not report it twice.
    expect(fatal).toBeUndefined();
    expect(socket.closed).toBe(1);
  });

  test("an error after ready is fatal, once", async () => {
    const socket = new FakeSocket();
    const fatals: string[] = [];
    const session = transcriber(socket).createSession({
      onFatalError: (error) => fatals.push(error.message),
    });
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    socket.say({ type: "error", error: { message: "session expired" } });
    socket.say({ type: "error", error: { message: "and again" } });
    socket.hangUp("gone");
    expect(fatals).toEqual(["session expired"]);
  });

  test("a socket that closes under a live session is fatal", async () => {
    const socket = new FakeSocket();
    const fatals: string[] = [];
    const session = transcriber(socket).createSession({
      onFatalError: (error) => fatals.push(error.message),
    });
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    socket.hangUp("upstream went away");
    expect(fatals).toEqual(["upstream went away"]);
  });

  test("closing is idempotent and silences everything after it", async () => {
    const socket = new FakeSocket();
    const fatals: string[] = [];
    const heard: string[] = [];
    const session = transcriber(socket).createSession({
      onUtterance: (text) => heard.push(text),
      onFatalError: (error) => fatals.push(error.message),
    });
    await Promise.resolve();
    socket.say({ type: "session.updated" });
    await session.waitUntilReady!();
    session.close();
    session.close();
    expect(socket.closed).toBe(1);
    session.feed(FRAME);
    socket.say({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "too late",
    });
    socket.hangUp("closed");
    expect(socket.audio()).toHaveLength(0);
    expect(heard).toEqual([]);
    expect(fatals).toEqual([]);
  });

  test("a handshake the upstream never answers fails the session", async () => {
    const socket = new FakeSocket();
    const session = createOpenAiTranscriberV1({
      openSocket: () => Promise.resolve(socket),
      connectTimeoutMs: 5,
    }).createSession({});
    await expect(session.waitUntilReady!()).rejects.toThrow(
      "didn't start in time",
    );
    expect(socket.closed).toBe(1);
  });

  test("a socket that never opens fails the session rather than hanging", async () => {
    const session = createOpenAiTranscriberV1({
      openSocket: () => Promise.reject(new Error("upgrade refused (401)")),
    }).createSession({});
    await expect(session.waitUntilReady!()).rejects.toThrow(
      "upgrade refused (401)",
    );
  });
});
