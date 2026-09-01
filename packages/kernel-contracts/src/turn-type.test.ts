import { describe, expect, test } from "bun:test";
import {
  admittedTurnTypesV1,
  decodeSessionEvent,
  decodeTurnTypeV1,
  TURN_TYPES_V1,
  type SessionEvent,
} from "./index.js";

const timestamp = "2026-08-31T00:00:00.000Z";

function durable(event: Record<string, unknown>): unknown {
  return { ...event, seq: 0, timestamp };
}

describe("TurnTypeV1", () => {
  test("names every turn type the admission vocabulary declares", () => {
    expect([...TURN_TYPES_V1]).toEqual(["chat", "automation", "subagent"]);
    for (const turnType of TURN_TYPES_V1) {
      expect(decodeTurnTypeV1(turnType)).toBe(turnType);
    }
  });

  test("rejects a value outside the declared vocabulary", () => {
    for (const invalid of ["Chat", "routine", "", 1, null, undefined, {}]) {
      expect(() => decodeTurnTypeV1(invalid)).toThrow(/turn type is invalid/);
    }
  });
});

describe("turn/admission", () => {
  test("decodes the admitted turn type of a Turn", () => {
    const event = durable({
      type: "turn/admission",
      turn: 3,
      turnType: "automation",
    });
    expect(decodeSessionEvent(event)).toMatchObject({
      type: "turn/admission",
      turn: 3,
      turnType: "automation",
    });
  });

  test("rejects an unknown turn type and any extra or missing key", () => {
    expect(() =>
      decodeSessionEvent(
        durable({ type: "turn/admission", turn: 1, turnType: "routine" }),
      ),
    ).toThrow(/turnType is invalid/);
    expect(() =>
      decodeSessionEvent(durable({ type: "turn/admission", turn: 1 })),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeSessionEvent(
        durable({
          type: "turn/admission",
          turn: 1,
          turnType: "chat" as const,
          extra: true,
        }),
      ),
    ).toThrow(/invalid fields/);
  });

  test("leaves a pre-change turn/start decoding exactly as it did", () => {
    const started: SessionEvent = decodeSessionEvent(
      durable({ type: "turn/start", turn: 1 }),
    );
    expect(started).toMatchObject({ type: "turn/start", turn: 1 });
    expect(() =>
      decodeSessionEvent(
        durable({ type: "turn/start", turn: 1, turnType: "chat" }),
      ),
    ).toThrow(/invalid fields/);
  });
});

describe("admittedTurnTypesV1", () => {
  test("admits every turn type when neither the tool nor the manifest bounds it", () => {
    expect(admittedTurnTypesV1(undefined, undefined)).toEqual([
      ...TURN_TYPES_V1,
    ]);
  });

  test("narrows a tool declaration within the manifest ceiling", () => {
    expect(
      admittedTurnTypesV1(["chat", "automation"], ["automation", "subagent"]),
    ).toEqual(["automation"]);
    expect(admittedTurnTypesV1(["chat"], undefined)).toEqual(["chat"]);
    expect(admittedTurnTypesV1(undefined, ["automation"])).toEqual([
      "automation",
    ]);
  });

  test("keeps the declared vocabulary order and drops duplicates", () => {
    expect(
      admittedTurnTypesV1(["subagent", "chat", "chat"], undefined),
    ).toEqual(["chat", "subagent"]);
  });
});
