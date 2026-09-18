// The gate in front of the opt-in diagnostics.
//
// Everything downstream of this file is `timing?.mark(…)`, so this decision —
// is there a timing at all — is the whole of the opt-in. What is proved here
// is that it is one shape only, that a url cannot smuggle a string of its own
// into a log, and that a line carries what it says it carries and no more.
import { describe, expect, test } from "bun:test";
import {
  isVoiceTraceIdV1,
  voiceAssistantEdgeTimingOfV1,
  voiceAssistantEdgeTimingV1,
  voiceTimingForV1,
  voiceTraceOfV1,
  VoiceTimingV1,
  VOICE_TIMING_PREFIX_V1,
  VOICE_TRACE_QUERY_V1,
} from "./diagnostics.js";

const TRACE = "6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071";

const asked = (query: string) =>
  new URL(`https://frockbot.example/api/voice/assistant${query}`);

describe("the trace a socket may carry", () => {
  test("is a UUID, or it is nothing", () => {
    expect(isVoiceTraceIdV1(TRACE)).toBe(true);
    expect(isVoiceTraceIdV1(crypto.randomUUID())).toBe(true);
    for (const value of [
      "",
      "not-a-uuid",
      "../../etc/passwd",
      "6f1a2b3c-4d5e-4f60-8a1b",
      `${TRACE} and a sentence`,
      TRACE.toUpperCase(),
      42,
      null,
      undefined,
      { toString: () => TRACE },
    ]) {
      expect(isVoiceTraceIdV1(value)).toBe(false);
    }
  });

  test("enables nothing when it is absent, wrong or repeated", () => {
    expect(voiceTraceOfV1(asked("?version=1"))).toBeUndefined();
    expect(voiceTraceOfV1(asked("?trace=nonsense"))).toBeUndefined();
    // Two of them is a client nobody wrote; diagnostics are not worth
    // guessing which one it meant.
    expect(
      voiceTraceOfV1(asked(`?trace=${TRACE}&trace=${crypto.randomUUID()}`)),
    ).toBeUndefined();
    expect(voiceTraceOfV1(asked(`?version=1&trace=${TRACE}`))).toBe(TRACE);
    expect(VOICE_TRACE_QUERY_V1).toBe("trace");
  });

  test("only the assistant upgrade is timed at the edge", () => {
    expect(voiceAssistantEdgeTimingV1(asked(`?trace=${TRACE}`))?.trace).toBe(
      TRACE,
    );
    expect(
      voiceAssistantEdgeTimingOfV1(
        `https://frockbot.example/api/voice/dictation?trace=${TRACE}`,
      ),
    ).toBeUndefined();
    expect(
      voiceAssistantEdgeTimingOfV1("https://frockbot.example/api/identity"),
    ).toBeUndefined();
    expect(voiceAssistantEdgeTimingOfV1("not a url at all")).toBeUndefined();
    expect(
      voiceAssistantEdgeTimingOfV1(
        `https://frockbot.example/api/voice/assistant?trace=${TRACE}`,
      )?.trace,
    ).toBe(TRACE);
  });
});

describe("a line, when there is one", () => {
  test("carries the id, the side, the clock and what it was given", () => {
    const written: string[] = [];
    const timing = new VoiceTimingV1(
      TRACE,
      (line) => written.push(line),
      "edge",
    );
    timing.mark("edge-fetch");
    timing.markOnce("once", { bytes: 1280 });
    timing.markOnce("once", { bytes: 9999 });
    expect(written).toHaveLength(2);
    const first = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(first.trace).toBe(TRACE);
    expect(first.side).toBe("edge");
    expect(first.event).toBe("edge-fetch");
    expect(typeof first.elapsedMs).toBe("number");
    expect(first.elapsedMs as number).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(first.at as string))).toBe(false);
    const second = JSON.parse(written[1] ?? "{}") as Record<string, unknown>;
    expect(second.bytes).toBe(1280);
    expect(Object.keys(second).sort()).toEqual([
      "at",
      "bytes",
      "elapsedMs",
      "event",
      "side",
      "trace",
    ]);
    expect(VOICE_TIMING_PREFIX_V1).toBe("voice timing");
  });

  test("a request that asked for none builds nothing to write with", () => {
    expect(voiceTimingForV1(asked("?version=1"))).toBeUndefined();
    expect(voiceTimingForV1(asked(`?trace=${TRACE}`))?.trace).toBe(TRACE);
  });
});
