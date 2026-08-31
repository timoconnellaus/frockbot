// The Bot's own export tool: what it admits, what it stages, and what it says.
import { describe, expect, it } from "bun:test";
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
  BOT_EXPORT_TEMPLATE_TOOL_V1,
  createBotTemplateRuntimePlugin,
  stageCommandIdV1,
} from "./agent.ts";
import type { TemplateShareReceiptV1 } from "./shared.ts";

const SESSION_ID = "user-1:budget";
const SHARE_ID = `user-1.${"a".repeat(32)}`;

function receipt(commandId: string): TemplateShareReceiptV1 {
  return {
    schemaVersion: 1,
    commandId,
    status: "applied",
    share: {
      schemaVersion: 1,
      shareId: SHARE_ID,
      hash: "b".repeat(64),
      botId: "budget",
      visibility: "private",
      createdAt: "2026-08-31T00:00:00.000Z",
    },
    summary: {
      schemaVersion: 1,
      botId: "budget",
      skills: 2,
      routines: 1,
      packages: 0,
      publicServers: 0,
      needsConnection: 1,
      omitted: [{ reason: "memory", count: 1 }],
    },
  };
}

async function mount(
  stage: (input: {
    commandId: string;
    botId: string;
  }) => Promise<TemplateShareReceiptV1> = (input) =>
    Promise.resolve(receipt(input.commandId)),
) {
  const root = new Context();
  await root.plugin(SessionStore);
  await root.plugin(ToolRegistry);
  const session: Session = root.sessions.create(SESSION_ID);
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 0 },
  ]);
  await root.plugin(
    createBotTemplateRuntimePlugin({
      owner: { userId: "user-1", botId: "budget" },
      stageTemplate: stage,
    }),
  );
  return { root, session, dispose: () => root.fiber.dispose() };
}

function contextFor(turnType: TurnTypeV1): ToolExecutionContext {
  return {
    botId: "budget",
    agentId: "budget",
    sessionId: SESSION_ID,
    compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
    turnType,
    effectId: "tool:1:0:0",
    signal: new AbortController().signal,
  };
}

const call: ToolCall = {
  id: "call-1",
  name: BOT_EXPORT_TEMPLATE_TOOL_V1,
  input: {},
};

async function invoke(
  mounted: Awaited<ReturnType<typeof mount>>,
  turnType: TurnTypeV1,
) {
  const context = contextFor(turnType);
  const preparation = await mounted.root.tools.prepare(call, context);
  if (preparation.kind === "denied") return preparation.result;
  return mounted.root.tools.executePrepared(preparation, context);
}

describe("bot_export_template", () => {
  it("is offered on chat turns only", async () => {
    const mounted = await mount();
    try {
      const names = (turnType: TurnTypeV1) =>
        mounted.root.tools.schemas({ turnType }).map((tool) => tool.name);
      expect(names("chat")).toContain(BOT_EXPORT_TEMPLATE_TOOL_V1);
      for (const turnType of ["automation", "subagent", "channel"] as const) {
        expect(names(turnType)).not.toContain(BOT_EXPORT_TEMPLATE_TOOL_V1);
      }
    } finally {
      await mounted.dispose();
    }
  });

  it("declares itself idempotent", async () => {
    const mounted = await mount();
    try {
      const preparation = await mounted.root.tools.prepare(
        call,
        contextFor("chat"),
      );
      expect(preparation.kind).toBe("ready");
      if (preparation.kind === "ready") {
        expect(preparation.idempotent).toBe(true);
      }
    } finally {
      await mounted.dispose();
    }
  });

  it("stages with a command id derived from the occurrence", async () => {
    const staged: string[] = [];
    const mounted = await mount((input) => {
      staged.push(input.commandId);
      return Promise.resolve(receipt(input.commandId));
    });
    try {
      await invoke(mounted, "chat");
      await invoke(mounted, "chat");
      expect(staged).toEqual([
        stageCommandIdV1("tool:1:0:0"),
        stageCommandIdV1("tool:1:0:0"),
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  it("records an agent-card naming what was packed and scrubbed", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(mounted, "chat");
      expect(result.isError).toBe(false);
      expect(result.content).toContain(SHARE_ID);
      const sends = mounted.session.events.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(1);
      const payload = (sends[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload.type).toBe("agent-card");
      expect(payload.title).toBe("Bot template staged");
      expect(String(payload.body)).toContain("Memory");
      expect(String(payload.body)).toContain(
        "Nothing is shared until you choose",
      );
    } finally {
      await mounted.dispose();
    }
  });

  it("never leaves the Turn, so the card is not the last word", async () => {
    const mounted = await mount();
    try {
      const result = await invoke(mounted, "chat");
      expect(result.endsTurn).toBeUndefined();
    } finally {
      await mounted.dispose();
    }
  });

  it("reports a staging failure as a refusal, not a throw", async () => {
    const mounted = await mount(() =>
      Promise.reject(new Error("the User authority is unavailable")),
    );
    try {
      const result = await invoke(mounted, "chat");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("the User authority is unavailable");
    } finally {
      await mounted.dispose();
    }
  });
});
