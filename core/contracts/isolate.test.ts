import { describe, expect, test } from "bun:test";
import {
  decodeIsolateCapabilityFailureV1,
  decodeIsolateCapabilityListV1,
  decodeIsolateHealthV1,
  decodeIsolateHookInvocationV1,
  decodeIsolateHookResultV1,
  decodeIsolateIdentityV1,
  decodeIsolateScopeV1,
  decodeIsolateStorageGetRequestV1,
  decodeIsolateStorageListRequestV1,
  decodeIsolateStoragePutRequestV1,
  decodeIsolateModelEventV1,
  decodeIsolateModelInvocationV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateToolDescriptorV1,
  decodeIsolateToolInvocationV1,
  decodeIsolateToolResultV1,
  encodeIsolateModelEventLineV1,
  isolateToolSchemaV1,
  ISOLATE_MAX_DEADLINE_MS,
  type IsolateHookInvocationV1,
} from "./isolate.js";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    name: "reverse_text",
    description: "Reverses text",
    inputSchema: { type: "object" },
    idempotent: true,
    ...overrides,
  };
}

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    tool: "reverse_text",
    input: { text: "ab" },
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
    deadlineMs: 5_000,
    ...overrides,
  };
}

describe("isolate tool descriptor v1", () => {
  test("decodes an exact descriptor", () => {
    expect(decodeIsolateToolDescriptorV1(descriptor())).toEqual({
      name: "reverse_text",
      description: "Reverses text",
      inputSchema: { type: "object" },
      idempotent: true,
    });
  });

  test("rejects an unknown field", () => {
    expect(() =>
      decodeIsolateToolDescriptorV1({ ...descriptor(), extra: 1 }),
    ).toThrow(/invalid fields/);
  });

  test("rejects a tool name the kernel would not accept", () => {
    expect(() =>
      decodeIsolateToolDescriptorV1(descriptor({ name: "Reverse-Text" })),
    ).toThrow(/name is invalid/);
  });

  test("rejects a non-object input schema", () => {
    expect(() =>
      decodeIsolateToolDescriptorV1(descriptor({ inputSchema: [] })),
    ).toThrow(/inputSchema must be an object/);
  });

  test("projects onto the kernel tool schema", () => {
    expect(
      isolateToolSchemaV1(decodeIsolateToolDescriptorV1(descriptor())),
    ).toEqual({
      name: "reverse_text",
      description: "Reverses text",
      inputSchema: { type: "object" },
    });
  });
});

describe("isolate tool invocation v1", () => {
  test("decodes an exact invocation", () => {
    expect(decodeIsolateToolInvocationV1(invocation())).toEqual(invocation());
  });

  test("rejects a missing field", () => {
    const { runId: _runId, ...partial } = invocation();
    expect(() => decodeIsolateToolInvocationV1(partial)).toThrow(
      /invalid fields/,
    );
  });

  test("rejects a deadline beyond the contract bound", () => {
    expect(() =>
      decodeIsolateToolInvocationV1(
        invocation({ deadlineMs: ISOLATE_MAX_DEADLINE_MS + 1 }),
      ),
    ).toThrow(/deadlineMs is out of range/);
  });

  test("rejects a zero deadline", () => {
    expect(() =>
      decodeIsolateToolInvocationV1(invocation({ deadlineMs: 0 })),
    ).toThrow(/deadlineMs is out of range/);
  });

  test("rejects input that is not JSON", () => {
    expect(() =>
      decodeIsolateToolInvocationV1(invocation({ input: { at: () => 1 } })),
    ).toThrow(/must be JSON/);
  });
});

describe("isolate tool result v1", () => {
  test("decodes an empty successful result", () => {
    expect(
      decodeIsolateToolResultV1({
        schemaVersion: 1,
        content: "",
        isError: false,
      }),
    ).toEqual({ schemaVersion: 1, content: "", isError: false });
  });

  test("rejects a non-boolean isError", () => {
    expect(() =>
      decodeIsolateToolResultV1({
        schemaVersion: 1,
        content: "ok",
        isError: "false",
      }),
    ).toThrow(/isError must be a boolean/);
  });

  test("rejects an unsupported schema version", () => {
    expect(() =>
      decodeIsolateToolResultV1({
        schemaVersion: 2,
        content: "ok",
        isError: false,
      }),
    ).toThrow(/schemaVersion is unsupported/);
  });
});

describe("isolate health v1", () => {
  const health = {
    schemaVersion: 1,
    ok: true,
    packageId: "bot-authored",
    contractVersion: 1,
    tools: [descriptor()],
  };

  test("decodes a healthy report", () => {
    expect(decodeIsolateHealthV1(health).tools).toHaveLength(1);
  });

  test("rejects an unsupported contract version", () => {
    expect(() =>
      decodeIsolateHealthV1({ ...health, contractVersion: 5 }),
    ).toThrow(/contractVersion is unsupported/);
    expect(() =>
      decodeIsolateHealthV1({ ...health, contractVersion: 0 }),
    ).toThrow(/contractVersion is unsupported/);
  });

  test("admits a v1 descriptor onto every turn type", () => {
    const decoded = decodeIsolateHealthV1(health);
    expect(decoded.contractVersion).toBe(1);
    expect(decoded.tools[0]?.admission).toBeUndefined();
  });

  test("carries a v2 descriptor admission through, and refuses one on v1", () => {
    const decoded = decodeIsolateHealthV1({
      ...health,
      contractVersion: 2,
      tools: [descriptor({ admission: { turnTypes: ["chat"] } })],
    });
    expect(decoded).toMatchObject({
      contractVersion: 2,
      tools: [{ admission: { turnTypes: ["chat"] } }],
    });
    expect(
      decodeIsolateHealthV1({ ...health, contractVersion: 2 }).tools[0]
        ?.admission,
    ).toBeUndefined();
    expect(() =>
      decodeIsolateHealthV1({
        ...health,
        tools: [descriptor({ admission: { turnTypes: ["chat"] } })],
      }),
    ).toThrow(/invalid fields/);
  });

  test("requires and decodes declared hooks on contract v3", () => {
    expect(
      decodeIsolateHealthV1({
        ...health,
        contractVersion: 3,
        hooks: ["agent/tool-exposure", "tools/post-execute"],
      }).hooks,
    ).toEqual(["agent/tool-exposure", "tools/post-execute"]);
    expect(() =>
      decodeIsolateHealthV1({ ...health, contractVersion: 3 }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeIsolateHealthV1({
        ...health,
        contractVersion: 3,
        hooks: ["agent/request-error"],
      }),
    ).toThrow(/hooks\[0\] is invalid/);
  });

  test("rejects an unknown turn type in a v2 descriptor", () => {
    expect(() =>
      decodeIsolateHealthV1({
        ...health,
        contractVersion: 2,
        tools: [descriptor({ admission: { turnTypes: ["routine"] } })],
      }),
    ).toThrow(/turnTypes\[0\] is invalid/);
    expect(() =>
      decodeIsolateHealthV1({
        ...health,
        contractVersion: 2,
        tools: [descriptor({ admission: { turnTypes: [] } })],
      }),
    ).toThrow(/turnTypes must not be empty/);
  });

  test("rejects duplicate tool names", () => {
    expect(() =>
      decodeIsolateHealthV1({ ...health, tools: [descriptor(), descriptor()] }),
    ).toThrow(/duplicate names/);
  });
});

describe("isolate hook v1", () => {
  const hookInvocation: IsolateHookInvocationV1<"agent/tool-exposure"> = {
    schemaVersion: 1,
    event: "agent/tool-exposure",
    payload: {
      step: {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId: "session-1",
        status: "running",
        compositionGenerationId: "gen-1",
        turn: 1,
        step: 1,
        turnType: "chat",
      },
      tools: [],
    },
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    deadlineMs: 1_000,
  };

  test("decodes an exact hook invocation and result envelope", () => {
    expect(decodeIsolateHookInvocationV1(hookInvocation)).toEqual(
      hookInvocation,
    );
    expect(
      decodeIsolateHookResultV1({
        schemaVersion: 1,
        status: "replaced",
        replacement: [],
      }),
    ).toEqual({ schemaVersion: 1, status: "replaced", replacement: [] });
  });

  test("refuses undeclared events and inexact result envelopes", () => {
    expect(() =>
      decodeIsolateHookInvocationV1({
        ...hookInvocation,
        event: "agent/request-error",
      }),
    ).toThrow(/event is invalid/);
    expect(() =>
      decodeIsolateHookResultV1({
        schemaVersion: 1,
        status: "unchanged",
        replacement: [],
      }),
    ).toThrow(/invalid fields/);
  });
});

describe("isolate identity and capabilities", () => {
  test("decodes the identity binding: the User and its plugins, nothing per Turn", () => {
    expect(
      decodeIsolateIdentityV1({
        userId: "user-1",
        plugins: [
          { pluginId: "weather", grants: ["ai"], consumes: [] },
          { pluginId: "greeter", grants: [], consumes: ["weather-data"] },
        ],
      }),
    ).toEqual({
      userId: "user-1",
      plugins: [
        { pluginId: "weather", grants: ["ai"], consumes: [] },
        { pluginId: "greeter", grants: [], consumes: ["weather-data"] },
      ],
    });
    expect(() =>
      decodeIsolateIdentityV1({
        userId: "user-1",
        botId: "bot-1",
        plugins: [],
      }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeIsolateIdentityV1({
        userId: "user-1",
        plugins: [
          { pluginId: "weather", grants: [], consumes: [] },
          { pluginId: "weather", grants: [], consumes: [] },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test("decodes a call scope exactly", () => {
    const scope = {
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "run-1",
      turnId: "turn-1",
      generationId: "gen-1",
      pluginId: "weather",
    };
    expect(decodeIsolateScopeV1(scope)).toEqual(scope);
    expect(() => decodeIsolateScopeV1({ ...scope, userId: "user-2" })).toThrow(
      /invalid fields/,
    );
    expect(() =>
      decodeIsolateScopeV1({ ...scope, pluginId: "Weather" }),
    ).toThrow(/pluginId/);
  });

  test("decodes storage requests within their bounds", () => {
    expect(decodeIsolateStorageGetRequestV1({ key: "notes/today" })).toEqual({
      key: "notes/today",
    });
    expect(() => decodeIsolateStorageGetRequestV1({ key: "" })).toThrow();
    expect(() => decodeIsolateStorageGetRequestV1({ key: "a b" })).toThrow(
      /invalid/,
    );
    expect(
      decodeIsolateStoragePutRequestV1({ key: "k", value: { n: 1, s: "x" } }),
    ).toEqual({ key: "k", value: { n: 1, s: "x" } });
    expect(() =>
      decodeIsolateStoragePutRequestV1({ key: "k", value: () => 1 }),
    ).toThrow();
    expect(() =>
      decodeIsolateStoragePutRequestV1({ key: "k", value: "x".repeat(70_000) }),
    ).toThrow(/bound/);
    // The bound is bytes, so a value under it in code units but over it once
    // encoded is refused rather than handed on to storage.
    expect(() =>
      decodeIsolateStoragePutRequestV1({
        key: "k",
        value: "\u4e2d".repeat(30_000),
      }),
    ).toThrow(/bound/);
    expect(
      decodeIsolateStoragePutRequestV1({
        key: "k",
        value: "\u4e2d".repeat(20_000),
      }),
    ).toEqual({ key: "k", value: "\u4e2d".repeat(20_000) });
    expect(decodeIsolateStorageListRequestV1({})).toEqual({});
    expect(
      decodeIsolateStorageListRequestV1({ prefix: "notes/", limit: 10 }),
    ).toEqual({ prefix: "notes/", limit: 10 });
    expect(() => decodeIsolateStorageListRequestV1({ limit: 0 })).toThrow(
      /limit/,
    );
    expect(() => decodeIsolateStorageListRequestV1({ limit: 257 })).toThrow(
      /limit/,
    );
  });

  test("decodes a capability list", () => {
    expect(
      decodeIsolateCapabilityListV1({
        status: "available",
        connections: [
          {
            connectionId: "connection-1",
            packageId: "provider",
            connectionTypeId: "account",
            displayName: "Account",
            generation: "generation-1",
            safeMetadata: { region: "au" },
          },
        ],
        model: {
          connectionId: "connection-1",
          packageId: "provider",
          provider: "provider",
          providerModelId: "model-1",
          connectionGeneration: "generation-1",
        },
        memory: true,
        workspace: false,
        schedule: true,
      }),
    ).toMatchObject({
      status: "available",
      connections: [{ connectionId: "connection-1" }],
      memory: true,
      workspace: false,
      schedule: true,
    });
  });

  test("rejects authority fields outside the Bot authority contract", () => {
    expect(() =>
      decodeIsolateCapabilityListV1({
        status: "available",
        connections: [],
        memory: true,
        workspace: true,
        schedule: true,
        packageId: "package-local-authority",
      }),
    ).toThrow(/invalid fields/);
  });
});

describe("isolate schedule request v1", () => {
  test("decodes the durable Routine input and call id", () => {
    expect(
      decodeIsolateScheduleRequestV1({
        callId: "schedule-1",
        input: { action: "create", schedule: "@daily" },
      }),
    ).toEqual({
      callId: "schedule-1",
      input: { action: "create", schedule: "@daily" },
    });
  });

  test("rejects an undeclared field", () => {
    expect(() =>
      decodeIsolateScheduleRequestV1({
        callId: "schedule-1",
        input: {},
        packageId: "package-local-authority",
      }),
    ).toThrow(/invalid fields/);
  });
});

describe("isolate model invocation v1", () => {
  test("round-trips a stream event line", () => {
    const line = encodeIsolateModelEventLineV1({
      type: "text-delta",
      text: "hi",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(decodeIsolateModelEventV1(JSON.parse(line))).toEqual({
      type: "text-delta",
      text: "hi",
    });
  });

  test("decodes a tool-call event", () => {
    expect(
      decodeIsolateModelEventV1({
        type: "tool-call",
        call: { id: "call-1", name: "echo", input: { text: "x" } },
      }),
    ).toEqual({
      type: "tool-call",
      call: { id: "call-1", name: "echo", input: { text: "x" } },
    });
  });

  test("rejects an unknown event type", () => {
    expect(() => decodeIsolateModelEventV1({ type: "usage" })).toThrow(
      /type is invalid/,
    );
  });

  test("decodes a streaming outcome carrying a byte stream", () => {
    const events = new ReadableStream<Uint8Array>();
    const outcome = decodeIsolateModelInvocationV1({
      status: "streaming",
      requestId: "request-1",
      events,
    });
    expect(outcome.status).toBe("streaming");
    if (outcome.status === "streaming") expect(outcome.events).toBe(events);
  });

  test("decodes an unavailable outcome when no model is configured", () => {
    expect(
      decodeIsolateModelInvocationV1({
        status: "unavailable",
        reason: "this Bot has no configured model",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "this Bot has no configured model",
    });
  });

  test("rejects a streaming outcome without a stream", () => {
    expect(() =>
      decodeIsolateModelInvocationV1({
        status: "streaming",
        requestId: "request-1",
        events: [],
      }),
    ).toThrow(/must be a readable stream/);
  });
});

describe("isolate capability failure v1", () => {
  test("decodes the declared refusal", () => {
    expect(
      decodeIsolateCapabilityFailureV1({
        status: "unavailable",
        reason: "the model request could not be served",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "the model request could not be served",
    });
  });

  test("refuses another status, an undeclared field, and an unbounded reason", () => {
    expect(() =>
      decodeIsolateCapabilityFailureV1({ status: "denied", reason: "no" }),
    ).toThrow(/status must be unavailable/);
    expect(() =>
      decodeIsolateCapabilityFailureV1({
        status: "unavailable",
        reason: "no",
        detail: "provider said 401 for key sk-live-1",
      }),
    ).toThrow(/has invalid fields/);
    expect(() =>
      decodeIsolateCapabilityFailureV1({
        status: "unavailable",
        reason: "r".repeat(513),
      }),
    ).toThrow(/reason must be a bounded string/);
  });
});
