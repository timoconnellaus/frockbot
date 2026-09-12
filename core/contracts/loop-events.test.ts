import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodeBotIsolateHookReplacementV1,
  LOOP_EVENTS_V1,
} from "./loop-events.js";

const call = { id: "call-1", name: "write", input: { value: 1 } };

describe("the public loop event declaration", () => {
  test("flags every isolate event, and only those, as an isolate hook", () => {
    const flagged = Object.entries(LOOP_EVENTS_V1)
      .filter(([, definition]) => definition.isolateHook)
      .map(([event]) => event);
    expect(flagged.toSorted()).toEqual([...BOT_ISOLATE_HOOK_EVENTS_V1].sort());
  });

  test("dispatches every isolate event a plugin can replace as a waterfall", () => {
    // `turn.terminate` is the exception: it notifies a settling Turn and has
    // no value to replace, so it is serial.
    expect(
      BOT_ISOLATE_HOOK_EVENTS_V1.filter(
        (event) => LOOP_EVENTS_V1[event].mode !== "waterfall",
      ),
    ).toEqual(["agent/turn-stopping"]);
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

  test("a request hook shapes the request and cannot redirect it", () => {
    const original = {
      requestId: "request-1",
      provider: "scripted",
      model: "scripted-v1",
      system: "core",
      messages: [],
      tools: [],
    };
    expect(
      decodeBotIsolateHookReplacementV1(
        "agent/request",
        { ...original, system: "plugin system" },
        original,
      ),
    ).toMatchObject({ requestId: "request-1", system: "plugin system" });
    for (const redirect of [
      { ...original, requestId: "request-2" },
      { ...original, provider: "other" },
      { ...original, model: "other-model" },
    ]) {
      expect(() =>
        decodeBotIsolateHookReplacementV1("agent/request", redirect, original),
      ).toThrow(/cannot redirect/);
    }
    expect(() =>
      decodeBotIsolateHookReplacementV1(
        "agent/request",
        { ...original, live: () => {} },
        original,
      ),
    ).toThrow(/invalid fields/);
  });

  test("a request hook cannot change the model binding", () => {
    const binding = {
      connectionId: "connection-1",
      connectionGeneration: "1",
    };
    const bound = {
      requestId: "request-1",
      provider: "scripted",
      model: "scripted-v1",
      system: "core",
      messages: [],
      tools: [],
      modelBinding: binding,
    };
    expect(
      decodeBotIsolateHookReplacementV1(
        "agent/request",
        { ...bound, system: "plugin system" },
        bound,
      ),
    ).toMatchObject({ modelBinding: binding });
    for (const redirect of [
      { ...bound, modelBinding: { ...binding, connectionId: "connection-2" } },
      { ...bound, modelBinding: { ...binding, connectionGeneration: "2" } },
      { ...bound, modelBinding: { connectionId: "connection-1" } },
      { ...bound, modelBinding: undefined },
    ]) {
      expect(() =>
        decodeBotIsolateHookReplacementV1("agent/request", redirect, bound),
      ).toThrow(/cannot redirect/);
    }
    const unbound = { ...bound, modelBinding: undefined };
    expect(() =>
      decodeBotIsolateHookReplacementV1(
        "agent/request",
        { ...unbound, modelBinding: binding },
        unbound,
      ),
    ).toThrow(/cannot redirect/);
  });
});
