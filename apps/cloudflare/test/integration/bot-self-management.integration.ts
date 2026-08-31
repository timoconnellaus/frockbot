// Slice C end to end: a Bot changing itself, and a Bot adding a Bot to its
// User's flock, driven the way production drives them — by a model that
// answers with a tool call.
//
// Nothing here calls a tool directly. The stubbed Ollama Cloud endpoint returns
// a `tool_calls` stream when the turn's user message carries
// {@link TOOL_CALL_TRIGGER}, so the Agent loop inside the Bot Durable Object
// prepares, admits, journals, and executes the call exactly as it would for a
// real model, and every assertion afterwards is a request a browser makes.
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface ClientTurn {
  runId: string;
  events: Array<
    | { type: "tool/call"; call: { id: string; name: string } }
    | { type: "tool/result"; callId: string; content: string; isError: boolean }
    | { type: "run/events-truncated"; omittedInteractions: number }
  >;
}

interface Identity {
  botId: string;
  name: string;
  namedBy: string;
  hiddenFromSidebar: boolean;
  title?: string;
}

/** Runs one chat Turn whose model answers with `name(input)`. */
async function turnCalling(
  userId: string,
  botId: string,
  commandId: string,
  name: string,
  input: unknown,
): Promise<ClientTurn> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: `${TOOL_CALL_TRIGGER}${name}:${JSON.stringify(input)}`,
    }),
  )) as ClientTurn;
}

async function identities(userId: string): Promise<Identity[]> {
  const directory = (await expectOkJson(
    await asUser(userId, "/api/bots/identities"),
  )) as { identities: Identity[] };
  return directory.identities;
}

/** The tool result of a Turn, asserting the loop actually ran the tool. */
function toolResult(turn: ClientTurn, name: string): string {
  const call = turn.events.find(
    (event) => event.type === "tool/call" && event.call.name === name,
  );
  expect(call, `the Turn made no ${name} call`).toBeDefined();
  const callId = (call as { call: { id: string } }).call.id;
  const result = turn.events.find(
    (event) => event.type === "tool/result" && event.callId === callId,
  ) as { content: string; isError: boolean } | undefined;
  expect(result, `the ${name} call produced no result`).toBeDefined();
  expect(result!.isError, result!.content).toBe(false);
  return result!.content;
}

describe("Bot self-management through the gateway", () => {
  it("renames and retitles itself, and the change reaches the directory and the Session", async () => {
    const userId = freshUserId("bot-self-update");
    const botId = "self-managing-bot";
    await provisionThroughGateway({ userId, botId });

    const turn = await turnCalling(
      userId,
      botId,
      "self-update-1",
      "bot_update",
      {
        name: "Atlas",
        title: "Chief of staff",
      },
    );

    toolResult(turn, "bot_update");

    const directory = await identities(userId);
    expect(directory).toContainEqual(
      expect.objectContaining({
        botId,
        name: "Atlas",
        title: "Chief of staff",
        // The provenance says the Bot renamed itself, not its User.
        namedBy: "bot",
      }),
    );

    // The rename is durable conversational history, so it rides the run list.
    const runs = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as {
      announcements?: Array<{
        type: string;
        from: string;
        to: string;
        namedBy: string;
      }>;
    };
    expect(runs.announcements).toContainEqual(
      expect.objectContaining({
        type: "bot/renamed",
        to: "Atlas",
        namedBy: "bot",
      }),
    );
  });

  it("adds a Bot to its User's flock, and only the fields it named change", async () => {
    const userId = freshUserId("bot-self-create");
    const botId = "founder-bot";
    await provisionThroughGateway({ userId, botId });

    const before = (await expectOkJson(await asUser(userId, "/api/bots"))) as {
      revision: number;
      bots: Array<{ botId: string }>;
    };
    expect(before.bots).toHaveLength(1);

    const created = await turnCalling(
      userId,
      botId,
      "self-create-1",
      "bot_create",
      { name: "Budget", description: "Watches the money." },
    );
    toolResult(created, "bot_create");

    const after = (await expectOkJson(await asUser(userId, "/api/bots"))) as {
      bots: Array<{
        botId: string;
        initialName: string;
        initialDescription?: string;
        initialModel?: unknown;
        createdBy?: { kind: string; botId: string };
      }>;
    };
    expect(after.bots).toHaveLength(2);
    const budget = after.bots.find((bot) => bot.initialName === "Budget")!;
    expect(budget.initialDescription).toBe("Watches the money.");
    // "Self-modification never widens authority": the new Bot gets no model of
    // its own, only its User's default, exactly as a sidebar create does.
    expect(budget.initialModel).toBeUndefined();
    expect(budget.createdBy).toMatchObject({ kind: "bot", botId });

    // The creating Bot's own identity is untouched by the create.
    const founder = (await identities(userId)).find(
      (identity) => identity.botId === botId,
    )!;
    expect(founder.namedBy).toBe("user");
    expect(founder.title).toBeUndefined();
  });
});
