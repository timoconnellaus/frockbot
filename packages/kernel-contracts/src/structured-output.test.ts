import { describe, expect, test } from "bun:test";
import {
  decodeModelResponseFormatV1,
  decodeStructuredOutputSchemaV1,
  parseStructuredOutputJsonV1,
  validateStructuredOutputV1,
} from "./structured-output.js";

const schema = decodeStructuredOutputSchemaV1({
  type: "object",
  properties: {
    name: { type: "string" },
    scores: { type: "array", items: { type: "number" } },
    active: { type: "boolean", enum: [true] },
  },
  required: ["name", "scores", "active"],
  additionalProperties: false,
});

describe("the structured-output schema subset", () => {
  test("accepts nested objects, arrays, primitives and enums", () => {
    expect(
      validateStructuredOutputV1(
        '{"name":"Ada","scores":[1,2.5],"active":true}',
        schema,
      ),
    ).toEqual({
      status: "completed",
      value: { name: "Ada", scores: [1, 2.5], active: true },
      raw: '{"name":"Ada","scores":[1,2.5],"active":true}',
    });
  });

  test("returns a typed JSON failure without throwing", () => {
    expect(validateStructuredOutputV1("not json", schema)).toEqual({
      status: "failed",
      failure: {
        code: "invalid-json",
        message: "The model response was not valid JSON",
      },
      raw: "not json",
    });
  });

  test("validates schema-free JSON mode", () => {
    expect(parseStructuredOutputJsonV1('[1,"two",true]')).toEqual({
      status: "completed",
      value: [1, "two", true],
      raw: '[1,"two",true]',
    });
    expect(parseStructuredOutputJsonV1("not json")).toMatchObject({
      status: "failed",
      failure: { code: "invalid-json" },
    });
  });

  test("compares object enum members as JSON values, independent of key order", () => {
    const enumSchema = decodeStructuredOutputSchemaV1({
      type: "object",
      enum: [{ first: 1, second: 2 }],
    });
    expect(
      validateStructuredOutputV1('{"second":2,"first":1}', enumSchema),
    ).toMatchObject({ status: "completed" });
  });

  test("reports required, type, enum and additional-property failures", () => {
    const result = validateStructuredOutputV1(
      '{"scores":[1,"two"],"active":false,"extra":1}',
      schema,
    );
    expect(result.status).toBe("failed");
    if (result.status === "completed") return;
    expect(result.failure.code).toBe("schema-mismatch");
    if (result.failure.code === "invalid-json") return;
    expect(result.failure.issues.map((issue) => issue.code)).toEqual([
      "required",
      "type",
      "enum",
      "additional-property",
    ]);
  });

  test("refuses unsupported schema dialect at the seam", () => {
    expect(() =>
      decodeStructuredOutputSchemaV1({ type: "string", minLength: 1 }),
    ).toThrow("minLength is not supported");
    expect(() =>
      decodeStructuredOutputSchemaV1({
        type: "object",
        properties: {},
        required: ["missing"],
      }),
    ).toThrow('required names unknown property "missing"');
  });

  test("strictly decodes the normalized response format", () => {
    expect(
      decodeModelResponseFormatV1({
        type: "json_schema",
        name: "answer_v1",
        schema: { type: "string" },
      }),
    ).toEqual({
      type: "json_schema",
      name: "answer_v1",
      schema: { type: "string" },
    });
    expect(() =>
      decodeModelResponseFormatV1({
        type: "json_schema",
        name: "answer v1",
        schema: { type: "string" },
      }),
    ).toThrow("1-64 letters");
  });
});
