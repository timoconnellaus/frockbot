// The dictation session the upstream actually receives, against an upstream
// that behaves the way OpenAI's realtime transcription endpoint was observed
// to behave on 2026-09-11.
//
// The rule that killed production dictation: the streaming transcription
// models answer any `turn_detection` with "Turn detection is not supported
// for this transcription model." and the session is over. With turn detection
// null the same endpoint streams deltas against a single item while the
// person speaks, and produces a transcript only after the client commits.
// Whether dictation works is therefore decided by the frame the relay sends
// and by what it does at `stop`, not by anything this file asserts about
// source text.
import { describe, expect, test } from "vitest";
import {
  openVoiceDictationRelayV1,
  type VoiceDictationLeaseV1,
} from "../src/voice-dictation.ts";
import { translateVoiceRealtimeUpstreamFrameV1 } from "@frockbot/app/voice/openai-realtime";

/** The streaming transcription models, which refuse turn detection outright. */
const NO_VAD_MODELS = new Set(["gpt-live-transcribe", "gpt-realtime-whisper"]);

const TURN_DETECTION_REFUSAL = {
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "invalid_value",
    param: "session.audio.input.turn_detection",
    message: "Turn detection is not supported for this transcription model.",
  },
};

interface PolicyUpstream {
  socket: () => Promise<WebSocket>;
  sessionUpdates: Record<string, unknown>[];
  /** Raw frames the upstream answered with, in order. */
  answers: Record<string, unknown>[];
}

/**
 * An upstream that applies the observed rule to what it is sent: refuse any
 * turn detection for a streaming model, otherwise stream deltas against one
 * item and transcribe only what a client commit closes.
 */
function policyUpstream(): PolicyUpstream {
  const sessionUpdates: Record<string, unknown>[] = [];
  const answers: Record<string, unknown>[] = [];
  let server: WebSocket | undefined;
  let items = 0;
  let itemId: string | undefined;
  let heard: number[] = [];
  const emit = (frame: Record<string, unknown>) => {
    answers.push(frame);
    server?.send(JSON.stringify(frame));
  };
  return {
    sessionUpdates,
    answers,
    socket: async () => {
      const pair = new WebSocketPair();
      const [client, upstream] = Object.values(pair);
      server = upstream;
      upstream.accept();
      upstream.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (frame.type === "session.update") {
          sessionUpdates.push(frame);
          const input = (
            (frame.session as Record<string, unknown>).audio as
              Record<string, unknown> | undefined
          )?.input as Record<string, unknown> | undefined;
          const model = (
            input?.transcription as Record<string, unknown> | undefined
          )?.model as string | undefined;
          if (model && NO_VAD_MODELS.has(model) && input?.turn_detection) {
            emit(TURN_DETECTION_REFUSAL);
            return;
          }
          emit({ type: "session.updated" });
          return;
        }
        if (frame.type === "input_audio_buffer.append") {
          const byte = atob(String(frame.audio ?? "")).charCodeAt(0);
          heard.push(byte);
          // Every delta of a capture belongs to the same item, and nothing is
          // committed while the person is still speaking.
          itemId ??= `item_${(items += 1)}`;
          emit({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: itemId,
            delta: heard.length === 1 ? String(byte) : ` ${byte}`,
          });
          return;
        }
        if (frame.type === "input_audio_buffer.commit") {
          const closed = itemId!;
          const spoken = heard;
          itemId = undefined;
          heard = [];
          emit({ type: "input_audio_buffer.committed", item_id: closed });
          emit({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: closed,
            transcript: `heard ${spoken.join(",")}`,
          });
        }
      });
      client.accept();
      return client;
    },
  };
}

const lease: VoiceDictationLeaseV1 = {
  acquire: async () => ({ status: "acquired" }),
  renew: async () => true,
  release: async () => {},
};

function openRelay(
  connectUpstream: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<WebSocket>,
  overrides: { maxCaptureMs?: number } = {},
) {
  const response = openVoiceDictationRelayV1(
    new Request("https://bot.frockbot.com/api/voice/dictation", {
      headers: { upgrade: "websocket" },
    }),
    {
      env: { OPENAI_API_KEY: "sk-test" },
      connectUpstream,
      lease,
      ...overrides,
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  return {
    socket,
    frames,
    waitFor(
      predicate: (frame: Record<string, unknown>) => boolean,
      label: string,
    ): Promise<Record<string, unknown>> {
      const seen = frames.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          5_000,
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

function pcm(tag: number): ArrayBuffer {
  const buffer = new Uint8Array(1536);
  buffer[0] = tag;
  return buffer.buffer;
}

const start = JSON.stringify({
  schemaVersion: 1,
  type: "start",
  sampleRate: 24000,
});
const stop = JSON.stringify({ schemaVersion: 1, type: "stop" });

describe("dictation against an upstream that enforces the turn-detection rule", () => {
  test("a capture streams deltas and lands its transcript at stop", async () => {
    const upstream = policyUpstream();
    const opened = openRelay(upstream.socket);
    opened.socket.send(start);
    opened.socket.send(pcm(1));
    await opened.waitFor((f) => f.type === "ready", "ready");
    opened.socket.send(pcm(2));
    await opened.waitFor(
      (f) => f.type === "delta" && String(f.text).includes("2"),
      "the second delta",
    );

    // Nothing is transcribed until the relay commits: no segment yet.
    expect(opened.frames.some((f) => f.type === "segment")).toBe(false);

    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");

    const sent = upstream.sessionUpdates[0]!;
    console.log(
      "[evidence] session.update the upstream received:\n" +
        JSON.stringify(sent, null, 2),
    );
    console.log(
      "[evidence] upstream answers: " +
        JSON.stringify(upstream.answers.map((a) => a.type)),
    );
    console.log(
      "[evidence] composer frames: " +
        JSON.stringify(
          opened.frames.map((f) =>
            f.type === "delta" || f.type === "segment"
              ? `${String(f.type)}:${String(f.text)}`
              : f.type,
          ),
        ),
    );

    expect(opened.frames.some((f) => f.type === "error")).toBe(false);
    expect(
      opened.frames.filter((f) => f.type === "segment").map((f) => f.text),
    ).toEqual(["heard 1,2"]);

    // One item means one growing draft. The client replaces the previous
    // delta with each new one, so what matters is that every delta extends
    // the one before it — never repeats the words alongside them.
    const deltas = opened.frames
      .filter((f) => f.type === "delta")
      .map((f) => String(f.text));
    expect(deltas[0]).toBe("1");
    expect(deltas.at(-1)).toBe("1 2");
    for (const [index, text] of deltas.entries()) {
      if (index === 0) continue;
      expect(text.startsWith(deltas[index - 1]!)).toBe(true);
    }

    // The session asks for no turn detection at all, explicitly.
    const input = (
      (sent.session as Record<string, unknown>).audio as Record<string, unknown>
    ).input as Record<string, unknown>;
    expect(input).toHaveProperty("turn_detection");
    expect(input.turn_detection).toBeNull();

    // Exactly one commit closed the capture, and the relay sent it.
    expect(
      upstream.answers.filter((a) => a.type === "input_audio_buffer.committed"),
    ).toHaveLength(1);
  });

  test("the five-minute cap delivers the capture, then says why it ended", async () => {
    const upstream = policyUpstream();
    const opened = openRelay(upstream.socket, { maxCaptureMs: 500 });
    opened.socket.send(start);
    opened.socket.send(pcm(1));
    await opened.waitFor((f) => f.type === "ready", "ready");
    opened.socket.send(pcm(2));
    await opened.waitFor(
      (f) => f.type === "delta" && String(f.text).includes("2"),
      "the second delta",
    );

    // Nobody presses Stop; the cap fires instead. It commits the capture the
    // way a Stop does, so the words survive, and closes on the limit error
    // in place of `final`.
    const error = await opened.waitFor((f) => f.type === "error", "the error");
    expect(error.code).toBe("limit");
    expect(error.message).toBe(
      "Dictation stopped after five minutes. Press the microphone to continue.",
    );
    expect(opened.frames.some((f) => f.type === "final")).toBe(false);

    const types = opened.frames.map((f) => f.type);
    expect(types.indexOf("segment")).toBeLessThan(types.indexOf("error"));
    expect(
      opened.frames.filter((f) => f.type === "segment").map((f) => f.text),
    ).toEqual(["heard 1,2"]);
    expect(
      upstream.answers.filter((a) => a.type === "input_audio_buffer.committed"),
    ).toHaveLength(1);
  });

  test("asking for server VAD again reproduces the production failure", async () => {
    const upstream = policyUpstream();
    // The relay's own session frame, with only the turn detection put back the
    // way it was. Everything else — the relay, the upstream, the client — is
    // unchanged, so what fails is the configuration and nothing else.
    const withServerVad = async () => {
      const socket = await upstream.socket();
      const send = socket.send.bind(socket) as (data: unknown) => void;
      socket.send = ((data: unknown) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data) as Record<string, unknown>;
          if (frame.type === "session.update") {
            const input = (
              (frame.session as Record<string, unknown>).audio as Record<
                string,
                unknown
              >
            ).input as Record<string, unknown>;
            input.turn_detection = {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
            };
            send(JSON.stringify(frame));
            return;
          }
        }
        send(data);
      }) as typeof socket.send;
      return socket;
    };

    const opened = openRelay(withServerVad);
    opened.socket.send(start);
    opened.socket.send(pcm(1));
    const error = await opened.waitFor((f) => f.type === "error", "the error");
    console.log(
      "[evidence] composer frames with server VAD: " +
        JSON.stringify(opened.frames.map((f) => f.type)),
    );
    expect(opened.frames.some((f) => f.type === "ready")).toBe(false);
    expect(error.code).toBe("upstream");
    expect(error.message).toBe(
      "Dictation stopped: the speech service refused the session. Try again.",
    );

    // And the refusal reads as fatal, not as an empty buffer the relay
    // forgives after stop.
    const raw = JSON.stringify(TURN_DETECTION_REFUSAL);
    expect(translateVoiceRealtimeUpstreamFrameV1(raw)).toEqual({
      kind: "error",
      message: "Turn detection is not supported for this transcription model.",
      emptyBuffer: false,
    });
  });
});
