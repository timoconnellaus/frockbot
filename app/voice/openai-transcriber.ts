// The continuous assistant's ears: OpenAI realtime transcription with the
// server deciding where a turn ends.
//
// The assistant is hands-free. Nobody presses a key to say "I have finished
// speaking", so something has to hear the pause — and the thing that hears it
// should be the thing that heard the speech. `gpt-transcribe` with
// `server_vad` announces `input_audio_buffer.speech_started` the instant
// someone talks over the reply (which is what barge-in hangs on) and commits
// an item about half a second after they stop, which is the turn. It streams
// no text before that commit; dictation, which needs live text and therefore
// a streaming model, cannot have VAD, and this path, which needs VAD, cannot
// have live text. Established against the live endpoint on 2026-09-11.
//
// Nothing here imports the Cloudflare SDK or opens a socket itself: the
// socket arrives as a factory, so the whole adapter is driven by a fake in
// tests and by a `fetch` upgrade in the Worker.
import { createPcm16Upsampler16to24V1 } from "./pcm-resample.js";
import {
  translateVoiceRealtimeUpstreamFrameV1,
  voiceRealtimeAppendV1,
  VOICE_REALTIME_PCM_RATE_V1,
} from "./openai-realtime.js";
import type {
  VoiceTranscriberSessionOptionsV1,
  VoiceTranscriberSessionV1,
  VoiceTranscriberV1,
} from "./sleeping-transcriber.js";

/** The VAD transcription model the assistant listens through. */
export const VOICE_ASSISTANT_STT_MODEL_V1 = "gpt-transcribe";

/**
 * How the server decides a turn ended.
 *
 * 700 ms of silence is long enough to survive the pause in the middle of a
 * sentence most of the time and short enough that the answer does not feel
 * late. A longer mid-sentence pause splits the turn in two; two short Turns
 * is a better failure than a lost one.
 */
export const VOICE_ASSISTANT_TURN_DETECTION_V1 = {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
} as const;

/** The socket the adapter drives, named so a test can be one. */
export interface VoiceRealtimeSocketV1 {
  send(data: string): void;
  close(): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export interface OpenAiTranscriberOptionsV1 {
  /** Opens one upstream socket, already accepted. */
  openSocket: () => Promise<VoiceRealtimeSocketV1>;
}

/** What the assistant says to the upstream before any audio. */
export function voiceAssistantSessionUpdateV1(): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          // 24 kHz is the only rate the endpoint accepts, whatever the client
          // captured at; `feed` resamples to meet it.
          format: { type: "audio/pcm", rate: VOICE_REALTIME_PCM_RATE_V1 },
          // The assistant is spoken to across a room, not into a phone held
          // at the mouth, which is the difference from dictation.
          noise_reduction: { type: "far_field" },
          transcription: { model: VOICE_ASSISTANT_STT_MODEL_V1 },
          turn_detection: VOICE_ASSISTANT_TURN_DETECTION_V1,
        },
      },
    },
  };
}

/**
 * A transcriber whose sessions are OpenAI realtime sockets.
 *
 * Shaped for `@cloudflare/voice` — and so for the sleeping wrapper that sits
 * between them — which opens one session per call, feeds it PCM16, and acts
 * on the callbacks: `onSpeechStart` interrupts playback, `onUtterance` starts
 * a chat turn, `onFatalError` ends the call.
 */
export function createOpenAiTranscriberV1(
  options: OpenAiTranscriberOptionsV1,
): VoiceTranscriberV1 {
  return {
    createSession(sessionOptions: VoiceTranscriberSessionOptionsV1 = {}) {
      return openSession(options.openSocket, sessionOptions);
    },
  };
}

function openSession(
  openSocket: () => Promise<VoiceRealtimeSocketV1>,
  options: VoiceTranscriberSessionOptionsV1,
): VoiceTranscriberSessionV1 {
  const upsample = createPcm16Upsampler16to24V1();
  /** Text accumulated per item id, so an interim reads as the whole phrase. */
  const partials = new Map<string, string>();
  let socket: VoiceRealtimeSocketV1 | undefined;
  let ready = false;
  let closed = false;
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Nothing is waiting on this promise until `waitUntilReady` is called, and
  // a rejection before then would be unhandled.
  readyPromise.catch(() => {});

  const fail = (message: string) => {
    if (closed) return;
    const error = new Error(message);
    if (!settled) {
      settled = true;
      closed = true;
      socket?.close();
      rejectReady(error);
      return;
    }
    closed = true;
    socket?.close();
    options.onFatalError?.(error);
  };

  const onEvent = (raw: string) => {
    if (closed) return;
    const event = translateVoiceRealtimeUpstreamFrameV1(raw);
    if (!event) return;
    switch (event.kind) {
      case "session-updated": {
        if (ready) return;
        ready = true;
        settled = true;
        resolveReady();
        return;
      }
      case "speech-started":
        options.onSpeechStart?.();
        return;
      case "delta": {
        const id = event.itemId ?? "current";
        const text = (partials.get(id) ?? "") + event.text;
        partials.set(id, text);
        options.onInterim?.(text);
        return;
      }
      case "completed": {
        partials.delete(event.itemId ?? "current");
        const transcript = event.text.trim();
        if (transcript) options.onUtterance?.(transcript);
        return;
      }
      case "failed":
        // One item the model could not read. The call continues; the person
        // repeats themselves.
        partials.delete(event.itemId ?? "current");
        return;
      case "committed":
        return;
      case "error":
        fail(event.message);
        return;
    }
  };

  void openSocket().then(
    (opened) => {
      if (closed) {
        opened.close();
        return;
      }
      socket = opened;
      opened.onMessage(onEvent);
      opened.onClose((reason) => {
        fail(reason || "the transcription service closed the connection");
      });
      opened.send(JSON.stringify(voiceAssistantSessionUpdateV1()));
    },
    (error: unknown) => {
      fail(error instanceof Error ? error.message : String(error));
    },
  );

  return {
    feed(chunk: ArrayBuffer) {
      // Audio fed before the session is ready is dropped: the sleeping
      // wrapper above holds and drains frames itself and only feeds once
      // `waitUntilReady` has resolved.
      if (closed || !ready || !socket) return;
      socket.send(voiceRealtimeAppendV1(upsample(chunk)));
    },
    waitUntilReady() {
      return readyPromise;
    },
    close() {
      if (closed) return;
      closed = true;
      settled = true;
      socket?.close();
    },
  };
}
