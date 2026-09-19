import { describe, expect, test } from "bun:test";
import { exactKeysV1, recordV1 } from "./records.js";

describe("contract record helpers", () => {
  test("accepts objects with required and optional own keys", () => {
    const value = recordV1({ required: 1, optional: 2 }, "record");
    expect(() =>
      exactKeysV1(value, ["required"], ["optional"], "record"),
    ).not.toThrow();
  });

  test("rejects non-records, missing required keys, and unknown keys", () => {
    expect(() => recordV1(null, "record")).toThrow("record must be an object");
    expect(() => recordV1([], "record")).toThrow("record must be an object");
    expect(() => exactKeysV1({}, ["required"], [], "record")).toThrow(
      "record has invalid fields",
    );
    expect(() =>
      exactKeysV1({ required: 1, extra: true }, ["required"], [], "record"),
    ).toThrow("record has invalid fields");
  });
});
