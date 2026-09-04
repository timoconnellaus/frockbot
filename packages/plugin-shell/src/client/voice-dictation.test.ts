import { describe, expect, test } from "bun:test";
import {
  applyDictationTailV1,
  voiceButtonLabelV1,
  voiceWaveBarsV1,
  VoiceDictationTranscriptV1,
} from "./voice-dictation.js";

describe("writing dictation into a draft somebody may be editing", () => {
  test("appends the first words to an empty draft", () => {
    expect(applyDictationTailV1("", "", "hello")).toEqual({
      draft: "hello",
      tail: "hello",
    });
  });

  test("grows in place rather than repeating itself", () => {
    const first = applyDictationTailV1("", "", "hello");
    const second = applyDictationTailV1(first.draft, first.tail, "hello there");
    expect(second.draft).toBe("hello there");
  });

  test("keeps a typed prefix, and a typed suffix, around what is spoken", () => {
    const first = applyDictationTailV1("Note: ", "", "buy milk");
    expect(first.draft).toBe("Note: buy milk");
    // The person types on the end while the next words arrive.
    const edited = `${first.draft} today`;
    const second = applyDictationTailV1(
      edited,
      first.tail,
      "buy milk and bread",
    );
    expect(second.draft).toBe("Note: buy milk and bread today");
  });

  test("rewrites the last occurrence, so a repeated word moves the right one", () => {
    // "go" was typed, then "go" was dictated. Growing the dictated one must
    // not reach back and rewrite the typed one.
    expect(applyDictationTailV1("go go", "go", "gone")).toEqual({
      draft: "go gone",
      tail: "gone",
    });
  });

  test("appends rather than fighting when the person deleted what was dictated", () => {
    const first = applyDictationTailV1("", "", "hello");
    const cleared = applyDictationTailV1("", first.tail, "hello there");
    expect(cleared).toEqual({ draft: "hello there", tail: "hello there" });
  });

  test("never glues two words together", () => {
    expect(applyDictationTailV1("Note:", "", "one").draft).toBe("Note: one");
    expect(applyDictationTailV1("Note: ", "", "one").draft).toBe("Note: one");
  });
});

describe("what has been heard so far", () => {
  test("streams deltas, then lets the finished segment replace them", () => {
    const transcript = new VoiceDictationTranscriptV1();
    expect(transcript.empty()).toBe(true);
    transcript.delta("hello ");
    transcript.delta("their");
    expect(transcript.text()).toBe("hello their");
    transcript.settle("Hello there.");
    expect(transcript.text()).toBe("Hello there.");
    expect(transcript.empty()).toBe(false);
  });

  test("joins segments with a single space and drops an empty one", () => {
    const transcript = new VoiceDictationTranscriptV1();
    transcript.settle("  One. ");
    transcript.settle("");
    transcript.settle("Two.");
    transcript.delta("thr");
    expect(transcript.text()).toBe("One. Two. thr");
  });

  test("resets to nothing, so a binned capture leaves no tail behind", () => {
    const transcript = new VoiceDictationTranscriptV1();
    transcript.settle("One.");
    transcript.reset();
    expect(transcript.empty()).toBe(true);
    expect(transcript.text()).toBe("");
  });
});

describe("the composer's dictation chrome", () => {
  test("names each state for the aria label and the tooltip alike", () => {
    expect(voiceButtonLabelV1("idle")).toBe("Dictate a message");
    expect(voiceButtonLabelV1("listening")).toBe("Listening");
    expect(voiceButtonLabelV1("finishing")).toBe("Finishing dictation");
  });

  test("the wave follows the microphone and never collapses to a line", () => {
    const silent = voiceWaveBarsV1(0, []);
    expect(silent).toHaveLength(4);
    expect(silent.every((bar) => bar >= 0.2)).toBe(true);
    const loud = voiceWaveBarsV1(1, silent);
    expect(loud[0]).toBeCloseTo(1);
    // The level travels along the bars rather than moving all of them at once.
    expect(loud[1]).toBeCloseTo(silent[0]!);
    expect(voiceWaveBarsV1(Number.NaN, silent)[0]).toBeCloseTo(0.2);
    expect(voiceWaveBarsV1(9, silent)[0]).toBeCloseTo(1);
  });
});
