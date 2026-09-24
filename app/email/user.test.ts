import { describe, expect, test } from "bun:test";
import {
  InboundEmailUserStoreV1,
  type InboundEmailUserHostV1,
} from "./user.ts";
import { displaySenderCodeV1, INBOUND_EMAIL_CODE_TTL_MS_V1 } from "./shared.ts";

function memoryHost(options: { active?: Set<string> } = {}) {
  const map = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(map.get(key)) as T,
    put: async (key: string, value: unknown) =>
      void map.set(key, structuredClone(value)),
    delete: async (key: string) => map.delete(key),
  };
  const directory = new Map<string, string>();
  const calls: string[] = [];
  const active = options.active ?? new Set(["fox", "owl"]);
  const host: InboundEmailUserHostV1 = {
    storage: { ...storage, transaction: (closure) => closure(storage) },
    botActive: async (botId) => active.has(botId),
    directory: {
      register: async (botId, token) => {
        calls.push(`register ${botId}`);
        directory.set(botId, token);
      },
      release: async (botId) => {
        calls.push(`release ${botId}`);
        directory.delete(botId);
      },
    },
    exclusive: (closure) => closure(),
  };
  return { host, map, directory, calls, active };
}

const NOW = Date.parse("2026-09-24T10:00:00.000Z");

describe("each Bot's address", () => {
  test("is made once, rotated on request, and the directory always holds the one kept", async () => {
    const { host, directory } = memoryHost();
    const store = new InboundEmailUserStoreV1(host);
    await store.setAddress("fox", {
      rotate: false,
      now: "2026-09-24T10:00:00Z",
    });
    const first = (await store.state("fox")).address;
    expect(first?.token).toMatch(/^[a-z2-7]{26}$/);
    expect(directory.get("fox")).toBe(first?.token);

    await store.setAddress("fox", {
      rotate: false,
      now: "2026-09-24T11:00:00Z",
    });
    expect((await store.state("fox")).address).toEqual(first);

    await store.setAddress("fox", {
      rotate: true,
      now: "2026-09-24T12:00:00Z",
    });
    const second = (await store.state("fox")).address;
    expect(second?.token).not.toBe(first?.token);
    expect(directory.get("fox")).toBe(second?.token);

    await store.removeAddress("fox");
    expect((await store.state("fox")).address).toBeUndefined();
    expect(directory.has("fox")).toBe(false);
  });

  test("only an active Bot gets one", async () => {
    const { host, calls } = memoryHost({ active: new Set() });
    const store = new InboundEmailUserStoreV1(host);
    await expect(
      store.setAddress("fox", { rotate: false, now: "2026-09-24T10:00:00Z" }),
    ).rejects.toThrow("Only an active Bot");
    expect(calls).toEqual([]);
  });

  test("removing an address that is not there asks the directory nothing", async () => {
    const { host, calls } = memoryHost();
    await new InboundEmailUserStoreV1(host).removeAddress("fox");
    expect(calls).toEqual([]);
  });
});

describe("who may write to the User's Bots", () => {
  async function withAddress() {
    const memory = memoryHost();
    const store = new InboundEmailUserStoreV1(memory.host);
    await store.setAddress("fox", {
      rotate: false,
      now: "2026-09-24T10:00:00Z",
    });
    const token = (await store.state("fox")).address!.token;
    return { ...memory, store, token };
  }

  test("the sign-in address writes without a code", async () => {
    const { store, token } = await withAddress();
    expect(
      await store.route({
        botId: "fox",
        token,
        sender: "tim@example.com",
        signInEmail: "tim@example.com",
        codes: [],
        now: NOW,
      }),
    ).toEqual({ kind: "admit" });
  });

  test("an added address writes only once its code came back from it", async () => {
    const { store, token } = await withAddress();
    await store.addSender("tim@work.example", { now: NOW });
    const pending = (await store.state("fox")).senders[0]!;
    expect(pending).toMatchObject({ address: "tim@work.example" });
    const code = pending.code!;
    expect(displaySenderCodeV1(code)).toMatch(
      /^FROCK-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );

    const route = (codes: string[], now = NOW) =>
      store.route({
        botId: "fox",
        token,
        sender: "tim@work.example",
        codes,
        now,
      });
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
      {
        kind: "refused",
        code: "unverified-sender",
      },
    );
    expect(await route(["ZZZZZZZZ", code])).toEqual({ kind: "confirmed" });
    const confirmed = (await store.state("fox")).senders[0]!;
    expect(confirmed.verifiedAt).toBeDefined();
    expect(confirmed.code).toBeUndefined();
    expect(await route([])).toEqual({ kind: "admit" });
  });

  test("another address's code confirms nothing", async () => {
    const { store, token } = await withAddress();
    await store.addSender("tim@work.example", { now: NOW });
    const code = (await store.state("fox")).senders[0]!.code!;
    expect(
      await store.route({
        botId: "fox",
        token,
        sender: "eve@evil.example",
        codes: [code],
        now: NOW,
      }),
    ).toEqual({ kind: "refused", code: "unverified-sender" });
  });

  test("a rotated token, another Bot's token and an archived Bot are refused", async () => {
    const { store, token, active } = await withAddress();
    const route = (botId: string, presented: string) =>
      store.route({
        botId,
        token: presented,
        sender: "tim@example.com",
        signInEmail: "tim@example.com",
        codes: [],
        now: NOW,
      });
    expect(await route("owl", token)).toEqual({
      kind: "refused",
      code: "unknown-address",
    });
    await store.setAddress("fox", {
      rotate: true,
      now: "2026-09-24T11:00:00Z",
    });
    expect(await route("fox", token)).toEqual({
      kind: "refused",
      code: "unknown-address",
    });
    const current = (await store.state("fox")).address!.token;
    active.delete("fox");
    expect(await route("fox", current)).toEqual({
      kind: "refused",
      code: "bot-unavailable",
    });
  });

  test("the sign-in address cannot be added, and the list is bounded", async () => {
    const { store } = await withAddress();
    await expect(
      store.addSender("tim@example.com", {
        signInEmail: "tim@example.com",
        now: NOW,
      }),
    ).rejects.toThrow("sign in with");
    for (let index = 0; index < 10; index += 1) {
      await store.addSender(`tim+${index}@example.com`, { now: NOW });
    }
    await expect(
      store.addSender("one-more@example.com", { now: NOW }),
    ).rejects.toThrow("Up to 10");
    // Adding one already waiting is a fresh code, not another row.
    const before = (await store.state("fox")).senders[0]!.code;
    await store.addSender("tim+0@example.com", { now: NOW + 1000 });
    const senders = (await store.state("fox")).senders;
    expect(senders).toHaveLength(10);
    expect(senders[0]!.code).not.toBe(before);
    await store.removeSender("tim+0@example.com");
    expect((await store.state("fox")).senders).toHaveLength(9);
  });
});
