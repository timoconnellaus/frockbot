// A Group Chat end to end, through the gateway: the User starts a group of two
// Bots, mentions one, and that member's Turn runs in its own Bot object under
// the group's Session and its reply is posted to the group — and nowhere in
// the member's one-to-one chat.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  callsFrockbotTool,
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectJson,
  expectOkJson,
  flockRevision,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface GroupMessage {
  seq: number;
  author: { kind: "user" } | { kind: "bot"; botId: string };
  body:
    | { kind: "text"; text: string; mentions: Array<{ botId: string }> }
    | { kind: "event"; event: { type: string } };
}

async function messages(
  userId: string,
  groupId: string,
  after = 0,
): Promise<GroupMessage[]> {
  const page = (await expectJson(
    await asUser(userId, `/api/groups/${groupId}/messages?after=${after}`),
  )) as { messages: GroupMessage[] };
  return page.messages;
}

/** Waits for a member's reply, nudging the group's alarm when it is slow. */
async function replyFrom(
  userId: string,
  groupId: string,
  botId: string,
  after: number,
  text?: string,
): Promise<GroupMessage> {
  const deadline = Date.now() + 60_000;
  const group = env.GROUP_CHATS.get(
    env.GROUP_CHATS.idFromName(`${userId}:${groupId}`),
  );
  while (Date.now() < deadline) {
    const found = (await messages(userId, groupId, after)).find(
      (message) =>
        message.author.kind === "bot" &&
        message.author.botId === botId &&
        message.body.kind === "text" &&
        (text === undefined || message.body.text === text),
    );
    if (found) return found;
    await runDurableObjectAlarm(group);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${botId} did not reply in the group`);
}

describe("a Group Chat", () => {
  it("runs a mentioned member's Turn and posts its reply to the group only", async () => {
    const userId = freshUserId("group-chat");
    await provisionThroughGateway({ userId, botId: "general" });
    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-researcher",
      expectedRevision: await flockRevision(userId),
      botId: "researcher",
      name: "Researcher",
    });
    expect(created.status).toBe(201);

    const receipt = (await expectJson(
      await postAsUser(userId, "/api/groups", {
        type: "group/create",
        commandId: "create-trip",
        members: ["general", "researcher"],
        name: "Trip",
      }),
    )) as { groupId: string; status: string; group: { members: string[] } };
    expect(receipt.status).toBe("applied");
    const groupId = receipt.groupId;
    const list = (await expectJson(await asUser(userId, "/api/groups"))) as {
      groups: Array<{ groupId: string; name?: string }>;
    };
    expect(list.groups).toMatchObject([{ groupId, name: "Trip" }]);

    const [createdLine] = await messages(userId, groupId);
    expect(createdLine?.body).toMatchObject({
      kind: "event",
      event: { type: "created" },
    });

    const posted = (await expectJson(
      await postAsUser(userId, `/api/groups/${groupId}/messages`, {
        schemaVersion: 1,
        commandId: "ask-1",
        text: [
          "@Researcher find the flights",
          // The Researcher answers and hands the booking to General, whose
          // own scripted answer rides in that mention. Its `@` is escaped in
          // the JSON so the person's own message does not mention General.
          toolCallTriggerPrompt([
            "send_to_user",
            {
              disposition: "finish",
              payload: {
                type: "text",
                text: [
                  "Found three flights. @Integration Bot please book the first.",
                  toolCallTriggerPrompt([
                    "send_to_user",
                    {
                      disposition: "finish",
                      payload: { type: "text", text: "Booked." },
                    },
                  ]),
                ].join("\n"),
              },
            },
          ]).replace("@Integration Bot", "\\u0040Integration Bot"),
        ].join("\n"),
      }),
    )) as { message: GroupMessage };
    expect(posted.message.body).toMatchObject({
      kind: "text",
      mentions: [{ botId: "researcher" }],
    });

    const reply = await replyFrom(
      userId,
      groupId,
      "researcher",
      posted.message.seq,
    );
    expect(reply.body).toMatchObject({
      kind: "text",
      mentions: [{ botId: "general" }],
    });
    // Without Jev, a member's mention still runs, under the group's bound.
    // General reads the whole thread since it last took part, so the fake
    // model also finds the person's scripted line; its answer is the one
    // this looks for.
    const booked = await replyFrom(
      userId,
      groupId,
      "general",
      reply.seq,
      "Booked.",
    );
    expect(booked.body).toMatchObject({ kind: "text", text: "Booked." });

    // The member's one-to-one chat carries none of it.
    const oneToOne = (await expectJson(
      await asUser(userId, "/api/bots/researcher/turns"),
    )) as { runs: unknown[] };
    expect(oneToOne.runs).toEqual([]);

    const view = (await expectJson(
      await asUser(userId, `/api/groups/${groupId}`),
    )) as { head: number; unread: number; working: string[] };
    expect(view.unread).toBeGreaterThanOrEqual(2);
    const read = (await expectJson(
      await postAsUser(userId, `/api/groups/${groupId}/read`, {
        schemaVersion: 1,
        upTo: view.head,
      }),
    )) as { readThrough: number };
    expect(read.readThrough).toBe(view.head);

    // A group keeps at least two members.
    const refused = await postAsUser(
      userId,
      `/api/groups/${groupId}/commands`,
      {
        type: "group/remove-member",
        commandId: "remove-general",
        groupId,
        botId: "general",
      },
    );
    expect(refused.status).toBe(409);

    // A member writes into the group's Memory, which the User object keeps
    // and authorises by membership.
    const user = env.USER_CONFIGURATIONS.get(
      env.USER_CONFIGURATIONS.idFromName(userId),
    );
    const groupMemories = () =>
      runInDurableObject(
        user,
        (_instance, state) =>
          state.storage.sql
            .exec<{ n: number }>(
              "SELECT count(*) AS n FROM memory_item WHERE scope_key = ?",
              `groupChat:${userId}:${groupId}`,
            )
            .toArray()[0]!.n,
      );
    const remembered = (await runInDurableObject(user, (instance) =>
      (
        instance as unknown as {
          operateMemory(input: unknown): Promise<{ status: string }>;
        }
      ).operateMemory({
        schemaVersion: 1,
        userId,
        botId: "general",
        action: "write",
        request: {
          authority: {},
          scope: { kind: "groupChat", userId, groupChatId: groupId },
          content: "The trip is in October.",
          operationKey: "trip-1",
        },
      }),
    )) as { status: string };
    expect(remembered.status).toBe("ok");
    expect(await groupMemories()).toBe(1);

    const deleted = await postAsUser(
      userId,
      `/api/groups/${groupId}/commands`,
      {
        type: "group/delete",
        commandId: "delete-trip",
        groupId,
      },
    );
    expect(deleted.status).toBe(200);
    // Deleting the group deletes what was remembered in it.
    expect(await groupMemories()).toBe(0);
    expect((await asUser(userId, `/api/groups/${groupId}`)).status).toBe(404);
  });

  it("lets a Bot start a group from its own chat and post into it", async () => {
    const userId = freshUserId("group-chat-tools");
    await provisionThroughGateway({ userId, botId: "general" });
    expect(
      (
        await postAsUser(userId, "/api/bots", {
          schemaVersion: 1,
          type: "bot/create",
          commandId: "create-researcher",
          expectedRevision: await flockRevision(userId),
          botId: "researcher",
          name: "Researcher",
        })
      ).status,
    ).toBe(201);

    /** Runs one chat Turn of General's whose model calls `name(input)`. */
    async function called(commandId: string, name: string, input: unknown) {
      const turn = (await expectOkJson(
        await postAsUser(userId, "/api/bots/general/turns", {
          schemaVersion: 1,
          commandId,
          text: frockbotToolCallPrompt(name, input),
        }),
      )) as {
        events: Array<{
          type: string;
          call?: { id: string };
          callId?: string;
          content?: string;
          isError?: boolean;
        }>;
      };
      const call = turn.events.find((event) => callsFrockbotTool(event, name));
      const result = turn.events.find(
        (event) =>
          event.type === "tool/result" && event.callId === call?.call?.id,
      );
      expect(result?.isError, result?.content).toBe(false);
      return result!.content!;
    }

    await called("start-trip", "group_create", {
      members: ["Researcher"],
      name: "Trip",
    });
    const list = (await expectJson(await asUser(userId, "/api/groups"))) as {
      groups: Array<{ groupId: string; name?: string; members: string[] }>;
    };
    expect(list.groups).toMatchObject([
      { name: "Trip", members: ["general", "researcher"] },
    ]);
    const groupId = list.groups[0]!.groupId;

    expect(await called("list-groups", "group_list", {})).toContain(
      `Trip (${groupId})`,
    );
    await called("post-trip", "group_post", {
      group_id: groupId,
      text: "Flights are booked for Friday.",
    });
    const posted = (await messages(userId, groupId)).filter(
      (message) =>
        message.author.kind === "bot" && message.body.kind === "text",
    );
    expect(posted).toMatchObject([
      {
        author: { kind: "bot", botId: "general" },
        body: { kind: "text", text: "Flights are booked for Friday." },
      },
    ]);
  });

  it("refuses a group of Bots the User does not have", async () => {
    const userId = freshUserId("group-chat-stranger");
    await provisionThroughGateway({ userId, botId: "general" });
    const refused = await postAsUser(userId, "/api/groups", {
      type: "group/create",
      commandId: "create-bad",
      members: ["general", "stranger"],
    });
    expect(refused.status).toBe(409);
    const malformed = await postAsUser(userId, "/api/groups", {
      type: "group/create",
      commandId: "create-bad-2",
      members: ["general"],
    });
    expect(malformed.status).toBe(400);
  });
});
