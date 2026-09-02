import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodeBotIsolateHookReplacementV1,
  LOOP_EVENTS_V1,
} from "./loop-events.js";

const call = { id: "call-1", name: "write", input: { value: 1 } };

describe("the public loop event declaration", () => {
  test("marks every isolate event as a waterfall", () => {
    expect(
      BOT_ISOLATE_HOOK_EVENTS_V1.every(
        (event) =>
          LOOP_EVENTS_V1[event].mode === "waterfall" &&
          LOOP_EVENTS_V1[event].isolateHook,
      ),
    ).toBe(true);
  });

  test("decodes an exact tool exposure replacement", () => {
    expect(
      decodeBotIsolateHookReplacementV1(
        "agent/tool-exposure",
        [
          {
            name: "read_only",
            description: "Reads without effects.",
            inputSchema: { type: "object" },
          },
        ],
        [],
      ),
    ).toEqual([
      {
        name: "read_only",
        description: "Reads without effects.",
        inputSchema: { type: "object" },
      },
    ]);
    expect(() =>
      decodeBotIsolateHookReplacementV1(
        "agent/tool-exposure",
        [
          {
            name: "read_only",
            description: "Reads without effects.",
            inputSchema: {},
            execute: "not part of a schema",
          },
        ],
        [],
      ),
    ).toThrow(/invalid fields/);
  });

  test("a pre-execute hook may add a denial but cannot lift one", () => {
    const ready = { kind: "ready" as const, call, idempotent: false };
    expect(
      decodeBotIsolateHookReplacementV1(
        "tools/pre-execute",
        {
          kind: "denied",
          call,
          result: { content: "Bot policy denied this call", isError: true },
        },
        ready,
      ),
    ).toMatchObject({ kind: "denied" });

    const denied = {
      kind: "denied" as const,
      call,
      result: { content: "Core denied this call", isError: true },
    };
    expect(() =>
      decodeBotIsolateHookReplacementV1("tools/pre-execute", ready, denied),
    ).toThrow(/cannot lift/);
  });
});
