import { describe, expect, test } from "bun:test";
import {
  SECRET_SHAPES_V1,
  matchSecretShapeV1,
  redactSecretShapesV1,
} from "./index.ts";

describe("the credential-shape table", () => {
  test("every shape has a distinct id and a global pattern", () => {
    const ids = SECRET_SHAPES_V1.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SECRET_SHAPES_V1.every((shape) => shape.pattern.global)).toBe(true);
  });

  test("names the shape it matched", () => {
    expect(
      matchSecretShapeV1("Authorization: Bearer abcdefghijklmnopqrstuvwx"),
    ).toMatchObject({ id: "bearer-token" });
    expect(
      matchSecretShapeV1(
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toMatchObject({ id: "jwt" });
    expect(matchSecretShapeV1("sk-abcdefghijklmnopqrstuvwxyz")).toMatchObject({
      id: "api-key",
    });
    expect(matchSecretShapeV1("nothing interesting here")).toBeUndefined();
  });

  test("redaction keeps the surrounding text and names the shape", () => {
    expect(
      redactSecretShapesV1(
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://api",
      ),
    ).toBe("curl -H 'Authorization: [redacted:bearer-token]' https://api");
    expect(redactSecretShapesV1("export KEY=sk-abcdefghijklmnopqrstuv")).toBe(
      "export KEY=[redacted:api-key]",
    );
  });

  test("redaction replaces every occurrence, and is stable", () => {
    const text = "sk-aaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbb";
    const once = redactSecretShapesV1(text);
    expect(once).toBe("[redacted:api-key] and [redacted:api-key]");
    // The patterns are shared objects; a stale `lastIndex` would make the
    // second call differ from the first.
    expect(redactSecretShapesV1(text)).toBe(once);
    expect(matchSecretShapeV1(text)).toMatchObject({ id: "api-key" });
    expect(matchSecretShapeV1(text)).toMatchObject({ id: "api-key" });
  });

  test("is total and bounded", () => {
    expect(matchSecretShapeV1("")).toBeUndefined();
    const long = "a".repeat(200_000);
    expect(redactSecretShapesV1(long).length).toBeLessThanOrEqual(8_192);
  });
});
