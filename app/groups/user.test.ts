import { describe, expect, test } from "bun:test";
import { GroupChatUserStoreV1, type GroupChatUserKvV1 } from "./user.js";
import {
  GROUP_CHAT_MEMBERS_MAX_V1,
  GroupChatConflictError,
  GroupChatNotFoundError,
  type GroupChatCommandV1,
} from "./shared.js";

function memoryStorage() {
  const map = new Map<string, unknown>();
  const kv: GroupChatUserKvV1 = {
    get: <T>(key: string) =>
      Promise.resolve(structuredClone(map.get(key)) as T),
    put: (key, value) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
  };
  return {
    ...kv,
    async transaction<T>(
      closure: (transaction: GroupChatUserKvV1) => Promise<T>,
    ) {
      const snapshot = new Map(map);
      try {
        return await closure(kv);
      } catch (error) {
        map.clear();
        for (const [key, value] of snapshot) map.set(key, value);
        throw error;
      }
    },
  };
}

const bots = [
  { botId: "fox", name: "Fox" },
  { botId: "dog", name: "Dog" },
  { botId: "owl", name: "Owl" },
  ...Array.from({ length: 8 }, (_, index) => ({
    botId: `extra-${index}`,
    name: `Extra ${index}`,
  })),
];

function store() {
  return new GroupChatUserStoreV1(
    memoryStorage(),
    () => Promise.resolve(bots),
    () => new Date("2026-09-23T10:00:00.000Z"),
  );
}

const create: GroupChatCommandV1 = {
  type: "group/create",
  commandId: "create-1",
  members: ["fox", "dog"],
};

describe("the User object's Group Chats", () => {
  test("creating a group names it from the command, and a replay is the same group", async () => {
    const groups = store();
    const first = await groups.execute("user-1", create, { kind: "user" });
    const again = await groups.execute("user-1", create, { kind: "user" });
    expect(first.receipt.groupId).toMatch(/^g-[0-9a-f]{20}$/);
    expect(again).toEqual(first);
    expect((await groups.list()).groups).toHaveLength(1);
    expect(first.change).toMatchObject({
      kind: "event",
      initialize: true,
      event: { type: "created", members: ["fox", "dog"] },
      context: {
        members: [
          { botId: "fox", name: "Fox" },
          { botId: "dog", name: "Dog" },
        ],
      },
    });
  });

  test("a command id reused for a different command is refused", async () => {
    const groups = store();
    await groups.execute("user-1", create, { kind: "user" });
    await expect(
      groups.execute(
        "user-1",
        { ...create, members: ["fox", "owl"] },
        { kind: "user" },
      ),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
  });

  test("members must be the User's Bots, and a group holds at most eight", async () => {
    const groups = store();
    await expect(
      groups.execute(
        "user-1",
        { ...create, members: ["fox", "stranger"] },
        { kind: "user" },
      ),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
    const { receipt } = await groups.execute(
      "user-1",
      {
        ...create,
        members: bots
          .slice(0, GROUP_CHAT_MEMBERS_MAX_V1)
          .map((bot) => bot.botId),
      },
      { kind: "user" },
    );
    await expect(
      groups.execute(
        "user-1",
        {
          type: "group/add-member",
          commandId: "add-9",
          groupId: receipt.groupId,
          botId: bots[GROUP_CHAT_MEMBERS_MAX_V1]!.botId,
        },
        { kind: "user" },
      ),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
  });

  test("rename, membership, archive and restore each leave a line; asking for what is already so does not", async () => {
    const groups = store();
    const { receipt } = await groups.execute("user-1", create, {
      kind: "user",
    });
    const groupId = receipt.groupId;
    const run = (command: GroupChatCommandV1) =>
      groups.execute("user-1", command, { kind: "user" });
    const renamed = await run({
      type: "group/rename",
      commandId: "rename-1",
      groupId,
      name: "Trip",
    });
    expect(renamed.change).toMatchObject({
      event: { type: "renamed", name: "Trip" },
    });
    const same = await run({
      type: "group/rename",
      commandId: "rename-2",
      groupId,
      name: "Trip",
    });
    expect(same.receipt.status).toBe("unchanged");
    expect(same.change).toBeUndefined();
    const added = await run({
      type: "group/add-member",
      commandId: "add-1",
      groupId,
      botId: "owl",
    });
    expect(added.receipt.group?.members).toEqual(["fox", "dog", "owl"]);
    const removed = await run({
      type: "group/remove-member",
      commandId: "remove-1",
      groupId,
      botId: "fox",
    });
    expect(removed.change).toMatchObject({
      event: { type: "member-removed", botId: "fox" },
      context: { group: { members: ["dog", "owl"] } },
    });
    await expect(
      run({
        type: "group/remove-member",
        commandId: "remove-2",
        groupId,
        botId: "dog",
      }),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
    const archived = await run({
      type: "group/archive",
      commandId: "archive-1",
      groupId,
    });
    expect(archived.receipt.group?.archivedAt).toBe("2026-09-23T10:00:00.000Z");
    const restored = await run({
      type: "group/restore",
      commandId: "restore-1",
      groupId,
    });
    expect(restored.receipt.group?.archivedAt).toBeUndefined();
  });

  test("a Bot may change a group it is in, archive it, but never restore or delete it", async () => {
    const groups = store();
    const { receipt } = await groups.execute("user-1", create, {
      kind: "bot",
      botId: "fox",
    });
    const groupId = receipt.groupId;
    await expect(
      groups.execute(
        "user-1",
        { type: "group/rename", commandId: "r1", groupId, name: "x" },
        { kind: "bot", botId: "owl" },
      ),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
    await groups.execute(
      "user-1",
      { type: "group/archive", commandId: "a1", groupId },
      { kind: "bot", botId: "dog" },
    );
    for (const command of [
      { type: "group/restore", commandId: "r2", groupId },
      { type: "group/delete", commandId: "d1", groupId },
    ] as const) {
      await expect(
        groups.execute("user-1", command, { kind: "bot", botId: "dog" }),
      ).rejects.toBeInstanceOf(GroupChatConflictError);
    }
    await expect(
      groups.execute(
        "user-1",
        { ...create, commandId: "c2", members: ["dog", "owl"] },
        {
          kind: "bot",
          botId: "fox",
        },
      ),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
  });

  test("the User deletes a group, and the group's object is told to go", async () => {
    const groups = store();
    const { receipt } = await groups.execute("user-1", create, {
      kind: "user",
    });
    const deleted = await groups.execute(
      "user-1",
      { type: "group/delete", commandId: "d1", groupId: receipt.groupId },
      { kind: "user" },
    );
    expect(deleted.change).toEqual({
      kind: "delete",
      groupId: receipt.groupId,
    });
    expect((await groups.list()).groups).toEqual([]);
    await expect(groups.context(receipt.groupId)).rejects.toBeInstanceOf(
      GroupChatNotFoundError,
    );
  });

  test("arranging the sidebar changes no thread", async () => {
    const groups = store();
    const { receipt } = await groups.execute("user-1", create, {
      kind: "user",
    });
    const arranged = await groups.execute(
      "user-1",
      {
        type: "group/arrange",
        commandId: "arrange-1",
        groupId: receipt.groupId,
        label: "Work",
        pinned: true,
        sidebarOrder: 2,
        hidden: true,
      },
      { kind: "user" },
    );
    expect(arranged.change).toBeUndefined();
    expect(arranged.receipt.group).toMatchObject({
      label: "Work",
      pinnedAt: "2026-09-23T10:00:00.000Z",
      sidebarOrder: 2,
      hiddenFromSidebar: true,
    });
  });

  test("a deleted Bot leaves every group it was in", async () => {
    const groups = store();
    const { receipt } = await groups.execute("user-1", create, {
      kind: "user",
    });
    const changes = await groups.forgetBot("fox");
    expect(changes).toMatchObject([
      { kind: "event", event: { type: "member-removed", botId: "fox" } },
    ]);
    expect((await groups.context(receipt.groupId)).group.members).toEqual([
      "dog",
    ]);
    expect(await groups.groupsOf("dog")).toEqual([receipt.groupId]);
    expect(await groups.groupsOf("fox")).toEqual([]);
  });
});
