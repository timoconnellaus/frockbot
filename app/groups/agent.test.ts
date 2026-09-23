import { describe, expect, test } from "bun:test";
import type { ToolExecutionContext } from "@frockbot/core/contracts";
import {
  createGroupArchiveTool,
  createGroupChatsPromptSectionV1,
  createGroupCreateTool,
  createGroupListTool,
  createGroupPostTool,
  createGroupUpdateTool,
  type GroupChatsRuntimeHostV1,
} from "./agent.js";
import type { GroupChatReceiptV1, GroupChatRecordV1 } from "./shared.js";

const GROUP_ID = "g-0123456789abcdef0123";

const group: GroupChatRecordV1 = {
  schemaVersion: 1,
  groupId: GROUP_ID,
  name: "Books",
  members: ["general", "xero"],
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

function fakeHost() {
  const calls: Array<{ command: unknown; key: string }> = [];
  const posts: Array<{ groupId: string; text: string; key: string }> = [];
  const host: GroupChatsRuntimeHostV1 = {
    botId: "general",
    directory: async () => [
      { botId: "general", name: "General" },
      { botId: "xero", name: "Xero Books" },
      { botId: "codex", name: "Codex" },
    ],
    list: async () => [
      {
        group,
        members: [
          { botId: "general", name: "General" },
          { botId: "xero", name: "Xero Books" },
        ],
      },
    ],
    execute: async (command, key) => {
      calls.push({ command, key });
      return {
        schemaVersion: 1,
        commandId: key,
        groupId: GROUP_ID,
        status: "applied",
        group: { ...group, members: ["general", "xero", "codex"] },
        revision: 2,
      } satisfies GroupChatReceiptV1;
    },
    post: async (groupId, text, key) => {
      posts.push({ groupId, text, key });
      return {
        schemaVersion: 1,
        seq: 7,
        messageId: "o-x",
        at: "2026-09-23T00:00:00.000Z",
        author: { kind: "bot", botId: "general" },
        body: { kind: "text", text, mentions: [] },
      };
    },
  };
  return { host, calls, posts };
}

const context = {
  botId: "general",
  agentId: "general",
  sessionId: "user-1:general",
  compositionGenerationId: "gen",
  effectId: "tool:3:1:0",
  turnType: "chat",
  signal: new AbortController().signal,
} as ToolExecutionContext;

describe("the Group Chat tools a Bot is given", () => {
  test("starting a group names the others by name or id, and always includes the Bot", async () => {
    const { host, calls } = fakeHost();
    const result = await createGroupCreateTool(host).execute(
      { members: ["@xero books", "codex"], name: "Month end" },
      context,
    );
    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      {
        command: {
          type: "group/create",
          members: ["general", "xero", "codex"],
          name: "Month end",
        },
        key: "tool:3:1:0:create",
      },
    ]);
    const unknown = await createGroupCreateTool(host).execute(
      { members: ["nobody"] },
      context,
    );
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toContain("nobody");
  });

  test("changing a group is one command per change, each with its own key", async () => {
    const { host, calls } = fakeHost();
    const result = await createGroupUpdateTool(host).execute(
      {
        group_id: GROUP_ID,
        name: "Closing",
        add_members: ["Codex"],
        remove_members: ["xero"],
      },
      context,
    );
    expect(result.isError).toBe(false);
    expect(calls.map((call) => [call.command, call.key])).toEqual([
      [
        { type: "group/rename", groupId: GROUP_ID, name: "Closing" },
        "tool:3:1:0:rename",
      ],
      [
        { type: "group/add-member", groupId: GROUP_ID, botId: "codex" },
        "tool:3:1:0:add:codex",
      ],
      [
        { type: "group/remove-member", groupId: GROUP_ID, botId: "xero" },
        "tool:3:1:0:remove:xero",
      ],
    ]);
    expect(
      await createGroupUpdateTool(host).execute(
        { group_id: GROUP_ID },
        context,
      ),
    ).toMatchObject({ isError: true });
  });

  test("archive and post take a group id from the list", async () => {
    const { host, calls, posts } = fakeHost();
    await createGroupArchiveTool(host).execute({ group_id: GROUP_ID }, context);
    expect(calls[0]?.command).toEqual({
      type: "group/archive",
      groupId: GROUP_ID,
    });
    const posted = await createGroupPostTool(host).execute(
      { group_id: GROUP_ID, text: " @Xero Books, the numbers are in. " },
      context,
    );
    expect(posted.isError).toBe(false);
    expect(posts).toEqual([
      {
        groupId: GROUP_ID,
        text: "@Xero Books, the numbers are in.",
        key: "tool:3:1:0:post",
      },
    ]);
    expect(
      await createGroupPostTool(host).execute(
        { group_id: "nope", text: "x" },
        context,
      ),
    ).toMatchObject({ isError: true });
  });

  test("the list names each group and its members", async () => {
    const { host } = fakeHost();
    const listed = await createGroupListTool(host).execute({}, context);
    expect(listed.content).toBe(`- Books (${GROUP_ID}): General, Xero Books`);
  });

  test("the prompt lists the Bot's groups in its chat and Routines only", async () => {
    const { host } = fakeHost();
    const section = createGroupChatsPromptSectionV1(host);
    const chat = await section.render({ turnType: "chat" } as never);
    expect(chat).toContain("<group_chats>");
    expect(chat).toContain(`Books (${GROUP_ID})`);
    expect(await section.render({ turnType: "agent" } as never)).toBe("");
  });
});
