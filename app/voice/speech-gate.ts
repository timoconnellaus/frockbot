// An energy gate with a pre-roll.
//
// Not a voice activity detector: it compares a frame's amplitude against an
// adapting floor and nothing more, and it will happily call a slammed door
// speech. It is deliberately not asked to do more than two jobs, both of which
// tolerate being wrong occasionally:
//
//   Waking. The transcriber bills every second it hears, so it is put to sleep
//   after a long quiet stretch. Something has to decide when the room started
//   making noise again, and replay the half-second before it decided, so the
//   first syllable survives the wait for a session to open.
//
//   Barge-in. While the assistant is talking, `bargeInDetected` — a higher
//   threshold held for longer — is what stops the speaker.
//
// What it explicitly does *not* do is choose which frames go up the wire while
// the upstream is awake. Every frame does, silence included: the transcriber
// finds the end of a turn in the pause after it, and a client that goes quiet
// at the pause never lets it get there.
//
// Pure: no DOM, no timers, no audio API. Frames arrive with the level already
// measured and a clock reading already taken, so the whole policy is testable
// with plain numbers.

/** One frame handed to the gate, and what the gate decided about it. */
export interface SpeechGateResultV1 {
  /** The gate is open: this frame belongs to an utterance. */
  speaking: boolean;
  /** This frame is the one that opened the gate. */
  onset: boolean;
  /** This frame is the one on which the hangover expired. */
  released: boolean;
  /**
   * The pre-roll, in capture order, followed by the current frame. Non-empty
   * only on an onset, and read only when that onset is waking a sleeping
   * upstream — while it is awake the caller sends every frame itself.
   */
  send: ArrayBuffer[];
}

export interface SpeechGateOptionsV1 {
  /** Milliseconds of audio per frame. */
  frameMs: number;
  /** Consecutive loud frames that verify an onset. Default 3 (≈120 ms). */
  onsetFrames?: number;
  /** How long the gate stays open after the last loud frame. Default 900 ms. */
  hangoverMs?: number;
  /** No frame under this RMS is ever speech, however quiet the room. */
  minFloorRms?: number;
  /** How far above the adapted noise floor a frame must sit, in decibels. */
  marginDb?: number;
  /** How much audio the ring holds ahead of an onset. Default 500 ms. */
  prerollMs?: number;
  /** Consecutive loud frames that verify a barge-in. Default 5 (≈200 ms). */
  bargeInFrames?: number;
  /** The barge-in margin, in decibels. Default 6 dB above `marginDb`. */
  bargeInMarginDb?: number;
}

export interface SpeechGateV1 {
  push(level: number, pcm: ArrayBuffer, nowMs: number): SpeechGateResultV1;
  /** How long the gate has been shut. Zero while it is open. */
  quietSinceMs(nowMs: number): number;
  /**
   * The stricter threshold, held for longer, for use while the assistant is
   * talking. It buys a margin against a cough or a keyboard; it does not
   * promise one.
   */
  bargeInDetected(): boolean;
  /** True while the gate is open or inside its hangover. The hangover is what
   * keeps a pause inside a sentence from starting the sleep countdown. */
  open(): boolean;
  /** The adapted noise floor, exposed for tests and diagnostics. */
  noiseFloor(): number;
  /** Forgets the pre-roll and closes the gate — a mute, or a fresh call. */
  reset(nowMs: number): void;
}

const DEFAULT_ONSET_FRAMES = 3;
const DEFAULT_HANGOVER_MS = 900;
const DEFAULT_MIN_FLOOR_RMS = 0.02;
const DEFAULT_MARGIN_DB = 8;
const DEFAULT_PREROLL_MS = 500;
const DEFAULT_BARGE_IN_FRAMES = 5;
const BARGE_IN_EXTRA_DB = 6;

/*
 * The floor climbs very slowly and falls quickly, on purpose, and it does both
 * whether or not the gate is open.
 *
 * Adapting only through silence cannot learn a noise that was already there
 * when the call started: the fan opens the gate on the first frame and holds
 * it open forever, and the meter never stops. Adapting quickly cannot survive
 * a long sentence: the floor chases the speech and shuts the speaker out
 * mid-breath. The rates below are the two answers at once — roughly a
 * ten-second climb and a quarter-second fall.
 *
 * The climb is slower again while the gate is open, because that is where the
 * two requirements pull hardest: a fan the call opened on must still be learnt
 * (it is, in about fifteen seconds, and then the meter stops), and a long
 * unbroken sentence must not be cut off by the floor chasing it (it is not —
 * over half a minute of continuous speech would be needed).
 */
const FLOOR_RISE = 0.004;
const FLOOR_RISE_OPEN = 0.0012;
const FLOOR_FALL = 0.15;

function clampLevel(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

export function createSpeechGateV1(options: SpeechGateOptionsV1): SpeechGateV1 {
  const frameMs = options.frameMs > 0 ? options.frameMs : 20;
  const onsetFrames = Math.max(1, options.onsetFrames ?? DEFAULT_ONSET_FRAMES);
  const hangoverMs = options.hangoverMs ?? DEFAULT_HANGOVER_MS;
  const minFloor = options.minFloorRms ?? DEFAULT_MIN_FLOOR_RMS;
  const marginDb = options.marginDb ?? DEFAULT_MARGIN_DB;
  const prerollMs = options.prerollMs ?? DEFAULT_PREROLL_MS;
  const bargeInFrames = Math.max(
    1,
    options.bargeInFrames ?? DEFAULT_BARGE_IN_FRAMES,
  );
  const bargeInMarginDb =
    options.bargeInMarginDb ?? marginDb + BARGE_IN_EXTRA_DB;

  const margin = 10 ** (marginDb / 20);
  const bargeInMargin = 10 ** (bargeInMarginDb / 20);
  const ringFrames = Math.max(1, Math.round(prerollMs / frameMs));

  let floor = minFloor;
  let opened = false;
  let loudRun = 0;
  let bargeRun = 0;
  let lastLoudAt = 0;
  let closedSince = 0;
  let started = false;
  // Only frames that were never sent live: emitting the ring on an onset can
  // then never repeat audio the wire has already carried.
  const ring: ArrayBuffer[] = [];

  function threshold(): number {
    return Math.max(minFloor, floor * margin);
  }

  function bargeThreshold(): number {
    return Math.max(minFloor * bargeInMargin, floor * bargeInMargin);
  }

  return {
    push(rawLevel, pcm, nowMs) {
      const level = clampLevel(rawLevel);
      if (!started) {
        started = true;
        closedSince = nowMs;
      }
      const loud = level >= threshold();
      loudRun = loud ? loudRun + 1 : 0;
      bargeRun = level >= bargeThreshold() ? bargeRun + 1 : 0;

      const rate =
        level <= floor ? FLOOR_FALL : opened ? FLOOR_RISE_OPEN : FLOOR_RISE;
      floor += (level - floor) * rate;

      let onset = false;
      let released = false;
      const send: ArrayBuffer[] = [];

      if (!opened && loudRun >= onsetFrames) {
        opened = true;
        onset = true;
        lastLoudAt = nowMs;
        send.push(...ring.splice(0, ring.length), pcm);
        return { speaking: true, onset, released, send };
      }

      if (opened) {
        if (loud) lastLoudAt = nowMs;
        if (nowMs - lastLoudAt > hangoverMs) {
          opened = false;
          released = true;
          closedSince = nowMs;
          loudRun = 0;
        } else {
          send.push(pcm);
          return { speaking: true, onset, released, send };
        }
      }

      ring.push(pcm);
      while (ring.length > ringFrames) ring.shift();
      return { speaking: false, onset, released, send };
    },

    quietSinceMs(nowMs) {
      if (opened) return 0;
      if (!started) return 0;
      return Math.max(0, nowMs - closedSince);
    },

    bargeInDetected() {
      return bargeRun >= bargeInFrames;
    },

    open() {
      return opened;
    },

    noiseFloor() {
      return floor;
    },

    reset(nowMs) {
      opened = false;
      loudRun = 0;
      bargeRun = 0;
      lastLoudAt = nowMs;
      closedSince = nowMs;
      started = true;
      ring.length = 0;
    },
  };
}
