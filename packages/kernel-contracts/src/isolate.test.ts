import { describe, expect, test } from "bun:test";
import {
  decodeIsolateAuthorityRequestV1,
  decodeIsolateCapabilityFailureV1,
  decodeIsolateCapabilityListV1,
  decodeIsolateHealthV1,
  decodeIsolateIdentityV1,
  decodeIsolateModelEventV1,
  decodeIsolateModelInvocationV1,
  decodeIsolatePendingDecisionV1,
  decodeIsolateToolDescriptorV1,
  decodeIsolateToolInvocationV1,
  decodeIsolateToolResultV1,
  encodeIsolateModelEventLineV1,
  isolateLoaderIdV1,
  isolateToolSchemaV1,
  ISOLATE_MAX_DEADLINE_MS,
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
      decodeIsolateHealthV1({ ...health, contractVersion: 3 }),
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

describe("isolate identity and capabilities", () => {
  test("decodes the identity binding", () => {
    expect(
      decodeIsolateIdentityV1({
        botId: "bot-1",
        generationId: "gen-1",
        packageId: "pkg-1",
      }),
    ).toEqual({ botId: "bot-1", generationId: "gen-1", packageId: "pkg-1" });
  });

  test("decodes a capability list", () => {
    expect(
      decodeIsolateCapabilityListV1([
        { capabilityId: "models:chat", kind: "model" },
      ]),
    ).toHaveLength(1);
  });

  test("rejects an unknown capability kind", () => {
    expect(() =>
      decodeIsolateCapabilityListV1([
        { capabilityId: "models:chat", kind: "network" },
      ]),
    ).toThrow(/kind is invalid/);
  });

  test("decodes an authority request and its pending answer", () => {
    expect(
      decodeIsolateAuthorityRequestV1({
        capabilityId: "models:chat",
        reason: "translate",
      }),
    ).toEqual({ capabilityId: "models:chat", reason: "translate" });
    expect(
      decodeIsolatePendingDecisionV1({
        status: "pending-user-decision",
        decisionId: "decision-1",
      }).decisionId,
    ).toBe("decision-1");
  });

  test("refuses to decode a grant as a decision", () => {
    expect(() =>
      decodeIsolatePendingDecisionV1({
        status: "granted",
        decisionId: "decision-1",
      }),
    ).toThrow(/pending-user-decision/);
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

  test("decodes a pending decision outcome", () => {
    expect(
      decodeIsolateModelInvocationV1({
        status: "pending-user-decision",
        decisionId: "decision-9",
      }),
    ).toEqual({ status: "pending-user-decision", decisionId: "decision-9" });
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

describe("isolate loader identity", () => {
  test("is the Bot, the User, and the content address — nothing else", () => {
    expect(
      isolateLoaderIdV1({
        userId: "user-1",
        botId: "bot-1",
        artifactSetHash: "a".repeat(64),
      }),
    ).toBe(`bot-package:user-1:bot-1:${"a".repeat(64)}`);
  });

  test("two Bots of one User never share an id", () => {
    const hash = "b".repeat(64);
    expect(
      isolateLoaderIdV1({
        userId: "user-1",
        botId: "bot-1",
        artifactSetHash: hash,
      }),
    ).not.toBe(
      isolateLoaderIdV1({
        userId: "user-1",
        botId: "bot-2",
        artifactSetHash: hash,
      }),
    );
  });

  test("rejects a component that could forge another Bot's id", () => {
    expect(() =>
      isolateLoaderIdV1({
        userId: "user-1:bot-2",
        botId: "bot-1",
        artifactSetHash: "c".repeat(64),
      }),
    ).toThrow(/components are invalid/);
  });

  test("rejects a hash that is not a content address", () => {
    expect(() =>
      isolateLoaderIdV1({
        userId: "user-1",
        botId: "bot-1",
        artifactSetHash: "not-a-hash",
      }),
    ).toThrow(/components are invalid/);
  });
});
