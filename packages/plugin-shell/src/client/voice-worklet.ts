// The dictation capture worklet, and the path the app serves it from.
//
// It is a first-party asset on the app's own origin rather than a blob URL,
// and that is a security decision, not a packaging one: the hosted client is
// served under `script-src 'self'`, which a `blob:` module does not satisfy —
// `context.audioWorklet.addModule(blobUrl)` fails with "Unable to load a
// worklet's module". Widening the policy to admit blob scripts everywhere, to
// load one 40-line file, is the wrong trade. So the source lives here as a
// string, the application Worker answers `GET` on the path below with it
// (`apps/cloudflare/src/user-application.ts`), and the policy is untouched.
//
// Its own module so the Worker can serve the source without pulling the
// browser-only microphone plumbing in beside it.

/** Where the application Worker serves {@link VOICE_CAPTURE_WORKLET_SOURCE_V1}. */
export const VOICE_CAPTURE_WORKLET_PATH_V1 = "/voice-capture-worklet.js";

/** The processor's registered name, shared by the source and the node. */
export const VOICE_CAPTURE_WORKLET_PROCESSOR_V1 = "frock-voice-capture";

/**
 * Microphone audio, decimated to the target rate and framed as PCM16.
 *
 * On the audio thread rather than the main one, because the alternative
 * (`ScriptProcessorNode`) shares the thread with Vue's renderer and drops
 * audio exactly when the composer is busiest — while the draft it is writing
 * is being re-laid out.
 *
 * The rate is reached by decimating whatever the context gives us rather than
 * by asking for it: iOS Safari ignores `new AudioContext({ sampleRate })` and
 * hands back 48 kHz regardless, and audio at the wrong rate transcribes as
 * gibberish rather than failing.
 */
export const VOICE_CAPTURE_WORKLET_SOURCE_V1 = `
class FrockVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions.targetRate;
    this.frame = options.processorOptions.frameSamples;
    this.buffer = new Float32Array(this.frame);
    this.filled = 0;
    this.position = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const step = sampleRate / this.target;
    let peak = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const value = channel[index];
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
    }
    // Decimation: walk the block at a fractional step, carrying the remainder
    // across blocks so no drift accumulates. Enough for speech, and cheap.
    while (this.position < channel.length) {
      this.buffer[this.filled] = channel[Math.floor(this.position)];
      this.position += step;
      this.filled += 1;
      if (this.filled === this.frame) {
        const pcm = new Int16Array(this.frame);
        for (let sample = 0; sample < this.frame; sample += 1) {
          const clamped = Math.max(-1, Math.min(1, this.buffer[sample]));
          pcm[sample] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
        this.port.postMessage({ pcm: pcm.buffer, level: peak }, [pcm.buffer]);
        this.filled = 0;
      }
    }
    this.position -= channel.length;
    return true;
  }
}
registerProcessor("${VOICE_CAPTURE_WORKLET_PROCESSOR_V1}", FrockVoiceCapture);
`;
