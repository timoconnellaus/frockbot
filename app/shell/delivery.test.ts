import { expect, test } from "bun:test";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type {
  LlmProvider,
  NormalizedModelRequest,
  SessionEvent,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { shellAgentFeature } from "./agent.js";

async function run(
  provider: LlmProvider,
  turnType: TurnTypeV1 = "chat",
  initial?: SessionEvent[],
) {
  const root = createAgentRuntimeHarness(
    initial ? { sessions: { initialSessions: { "user:test": initial } } } : {},
  );
  await root.mount(shellAgentFeature);
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
            input: { payload: { type: "text", text: "Hi!" } },
          },
        };
      yield { type: "finish", reason: "completed" };
    },
  });
  expect(requests).toHaveLength(3);
  expect(requests[1]?.system).toContain("Call `send_to_user`");
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
              input: { payload: { type: "text", text: "Hi!" } },
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
