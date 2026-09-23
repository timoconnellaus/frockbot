import { describe, expect, test } from "bun:test";
import {
  GroupChatDecodeError,
  answerGroupRpcV1,
  decodeGroupChatCommandV1,
  decodeGroupMessagePageQueryV1,
  decodeGroupPostCommandV1,
  groupDisplayNameV1,
  mentionedBotIdsV1,
  mentionsUserV1,
  resolveMentionsV1,
  unwrapGroupRpcV1,
  GroupChatNotFoundError,
} from "./shared.js";

const members = [
  { botId: "xero", name: "Xero" },
  { botId: "xero-books", name: "Xero Books" },
  { botId: "codex", name: "Codex" },
];

describe("reading mentions", () => {
  test("names match whole, ignoring case, longest first", () => {
    expect(
      resolveMentionsV1("@xero books and @Xero, ask @CODEX.", members),
    ).toEqual([
      { botId: "xero-books", start: 0, end: 11 },
      { botId: "xero", start: 16, end: 21 },
      { botId: "codex", start: 27, end: 33 },
    ]);
  });

  test("an address or a longer word is not a mention", () => {
    expect(resolveMentionsV1("mail tim@xero.com or @Xeroth", members)).toEqual(
      [],
    );
  });

  test("each member once, in the order first mentioned", () => {
    expect(
      mentionedBotIdsV1(resolveMentionsV1("@Codex @Xero @Codex", members)),
    ).toEqual(["codex", "xero"]);
  });
});

describe("calling the person", () => {
  test("@User, whole and in any case, calls them", () => {
    expect(mentionsUserV1("@User the invoice is overdue")).toBe(true);
    expect(mentionsUserV1("Done. @user, have a look.")).toBe(true);
    expect(mentionsUserV1("mail user@user.com")).toBe(false);
    expect(mentionsUserV1("@Username is a Bot")).toBe(false);
  });
});

describe("naming a group", () => {
  test("an unnamed group is its members' names", () => {
    expect(
      groupDisplayNameV1({ members: ["xero", "xero-books", "codex"] }, members),
    ).toBe("Xero, Xero Books & Codex");
    expect(
      groupDisplayNameV1({ name: "Books", members: ["xero"] }, members),
    ).toBe("Books");
  });
});

describe("decoding what a client sends", () => {
  test("a create command is exact, and names two to eight distinct Bots", () => {
    expect(
      decodeGroupChatCommandV1({
        type: "group/create",
        commandId: "c1",
        members: ["a", "b"],
        name: "  Trip   plans ",
      }),
    ).toEqual({
      type: "group/create",
      commandId: "c1",
      members: ["a", "b"],
      name: "Trip plans",
    });
    for (const bad of [
      { type: "group/create", commandId: "c1", members: ["a"] },
      { type: "group/create", commandId: "c1", members: ["a", "a"] },
      { type: "group/create", commandId: "c1", members: ["a", "b"], extra: 1 },
      { type: "group/rename", commandId: "c1", groupId: "nope", name: "x" },
    ]) {
      expect(() => decodeGroupChatCommandV1(bad)).toThrow(GroupChatDecodeError);
    }
  });

  test("a post is trimmed and bounded", () => {
    expect(
      decodeGroupPostCommandV1({
        schemaVersion: 1,
        commandId: "p1",
        text: " hi ",
      }),
    ).toEqual({ schemaVersion: 1, commandId: "p1", text: "hi" });
    expect(() =>
      decodeGroupPostCommandV1({
        schemaVersion: 1,
        commandId: "p1",
        text: "   ",
      }),
    ).toThrow(GroupChatDecodeError);
  });

  test("a page is read before or after a position, never both", () => {
    expect(
      decodeGroupMessagePageQueryV1(new URL("https://x/?before=10&limit=5")),
    ).toEqual({ before: 10, limit: 5 });
    expect(() =>
      decodeGroupMessagePageQueryV1(new URL("https://x/?before=1&after=2")),
    ).toThrow(GroupChatDecodeError);
    expect(() =>
      decodeGroupMessagePageQueryV1(new URL("https://x/?limit=500")),
    ).toThrow(GroupChatDecodeError);
  });
});

describe("refusals across a Durable Object call", () => {
  test("travel as values and come back as their own classes", async () => {
    const answer = await answerGroupRpcV1(() =>
      Promise.reject(new GroupChatNotFoundError("g-0")),
    );
    expect(answer).toMatchObject({ ok: false, code: "not-found" });
    expect(() => unwrapGroupRpcV1(structuredClone(answer))).toThrow(
      GroupChatNotFoundError,
    );
    expect(
      unwrapGroupRpcV1<{ a: number }>(
        await answerGroupRpcV1(() => Promise.resolve({ a: 1 })),
      ),
    ).toEqual({ a: 1 });
    await expect(
      answerGroupRpcV1(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});
