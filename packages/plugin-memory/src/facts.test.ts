// The typed markers on a fact text: `[note] ` and the reserved `[episode] `.
//
// The claim every case here defends is that typing the markers changed no
// bytes. A file written before markers were parsed parses to the same facts,
// renders to the same file, and injects the same line.
import { describe, expect, test } from "bun:test";
import {
  MEMORY_MARKERS_V1,
  isMemoryRetractionV1,
  memoryFactBodyV1,
  parseMemoryFileV1,
  parseMemoryMarkerV1,
  renderInjectedFactLineV1,
  renderMemoryFileV1,
  renderMemoryMarkerV1,
  retractedFactTextV1,
} from "./facts.ts";

describe("parseMemoryMarkerV1", () => {
  test("recognises exactly `[note] ` and `[episode] `", () => {
    expect(MEMORY_MARKERS_V1).toEqual(["note", "episode"]);
    expect(parseMemoryMarkerV1("[note] we ship on Friday")).toEqual({
      marker: "note",
      body: "we ship on Friday",
    });
    expect(parseMemoryMarkerV1("[episode] the gym build week")).toEqual({
      marker: "episode",
      body: "the gym build week",
    });
  });

  test("an unrecognised bracket prefix is fact text, not a marker", () => {
    for (const text of [
      "[todo] buy rubber matting",
      "[via School] Tim lives in Wollongong.",
      "[note]no space",
      "[NOTE] shouting",
      "a note about the floor",
    ]) {
      expect(parseMemoryMarkerV1(text)).toEqual({ body: text });
      expect(memoryFactBodyV1(text)).toBe(text);
    }
  });

  test("a retraction is checked first, so `[forgotten] [note] x` retracts the note", () => {
    const retraction = "[forgotten] [note] we ship on Friday";
    expect(isMemoryRetractionV1(retraction)).toBe(true);
    // The retraction itself carries no marker…
    expect(parseMemoryMarkerV1(retraction)).toEqual({ body: retraction });
    // …and what it retracts is the note, marker and all.
    expect(parseMemoryMarkerV1(retractedFactTextV1(retraction))).toEqual({
      marker: "note",
      body: "we ship on Friday",
    });
  });

  test("render is the exact inverse of parse, byte for byte", () => {
    for (const text of [
      "[note] we ship on Friday",
      "[episode] the gym build week",
      "[todo] buy rubber matting",
      "plain",
      "[note]  two spaces after the marker",
    ]) {
      const { marker, body } = parseMemoryMarkerV1(text);
      expect(renderMemoryMarkerV1(marker, body)).toBe(text);
    }
  });
});

describe("markers through the file format", () => {
  const FILE = [
    "- (2026-08-30) Tim prefers blunt answers.",
    "- (2026-08-31) [note] we ship on Friday",
    "- (2026-08-31) [episode] the gym build week",
    "- (2026-08-31) [todo] buy rubber matting",
    "",
  ].join("\n");

  test("a file written before this change parses identically, and round-trips", () => {
    const facts = parseMemoryFileV1(FILE);
    expect(facts.map((fact) => fact.text)).toEqual([
      "Tim prefers blunt answers.",
      "[note] we ship on Friday",
      "[episode] the gym build week",
      "[todo] buy rubber matting",
    ]);
    // `marker`/`body` are added *beside* `text`, which still holds the prefix.
    expect(facts.map((fact) => fact.marker)).toEqual([
      undefined,
      "note",
      "episode",
      undefined,
    ]);
    expect(facts[1]?.body).toBe("we ship on Friday");
    expect(facts[3]?.body).toBe("[todo] buy rubber matting");
    // disk → parse → disk, byte-identical.
    expect(renderMemoryFileV1(facts)).toBe(FILE);
  });

  test("the injected line is `(learned d) [via b] [note] body`", () => {
    expect(
      renderInjectedFactLineV1(
        { date: "2026-08-31", text: "[note] we ship on Friday", via: "School" },
        500,
      ),
    ).toBe("- (learned 2026-08-31) [via School] [note] we ship on Friday");
    expect(
      renderInjectedFactLineV1(
        { date: "2026-08-31", text: "[note] we ship on Friday" },
        500,
      ),
    ).toBe("- (learned 2026-08-31) [note] we ship on Friday");
  });

  test("the clamp applies to the whole fact text, marker included", () => {
    const long = `[note] ${"x".repeat(900)}`;
    const line = renderInjectedFactLineV1(
      { date: "2026-08-31", text: long },
      500,
    );
    expect(line.startsWith("- (learned 2026-08-31) [note] xxx")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBe("- (learned 2026-08-31) ".length + 500);
  });
});
