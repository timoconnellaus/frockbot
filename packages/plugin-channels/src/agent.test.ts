// The three tools, mounted on a real tool registry.
//
// The claim that matters most here is the trimming: `send_to_agent`,
// `react_to_message` and `channel_manage` exist on a `chat` Turn and on a
// `channel` Turn, and on an `automation` or `subagent` Turn they are not in the
// catalog and a call naming one is denied. That is register `:419`/`:444`
// exactly, and decision 3 of the plan — a Routine that must reach another Bot
// hands off, and the chat Turn posts.
import { describe, expect, test } from "bun:test";
import {
  SessionStore,
  type ToolCall,
  type ToolExecutionContext,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import {
  channelAdmissionCeilingV1,
  channelManageCommandV1,
  channelToolCommandIdV1,
  createChannelsRuntimePlugin,
  CHANNEL_MANAGE_TOOL_V1,
  REACT_TO_MESSAGE_TOOL_V1,
  SEND_TO_AGENT_TOOL_V1,
} from "./agent.js";
import { CHANNEL_HOP_MAX, pairChannelIdV1 } from "./records.js";
import { ChannelStore } from "./store.js";
import { createMemoryChannelStorageV1 } from "./testing.js";
import type { ChannelsRuntimeHostV1 } from "./agent-host.js";
import {
  CHANNELS_SECTION_ID,
  TEAMMATES_SECTION_ID,
  renderChannelsSectionV1,
  renderTeammatesSectionV1,
} from "./prompt.js";

const SESSION_ID = "tim:alpha";

const WRITER = { sessionId: SESSION_ID, turnId: "turn-4", runId: "run-9" };

const DIRECTORY = [
  { botId: "alpha", name: "Alpha" },
  { botId: "beta", name: "Beta", description: "Reads the mail" },
];

function seam(
  context: Partial<ChannelsRuntimeHostV1> = {},
): ChannelsRuntimeHostV1 & { store: ChannelStore } {
  const store = new ChannelStore(createMemoryChannelStorageV1());
  return {
    botId: "alpha",
    writer: WRITER,
    store,
    list: () => store.list("alpha"),
    directory: () => Promise.resolve(DIRECTORY),
    execute: (command, writer) => store.execute(command, writer),
    ...context,
  };
}

interface Mounted {
  root: Context;
  host: ChannelsRuntimeHostV1 & { store: ChannelStore };
  dispose(): Promise<void>;
}

async function mount(
  context: Partial<ChannelsRuntimeHostV1> = {},
): Promise<Mounted> {
  const root = new Context();
  await root.plugin(SessionStore);
  await root.plugin(SystemPromptRegistry);
  await root.plugin(ToolRegistry);
  const host = seam(context);
  await root.plugin(createChannelsRuntimePlugin(host));
  return { root, host, dispose: () => root.fiber.dispose() };
}

let step = 0;

/**
 * One tool call's context. The effect id advances per call, exactly as it does
 * in a real Turn: the command id is derived from it, so two calls in one test
 * must not collide on one durable receipt.
 */
function contextFor(turnType: TurnTypeV1): ToolExecutionContext {
  step += 1;
  return {
    botId: "alpha",
    agentId: "alpha",
    sessionId: SESSION_ID,
    compositionGenerationId: "2026-09-01T00:00:00.000Z:0123456789abcdef",
    turnType,
    effectId: `tool:4:${step}:0`,
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

function names(mounted: Mounted, turnType: TurnTypeV1): string[] {
  return mounted.root.tools.schemas({ turnType }).map((schema) => schema.name);
}

describe("per-turn-type admission", () => {
  test("the manifest ceiling is chat and channel, and nothing else", () => {
    expect(channelAdmissionCeilingV1()).toEqual(["chat", "channel"]);
  });

  test("all three tools are offered on chat and on channel turns", async () => {
    const mounted = await mount();
    try {
      for (const turnType of ["chat", "channel"] as const) {
        expect(names(mounted, turnType).sort()).toEqual([
          CHANNEL_MANAGE_TOOL_V1,
          REACT_TO_MESSAGE_TOOL_V1,
          SEND_TO_AGENT_TOOL_V1,
        ]);
      }
    } finally {
      await mounted.dispose();
    }
  });

  test("none of them is offered on an automation or subagent turn", async () => {
    const mounted = await mount();
    try {
      expect(names(mounted, "automation")).toEqual([]);
      expect(names(mounted, "subagent")).toEqual([]);
      const denied = await invoke(
        mounted,
        "automation",
        call(SEND_TO_AGENT_TOOL_V1, { botId: "beta", text: "hi" }),
      );
      expect(denied).toMatchObject({ isError: true });
      expect(denied.content).toContain(SEND_TO_AGENT_TOOL_V1);
      // Nothing was written: the denial is before the tool, not inside it.
      expect((await mounted.host.list()).channels).toEqual([]);
    } finally {
      await mounted.dispose();
    }
  });
});

describe("send_to_agent", () => {
  test("a bare botId opens and posts to the implicit pair channel", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_TO_AGENT_TOOL_V1, { botId: "beta", text: "morning" }),
      );
      expect(result.isError).toBe(false);
      const channelId = pairChannelIdV1("alpha", "beta");
      expect(result.content).toContain(channelId);
      const thread = await mounted.host.store.thread(channelId);
      expect(thread.messages).toMatchObject([
        { text: "morning", senderBotId: "alpha", hop: 1 },
      ]);
      // The sender is not owed its own post.
      expect(
        await mounted.host.store.deliveries(thread.messages[0]!.messageId),
      ).toMatchObject([{ botId: "beta", state: "pending" }]);
    } finally {
      await mounted.dispose();
    }
  });

  test("a post from a channel Turn is one hop further than the message it answers", async () => {
    const mounted = await mount({
      turnType: "channel",
      origin: { channelId: "room", hop: CHANNEL_HOP_MAX - 1 },
    });
    try {
      await mounted.host.execute(
        {
          schemaVersion: 1,
          type: "channel/create",
          commandId: "open",
          botId: "alpha",
          channelId: "room",
          name: "The room",
          members: ["alpha", "beta"],
        },
        { kind: "user" },
      );
      const result = await invoke(
        mounted,
        "channel",
        call(SEND_TO_AGENT_TOOL_V1, { channelId: "room", text: "reply" }),
      );
      expect(result.isError).toBe(false);
      expect((await mounted.host.store.thread("room")).messages).toMatchObject([
        { hop: CHANNEL_HOP_MAX },
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  test("the last hop is refused, visibly, and writes nothing", async () => {
    const mounted = await mount({
      turnType: "channel",
      origin: { channelId: "room", hop: CHANNEL_HOP_MAX },
    });
    try {
      await mounted.host.execute(
        {
          schemaVersion: 1,
          type: "channel/create",
          commandId: "open",
          botId: "alpha",
          channelId: "room",
          name: "The room",
          members: ["alpha", "beta"],
        },
        { kind: "user" },
      );
      const result = await invoke(
        mounted,
        "channel",
        call(SEND_TO_AGENT_TOOL_V1, { channelId: "room", text: "and again" }),
      );
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain("hops");
      expect((await mounted.host.store.thread("room")).messages).toEqual([]);
    } finally {
      await mounted.dispose();
    }
  });

  test("naming both a botId and a channelId is refused", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_TO_AGENT_TOOL_V1, {
          botId: "beta",
          channelId: "room",
          text: "which?",
        }),
      );
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain("exactly one");
    } finally {
      await mounted.dispose();
    }
  });

  test("a Bot that is not a member is refused", async () => {
    const mounted = await mount();
    try {
      await mounted.host.execute(
        {
          schemaVersion: 1,
          type: "channel/create",
          commandId: "open",
          botId: "beta",
          channelId: "room",
          name: "Not yours",
          members: ["beta", "gamma"],
        },
        { kind: "user" },
      );
      const result = await invoke(
        mounted,
        "chat",
        call(SEND_TO_AGENT_TOOL_V1, { channelId: "room", text: "hello?" }),
      );
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain("not a member");
    } finally {
      await mounted.dispose();
    }
  });
});

describe("react_to_message", () => {
  test("is idempotent and says so", async () => {
    const mounted = await mount();
    try {
      await invoke(
        mounted,
        "chat",
        call(SEND_TO_AGENT_TOOL_V1, { botId: "beta", text: "morning" }),
      );
      const channelId = pairChannelIdV1("alpha", "beta");
      const messageId = (await mounted.host.store.thread(channelId))
        .messages[0]!.messageId;
      const react = () =>
        mounted.host.execute(
          {
            schemaVersion: 1,
            type: "channel/react",
            commandId: `r-${Math.random()}`,
            botId: "alpha",
            channelId,
            messageId,
            emoji: "👍",
          },
          { kind: "user" },
        );
      expect(await react()).toMatchObject({ added: true });
      expect(await react()).toMatchObject({ added: false });
    } finally {
      await mounted.dispose();
    }
  });

  test("the tool reaches the same command path", async () => {
    const mounted = await mount();
    try {
      await invoke(
        mounted,
        "chat",
        call(SEND_TO_AGENT_TOOL_V1, { botId: "beta", text: "morning" }),
      );
      const channelId = pairChannelIdV1("alpha", "beta");
      const messageId = (await mounted.host.store.thread(channelId))
        .messages[0]!.messageId;
      const result = await invoke(
        mounted,
        "channel",
        call(REACT_TO_MESSAGE_TOOL_V1, {
          channelId,
          messageId,
          emoji: "🎉",
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Nobody was woken");
    } finally {
      await mounted.dispose();
    }
  });
});

describe("channel_manage", () => {
  test("creates a channel with the members it names", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(CHANNEL_MANAGE_TOOL_V1, {
          action: "create",
          channelId: "standup",
          name: "Standup",
          memberIds: ["alpha", "beta"],
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("You are a member");
      expect((await mounted.host.list()).channels).toMatchObject([
        { channelId: "standup", members: ["alpha", "beta"], active: true },
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  test("a create that leaves the caller out says so", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(
        mounted,
        "chat",
        call(CHANNEL_MANAGE_TOOL_V1, {
          action: "create",
          channelId: "theirs",
          name: "Theirs",
          memberIds: ["beta"],
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("not a member");
    } finally {
      await mounted.dispose();
    }
  });

  test("disconnect keeps the record and closes the room", async () => {
    const mounted = await mount();
    try {
      await invoke(
        mounted,
        "chat",
        call(CHANNEL_MANAGE_TOOL_V1, {
          action: "create",
          channelId: "standup",
          name: "Standup",
          memberIds: ["alpha", "beta"],
        }),
      );
      const result = await invoke(
        mounted,
        "chat",
        call(CHANNEL_MANAGE_TOOL_V1, {
          action: "disconnect",
          channelId: "standup",
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("disconnected");
      expect(await mounted.host.store.read("standup")).toMatchObject({
        active: false,
      });
    } finally {
      await mounted.dispose();
    }
  });

  test("translates one call into one command", () => {
    expect(
      channelManageCommandV1(
        {
          action: "update",
          channelId: "standup",
          addMemberIds: ["gamma"],
        },
        { botId: "alpha", commandId: "cx-1" },
      ),
    ).toEqual({
      schemaVersion: 1,
      type: "channel/update",
      commandId: "cx-1",
      botId: "alpha",
      channelId: "standup",
      addMemberIds: ["gamma"],
    });
    expect(() =>
      channelManageCommandV1(
        { action: "explode" },
        { botId: "alpha", commandId: "cx-1" },
      ),
    ).toThrow(/action is unknown/);
  });

  test("the command id names the Bot, the run, and the effect", () => {
    const scope = { botId: "alpha", runId: "run-9" };
    expect(channelToolCommandIdV1(scope, "tool:4:2:0")).toBe(
      "cx-alpha-run-9-tool-4-2-0",
    );
    // Stable for one effect, and distinct across Bots: the receipts live in
    // the User Durable Object, where an effect id alone is not unique.
    expect(channelToolCommandIdV1(scope, "tool:4:2:0")).toBe(
      channelToolCommandIdV1(scope, "tool:4:2:0"),
    );
    expect(
      channelToolCommandIdV1({ botId: "beta", runId: "run-9" }, "tool:4:2:0"),
    ).not.toBe(channelToolCommandIdV1(scope, "tool:4:2:0"));
  });
});

describe("prompt sections", () => {
  test("are registered on a chat Turn and on a channel Turn", async () => {
    for (const turnType of ["chat", "channel"] as const) {
      const mounted = await mount({ turnType });
      try {
        const assembly = await mounted.root.systemPrompt.assemble({
          sessionId: SESSION_ID,
          provider: "test",
          model: "test",
          turnType,
        });
        const ids = assembly.sections.map((section) => section.id);
        expect(ids).toContain(TEAMMATES_SECTION_ID);
        expect(ids).toContain(CHANNELS_SECTION_ID);
        expect(assembly.text).toContain("beta: Beta");
      } finally {
        await mounted.dispose();
      }
    }
  });

  test("are skipped on an automation or subagent Turn", async () => {
    for (const turnType of ["automation", "subagent"] as const) {
      const mounted = await mount({ turnType });
      try {
        const assembly = await mounted.root.systemPrompt.assemble({
          sessionId: SESSION_ID,
          provider: "test",
          model: "test",
          turnType,
        });
        expect(assembly.sections.map((section) => section.id)).toEqual([]);
      } finally {
        await mounted.dispose();
      }
    }
  });

  test("render the directory and the rooms, and never the Bot itself", () => {
    expect(
      renderTeammatesSectionV1({ selfBotId: "alpha", bots: DIRECTORY }),
    ).toBe(
      [
        "<teammates>",
        "The other Bots in your user's flock. Reach one with `send_to_agent`, naming its id.",
        "- beta: Beta — Reads the mail",
        "</teammates>",
      ].join("\n"),
    );
    expect(
      renderTeammatesSectionV1({
        selfBotId: "alpha",
        bots: [{ botId: "alpha", name: "Alpha" }],
      }),
    ).toContain("only Bot in this flock");
    expect(
      renderChannelsSectionV1({
        selfBotId: "alpha",
        channels: [
          {
            schemaVersion: 1,
            channelId: "standup",
            kind: "group",
            name: "Standup",
            members: ["alpha", "beta"],
            revision: 1,
            active: true,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
          {
            schemaVersion: 1,
            channelId: "closed",
            kind: "group",
            name: "Closed",
            members: ["alpha"],
            revision: 2,
            active: false,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(
      [
        "<channels>",
        "The channels you are a member of. Post to one with `send_to_agent`, naming its id.",
        '- standup: "Standup" with beta',
        "</channels>",
      ].join("\n"),
    );
  });
});
