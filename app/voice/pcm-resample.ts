// Turning the clients' 16 kHz microphone audio into the 24 kHz the
// transcription upstream insists on.
//
// Both clients capture at `VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1` (16 kHz) and
// OpenAI's realtime socket accepts one PCM rate and one only — 24 kHz — so
// every assistant frame is resampled on the way up. The ratio is 2:3, and a
// frame boundary is not a stream boundary: the interpolation phase and the
// last sample carry from one frame to the next so the output is one
// continuous signal rather than a series of restarts, and an odd trailing
// byte (half a sample) waits for the byte that completes it.

const RATIO = 16_000 / 24_000;

/**
 * A stateful 16 → 24 kHz upsampler for little-endian PCM16.
 *
 * One per upstream session: the returned function is fed frames in order and
 * answers each with the bytes that belong to it. Linear interpolation is
 * enough here — the source is band-limited speech well below 8 kHz, and what
 * matters to the model is that the signal is continuous and at the declared
 * rate.
 */
export function createPcm16Upsampler16to24V1(): (
  frame: ArrayBuffer,
) => ArrayBuffer {
  /** The last sample of the previous frame, at virtual index -1. */
  let previous: number | undefined;
  /** Where the next output sample falls, in input samples from the frame. */
  let phase = 0;
  /** Half a sample left over from the previous frame. */
  let oddByte: number | undefined;

  return (frame: ArrayBuffer): ArrayBuffer => {
    const bytes = new Uint8Array(frame);
    const joined =
      oddByte === undefined
        ? bytes
        : (() => {
            const merged = new Uint8Array(bytes.length + 1);
            merged[0] = oddByte;
            merged.set(bytes, 1);
            return merged;
          })();
    const sampleCount = joined.length >> 1;
    oddByte = joined.length % 2 === 1 ? joined[joined.length - 1] : undefined;
    if (sampleCount === 0) return new ArrayBuffer(0);

    const input = new Int16Array(sampleCount);
    const view = new DataView(joined.buffer, joined.byteOffset, joined.length);
    for (let i = 0; i < sampleCount; i += 1) {
      input[i] = view.getInt16(i * 2, true);
    }

    // Positions are measured against `[previous, ...input]` when a previous
    // sample exists, so index 0 is that carried sample; without one the frame
    // starts at its own first sample. Output runs while the pair straddling
    // the position is in hand, and what is left over becomes the next frame's
    // starting phase.
    const offset = previous === undefined ? 0 : 1;
    const last = sampleCount - 1 + offset;
    const at = (index: number): number =>
      index < offset ? previous! : input[index - offset]!;

    const out: number[] = [];
    let position = phase;
    while (position < last) {
      const lower = Math.floor(position);
      const fraction = position - lower;
      const a = at(lower);
      const b = at(lower + 1);
      out.push(Math.round(a + (b - a) * fraction));
      position += RATIO;
    }
    phase = position - last;
    previous = input[sampleCount - 1];

    const result = new ArrayBuffer(out.length * 2);
    const resultView = new DataView(result);
    for (let i = 0; i < out.length; i += 1) {
      resultView.setInt16(i * 2, clampPcm16(out[i]!), true);
    }
    return result;
  };
}

function clampPcm16(value: number): number {
  if (value > 32_767) return 32_767;
  if (value < -32_768) return -32_768;
  return value;
}
