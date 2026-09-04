import { describe, expect, test } from "bun:test";
import {
  decodeMemoryChunkIndexEntryV1,
  memoryChunkIndexEntriesV1,
  memoryChunkIndexKeyV1,
} from "./chunk-index.js";

describe("the durable Memory chunk index", () => {
  test("deduplicates ids and round-trips each exact stored entry", () => {
    const entries = memoryChunkIndexEntriesV1([
      "chunk/a",
      "chunk/a",
      "chunk b",
    ]);
    expect(Object.keys(entries)).toEqual([
      memoryChunkIndexKeyV1("chunk/a"),
      memoryChunkIndexKeyV1("chunk b"),
    ]);
    for (const [key, value] of Object.entries(entries)) {
      expect(decodeMemoryChunkIndexEntryV1(key, value)).toEqual(value);
    }
  });

  test("refuses a record whose key names a different vector", () => {
    expect(() =>
      decodeMemoryChunkIndexEntryV1(memoryChunkIndexKeyV1("one"), {
        schemaVersion: 1,
        vectorId: "two",
      }),
    ).toThrow("does not match");
  });
});
