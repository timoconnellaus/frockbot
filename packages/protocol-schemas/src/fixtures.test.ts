import { describe, expect, test } from "bun:test";
import valid from "../fixtures/valid.json";
import invalid from "../fixtures/invalid.json";
import source from "../schema/client-wire.schema.json";
import {
  decodeProtocol,
  isProtocolValue,
  type ProtocolTypes,
} from "./index.js";

describe("language-neutral client wire fixtures", () => {
  for (const [expected, fixtures] of [
    [true, valid],
    [false, invalid],
  ] as const) {
    for (const fixture of fixtures)
      test(fixture.name, () => {
        const name = fixture.schema as keyof ProtocolTypes;
        const value: unknown = fixture.value;
        expect(isProtocolValue(name, value)).toBe(expected);
        if (expected)
          expect<unknown>(decodeProtocol(name, value)).toEqual(value);
        else expect(() => decodeProtocol(name, value)).toThrow();
      });
  }
  test("each named schema has positive and negative shared coverage", () => {
    for (const name of Object.keys(source.$defs)) {
      expect(valid.some((f) => f.schema === name)).toBe(true);
      expect(invalid.some((f) => f.schema === name)).toBe(true);
    }
  });
});
