// The browser's half of dictation: a microphone, resampled to the PCM16 the
// upstream transcription session expects.
//
// The capture itself runs on the audio thread; its source and the reason it is
// served as a first-party asset are in `voice-worklet.ts`. This module is the
// graph around it: permission, the context, the silent sink that keeps the
// node pulled, and the teardown that actually releases the microphone.
import {
  VOICE_CAPTURE_WORKLET_PATH_V1,
  VOICE_CAPTURE_WORKLET_PROCESSOR_V1,
} from "./voice-worklet.js";

/** What the upstream is told to expect, and therefore what leaves here. */
export const VOICE_CAPTURE_SAMPLE_RATE_V1 = 24_000;

/** Samples per frame at 24 kHz: 32 ms, small enough to feel live. */
const FRAME_SAMPLES = 768;

export interface VoiceMicrophoneV1 {
  stop(): Promise<void>;
}

export interface VoiceMicrophoneOptionsV1 {
  /** One frame of PCM16, little-endian, mono, 24 kHz. */
  audio(pcm16: ArrayBuffer): void;
  /** Peak amplitude of the frame, 0…1, for the capture animation. */
  level(value: number): void;
}

/** False on a platform with no microphone API at all; the button stays hidden. */
export function voiceCaptureSupportedV1(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof (globalThis as { AudioContext?: unknown }).AudioContext ===
      "function"
  );
}

/**
 * The refusal a person reads when the browser will not give up the
 * microphone. Named cases only: anything else says what the browser said.
 */
export function voiceMicrophoneRefusalV1(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "FrockBot needs permission to use your microphone. Allow it in your browser, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Plug one in, then try again.";
  }
  return `The microphone couldn't start: ${
    error instanceof Error && error.message ? error.message : "unknown error"
  }`;
}

export async function startVoiceMicrophoneV1(
  options: VoiceMicrophoneOptionsV1,
): Promise<VoiceMicrophoneV1> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let silence: GainNode | undefined;
  try {
    // Same-origin, so `script-src 'self'` admits it. See `voice-worklet.ts`.
    await context.audioWorklet.addModule(VOICE_CAPTURE_WORKLET_PATH_V1);
    node = new AudioWorkletNode(context, VOICE_CAPTURE_WORKLET_PROCESSOR_V1, {
      numberOfInputs: 1,
      // One silent output, connected below. A graph is pulled from the
      // destination, so a node with no path to it is never asked to process
      // and the microphone produces nothing at all — silently.
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetRate: VOICE_CAPTURE_SAMPLE_RATE_V1,
        frameSamples: FRAME_SAMPLES,
      },
    });
    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { pcm?: ArrayBuffer; level?: number };
      if (message.pcm) options.audio(message.pcm);
      if (typeof message.level === "number") options.level(message.level);
    };
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    // Silenced at the sink rather than left unconnected: the person must not
    // hear themselves, and the node must still be pulled.
    silence = context.createGain();
    silence.gain.value = 0;
    node.connect(silence);
    silence.connect(context.destination);
    // A suspended context produces silence and no error at all; Safari hands
    // one back whenever the gesture that opened it has already finished.
    if (context.state === "suspended") await context.resume();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (node) node.port.onmessage = null;
      source?.disconnect();
      node?.disconnect();
      silence?.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
    },
  };
}
