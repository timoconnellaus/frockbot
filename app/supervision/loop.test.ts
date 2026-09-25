import { expect, test } from "bun:test";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import {
  allowAllStepDecisionV1,
  createFakeTurnSupervisorV1,
  createUnavailableTurnSupervisorV1,
  defaultTurnDirectiveV1,
  SUPERVISION_NOT_AUTHORIZED_PREFIX_V1,
  SUPERVISION_WITHHELD_SEND_PREFIX_V1,
  type LlmProvider,
  type NormalizedModelRequest,
  type SendReviewEvidenceV1,
  type SessionEvent,
  type CallReviewEvidenceV1,
  type ToolCall,
  type ToolDefinition,
  type TurnSupervisor,
} from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { createWebFetchToolDefinitionV1 } from "@frockbot/app/web/agent";
import { shellAgentFeature } from "../shell/agent.js";
import { createReplyToRequestToolV1 } from "../shell/reply-to-caller.js";
import type { FoundationFeature } from "../runtime.js";
import {
  ACKNOWLEDGE_NOTE_V1,
  createSupervisionRuntimeFeatureV1,
  turnInputOriginV1,
} from "./loop.js";

function text(textValue: string, disposition: "finish" | "continue"): unknown {
  return { disposition, payload: { type: "text", text: textValue } };
}

/** A model that makes these calls, one response per step. */
function scripted(
  steps: readonly (readonly ToolCall[])[],
  seen: NormalizedModelRequest[] = [],
): LlmProvider {
  return {
    id: "test",
    async *stream(request) {
      seen.push(request);
      const calls = steps[seen.length - 1] ?? [];
      for (const call of calls) yield { type: "tool-call", call };
      yield {
        type: "finish",
        reason: calls.length > 0 ? "tool-calls" : "completed",
      };
    },
  };
}

async function run(
  provider: LlmProvider,
  supervisor: TurnSupervisor,
  options: {
    cleared?: number[];
    /** A voice caller waiting on `reply_to_request`. */
    voice?: boolean;
    /** Folded into the Turn as a later message before step 2. */
    followUp?: string;
    /** More tools, registered as a host would. */
    tools?: readonly ToolDefinition[];
  } = {},
): Promise<SessionEvent[]> {
  const root = createAgentRuntimeHarness({});
  // Mounted first, as the host does.
  await root.mount(
    createSupervisionRuntimeFeatureV1({
      supervisor,
      origin: options.voice ? "voice" : "user",
      clearReplyDraft: (ordinal) => options.cleared?.push(ordinal),
    }) as unknown as Parameters<typeof root.mount>[0],
  );
  await root.mount(shellAgentFeature);
  const followUp = options.followUp;
  if (followUp !== undefined) {
    root.hooks.add({
      preStep: async (_agent, _inputs, _turn, step, next) => {
        const decision = await next();
        return decision.kind === "enter" && step === 2
          ? {
              kind: "enter",
              inputs: [
                ...decision.inputs,
                { messageId: "follow-up", text: followUp },
              ],
            }
          : decision;
      },
    });
  }
  if (options.voice) {
    root.tools.register(createReplyToRequestToolV1("voice", root.sessions));
  }
  for (const tool of options.tools ?? []) root.tools.register(tool);
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
      turnType: options.voice ? "agent" : "chat",
      admitEffect: () => Promise.resolve(true),
    });
    handle.agent.send("Email Dana the March invoice.");
    await handle.agent.whenIdle();
    return [...handle.agent.session.activeRunJournal];
  } finally {
    await loop.dispose();
    await root.dispose();
  }
}

function withholding(
  when: (evidence: SendReviewEvidenceV1) => boolean,
): TurnSupervisor {
  return createFakeTurnSupervisorV1({
    reviewSend: async (evidence) =>
      when(evidence)
        ? {
            send: "withhold",
            reason: "redundant_text",
            judgments: [{ question: "messageNeeded", value: 0.1 }],
          }
        : { send: "release", judgments: [] },
  });
}

const sent = (events: readonly SessionEvent[]) =>
  events.flatMap((event) =>
    event.type === "send/to-user" && event.payload.type === "text"
      ? [event.payload.text]
      : [],
  );

test("asks the start-of-Turn question once, and records it before the first request", async () => {
  let asked = 0;
  const events = await run(
    scripted([
      [{ id: "a", name: "send_to_user", input: text("Done.", "finish") }],
    ]),
    createFakeTurnSupervisorV1({
      startTurn: async () => {
        asked++;
        return defaultTurnDirectiveV1();
      },
    }),
  );
  expect(asked).toBe(1);
  const start = events.findIndex(
    (event) => event.type === "supervision/turn-start",
  );
  const request = events.findIndex((event) => event.type === "model/request");
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThan(request);
});

test("an acknowledgement is asked for at the tail of the first request only", async () => {
  const seen: NormalizedModelRequest[] = [];
  await run(
    scripted(
      [
        [{ id: "a", name: "send_to_user", input: text("On it.", "continue") }],
        [{ id: "b", name: "send_to_user", input: text("Sent.", "finish") }],
      ],
      seen,
    ),
    createFakeTurnSupervisorV1({
      startTurn: async () => ({
        ...defaultTurnDirectiveV1(),
        acknowledge: true,
      }),
    }),
  );
  expect(seen).toHaveLength(2);
  expect(seen[0]?.messages.at(-1)).toEqual({
    role: "user",
    content: ACKNOWLEDGE_NOTE_V1,
  });
  expect(seen[1]?.messages.some((m) => m.content === ACKNOWLEDGE_NOTE_V1)).toBe(
    false,
  );
  // The note never touches the cached prefix.
  expect(seen[0]?.system).toBe(seen[1]?.system);
});

test("a withheld finish is never delivered and still ends the Turn", async () => {
  const cleared: number[] = [];
  const seen: NormalizedModelRequest[] = [];
  const events = await run(
    scripted(
      [
        [
          {
            id: "a",
            name: "send_to_user",
            input: text("Here it is.", "continue"),
          },
          {
            id: "b",
            name: "send_to_user",
            input: text("I've emailed Dana.", "finish"),
          },
        ],
      ],
      seen,
    ),
    withholding((evidence) => evidence.message === "I've emailed Dana."),
    { cleared },
  );
  expect(seen).toHaveLength(1);
  expect(sent(events)).toEqual(["Here it is."]);
  expect(
    events.find(
      (event) =>
        event.type === "tool/result" && event.occurrenceId.endsWith(":1"),
    ),
  ).toMatchObject({
    content: expect.stringMatching(
      new RegExp(`^${SUPERVISION_WITHHELD_SEND_PREFIX_V1}`),
    ),
  });
  expect(
    events.filter((event) => event.type === "supervision/send"),
  ).toMatchObject([
    { finish: false, decision: { send: "release" } },
    { finish: true, decision: { send: "withhold", reason: "redundant_text" } },
  ]);
  // The draft of the withheld send is cleared from where the step's sends begin.
  expect(cleared).toEqual([0]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a withheld finish does not end a Turn that still owes its caller an answer", async () => {
  const seen: NormalizedModelRequest[] = [];
  const events = await run(
    scripted(
      [
        [{ id: "a", name: "send_to_user", input: text("On it.", "finish") }],
        [{ id: "b", name: "reply_to_request", input: { answer: "4 pm." } }],
      ],
      seen,
    ),
    withholding((evidence) => evidence.message === "On it."),
    { voice: true },
  );
  expect(seen).toHaveLength(2);
  const withheld = events.find(
    (event) => event.type === "tool/result" && event.name === "send_to_user",
  );
  expect(withheld).toMatchObject({
    content: expect.stringContaining("reply_to_request"),
  });
  expect(withheld).not.toMatchObject({
    content: expect.stringContaining("The Turn is complete"),
  });
  expect(
    events.filter((event) => event.type === "reply/to-caller"),
  ).toMatchObject([{ text: "4 pm." }]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a later message adds to the task rather than replacing it", async () => {
  const objectives: string[] = [];
  await run(
    scripted([
      [
        {
          id: "fetch",
          name: "web_fetch",
          input: { url: "https://example.com" },
        },
      ],
      [{ id: "b", name: "send_to_user", input: text("Sent.", "finish") }],
    ]),
    createFakeTurnSupervisorV1({
      reviewStep: async (evidence) => {
        objectives.push(evidence.objective);
        return allowAllStepDecisionV1(evidence.calls);
      },
    }),
    { followUp: "Also include prices." },
  );
  expect(objectives).toEqual([
    "Email Dana the March invoice.",
    "Email Dana the March invoice.\n\nAlso include prices.",
  ]);
});

test("a withheld interim send lets the Turn carry on to its answer", async () => {
  const events = await run(
    scripted([
      [
        {
          id: "a",
          name: "send_to_user",
          input: text("Looking now.", "continue"),
        },
      ],
      [{ id: "b", name: "send_to_user", input: text("It is 4 pm.", "finish") }],
    ]),
    withholding((evidence) => evidence.message === "Looking now."),
  );
  expect(sent(events)).toEqual(["It is 4 pm."]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("each send is judged with what the Turn already showed", async () => {
  const shownAtReview: string[][] = [];
  await run(
    scripted([
      [
        { id: "a", name: "send_to_user", input: text("First.", "continue") },
        { id: "b", name: "send_to_user", input: text("Second.", "finish") },
      ],
    ]),
    createFakeTurnSupervisorV1({
      reviewSend: async (evidence) => {
        shownAtReview.push([...evidence.shown]);
        return { send: "release", judgments: [] };
      },
    }),
  );
  expect(shownAtReview).toEqual([[], ["First."]]);
});

test("a batch's text sends are judged one by one", async () => {
  const events = await run(
    scripted([
      [
        {
          id: "batch",
          name: "batch",
          input: {
            calls: [
              { tool: "send_to_user", arguments: text("Kept.", "continue") },
              { tool: "send_to_user", arguments: text("Dropped.", "finish") },
            ],
          },
        },
      ],
    ]),
    withholding((evidence) => evidence.message === "Dropped."),
  );
  expect(sent(events)).toEqual(["Kept."]);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});

test("a response off its task runs none of its calls but the Bot speaking", async () => {
  const events = await run(
    scripted([
      [
        {
          id: "fetch",
          name: "web_fetch",
          input: { url: "https://example.com" },
        },
        {
          id: "ask",
          name: "send_to_user",
          input: text("Which Dana?", "finish"),
        },
      ],
    ]),
    createFakeTurnSupervisorV1({
      reviewStep: async (evidence) => ({
        ...allowAllStepDecisionV1(evidence.calls),
        responseAlignment: "wrong-objective",
      }),
    }),
  );
  expect(
    events.find(
      (event) => event.type === "tool/result" && event.name === "web_fetch",
    ),
  ).toMatchObject({
    content: expect.stringMatching(/^Not run: supervision judged/),
  });
  expect(sent(events)).toEqual(["Which Dana?"]);
});

test("the step decision is recorded before any of its calls runs", async () => {
  const events = await run(
    scripted([
      [{ id: "a", name: "send_to_user", input: text("Done.", "finish") }],
    ]),
    createFakeTurnSupervisorV1(),
  );
  const review = events.findIndex((event) => event.type === "supervision/step");
  const call = events.findIndex((event) => event.type === "tool/call");
  expect(review).toBeGreaterThan(-1);
  expect(review).toBeLessThan(call);
});

test("no Turn runs unsupervised: an unavailable supervisor fails it before the model", async () => {
  const seen: NormalizedModelRequest[] = [];
  const events = await run(
    scripted(
      [[{ id: "a", name: "send_to_user", input: text("Hi.", "finish") }]],
      seen,
    ),
    createUnavailableTurnSupervisorV1(),
  );
  expect(seen).toHaveLength(0);
  expect(sent(events)).toEqual([]);
  // Told to the person as a failed reply; the reason is on the log.
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "model-error",
    reason: "Turn supervision is unavailable.",
  });
});

test("a run's origin names who is on the other end of its Turn", () => {
  expect(turnInputOriginV1(undefined)).toBe("user");
  expect(turnInputOriginV1({ kind: "email", messageId: "m" })).toBe("email");
  expect(turnInputOriginV1({ kind: "routine-delivery", wakeRunId: "r" })).toBe(
    "schedule",
  );
  expect(turnInputOriginV1({ kind: "input-delivery", inputId: "i" })).toBe(
    "user",
  );
});

// Keeps the feature assignable where the host mounts it.
export const mountable: (
  host: Parameters<typeof createSupervisionRuntimeFeatureV1>[0],
) => FoundationFeature = createSupervisionRuntimeFeatureV1;

/** A tool that records whether it ran, with the effect its host gave it. */
function effectTool(
  name: string,
  effect: "read" | "mutate" | undefined,
  ran: string[],
): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object", additionalProperties: true },
    ...(effect === undefined ? {} : { effect }),
    execute: async () => {
      ran.push(name);
      return { content: `${name} done`, isError: false };
    },
  };
}

test("a mutate call the person did not ask for never runs, and the Bot is told to ask", async () => {
  const ran: string[] = [];
  const reviewed: CallReviewEvidenceV1[] = [];
  const events = await run(
    scripted([
      [{ id: "post", name: "post_to_slack", input: { channel: "#all" } }],
      [
        {
          id: "a",
          name: "send_to_user",
          input: text("Shall I post it?", "finish"),
        },
      ],
    ]),
    createFakeTurnSupervisorV1({
      reviewCall: async (evidence) => {
        reviewed.push(evidence);
        return {
          decision: "reject",
          reasonCode: "no_authorization",
          judgments: [
            { question: "authorization", answer: "none", value: 0.9 },
          ],
        };
      },
    }),
    { tools: [effectTool("post_to_slack", "mutate", ran)] },
  );
  expect(ran).toEqual([]);
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0]?.call).toEqual({
    tool: "post_to_slack",
    arguments: { channel: "#all" },
  });
  // The person's own request is the evidence an authorization comes from.
  expect(reviewed[0]?.conversation.at(-1)).toEqual({
    speaker: "user",
    text: "Email Dana the March invoice.",
  });
  expect(
    events.find(
      (event) => event.type === "tool/result" && event.name === "post_to_slack",
    ),
  ).toMatchObject({
    isError: true,
    content: expect.stringMatching(
      new RegExp(
        `^${SUPERVISION_NOT_AUTHORIZED_PREFIX_V1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    ),
  });
  expect(
    events.filter((event) => event.type === "supervision/call"),
  ).toMatchObject([
    {
      tool: "post_to_slack",
      decision: { decision: "reject", reasonCode: "no_authorization" },
    },
  ]);
});

test("an allowed mutate call runs once, and a read call is never reviewed", async () => {
  const ran: string[] = [];
  let reviews = 0;
  const events = await run(
    scripted([
      [
        { id: "look", name: "lookup", input: {} },
        { id: "post", name: "post_to_slack", input: { channel: "#team" } },
      ],
      [{ id: "a", name: "send_to_user", input: text("Posted.", "finish") }],
    ]),
    createFakeTurnSupervisorV1({
      reviewCall: async () => {
        reviews++;
        return { decision: "allow", reasonCode: "authorized", judgments: [] };
      },
    }),
    {
      tools: [
        effectTool("lookup", undefined, ran),
        effectTool("post_to_slack", "mutate", ran),
      ],
    },
  );
  expect(ran).toEqual(["lookup", "post_to_slack"]);
  expect(reviews).toBe(1);
  expect(
    events.filter((event) => event.type === "supervision/call"),
  ).toHaveLength(1);
});

test("a namespaced mutate call is reviewed and recorded under its namespace", async () => {
  const ran: string[] = [];
  const reviewed: CallReviewEvidenceV1[] = [];
  const events = await run(
    scripted([
      [
        {
          id: "send",
          name: "call_dynamic_tool",
          input: {
            namespace: "composio-gmail",
            toolName: "GMAIL_SEND_EMAIL",
            arguments: { to: "dana@example.com" },
            mcpDetails: { description: "Email Dana the invoice." },
          },
        },
      ],
      [{ id: "a", name: "send_to_user", input: text("Sent.", "finish") }],
    ]),
    createFakeTurnSupervisorV1({
      reviewCall: async (evidence) => {
        reviewed.push(evidence);
        return { decision: "allow", reasonCode: "authorized", judgments: [] };
      },
    }),
    {
      tools: [
        {
          ...effectTool("GMAIL_SEND_EMAIL", "mutate", ran),
          namespace: "composio-gmail",
        },
      ],
    },
  );
  expect(ran).toEqual(["GMAIL_SEND_EMAIL"]);
  expect(reviewed.map((evidence) => evidence.call)).toEqual([
    {
      tool: "composio-gmail/GMAIL_SEND_EMAIL",
      arguments: { to: "dana@example.com" },
    },
  ]);
  expect(
    events.filter((event) => event.type === "supervision/call"),
  ).toMatchObject([{ tool: "composio-gmail/GMAIL_SEND_EMAIL" }]);
});
