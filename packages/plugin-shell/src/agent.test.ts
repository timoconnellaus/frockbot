// The Shell's runtime Contribution: what it admits, what it records, and what
// ends a Turn.
import { describe, expect, test } from "bun:test";
import {
  SessionStore,
  type Session,
  type ToolCall,
  type ToolExecutionContext,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import {
  shellAdmissionCeilingV1,
  shellAgentPlugin,
  PARENT_HANDOFF_CAPABILITY_V1,
  SEND_MESSAGE_ALIAS_V1,
  SEND_TO_USER_TOOL_V1,
  USER_VOICE_CAPABILITY_V1,
  WAKE_PARENT_TOOL_V1,
} from "./agent.ts";

const SESSION_ID = "user-1:bot-1";

interface Mounted {
  root: Context;
  session: Session;
  dispose(): Promise<void>;
}

async function mount(): Promise<Mounted> {
  const root = new Context();
  await root.plugin(SessionStore);
  await root.plugin(ToolRegistry);
  const session = root.sessions.create(SESSION_ID);
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  await root.plugin(shellAgentPlugin);
  return { root, session, dispose: () => root.fiber.dispose() };
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
  const context = contextFor(turnType);
  const preparation = await mounted.root.tools.prepare(toolCall, context);
  if (preparation.kind === "denied") return preparation.result;
  return mounted.root.tools.executePrepared(preparation, context);
}

describe("the Shell's tool admission", () => {
  test("offers the send tool and its alias on chat and channel turns only", async () => {
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

      expect(chat).toContain(SEND_TO_USER_TOOL_V1);
      expect(chat).toContain(SEND_MESSAGE_ALIAS_V1);
      expect(chat).not.toContain(WAKE_PARENT_TOOL_V1);
      expect(automation).toEqual([WAKE_PARENT_TOOL_V1]);
      expect(subagent).toEqual([WAKE_PARENT_TOOL_V1]);
      // A `channel` Turn has the Bot's voice and nothing else. In an external
      // Channel that voice is carried to the remote platform by the connector;
      // in a group Channel it is recorded and reaches nobody. Nothing hands off
      // from a Channel Turn either way.
      const channel = mounted.root.tools
        .schemas({ turnType: "channel" })
        .map((tool: { name: string }) => tool.name);
      expect(channel).toContain(SEND_TO_USER_TOOL_V1);
      expect(channel).toContain(SEND_MESSAGE_ALIAS_V1);
      expect(channel).not.toContain(WAKE_PARENT_TOOL_V1);
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
        expect(names).not.toContain(SEND_MESSAGE_ALIAS_V1);
        expect(names).toEqual([WAKE_PARENT_TOOL_V1]);
      }
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
        mounted.session.events.some((event) => event.type === "wake/parent"),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("denies send_to_user and its alias on an automation turn", async () => {
    const mounted = await mount();
    try {
      for (const name of [SEND_TO_USER_TOOL_V1, SEND_MESSAGE_ALIAS_V1]) {
        const result = await invoke(
          mounted,
          "automation",
          call(name, { payload: { type: "text", text: "hi" } }),
        );

        expect(result).toEqual({
          content: `Tool is not available on a automation turn: ${name}`,
          isError: true,
        });
      }
      expect(
        mounted.session.events.some((event) => event.type === "send/to-user"),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("bounds each tool by the turn types its manifest Capability declares", () => {
    expect(shellAdmissionCeilingV1(USER_VOICE_CAPABILITY_V1)).toEqual([
      "chat",
      "channel",
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
          payload: { type: "text", text: "Booked for Tuesday." },
        }),
      );

      expect(result.isError).toBe(false);
      expect(result.endsTurn).toBeUndefined();
      expect(
        mounted.session.events.find((event) => event.type === "send/to-user"),
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

  test("ends the Turn on a widget and an approval, and on nothing else", async () => {
    const mounted = await mount();
    try {
      const widget = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
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
          payload: { type: "text", text: "On it." },
        }),
      );
      const secret = await invoke(
        mounted,
        "chat",
        call(SEND_TO_USER_TOOL_V1, {
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
          payload: { type: "agent-card", agentId: "bot-2", title: "School" },
        }),
      );

      expect(widget.endsTurn).toBe(true);
      expect(approval.endsTurn).toBe(true);
      expect(attachment.endsTurn).toBeUndefined();
      expect(text.endsTurn).toBeUndefined();
      expect(secret.endsTurn).toBeUndefined();
      expect(card.endsTurn).toBeUndefined();
      expect(
        mounted.session.events
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
        call(SEND_TO_USER_TOOL_V1, { payload: { type: "shout", text: "hi" } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("send_to_user.payload.type is invalid");
      expect(result.endsTurn).toBeUndefined();
      expect(
        mounted.session.events.some((event) => event.type === "send/to-user"),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });

  test("records the alias under its own name and the same event", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_MESSAGE_ALIAS_V1, {
          payload: { type: "text", text: "Legacy." },
        }),
      );

      expect(result.isError).toBe(false);
      expect(
        mounted.session.events.find((event) => event.type === "send/to-user"),
      ).toMatchObject({ payload: { type: "text", text: "Legacy." } });
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
        mounted.session.events.find((event) => event.type === "wake/parent"),
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
        mounted.session.events.some((event) => event.type === "wake/parent"),
      ).toBe(false);
    } finally {
      await mounted.dispose();
    }
  });
});
