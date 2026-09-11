import { describe, expect, test } from "bun:test";
import { createPcm16Upsampler16to24V1 } from "./pcm-resample.js";

function pcm(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return buffer;
}

function samples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const out: number[] = [];
  for (let i = 0; i < buffer.byteLength / 2; i += 1) {
    out.push(view.getInt16(i * 2, true));
  }
  return out;
}

describe("the 16 to 24 kHz upsampler", () => {
  test("answers a steady stream of frames with three samples for every two", () => {
    const upsample = createPcm16Upsampler16to24V1();
    const frame = pcm(new Array(640).fill(0).map((_, i) => i * 10 - 3200));
    // The first frame gives up its last sample to start the next one, so it is
    // one sample short; every frame after it is exactly 3:2.
    expect(samples(upsample(frame)).length).toBe(959);
    expect(samples(upsample(frame)).length).toBe(960);
    expect(samples(upsample(frame)).length).toBe(960);
  });

  test("interpolates between neighbours rather than repeating them", () => {
    const upsample = createPcm16Upsampler16to24V1();
    const out = samples(upsample(pcm([0, 300, 600, 900])));
    // Positions 0, 2/3, 4/3, 2, 8/3 against a ramp of 300 per input sample.
    expect(out).toEqual([0, 200, 400, 600, 800]);
  });

  test("carries the phase across frames so the ramp stays straight", () => {
    const upsample = createPcm16Upsampler16to24V1();
    const first = samples(upsample(pcm([0, 300, 600, 900])));
    const second = samples(upsample(pcm([1200, 1500, 1800, 2100])));
    // The next output after 800 is 1000, two thirds of an input sample on,
    // and the run continues without a step or a repeat.
    expect(first.at(-1)).toBe(800);
    expect(second.slice(0, 3)).toEqual([1000, 1200, 1400]);
    const stream = [...first, ...second];
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i]! - stream[i - 1]!).toBe(200);
    }
  });

  test("holds an odd trailing byte until the byte that completes it", () => {
    const upsample = createPcm16Upsampler16to24V1();
    const whole = pcm([0, 300, 600, 900]);
    const bytes = new Uint8Array(whole);
    const split = samples(upsample(bytes.slice(0, 5).buffer));
    const rest = samples(upsample(bytes.slice(5).buffer));
    // Two and a half samples arrived first, then the rest; what comes out is
    // what the whole frame would have produced.
    expect([...split, ...rest]).toEqual([0, 200, 400, 600, 800]);
  });

  test("says nothing when a frame is half a sample", () => {
    const upsample = createPcm16Upsampler16to24V1();
    expect(upsample(new Uint8Array([1]).buffer).byteLength).toBe(0);
  });
});
