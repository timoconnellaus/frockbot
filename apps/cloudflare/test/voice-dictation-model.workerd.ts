// The dictation session the upstream actually receives, against an upstream
// that enforces OpenAI's documented turn-detection policy.
//
// Production dictation died at the first `session.update` because
// `gpt-realtime-whisper` requires `turn_detection` omitted or null, while the
// relay's committed-segment ordering needs server VAD. The fake here answers
// the way the realtime transcription endpoint documents: a model that does
// not support VAD refuses a session carrying `turn_detection`, a model that
// does accepts it. Whether dictation works is therefore decided by the frame
// the relay sends, not by anything this file asserts about source text.
import { describe, expect, test } from "vitest";
import {
  openVoiceDictationRelayV1,
  type VoiceDictationLeaseV1,
} from "../src/voice-dictation.ts";
import { translateVoiceDictationUpstreamFrameV1 } from "@frockbot/app/voice/dictation-upstream";

/** Transcription models OpenAI documents as refusing turn detection. */
const NO_VAD_MODELS = new Set(["gpt-realtime-whisper"]);

const TURN_DETECTION_REFUSAL = {
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "unsupported_parameter",
    param: "session.audio.input.turn_detection",
    message: "Turn detection is not supported for this transcription model.",
  },
};

interface PolicyUpstream {
  socket: () => Promise<WebSocket>;
  sessionUpdates: Record<string, unknown>[];
  /** Raw frames the upstream answered with, in order. */
  answers: Record<string, unknown>[];
  serverSide: () => WebSocket | undefined;
}

/** An upstream that applies the model/turn-detection rule to what it is sent. */
function policyUpstream(): PolicyUpstream {
  const sessionUpdates: Record<string, unknown>[] = [];
  const answers: Record<string, unknown>[] = [];
  let server: WebSocket | undefined;
  let items = 0;
  let sessionModel: string | undefined;
  let heard: number[] = [];
  const emit = (frame: Record<string, unknown>) => {
    answers.push(frame);
    server?.send(JSON.stringify(frame));
  };
  return {
    sessionUpdates,
    answers,
    serverSide: () => server,
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
          // A later partial update (the relay disables VAD before its commit)
          // is judged against the model the session was opened with.
          if (model) sessionModel = model;
          const turnDetection = input?.turn_detection;
          if (
            sessionModel &&
            NO_VAD_MODELS.has(sessionModel) &&
            turnDetection != null
          ) {
            emit(TURN_DETECTION_REFUSAL);
            return;
          }
          emit({ type: "session.updated" });
          return;
        }
        if (frame.type === "input_audio_buffer.append") {
          const byte = atob(String(frame.audio ?? "")).charCodeAt(0);
          heard.push(byte);
          return;
        }
        if (frame.type === "input_audio_buffer.commit") {
          items += 1;
          const itemId = `item_${items}`;
          const spoken = heard;
          heard = [];
          emit({ type: "input_audio_buffer.committed", item_id: itemId });
          emit({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: itemId,
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

function openRelay(upstream: PolicyUpstream) {
  const response = openVoiceDictationRelayV1(
    new Request("https://bot.frockbot.com/api/voice/dictation", {
      headers: { upgrade: "websocket" },
    }),
    {
      env: { OPENAI_API_KEY: "sk-test" },
      connectUpstream: upstream.socket,
      lease,
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
  test("a capture reaches ready and lands its transcript", async () => {
    const upstream = policyUpstream();
    const opened = openRelay(upstream);
    opened.socket.send(start);
    opened.socket.send(pcm(1));
    await opened.waitFor((f) => f.type === "ready", "ready");
    opened.socket.send(pcm(2));
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
            f.type === "segment" ? `segment:${String(f.text)}` : f.type,
          ),
        ),
    );

    // The upstream accepted, so the composer got text instead of a refusal.
    expect(opened.frames.some((f) => f.type === "error")).toBe(false);
    expect(
      opened.frames.filter((f) => f.type === "segment").map((f) => f.text),
    ).toEqual(["heard 1,2"]);

    // Server VAD is still what the session asks for, unchanged.
    const input = (
      (sent.session as Record<string, unknown>).audio as Record<string, unknown>
    ).input as Record<string, unknown>;
    expect(input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 700,
    });
  });

  test("the same upstream refuses a session that asks for the old model", async () => {
    const upstream = policyUpstream();
    // Open the socket and speak the old session shape directly at it, so the
    // rule the previous test passed is shown to have teeth.
    const client = await upstream.socket();
    const refusal = new Promise<string>((resolve) => {
      client.addEventListener("message", (event) => {
        if (typeof event.data === "string") resolve(event.data);
      });
    });
    client.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: { model: "gpt-realtime-whisper" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },
            },
          },
        },
      }),
    );
    const raw = await refusal;
    console.log("[evidence] upstream answer for the old model: " + raw);
    // The relay reads that answer as a fatal refusal, not an empty buffer.
    const event = translateVoiceDictationUpstreamFrameV1(raw);
    expect(event).toEqual({
      kind: "error",
      message: "Turn detection is not supported for this transcription model.",
      emptyBuffer: false,
    });
  });
});
