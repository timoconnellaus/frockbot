// The Shell's runtime Contribution: what it admits, what it records, and what
// ends a Turn.
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import {
  decodeSendToUserPayloadV1,
  SEND_TO_USER_PAYLOAD_TYPES_V1,
  type FirstPartyCardDrawV1,
  type NormalizedModelRequest,
  type SendToUserPayloadV1,
  type Session,
  type ToolCall,
  type ToolExecutionContext,
  type TurnTypeV1,
  TURN_DEADLINE_MS_V1,
} from "@frockbot/core/contracts";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import {
  CONVERSATION_PROMPT_SECTION_V1,
  CONVERSATION_PROMPT_TEXT_V1,
  conversationPromptTextV1,
  HANDOFF_PROMPT_TEXT_V1,
  shellAdmissionCeilingV1,
  shellAgentFeature,
  PARENT_HANDOFF_CAPABILITY_V1,
  SEND_TO_USER_TOOL_V1,
  TIME_BUDGET_WARNING_MS_V1,
  TURN_BUDGET_NOTE_LABEL_V1,
  turnBudgetHooksV1,
  USER_VOICE_CAPABILITY_V1,
  SUBAGENT_ASK_PROMPT_TEXT_V1,
  TASK_ASK_TOOL_V1,
  WAKE_PARENT_TOOL_V1,
} from "./agent.ts";
import {
  SUBAGENT_QUESTION_PREFIX_V1,
  TASK_QUESTION_MAX_V1,
  subagentQuestionV1,
} from "@frockbot/app/subagents/records";

const SESSION_ID = "user-1:bot-1";

interface Mounted {
  root: AgentRuntimeHarness;
  session: Session;
  dispose(): Promise<void>;
}

async function mount(): Promise<Mounted> {
  const root = createAgentRuntimeHarness();
  const session = root.sessions.create(SESSION_ID);
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  await root.mount(shellAgentFeature);
  return { root, session, dispose: () => root.dispose() };
}

function contextFor(turnType: TurnTypeV1): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: SESSION_ID,
    compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
    turnType,
    effectId: "tool:4:2:0",
    signal: new AbortController().signal,
  };
}

function call(name: string, input: unknown): ToolCall {
  return { id: "call-1", name, input };
}

/** Runs a tool the way the loop does: prepare, then execute what it admits. */
async function invoke(
  mounted: Mounted,
  turnType: TurnTypeV1,
  toolCall: ToolCall,
) {
  const context = {
    ...contextFor(turnType),
    effectId: `tool:4:2:${mounted.session.activeRunJournal.filter((e) => e.type === "send/to-user").length}`,
  };
  const preparation = await mounted.root.tools.prepare(toolCall, context);
  if (preparation.kind === "denied") return preparation.result;
  return mounted.root.tools.executePrepared(preparation, context);
}

/** The budget note the request hook appends, or `undefined` for none. */
async function budgetNote(input: {
  step: number;
  remainingMs?: number;
  noBudget?: boolean;
}): Promise<string | undefined> {
  const base: NormalizedModelRequest = {
    requestId: "request-1",
    provider: "provider-1",
    model: "model-1",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  } as NormalizedModelRequest;
  const agent = {
    ...(input.noBudget
      ? {}
      : {
          turnBudget: () => ({
            maxSteps: 64,
            deadlineAt: TURN_DEADLINE_MS_V1,
            now: TURN_DEADLINE_MS_V1 - (input.remainingMs ?? 10 * 60_000),
          }),
        }),
  } as never;
  const request = await turnBudgetHooksV1.request!(
    agent,
    base,
    1,
    input.step,
    new AbortController().signal,
    async () => base,
  );
  expect(request.system).toBe(base.system);
  if (request.messages.length === base.messages.length) return undefined;
  const note = request.messages.at(-1);
  expect(note?.role).toBe("user");
  expect(note?.content.startsWith(TURN_BUDGET_NOTE_LABEL_V1)).toBe(true);
  return note?.content;
}

describe("the Shell's tool admission", () => {
  test("offers the send tool on chat and agent Turns", async () => {
    const mounted = await mount();
    try {
      const chat = mounted.root.tools
        .schemas({ turnType: "chat" })
        .map((tool) => tool.name);
      const automation = mounted.root.tools
        .schemas({ turnType: "automation" })
        .map((tool) => tool.name);
      const subagent = mounted.root.tools
        .schemas({ turnType: "subagent" })
        .map((tool) => tool.name);
      const agent = mounted.root.tools
        .schemas({ turnType: "agent" })
        .map((tool) => tool.name);

      expect(chat).toContain(SEND_TO_USER_TOOL_V1);
      expect(chat).not.toContain(WAKE_PARENT_TOOL_V1);
      expect(agent).toContain(SEND_TO_USER_TOOL_V1);
      expect(agent).not.toContain(WAKE_PARENT_TOOL_V1);
      expect(automation).toEqual([
        WAKE_PARENT_TOOL_V1,
        "batch",
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
      expect(subagent).toEqual([
        WAKE_PARENT_TOOL_V1,
        TASK_ASK_TOOL_V1,
        "batch",
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  test("no role widens a subagent turn: chat-only tools are absent for all five", async () => {
    const mounted = await mount();
    try {
      for (const subagentRole of [
        "executor",
        "browserUse",
        "computerUse",
        "watchVideo",
        "videoReview",
      ]) {
        const names = mounted.root.tools
          .schemas({ turnType: "subagent", subagentRole })
          .map((tool) => tool.name);
        // The turn-type ceiling comes first and no role can reach past it: the
        // Shell's user-facing tools are chat-only, and the hand-off is the only
        // thing any subagent role is offered here.
        expect(names).not.toContain(SEND_TO_USER_TOOL_V1);
        expect(names).toEqual([
          WAKE_PARENT_TOOL_V1,
          TASK_ASK_TOOL_V1,
          "batch",
          "get_dynamic_tools",
          "call_dynamic_tool",
        ]);
      }
    } finally {
      await mounted.dispose();
    }
  });

  test("a subagent asks its one question by handing it off, and is told how", async () => {
    expect(conversationPromptTextV1("subagent")).toContain(TASK_ASK_TOOL_V1);
    expect(conversationPromptTextV1("automation")).not.toContain(
      TASK_ASK_TOOL_V1,
    );
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "subagent",
        call(TASK_ASK_TOOL_V1, { question: "  Nomad or Ester?  " }),
      );
      expect(result).toMatchObject({ isError: false, endsTurn: true });
      expect(
        mounted.session.activeRunJournal.find(
          (event) => event.type === "wake/parent",
        ),
      ).toMatchObject({
        message: `${SUBAGENT_QUESTION_PREFIX_V1}Nomad or Ester?`,
      });
      expect(
        subagentQuestionV1(`${SUBAGENT_QUESTION_PREFIX_V1}Nomad or Ester?`),
      ).toBe("Nomad or Ester?");
      expect(subagentQuestionV1("Booked Ester.")).toBeUndefined();
      expect(
        await invoke(
          mounted,
          "subagent",
          call(TASK_ASK_TOOL_V1, {
            question: "x".repeat(TASK_QUESTION_MAX_V1 + 1),
          }),
        ),
      ).toMatchObject({ isError: true });
    } finally {
      await mounted.dispose();
    }
  });

  test("denies a hallucinated wake_parent on a chat turn", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(WAKE_PARENT_TOOL_V1, { message: "done" }),
      );

      expect(result).toEqual({
        content: `Tool is not available on a chat turn: ${WAKE_PARENT_TOOL_V1}`,
        isError: true,
      });
      expect(
        mounted.session.activeRunJournal.some(
          (event) => event.type === "wake/parent",
        ),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("denies send_to_user on an automation turn", async () => {
    const mounted = await mount();
    try {
      for (const name of [SEND_TO_USER_TOOL_V1]) {
        const result = await invoke(
          mounted,
          "automation",
          call(name, {
            disposition: "continue",
            payload: { type: "text", text: "hi" },
          }),
        );

        expect(result).toEqual({
          content: `Tool is not available on a automation turn: ${name}`,
          isError: true,
        });
      }
      expect(
        mounted.session.activeRunJournal.some(
          (event) => event.type === "send/to-user",
        ),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("bounds each tool by the turn types its manifest Capability declares", () => {
    expect(shellAdmissionCeilingV1(USER_VOICE_CAPABILITY_V1)).toEqual([
      "chat",
      "agent",
    ]);
    expect(shellAdmissionCeilingV1(PARENT_HANDOFF_CAPABILITY_V1)).toEqual([
      "automation",
      "subagent",
    ]);
    expect(shellAdmissionCeilingV1("not-a-capability")).toBeUndefined();
  });
});

describe("send_to_user", () => {
  test("records a text send and leaves the Turn running", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "text", text: "Booked for Tuesday." },
        }),
      );

      expect(result.isError).toBe(false);
      expect(result.endsTurn).toBeUndefined();
      expect(
        mounted.session.activeRunJournal.find(
          (event) => event.type === "send/to-user",
        ),
      ).toMatchObject({
        turn: 4,
        step: 2,
        occurrenceId: "tool:4:2:0",
        payload: { type: "text", text: "Booked for Tuesday." },
      });
    } finally {
      await mounted.dispose();
    }
  });

  test("records a card's ConnectApp bound to the app it connects, and refuses one it cannot", async () => {
    const mounted = await mount();
    const offer = (app: string) =>
      call(SEND_TO_USER_TOOL_V1, {
        disposition: "continue",
        payload: {
          type: "card",
          surfaceId: "offer",
          messages: [
            {
              version: "v1.0",
              createSurface: {
                surfaceId: "offer",
                components: [
                  { id: "root", component: "ConnectApp", app, name: "Slack" },
                ],
              },
            },
          ],
        },
      });
    try {
      const refused = await invoke(mounted, "chat", offer("nowhere-app"));
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain(
        `no app "nowhere-app" is in the Marketplace`,
      );
      expect(
        mounted.session.activeRunJournal.some(
          (event) => event.type === "send/to-user",
        ),
      ).toBe(false);

      const sent = await invoke(mounted, "chat", offer("Gmail"));
      expect(sent.isError).toBe(false);
      expect(
        mounted.session.activeRunJournal.find(
          (event) => event.type === "send/to-user",
        ),
      ).toMatchObject({
        payload: {
          type: "card",
          messages: [
            {
              createSurface: {
                components: [
                  {
                    id: "root",
                    component: "ConnectApp",
                    app: "gmail",
                    name: "Gmail",
                    packageId: "connect",
                    connectionTypeId: "connect-gmail",
                  },
                ],
              },
            },
          ],
        },
      });
    } finally {
      await mounted.dispose();
    }
  });

  test("widgets, approvals and secret requests end the Turn even when marked as interim", async () => {
    const mounted = await mount();
    try {
      const widget = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: {
            type: "widget",
            widget: { prompt: "Which day?", options: ["Tue", "Thu"] },
          },
        }),
      );
      const attachment = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "attachment", url: "https://files.example/a.pdf" },
        }),
      );

      // An approval ends the Turn for the same reason a widget does: the Bot
      // has nothing left to do until a person answers, and the answer is a
      // later Turn's input rather than this one's.
      const approval = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: {
            type: "approval",
            approvalId: "ap-1",
            action: "Delete the staging database",
            risk: "high",
          },
        }),
      );
      const text = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "text", text: "On it." },
        }),
      );
      const secret = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: {
            type: "secret-request",
            prompt: "Your API key",
            secretName: "api_key",
          },
        }),
      );
      const card = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "agent-card", agentId: "bot-2", title: "School" },
        }),
      );

      expect(widget.endsTurn).toBe(true);
      expect(approval.endsTurn).toBe(true);
      expect(attachment.endsTurn).toBeUndefined();
      expect(text.endsTurn).toBeUndefined();
      // A secret request waits on the person, as a question does.
      expect(secret.endsTurn).toBe(true);
      expect(card.endsTurn).toBeUndefined();
      expect(
        mounted.session.activeRunJournal
          .filter((event) => event.type === "send/to-user")
          .map((event) =>
            event.type === "send/to-user" ? event.payload.type : undefined,
          ),
      ).toEqual([
        "widget",
        "attachment",
        "approval",
        "text",
        "secret-request",
        "agent-card",
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  test("refuses a malformed payload without recording anything", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "shout", text: "hi" },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("send_to_user.payload.type is invalid");
      expect(result.endsTurn).toBeUndefined();
      expect(
        mounted.session.activeRunJournal.some(
          (event) => event.type === "send/to-user",
        ),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });
});

describe("wake_parent", () => {
  test("records the hand-off and always ends the Turn", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "automation",
        call(WAKE_PARENT_TOOL_V1, { message: "The invoice is paid." }),
      );

      expect(result).toMatchObject({ isError: false, endsTurn: true });
      expect(
        mounted.session.activeRunJournal.find(
          (event) => event.type === "wake/parent",
        ),
      ).toMatchObject({
        turn: 4,
        step: 2,
        occurrenceId: "tool:4:2:0",
        message: "The invoice is paid.",
      });
    } finally {
      await mounted.dispose();
    }
  });

  test("refuses an empty hand-off rather than ending the Turn on nothing", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "subagent",
        call(WAKE_PARENT_TOOL_V1, { message: "   " }),
      );

      expect(result.isError).toBe(true);
      expect(result.endsTurn).toBeUndefined();
      expect(
        mounted.session.activeRunJournal.some(
          (event) => event.type === "wake/parent",
        ),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });
});

// The conversational contract is a prompt section and a tool description, and
// the two have to say the same thing: a model that read one and not the other
// would have half the rule.
describe("the conversation prompt section", () => {
  test("is assembled into the system prompt the model reads", async () => {
    const mounted = await mount();
    try {
      const assembled = await mounted.root.systemPrompt.assemble({
        sessionId: SESSION_ID,
        provider: "test",
        model: "test-model",
        turnType: "chat",
      });

      const section = assembled.sections.find(
        (candidate) => candidate.id === CONVERSATION_PROMPT_SECTION_V1,
      );
      expect(section?.text).toBe(CONVERSATION_PROMPT_TEXT_V1);
      expect(assembled.text).toContain(CONVERSATION_PROMPT_TEXT_V1);
    } finally {
      await mounted.dispose();
    }
  });

  // A Turn is told about the voice it has. An automation Turn that was handed
  // the conversational contract spent its last steps hunting for a
  // `send_to_user` the manifest never admitted there.
  test("a Turn outside the conversation is given the hand-off contract", async () => {
    const mounted = await mount();
    try {
      const assembled = await mounted.root.systemPrompt.assemble({
        sessionId: SESSION_ID,
        provider: "test",
        model: "test-model",
        turnType: "automation",
      });

      const section = assembled.sections.find(
        (candidate) => candidate.id === CONVERSATION_PROMPT_SECTION_V1,
      );
      expect(section?.text).toBe(HANDOFF_PROMPT_TEXT_V1);
      expect(section?.text).toContain(WAKE_PARENT_TOOL_V1);
      // Named only as the thing that is not there, never as an instruction.
      expect(section?.text).not.toContain(
        `\`${SEND_TO_USER_TOOL_V1}\` call with`,
      );
      expect(assembled.text).not.toContain(CONVERSATION_PROMPT_TEXT_V1);
    } finally {
      await mounted.dispose();
    }
  });

  test("every turn type is given the contract for the voice it admits", () => {
    const expected: Record<TurnTypeV1, string> = {
      chat: CONVERSATION_PROMPT_TEXT_V1,
      agent: CONVERSATION_PROMPT_TEXT_V1,
      automation: HANDOFF_PROMPT_TEXT_V1,
      subagent: `${HANDOFF_PROMPT_TEXT_V1}\n${SUBAGENT_ASK_PROMPT_TEXT_V1}`,
    };
    for (const [turnType, text] of Object.entries(expected) as ReadonlyArray<
      [TurnTypeV1, string]
    >) {
      expect(conversationPromptTextV1(turnType)).toBe(text);
    }
  });

  test("the tool contract admits every payload type the decoder accepts", async () => {
    // The model is handed this schema as the tool's contract, and a strict
    // provider will not let it produce a branch the schema omits. So every
    // declared payload type must have one.
    const samples: Record<SendToUserPayloadV1["type"], SendToUserPayloadV1> = {
      text: { type: "text", text: "Booked." },
      attachment: { type: "attachment", url: "https://files.test/a.pdf" },
      widget: {
        type: "widget",
        widget: { prompt: "Which one?", options: ["Tuesday"] },
      },
      "secret-request": {
        type: "secret-request",
        prompt: "Your API key",
        secretName: "api_key",
      },
      "agent-card": { type: "agent-card", agentId: "bot-2", title: "School" },
      card: {
        type: "card",
        surfaceId: "draft-email",
        messages: [
          {
            version: "v1.0",
            createSurface: {
              surfaceId: "draft-email",
              components: [{ id: "root", component: "Text", text: "Ready" }],
            },
          },
        ],
      },
      approval: {
        type: "approval",
        approvalId: "ap-1",
        action: "Delete it",
        risk: "high",
      },
    };
    const mounted = await mount();
    try {
      const schema = mounted.root.tools
        .schemas({ turnType: "chat" })
        .find((tool) => tool.name === SEND_TO_USER_TOOL_V1);
      const validate = new Ajv({ strict: false }).compile(schema!.inputSchema);
      for (const type of SEND_TO_USER_PAYLOAD_TYPES_V1) {
        const payload = samples[type];
        expect(decodeSendToUserPayloadV1(payload)).toEqual(payload);
        expect(validate({ disposition: "finish", payload })).toBe(true);
      }
      expect(
        validate({
          disposition: "finish",
          payload: { type: "applet", appletId: "user-1.todo", token: "x" },
        }),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("matches what the send tool's own description tells the model", async () => {
    const mounted = await mount();
    try {
      const schema = mounted.root.tools
        .schemas({ turnType: "chat" })
        .find((tool) => tool.name === SEND_TO_USER_TOOL_V1);
      const description = schema?.description ?? "";
      const validate = new Ajv({ strict: false }).compile(schema!.inputSchema);
      expect(
        validate({
          disposition: "finish",
          payload: { type: "text", text: "Hi!" },
        }),
      ).toBe(true);
      expect(
        validate({ disposition: "finish", payload: { text: "Hi!" } }),
      ).toBe(false);
      expect(
        validate({ disposition: "finish", payload: { type: "text" } }),
      ).toBe(false);
      expect(
        validate({
          disposition: "finish",
          payload: { type: "invented", text: "Hi!" },
        }),
      ).toBe(false);

      expect(description).toContain("only way to say anything the user sees");
    } finally {
      await mounted.dispose();
    }
  });
});

describe("a secret request", () => {
  async function mountWithCards() {
    const mounted = await mount();
    const draws: FirstPartyCardDrawV1[] = [];
    mounted.root.firstPartyCards = {
      draw: async (request) => {
        draws.push(request);
        return { status: "drawn", surfaceId: "credentials_request.abc" };
      },
    };
    return { mounted, draws };
  }

  test("carries its site and payment class to the card, and the log keeps the wire's shape", async () => {
    const { mounted, draws } = await mountWithCards();
    try {
      const sent = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "finish",
          payload: {
            type: "secret-request",
            prompt: "Your shop password",
            secretName: "Shop login",
            origin: "https://shop.example/login",
            payment: false,
          },
        }),
      );
      expect(sent).toMatchObject({ isError: false, endsTurn: true });
      // The installed apps decode this payload with exact keys, so the log
      // carries exactly the three it always has.
      const send = mounted.session.activeRunJournal.find(
        (event) => event.type === "send/to-user",
      );
      expect(send?.type === "send/to-user" && send.payload).toEqual({
        type: "secret-request",
        prompt: "Your shop password",
        secretName: "Shop login",
      });
      expect(draws).toHaveLength(1);
      expect(draws[0]).toMatchObject({
        pluginId: "credentials",
        cardId: "request",
        data: {
          prompt: "Your shop password",
          secretName: "Shop login",
          origin: "https://shop.example",
          payment: false,
        },
        secretRequest: {
          label: "Shop login",
          origin: "https://shop.example",
          payment: false,
        },
      });
    } finally {
      await mounted.dispose();
    }
  });

  test("refuses a site that is not an https address", async () => {
    const { mounted, draws } = await mountWithCards();
    try {
      const refused = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "finish",
          payload: {
            type: "secret-request",
            prompt: "Your password",
            secretName: "Login",
            origin: "http://shop.example",
          },
        }),
      );
      expect(refused.isError).toBe(true);
      expect(draws).toHaveLength(0);
    } finally {
      await mounted.dispose();
    }
  });

  test("a card the Bot writes may not carry the field a secret is typed into", async () => {
    const { mounted } = await mountWithCards();
    try {
      const refused = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "finish",
          payload: {
            type: "card",
            surfaceId: "login-card",
            messages: [
              {
                version: "v1.0",
                createSurface: {
                  surfaceId: "login-card",
                  components: [
                    { id: "root", component: "Column", children: ["field"] },
                    {
                      id: "field",
                      component: "SecretField",
                      requestId: `secret-request-${"0".repeat(32)}`,
                    },
                  ],
                },
              },
            ],
          },
        }),
      );
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("secret-request");
      expect(
        mounted.session.activeRunJournal.filter(
          (event) => event.type === "send/to-user",
        ),
      ).toHaveLength(0);
    } finally {
      await mounted.dispose();
    }
  });
});

// The prompt and runtime agree: private text is never a delivery.
describe("the acknowledgement reaches the user", () => {
  test("the prompt names the call, not just the line", () => {
    expect(CONVERSATION_PROMPT_TEXT_V1).toContain(
      "Your own text is not shown to the user",
    );
    expect(CONVERSATION_PROMPT_TEXT_V1).toContain(
      "your first action is a `send_to_user` call",
    );
  });

  test("assistant text in a tool-calling step is never promoted to a send", async () => {
    const mounted = await mount();
    try {
      await mounted.root.hooks.assistantText(
        { session: mounted.session } as never,
        "On it — building the 2027 countdown applet now.",
        { turn: 4, step: 2, requestId: "request-1" },
      );

      const sends = mounted.session.activeRunJournal.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(0);
    } finally {
      await mounted.dispose();
    }
  });

  test("a step that is about to call send_to_user is not promoted", async () => {
    const mounted = await mount();
    try {
      // Bob on production, 2026-09-04: the model wrote the acknowledgement as
      // plain text and passed the same line to `send_to_user` in one step, and
      // the person saw two identical bubbles.
      await mounted.root.hooks.assistantText(
        { session: mounted.session } as never,
        "On it — building your to-do applet now.",
        {
          turn: 3,
          step: 1,
          requestId: "request-1",
          toolNames: [SEND_TO_USER_TOOL_V1, "applet_create"],
        },
      );
      await mounted.root.hooks.assistantText(
        { session: mounted.session } as never,
        "Sending it another way.",
        {
          turn: 3,
          step: 2,
          requestId: "request-2",
          toolNames: [SEND_TO_USER_TOOL_V1],
        },
      );

      const sends = mounted.session.activeRunJournal.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(0);
    } finally {
      await mounted.dispose();
    }
  });

  test("the last steps of a reply tell the model to send a status", async () => {
    const warning = await budgetNote({ step: 61 });
    expect(warning).toContain("<step_budget>");
    expect(warning).toContain("3 steps left after this one");
    expect(warning).toContain(SEND_TO_USER_TOOL_V1);
    expect(await budgetNote({ step: 64 })).toContain(
      "This is the last step of this reply",
    );
    expect(await budgetNote({ step: 10 })).toBeUndefined();
    // Outside the loop there is no budget, so nothing is said.
    expect(await budgetNote({ step: 64, noBudget: true })).toBeUndefined();
  });

  test("the last two minutes of a Turn tell the model to send a status", async () => {
    expect(
      await budgetNote({ step: 1, remainingMs: TIME_BUDGET_WARNING_MS_V1 }),
    ).toBeUndefined();
    const warning = await budgetNote({
      step: 61,
      remainingMs: TIME_BUDGET_WARNING_MS_V1 - 1,
    });
    expect(warning).toContain("<time_budget>");
    expect(warning).toContain("fewer than 2 minutes left");
    expect(warning).toContain("Do not start new work");
    expect(warning!.indexOf("<time_budget>")).toBeGreaterThan(
      warning!.indexOf("<step_budget>"),
    );
  });

  test("a Turn's last steps leave the system prompt, the cached prefix, as it was", async () => {
    const mounted = await mount();
    try {
      const assemble = (current: number) =>
        mounted.root.systemPrompt.assemble({
          sessionId: "session-1",
          provider: "provider-1",
          model: "model-1",
          turnType: "chat",
          step: { current, max: 64 },
          deadline: { at: TURN_DEADLINE_MS_V1, now: TURN_DEADLINE_MS_V1 - 1 },
        });
      expect((await assemble(64)).text).toBe((await assemble(1)).text);
    } finally {
      await mounted.dispose();
    }
  });

  test("a step that already spoke is left alone, and a replay adds nothing", async () => {
    const mounted = await mount();
    try {
      await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
          disposition: "continue",
          payload: { type: "text", text: "On it." },
        }),
      );
      await mounted.root.hooks.assistantText(
        { session: mounted.session } as never,
        "On it — building the countdown applet now.",
        { turn: 4, step: 2, requestId: "request-1" },
      );
      // The same step replayed after an eviction promotes nothing new either.
      await mounted.root.hooks.assistantText(
        { session: mounted.session } as never,
        "On it — building the countdown applet now.",
        { turn: 4, step: 2, requestId: "request-1" },
      );

      const sends = mounted.session.activeRunJournal.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ payload: { text: "On it." } });
    } finally {
      await mounted.dispose();
    }
  });
});

test("a send without an explicit disposition is refused before delivery", async () => {
  const mounted = await mount();
  try {
    const result = await invoke(
      mounted,
      "chat",
      call(SEND_TO_USER_TOOL_V1, { payload: { type: "text", text: "Hi" } }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disposition");
    expect(
      mounted.session.activeRunJournal.some((e) => e.type === "send/to-user"),
    ).toBe(false);
  } finally {
    await mounted.dispose();
  }
});
