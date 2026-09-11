import { describe, expect, test } from "bun:test";
import { createSpeechGateV1 } from "./speech-gate.js";

const FRAME_MS = 40;

function frame(tag: number): ArrayBuffer {
  const bytes = new Uint8Array(4);
  bytes[0] = tag & 0xff;
  bytes[1] = (tag >> 8) & 0xff;
  return bytes.buffer;
}

function tagOf(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  return bytes[0] | (bytes[1] << 8);
}

function gate(
  overrides: Partial<Parameters<typeof createSpeechGateV1>[0]> = {},
) {
  return createSpeechGateV1({
    frameMs: FRAME_MS,
    minFloorRms: 0.02,
    marginDb: 8,
    prerollMs: 200,
    ...overrides,
  });
}

describe("speech gate onset", () => {
  test("a single loud frame does not open the gate", () => {
    const speech = gate();
    let at = 0;
    let tag = 0;
    // Settle the floor on a quiet room first.
    for (let index = 0; index < 10; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    const spike = speech.push(0.9, frame(tag++), (at += FRAME_MS));
    expect(spike.onset).toBe(false);
    expect(spike.speaking).toBe(false);
    expect(spike.send).toEqual([]);

    const after = speech.push(0.001, frame(tag++), (at += FRAME_MS));
    expect(after.speaking).toBe(false);
    expect(speech.open()).toBe(false);
  });

  test("three consecutive loud frames open the gate", () => {
    const speech = gate({ onsetFrames: 3 });
    let at = 0;
    let tag = 0;
    for (let index = 0; index < 10; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    expect(speech.push(0.5, frame(tag++), (at += FRAME_MS)).onset).toBe(false);
    expect(speech.push(0.5, frame(tag++), (at += FRAME_MS)).onset).toBe(false);
    const opened = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(opened.onset).toBe(true);
    expect(opened.speaking).toBe(true);
  });
});

describe("speech gate pre-roll", () => {
  test("emits the ring in order ahead of the onset frame, once", () => {
    const speech = gate({ onsetFrames: 2, prerollMs: 200 });
    let at = 0;
    let tag = 0;
    for (let index = 0; index < 12; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    const quietTail = [tag - 5, tag - 4, tag - 3, tag - 2, tag - 1];

    const first = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(first.onset).toBe(false);
    const opened = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(opened.onset).toBe(true);

    const sent = opened.send.map(tagOf);
    // Five frames of pre-roll (200 ms at 40 ms) — the newest four quiet frames
    // and the first loud one, which had not yet verified the onset — followed
    // by the frame that did, in the order they were captured.
    expect(sent.length).toBe(6);
    expect(sent).toEqual(
      Array.from({ length: 6 }, (_, index) => sent[0] + index),
    );
    expect(sent.at(-1)).toBe(tag - 1);
    expect(sent).toContain(quietTail[quietTail.length - 1]);

    // Live frames while open carry only themselves.
    const live = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(live.send.map(tagOf)).toEqual([tag - 1]);

    // Close, then re-open: nothing already sent is replayed.
    for (let index = 0; index < 40; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    const reopenFirst = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(reopenFirst.onset).toBe(false);
    const reopened = speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(reopened.onset).toBe(true);
    const replayed = reopened.send.map(tagOf);
    expect(replayed).not.toContain(sent[0]);
    expect(new Set(replayed).size).toBe(replayed.length);
  });
});

describe("speech gate hangover", () => {
  test("streams through a 600 ms pause and closes after 900 ms", () => {
    const speech = gate({ onsetFrames: 2, hangoverMs: 900 });
    let at = 0;
    let tag = 0;
    for (let index = 0; index < 10; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    speech.push(0.5, frame(tag++), (at += FRAME_MS));
    speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(speech.open()).toBe(true);

    // 600 ms of quiet: still streaming.
    for (let index = 0; index < 600 / FRAME_MS; index += 1) {
      const result = speech.push(0.001, frame(tag++), (at += FRAME_MS));
      expect(result.speaking).toBe(true);
      expect(result.send.length).toBe(1);
    }
    expect(speech.open()).toBe(true);

    // Past 900 ms it releases and stops sending.
    let released = false;
    for (let index = 0; index < 400 / FRAME_MS; index += 1) {
      const result = speech.push(0.001, frame(tag++), (at += FRAME_MS));
      if (result.released) released = true;
    }
    expect(released).toBe(true);
    expect(speech.open()).toBe(false);
    expect(speech.push(0.001, frame(tag++), (at += FRAME_MS)).send).toEqual([]);
  });

  test("quietSinceMs is zero while open and grows once released", () => {
    const speech = gate({ onsetFrames: 2, hangoverMs: 900 });
    let at = 0;
    let tag = 0;
    speech.push(0.001, frame(tag++), (at += FRAME_MS));
    speech.push(0.5, frame(tag++), (at += FRAME_MS));
    speech.push(0.5, frame(tag++), (at += FRAME_MS));
    expect(speech.quietSinceMs(at)).toBe(0);
    for (let index = 0; index < 50; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }
    expect(speech.quietSinceMs(at + 5_000)).toBeGreaterThan(5_000);
  });
});

describe("speech gate noise floor", () => {
  test("adapts upward in sustained noise; louder speech still opens", () => {
    const speech = gate({ onsetFrames: 3, minFloorRms: 0.005, marginDb: 8 });
    let at = 0;
    let tag = 0;
    const noise = 0.06;
    // A fan that was already running when the call started opens the gate for
    // a moment and is then learnt: the last seconds of it send nothing.
    let sentInTail = 0;
    for (let index = 0; index < 800; index += 1) {
      const result = speech.push(noise, frame(tag++), (at += FRAME_MS));
      if (index >= 600) sentInTail += result.send.length;
    }
    expect(sentInTail).toBe(0);
    expect(speech.open()).toBe(false);
    expect(speech.noiseFloor()).toBeGreaterThan(0.04);
    expect(speech.noiseFloor()).toBeLessThanOrEqual(noise);

    // Speech above the adapted floor still opens the gate.
    let onset = false;
    for (let index = 0; index < 4; index += 1) {
      if (speech.push(0.45, frame(tag++), (at += FRAME_MS)).onset) onset = true;
    }
    expect(onset).toBe(true);
  });

  test("the floor rises slowly rather than in one frame", () => {
    const speech = gate({ minFloorRms: 0.001 });
    let at = 0;
    const before = speech.noiseFloor();
    speech.push(0.05, frame(1), (at += FRAME_MS));
    const after = speech.noiseFloor();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(0.01);
  });

  test("a long unbroken utterance is not cut off by its own adaptation", () => {
    const speech = gate({ onsetFrames: 3, minFloorRms: 0.02, marginDb: 8 });
    let at = 0;
    let tag = 0;
    for (let index = 0; index < 10; index += 1) {
      speech.push(0.002, frame(tag++), (at += FRAME_MS));
    }
    // Six seconds of continuous speech: the gate stays open throughout.
    for (let index = 0; index < 150; index += 1) {
      speech.push(0.5, frame(tag++), (at += FRAME_MS));
    }
    expect(speech.open()).toBe(true);
  });
});

describe("speech gate barge-in", () => {
  test("is stricter than an ordinary onset", () => {
    const speech = gate({
      onsetFrames: 3,
      bargeInFrames: 5,
      minFloorRms: 0.02,
      marginDb: 8,
      bargeInMarginDb: 14,
    });
    let at = 0;
    let tag = 0;
    for (let index = 0; index < 10; index += 1) {
      speech.push(0.001, frame(tag++), (at += FRAME_MS));
    }

    // Loud enough to open the gate, not loud enough to interrupt a reply.
    let onset = false;
    for (let index = 0; index < 6; index += 1) {
      if (speech.push(0.06, frame(tag++), (at += FRAME_MS)).onset) onset = true;
    }
    expect(onset).toBe(true);
    expect(speech.bargeInDetected()).toBe(false);

    // Four loud frames are still not enough; the fifth is.
    for (let index = 0; index < 4; index += 1) {
      speech.push(0.6, frame(tag++), (at += FRAME_MS));
    }
    expect(speech.bargeInDetected()).toBe(false);
    speech.push(0.6, frame(tag++), (at += FRAME_MS));
    expect(speech.bargeInDetected()).toBe(true);

    // One quiet frame retires it.
    speech.push(0.001, frame(tag++), (at += FRAME_MS));
    expect(speech.bargeInDetected()).toBe(false);
  });
});
