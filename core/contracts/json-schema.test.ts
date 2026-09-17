import { describe, expect, test } from "bun:test";
import {
  assertEnforceableJsonSchemaV1,
  JsonSchemaError,
  validateAgainstJsonSchemaV1,
} from "./json-schema.ts";

const draft = {
  type: "object",
  properties: {
    to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
    subject: { type: "string", maxLength: 8 },
    urgency: { type: "integer", minimum: 1, maximum: 3 },
    draft: { type: "boolean" },
  },
  required: ["to", "subject"],
  additionalProperties: false,
};

describe("the JSON Schema subset the kernel enforces", () => {
  test("accepts values the schema declares", () => {
    expect(() =>
      validateAgainstJsonSchemaV1(
        { to: ["nick@example.com"], subject: "Hi", urgency: 2, draft: true },
        draft,
      ),
    ).not.toThrow();
  });

  test("names the field that failed, in the words the Bot reads", () => {
    expect(() => validateAgainstJsonSchemaV1({ subject: "Hi" }, draft)).toThrow(
      /value\.to is required/,
    );
    expect(() =>
      validateAgainstJsonSchemaV1({ to: [], subject: "Hi" }, draft),
    ).toThrow(/value\.to must hold at least 1/);
    expect(() =>
      validateAgainstJsonSchemaV1({ to: [1], subject: "Hi" }, draft),
    ).toThrow(/value\.to\[0\] must be a string/);
    expect(() =>
      validateAgainstJsonSchemaV1(
        { to: ["a@b.co"], subject: "far too long" },
        draft,
      ),
    ).toThrow(/at most 8 characters/);
    expect(() =>
      validateAgainstJsonSchemaV1(
        { to: ["a@b.co"], subject: "Hi", urgency: 9 },
        draft,
      ),
    ).toThrow(/at most 3/);
    expect(() =>
      validateAgainstJsonSchemaV1(
        { to: ["a@b.co"], subject: "Hi", cc: [] },
        draft,
      ),
    ).toThrow(/value\.cc is not declared/);
  });

  // The reason this validator exists rather than a library: a constraint the
  // kernel cannot enforce must not be silently ignored.
  test("refuses a schema using a keyword it does not enforce", () => {
    expect(() =>
      validateAgainstJsonSchemaV1("anything", {
        type: "string",
        pattern: "^a",
      }),
    ).toThrow(/does not enforce/);
    expect(() => validateAgainstJsonSchemaV1("a", { enum: ["a"] })).toThrow(
      /does not declare a known type/,
    );
    expect(() => validateAgainstJsonSchemaV1("a", undefined)).toThrow(
      JsonSchemaError,
    );
  });

  // A bound the value walk's branch for the declared type never reads is a
  // bound nobody enforces, which is the one thing this module promises not to
  // let happen.
  test("refuses a keyword that does not apply to the declared type", () => {
    const list = { type: "array", items: { type: "string" }, maxLength: 3 };
    expect(() => assertEnforceableJsonSchemaV1(list)).toThrow(
      /does not enforce on type "array"/,
    );
    // Proof that it would otherwise be dropped in silence: the value walk
    // admits a list past the bound the author thought they had written.
    expect(() =>
      validateAgainstJsonSchemaV1(["a", "b", "c", "d"], list),
    ).not.toThrow();

    for (const schema of [
      { type: "string", minimum: 1 },
      { type: "number", minLength: 1 },
      { type: "string", required: ["a"] },
      { type: "object", items: { type: "string" } },
      { type: "boolean", enum: [true] },
    ]) {
      if (schema.type === "boolean") {
        expect(() => assertEnforceableJsonSchemaV1(schema)).not.toThrow();
        continue;
      }
      expect(() => assertEnforceableJsonSchemaV1(schema)).toThrow(
        /does not enforce on type/,
      );
    }
    // The email card's own schema keeps every keyword on the right type.
    expect(() => assertEnforceableJsonSchemaV1(draft)).not.toThrow();
  });

  test("stops at the depth a card's values may nest", () => {
    let schema: Record<string, unknown> = { type: "string" };
    let value: unknown = "leaf";
    for (let level = 0; level < 10; level += 1) {
      schema = { type: "array", items: schema };
      value = [value];
    }
    expect(() => validateAgainstJsonSchemaV1(value, schema)).toThrow(
      /nests deeper/,
    );
  });
});
