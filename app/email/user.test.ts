import { describe, expect, test } from "bun:test";
import {
  InboundEmailUserStoreV1,
  type InboundEmailBotV1,
  type InboundEmailUserHostV1,
} from "./user.ts";
import { displaySenderCodeV1, INBOUND_EMAIL_CODE_TTL_MS_V1 } from "./shared.ts";

function memoryHost() {
  const map = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(map.get(key)) as T,
    put: async (key: string, value: unknown) =>
      void map.set(key, structuredClone(value)),
    delete: async (key: string) => map.delete(key),
  };
  const bots: InboundEmailBotV1[] = [
    {
      botId: "b-fox",
      name: "Fox",
      registeredAt: "2026-09-01T00:00:00.000Z",
      active: true,
    },
    {
      botId: "b-owl",
      name: "Owl",
      registeredAt: "2026-09-02T00:00:00.000Z",
      active: true,
    },
  ];
  let reads = 0;
  const host: InboundEmailUserHostV1 = {
    storage: { ...storage, transaction: (closure) => closure(storage) },
    bots: async () => {
      reads += 1;
      return structuredClone(bots);
    },
  };
  return { host, map, bots, botReads: () => reads };
}

const NOW = Date.parse("2026-09-24T10:00:00.000Z");
const TIM = "tim@example.com";

describe("each Bot's email", () => {
  test("follows the Bot's name, and is off until turned on", async () => {
    const { host, bots } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    expect(await store.state("b-fox")).toEqual({
      schemaVersion: 1,
      slug: "fox",
      enabled: false,
      senders: [],
    });
    await store.setEnabled("b-fox", true);
    expect((await store.state("b-fox")).enabled).toBe(true);
    bots[0]!.name = "Red Fox";
    expect((await store.state("b-fox")).slug).toBe("red-fox");
    await store.setEnabled("b-fox", false);
    expect((await store.state("b-fox")).enabled).toBe(false);
  });

  test("only an active Bot can be turned on, and a deleted one leaves nothing", async () => {
    const { host, bots, map } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    await store.setEnabled("b-owl", true);
    bots[1]!.active = false;
    await expect(store.setEnabled("b-owl", true)).rejects.toThrow(
      "Only an active Bot",
    );
    await expect(store.setEnabled("b-gone", true)).rejects.toThrow(
      "Only an active Bot",
    );
    await expect(store.state("b-gone")).rejects.toThrow("isn’t yours");
    await store.forgetBot("b-owl");
    expect([...map.keys()]).toEqual([]);
  });
});

describe("which message reaches which Bot", () => {
  async function enabled() {
    const memory = memoryHost();
    const store = new InboundEmailUserStoreV1(memory.host);
    await store.setEnabled("b-fox", true);
    const route = (slug: string, sender = TIM, codes: string[] = []) =>
      store.route({ slug, sender, signInEmail: TIM, codes, now: NOW });
    return { ...memory, store, route };
  }

  test("the slug names the Bot by its name now", async () => {
    const { route, bots } = await enabled();
    expect(await route("fox")).toEqual({ kind: "admit", botId: "b-fox" });
    bots[0]!.name = "Red Fox";
    expect(await route("fox")).toEqual({
      kind: "refused",
      code: "unknown-address",
    });
    expect(await route("red-fox")).toEqual({
      kind: "admit",
      botId: "b-fox",
    });
  });

  test("a Bot that does not receive, or is archived, is refused", async () => {
    const { route, bots } = await enabled();
    expect(await route("owl")).toEqual({
      kind: "refused",
      code: "switched-off",
    });
    bots[0]!.active = false;
    expect(await route("fox")).toEqual({
      kind: "refused",
      code: "bot-unavailable",
    });
  });

  test("the later of two Bots with one name is -2", async () => {
    const { store, route, bots } = await enabled();
    bots[1]!.name = "fox";
    await store.setEnabled("b-owl", true);
    expect(await route("fox")).toEqual({ kind: "admit", botId: "b-fox" });
    expect(await route("fox-2")).toEqual({ kind: "admit", botId: "b-owl" });
    expect((await store.state("b-owl")).slug).toBe("fox-2");
  });

  test("a stranger learns nothing about which Bots there are", async () => {
    const { route, botReads } = await enabled();
    const before = botReads();
    for (const slug of ["fox", "owl", "nobody"]) {
      expect(await route(slug, "eve@evil.example")).toEqual({
        kind: "refused",
        code: "unverified-sender",
      });
    }
    expect(botReads()).toBe(before);
  });
});

describe("who may write to the User's Bots", () => {
  test("an added address writes only once its code came back from it", async () => {
    const { host } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    await store.setEnabled("b-fox", true);
    await store.addSender("tim@work.example", { now: NOW });
    const pending = (await store.state("b-fox")).senders[0]!;
    expect(pending).toMatchObject({ address: "tim@work.example" });
    const code = pending.code!;
    expect(displaySenderCodeV1(code)).toMatch(
      /^FROCK-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );

    const route = (codes: string[], now = NOW, slug = "fox") =>
      store.route({ slug, sender: "tim@work.example", codes, now });
    expect(await route([])).toEqual({
      kind: "refused",
      code: "unverified-sender",
    });
    expect(await route(["ZZZZZZZZ"])).toEqual({
      kind: "refused",
      code: "unverified-sender",
    });
    // Too late.
    expect(await route([code], NOW + INBOUND_EMAIL_CODE_TTL_MS_V1 + 1)).toEqual(
      { kind: "refused", code: "unverified-sender" },
    );
    // The code confirms the address whichever Bot's address it went to.
    expect(await route(["ZZZZZZZZ", code], NOW, "owl")).toEqual({
      kind: "confirmed",
    });
    const confirmed = (await store.state("b-fox")).senders[0]!;
    expect(confirmed.verifiedAt).toBeDefined();
    expect(confirmed.code).toBeUndefined();
    expect(await route([])).toEqual({ kind: "admit", botId: "b-fox" });
  });

  test("another address's code confirms nothing", async () => {
    const { host } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    await store.addSender("tim@work.example", { now: NOW });
    const code = (await store.state("b-fox")).senders[0]!.code!;
    expect(
      await store.route({
        slug: "fox",
        sender: "eve@evil.example",
        codes: [code],
        now: NOW,
      }),
    ).toEqual({ kind: "refused", code: "unverified-sender" });
  });

  test("the sign-in address cannot be added, and the list is bounded", async () => {
    const { host } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    await expect(
      store.addSender(TIM, { signInEmail: TIM, now: NOW }),
    ).rejects.toThrow("sign in with");
    for (let index = 0; index < 10; index += 1) {
      await store.addSender(`tim+${index}@example.com`, { now: NOW });
    }
    await expect(
      store.addSender("one-more@example.com", { now: NOW }),
    ).rejects.toThrow("Up to 10");
    // Adding one already waiting is a fresh code, not another row.
    const before = (await store.state("b-fox")).senders[0]!.code;
    await store.addSender("tim+0@example.com", { now: NOW + 1000 });
    const senders = (await store.state("b-fox")).senders;
    expect(senders).toHaveLength(10);
    expect(senders[0]!.code).not.toBe(before);
    await store.removeSender("tim+0@example.com");
    expect((await store.state("b-fox")).senders).toHaveLength(9);
  });
});
