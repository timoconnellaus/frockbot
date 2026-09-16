import { expect, test } from "bun:test";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type {
  LlmProvider,
  NormalizedModelRequest,
  SessionEvent,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { createWebFetchToolDefinitionV1 } from "@frockbot/app/web/agent";
import { shellAgentFeature } from "./agent.js";
import { createReplyToRequestToolV1 } from "./reply-to-caller.js";

async function run(
  provider: LlmProvider,
  turnType: TurnTypeV1 = "chat",
  initial?: SessionEvent[],
  voice = false,
) {
  const root = createAgentRuntimeHarness(
    initial ? { sessions: { initialSessions: { "user:test": initial } } } : {},
  );
  await root.mount(shellAgentFeature);
  if (voice)
    root.tools.register(createReplyToRequestToolV1("voice", root.sessions));
  root.tools.register(
    createWebFetchToolDefinitionV1({
      fetch: async () =>
        new Response("Example result", {
          headers: { "content-type": "text/plain" },
        }),
    }),
  );
  root.llm.register(provider);
  const loop = createAgentLoop(root, {
    maxSteps: 8,
    composition: {
      generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
      artifactSetHash: "a".repeat(64),
    },
  });
  try {
    const handle = await loop.create({
      botId: "test",
      sessionId: "user:test",
      provider: provider.id,
      model: "test",
      turnType,
      admitEffect: () => Promise.resolve(true),
    });
    if (initial) handle.agent.resume();
    else handle.agent.send("hi");
    await handle.agent.whenIdle();
    return [...handle.agent.session.events];
  } finally {
    await loop.dispose();
    await root.dispose();
  }
}

test("a User-directed finish does not settle the answer owed to voice", async () => {
  let calls = 0;
  const events = await run(
    {
      id: "test",
      async *stream() {
        calls++;
        yield {
          type: "tool-call",
          call:
            calls === 1
              ? {
                  id: "update",
                  name: "send_to_user",
                  input: {
                    disposition: "finish",
                    payload: {
                      type: "text",
                      text: "The report is saved here.",
                    },
                  },
                }
              : {
                  id: "answer",
                  name: "reply_to_request",
                  input: { answer: "The report is ready." },
                },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    },
    "agent",
    undefined,
    true,
  );
  expect(calls).toBe(2);
  expect(events.filter((event) => event.type === "send/to-user")).toHaveLength(
    1,
  );
  expect(
    events.filter((event) => event.type === "reply/to-caller"),
  ).toMatchObject([{ caller: "voice", text: "The report is ready." }]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("an undelivered voice answer is repaired through the caller tool", async () => {
  const requests: NormalizedModelRequest[] = [];
  const events = await run(
    {
      id: "test",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1)
          yield { type: "text-delta", text: "Private draft." };
        else
          yield {
            type: "tool-call",
            call: {
              id: "answer",
              name: "reply_to_request",
              input: { answer: "The launch went well." },
            },
          };
        yield { type: "finish", reason: "completed" };
      },
    },
    "agent",
    undefined,
    true,
  );
  expect(requests).toHaveLength(2);
  expect(events.filter((event) => event.type === "send/to-user")).toHaveLength(
    0,
  );
  expect(
    events.filter((event) => event.type === "reply/to-caller"),
  ).toMatchObject([{ caller: "voice", text: "The launch went well." }]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

for (const batched of [false, true]) {
  test(`an answer can span separate sends ${batched ? "in one model step" : "across model steps"}`, async () => {
    const parts = [
      "RAM holds what your computer is using right now.",
      "Storage keeps your files after the power is off.",
      "A backup is another copy you can recover if the original is lost.",
    ];
    let requests = 0;
    const events = await run({
      id: "test",
      async *stream() {
        const first = requests++;
        const last = batched ? parts.length : first + 1;
        for (let index = first; index < last; index++) {
          yield {
            type: "tool-call",
            call: {
              id: `part-${index}`,
              name: "send_to_user",
              input: {
                disposition: index === parts.length - 1 ? "finish" : "continue",
                payload: { type: "text", text: parts[index]! },
              },
            },
          };
        }
        yield { type: "finish", reason: "completed" };
      },
    });
    expect(requests).toBe(batched ? 1 : parts.length);
    expect(
      events
        .filter((event) => event.type === "send/to-user")
        .map((event) => event.payload),
    ).toEqual(parts.map((text) => ({ type: "text", text })));
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });
}

test("a plain answer is repaired by an explicit send, never promoted or silently completed", async () => {
  const requests: NormalizedModelRequest[] = [];
  const events = await run({
    id: "test",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1)
        yield { type: "text-delta", text: "Hi! What can I help you with?" };
      else if (requests.length === 2)
        yield {
          type: "tool-call",
          call: {
            id: "send",
            name: "send_to_user",
            input: {
              disposition: "finish",
              payload: { type: "text", text: "Hi!" },
            },
          },
        };
      yield { type: "finish", reason: "completed" };
    },
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.system).toContain("Call `send_to_user`");
  expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["send_to_user"]);
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: expect.stringContaining("[FrockBot runtime: delivery repair]"),
  });
  expect(events.filter((event) => event.type === "user/message")).toHaveLength(
    1,
  );
  const sends = events.filter((e) => e.type === "send/to-user");
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ payload: { type: "text", text: "Hi!" } });
  expect(sends[0]?.occurrenceId).toStartWith("tool:");
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a model that ignores the send contract reaches a bounded durable failure", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream() {
      requests++;
      yield { type: "text-delta", text: "private scratch text" };
      yield { type: "finish", reason: "completed" };
    },
  });
  expect(requests).toBe(2);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "model-error",
    reason: "The model finished without sending a reply. Try again.",
  });
});

test("automation may finish without speaking in the conversation", async () => {
  let requests = 0;
  const events = await run(
    {
      id: "test",
      async *stream() {
        requests++;
        yield { type: "text-delta", text: "background result" };
        yield { type: "finish", reason: "completed" };
      },
    },
    "automation",
  );
  expect(requests).toBe(1);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("eviction after an unsent step does not silently complete the Turn", async () => {
  const original = await run({
    id: "test",
    async *stream() {
      yield { type: "text-delta", text: "private" };
      yield { type: "finish", reason: "completed" };
    },
  });
  const checkpoint = original.slice(
    0,
    original.findIndex((event) => event.type === "step/end") + 1,
  );
  let requests = 0;
  const resumed = await run(
    {
      id: "test",
      async *stream() {
        requests++;
        if (requests === 1)
          yield {
            type: "tool-call",
            call: {
              id: "reply",
              name: "send_to_user",
              input: {
                disposition: "finish",
                payload: { type: "text", text: "Hi!" },
              },
            },
          };
        yield { type: "finish", reason: "completed" };
      },
    },
    "chat",
    checkpoint,
  );
  expect(resumed.filter((event) => event.type === "send/to-user")).toHaveLength(
    1,
  );
  expect(resumed.filter((event) => event.type === "user/message")).toHaveLength(
    1,
  );
  expect(resumed.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a widget still ends the Turn when another tool in its batch fails", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream() {
      requests++;
      yield {
        type: "tool-call",
        call: {
          id: "question",
          name: "send_to_user",
          input: {
            disposition: "finish",
            payload: {
              type: "widget",
              widget: {
                prompt: "Which option?",
                options: ["Continue"],
                allowCustom: true,
                dismissOnMoveOn: false,
              },
            },
          },
        },
      };
      yield {
        type: "tool-call",
        call: { id: "unavailable", name: "unavailable_tool", input: {} },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toBe(1);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a final greeting completes in one model call even if the model would repeat", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream(request) {
      requests++;
      expect(request.tools.map((tool) => tool.name)).toEqual([
        "send_to_user",
        "batch",
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
      yield {
        type: "tool-call",
        call: {
          id: "reply",
          name: "send_to_user",
          input: {
            disposition: "finish",
            payload: { type: "text", text: "Hi!" },
          },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toBe(1);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("an interim update continues to a final reply", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream() {
      requests++;
      yield {
        type: "tool-call",
        call: {
          id: `reply-${requests}`,
          name: "send_to_user",
          input: {
            disposition: requests === 1 ? "continue" : "finish",
            payload: {
              type: "text",
              text: requests === 1 ? "On it." : "Done.",
            },
          },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toBe(2);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("eviction after a final send or its completed step never calls the model again", async () => {
  const original = await run({
    id: "test",
    async *stream() {
      yield {
        type: "tool-call",
        call: {
          id: "reply",
          name: "send_to_user",
          input: {
            disposition: "finish",
            payload: { type: "text", text: "Hi!" },
          },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  for (const boundary of ["send/to-user", "tool/result", "step/end"] as const) {
    let requests = 0;
    const resumed = await run(
      {
        id: "test",
        async *stream() {
          requests++;
          yield { type: "finish", reason: "completed" };
        },
      },
      "chat",
      original.slice(0, original.findIndex((e) => e.type === boundary) + 1),
    );
    expect(requests).toBe(0);
    expect(resumed.filter((e) => e.type === "send/to-user")).toHaveLength(1);
    expect(resumed.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  }
});

test("a repaired interim update restores the full toolset for the rest of the Turn", async () => {
  const requests: NormalizedModelRequest[] = [];
  const events = await run({
    id: "test",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "text-delta", text: "I should look that up." };
        yield { type: "finish", reason: "completed" };
        return;
      }
      if (requests.length === 2) {
        expect(request.tools.map((tool) => tool.name)).toEqual([
          "send_to_user",
        ]);
        yield {
          type: "tool-call",
          call: {
            id: "ack",
            name: "send_to_user",
            input: {
              disposition: "continue",
              payload: { type: "text", text: "On it." },
            },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      expect(request.tools.map((tool) => tool.name)).toEqual([
        "send_to_user",
        "batch",
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
      expect(request.messages.at(-1)).not.toMatchObject({
        content: expect.stringContaining("[FrockBot runtime: delivery repair]"),
      });
      if (requests.length === 3) {
        yield {
          type: "tool-call",
          call: {
            id: "fetch",
            name: "call_dynamic_tool",
            input: {
              namespace: "frockbot",
              toolName: "web_fetch",
              arguments: { url: "https://example.com" },
            },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      const result = request.messages.at(-1);
      expect(result?.role === "tool" && result.content).toContain(
        "Example result",
      );
      yield {
        type: "tool-call",
        call: {
          id: "answer",
          name: "send_to_user",
          input: {
            disposition: "finish",
            payload: { type: "text", text: "Example result" },
          },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toHaveLength(4);
  const sends = events.filter((e) => e.type === "send/to-user");
  expect(sends).toHaveLength(2);
  expect(sends.at(-1)).toMatchObject({
    payload: { type: "text", text: "Example result" },
  });
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("text-only steps either side of a delivered update do not fail the Turn", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream() {
      requests++;
      if (requests === 2) {
        yield {
          type: "tool-call",
          call: {
            id: "ack",
            name: "send_to_user",
            input: {
              disposition: "continue",
              payload: { type: "text", text: "On it." },
            },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      if (requests === 4) {
        yield {
          type: "tool-call",
          call: {
            id: "answer",
            name: "send_to_user",
            input: {
              disposition: "finish",
              payload: { type: "text", text: "Done." },
            },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "private scratch text" };
      yield { type: "finish", reason: "completed" };
    },
  });
  expect(requests).toBe(4);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("specialist schemas are disclosed on demand and interim work reaches a final reply", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream(request) {
      requests++;
      expect(request.tools.map((t) => t.name)).toEqual([
        "send_to_user",
        "batch",
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
      expect(request.system).toContain("web_fetch");
      if (requests === 1) {
        yield {
          type: "tool-call",
          call: {
            id: "ack",
            name: "send_to_user",
            input: {
              disposition: "continue",
              payload: { type: "text", text: "On it." },
            },
          },
        };
        yield {
          type: "tool-call",
          call: {
            id: "discover",
            name: "get_dynamic_tools",
            input: { namespace: "frockbot", toolName: "web_fetch" },
          },
        };
      } else if (requests === 2) {
        const result = request.messages.at(-1);
        expect(result).toMatchObject({
          role: "tool",
          name: "get_dynamic_tools",
        });
        expect(result?.role === "tool" && result.content).toContain(
          '"inputSchema"',
        );
        yield {
          type: "tool-call",
          call: {
            id: "fetch",
            name: "call_dynamic_tool",
            input: {
              namespace: "frockbot",
              toolName: "web_fetch",
              arguments: { url: "https://example.com" },
            },
          },
        };
      } else {
        const result = request.messages.at(-1);
        expect(result?.role === "tool" && result.content).toContain(
          "Example result",
        );
        yield {
          type: "tool-call",
          call: {
            id: "answer",
            name: "send_to_user",
            input: {
              disposition: "finish",
              payload: { type: "text", text: "Example result" },
            },
          },
        };
      }
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toBe(3);
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a batched finish send ends the Turn in one model call", async () => {
  let requests = 0;
  const events = await run({
    id: "test",
    async *stream() {
      requests++;
      yield {
        type: "tool-call",
        call: {
          id: "parts",
          name: "batch",
          input: {
            calls: [
              {
                tool: "send_to_user",
                arguments: {
                  disposition: "continue",
                  payload: { type: "text", text: "First part." },
                },
              },
              {
                tool: "send_to_user",
                arguments: {
                  disposition: "finish",
                  payload: { type: "text", text: "Second part." },
                },
              },
            ],
          },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    },
  });
  expect(requests).toBe(1);
  expect(
    events
      .filter((event) => event.type === "send/to-user")
      .map((event) => event.payload),
  ).toEqual([
    { type: "text", text: "First part." },
    { type: "text", text: "Second part." },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});
