import { describe, expect, test } from "bun:test";
import type { TelegramBotChoiceV1 } from "./shared.js";
import { TelegramUserStoreV1, type TelegramUserStorageV1 } from "./user.js";

function memoryStorage() {
  const values = new Map<string, unknown>();
  const storage: TelegramUserStorageV1 = {
    get: <T>(key: string) =>
      Promise.resolve(structuredClone(values.get(key)) as T | undefined),
    put: (key, value) => {
      values.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  return {
    values,
    storage: {
      ...storage,
      transaction: <T>(
        closure: (transaction: TelegramUserStorageV1) => Promise<T>,
      ) => closure(storage),
    },
  };
}

function store(
  bots: TelegramBotChoiceV1[] = [
    { botId: "research", name: "Research" },
    { botId: "general-1", name: "General" },
  ],
) {
  const memory = memoryStorage();
  const choices = { bots, generalBotId: "general-1" };
  return {
    memory,
    choices,
    store: new TelegramUserStoreV1({
      storage: memory.storage,
      bots: () => Promise.resolve(structuredClone(choices)),
    }),
  };
}

const account = {
  telegramUserId: "4242",
  chatId: "4242",
  username: "tim_o",
  name: "Tim",
};
const T0 = "2026-09-24T00:00:00.000Z";
const T1 = "2026-09-24T01:00:00.000Z";

function message(text: string, telegramUserId = "4242") {
  return { telegramUserId, chatId: telegramUserId, messageId: "12", text };
}

describe("the User's Telegram link", () => {
  test("a new link talks to General, and relinking keeps the Bot", async () => {
    const { store: telegram } = store();
    const first = await telegram.complete(account, T0);
    expect(first.link.botId).toBe("general-1");
    expect(first.botName).toBe("General");
    await telegram.select("research");
    const again = await telegram.complete(account, T1);
    expect(again.link).toMatchObject({ botId: "research", linkedAt: T1 });
    expect(again.previous?.telegramUserId).toBe("4242");
    expect(await telegram.read()).toMatchObject({
      link: { username: "tim_o", botId: "research" },
    });
  });

  test("a message from any other account is not this link's", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T0);
    expect(await telegram.route(message("hi", "7"))).toEqual({
      decision: { kind: "not-linked" },
    });
    expect(await telegram.route(message("hi"))).toEqual({
      decision: { kind: "admit", botId: "general-1" },
    });
  });

  test("the chat's commands are answered here, and /bot switches", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T0);
    const listed = await telegram.route(message("/bots"));
    expect(listed.decision).toEqual({
      kind: "reply",
      text: [
        "Your Bots:",
        "1. Research",
        "2. General (talking now)",
        "Send /bot and a number or a name to switch.",
      ].join("\n"),
    });
    const switched = await telegram.route(message("/bot res"));
    expect(switched).toEqual({
      decision: { kind: "reply", text: "Now talking to Research." },
      switched: { from: "general-1", to: "research" },
    });
    expect(await telegram.route(message("/bot 2"))).toMatchObject({
      switched: { from: "research", to: "general-1" },
    });
    expect(
      (await telegram.route(message("/bot nobody"))).decision,
    ).toMatchObject({ kind: "reply" });
    expect((await telegram.link())?.botId).toBe("general-1");
  });

  test("a Bot that is gone is not talked to", async () => {
    const { store: telegram, choices } = store();
    await telegram.complete(account, T0);
    choices.bots = choices.bots.filter((bot) => bot.botId !== "general-1");
    const answer = await telegram.route(message("hello"));
    expect(answer.decision.kind).toBe("reply");
    await telegram.forgetBot("general-1");
    expect((await telegram.link())?.botId).toBeUndefined();
    expect(await telegram.select("gone")).toMatchObject({
      status: "rejected",
    });
  });

  test("a drop from another User's claim ends only the link it was about", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T1);
    // A claim from before this link was made is not about this link.
    expect(await telegram.drop("4242", T0)).toBeUndefined();
    expect(await telegram.link()).toBeDefined();
    expect(await telegram.drop("99", T1)).toBeUndefined();
    expect((await telegram.drop("4242", T1))?.telegramUserId).toBe("4242");
    expect(await telegram.link()).toBeUndefined();
  });
});

describe("a mirrored message is sent at most once", () => {
  const cursor = (n: number) => `message-${String(n).padStart(20, "0")}`;
  const NOW = Date.parse(T1);

  test("only for the Bot the link names now", async () => {
    const { store: telegram } = store();
    expect(await telegram.claimDelivery("research", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "skipped" },
    });
    await telegram.complete(account, T0);
    expect(await telegram.claimDelivery("research", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "skipped" },
    });
    expect(await telegram.claimDelivery("general-1", cursor(1), NOW)).toEqual({
      kind: "claimed",
      chatId: "4242",
    });
  });

  test("an attempt whose outcome was lost is uncertain, never repeated", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T0);
    await telegram.claimDelivery("general-1", cursor(1), NOW);
    // The object died between recording the intent and the answer.
    expect(await telegram.claimDelivery("general-1", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "uncertain" },
    });
    expect(await telegram.claimDelivery("general-1", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "uncertain" },
    });
  });

  test("a sent message answers sent, and an older one is not sent at all", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T0);
    await telegram.claimDelivery("general-1", cursor(2), NOW);
    await telegram.finishDelivery(
      "general-1",
      cursor(2),
      { status: "sent" },
      NOW,
    );
    expect(await telegram.claimDelivery("general-1", cursor(2), NOW)).toEqual({
      kind: "done",
      outcome: { status: "sent" },
    });
    expect(await telegram.claimDelivery("general-1", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "skipped" },
    });
  });

  test("a message Telegram asked to hold is tried again after the wait", async () => {
    const { store: telegram } = store();
    await telegram.complete(account, T0);
    await telegram.claimDelivery("general-1", cursor(1), NOW);
    const retryAt = new Date(NOW + 30_000).toISOString();
    await telegram.finishDelivery(
      "general-1",
      cursor(1),
      { status: "retry", retryAt },
      NOW,
    );
    expect(await telegram.claimDelivery("general-1", cursor(1), NOW)).toEqual({
      kind: "done",
      outcome: { status: "retry", retryAt },
    });
    expect(
      await telegram.claimDelivery("general-1", cursor(1), NOW + 30_001),
    ).toEqual({ kind: "claimed", chatId: "4242" });
  });
});
