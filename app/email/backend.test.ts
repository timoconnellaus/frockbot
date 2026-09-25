import { describe, expect, test } from "bun:test";
import {
  createInboundEmailBackendContribution,
  type InboundEmailGatewayHostV1,
} from "./backend.ts";
import {
  botEmailSlugsV1,
  emailUsernameProblemV1,
  emailDomainV1,
  inboundEmailViewV1,
  inboundMessageIdV1,
  parseBotEmailLocalPartV1,
  senderCodesInV1,
  type InboundEmailStateV1,
} from "./shared.ts";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");

describe("a Bot's address", () => {
  const slugs = (...names: string[]) =>
    [
      ...botEmailSlugsV1(
        names.map((name, index) => ({
          botId: `b${index}xyz789`,
          name,
          registeredAt: new Date(NOW + index * 1000).toISOString(),
        })),
      ).values(),
    ].sort();

  test("is the Bot's name, lowercased, with spaces as dashes", () => {
    expect(slugs("Fox")).toEqual(["fox"]);
    expect(slugs("  Red   Fox!  ")).toEqual(["red-fox"]);
    expect(slugs("Zoë's Café")).toEqual(["zoes-cafe"]);
    expect(slugs("Straße Ærø Łódź")).toEqual(["strasse-aero-lodz"]);
    expect(slugs("mr.robot_2 -- ok")).toEqual(["mr-robot-2-ok"]);
    expect(slugs("a".repeat(40))).toEqual(["a".repeat(32)]);
  });

  test("falls back to the Bot's id, and tells two alike apart by age", () => {
    expect(slugs("🦊")).toEqual(["bot-b0xyz7"]);
    const map = botEmailSlugsV1([
      { botId: "late", name: "Fox", registeredAt: "2026-09-03T00:00:00Z" },
      { botId: "first", name: "fox", registeredAt: "2026-09-01T00:00:00Z" },
      { botId: "middle", name: "FOX", registeredAt: "2026-09-02T00:00:00Z" },
    ]);
    expect(Object.fromEntries(map)).toEqual({
      first: "fox",
      middle: "fox-2",
      late: "fox-3",
    });
    // A suffix stays inside the longest slug.
    const long = "b".repeat(32);
    expect(slugs(long, long)).toEqual([`${"b".repeat(30)}-2`, long]);
  });

  test("splits at the last dot into slug and username", () => {
    expect(parseBotEmailLocalPartV1("fox.tim")).toEqual({
      slug: "fox",
      username: "tim",
    });
    expect(parseBotEmailLocalPartV1("Red-Fox.Tim+notes")).toEqual({
      slug: "red-fox",
      username: "tim",
    });
    for (const local of [
      "tim",
      ".tim",
      "fox.",
      "fox.t",
      "red.fox.tim",
      "fox.abuse",
      "-fox.tim",
      "fox.ti-",
    ]) {
      expect(parseBotEmailLocalPartV1(local)).toBeUndefined();
    }
    // A reserved name never names an account, so it never reaches a Bot.
    expect(parseBotEmailLocalPartV1("fox.postmaster")).toBeUndefined();
  });

  test("a username is 3 to 30 of letters, digits and single dashes, and not reserved", () => {
    for (const ok of ["tim", "tim-o", "t1m", "a".repeat(30)]) {
      expect(emailUsernameProblemV1(ok)).toBeUndefined();
    }
    for (const bad of [
      undefined,
      "ti",
      "a".repeat(31),
      "1tim",
      "-tim",
      "tim-",
      "tim--o",
      "tim.o",
      "Tim",
      "tïm",
      "admin",
      "no-reply",
      "mailer-daemon",
    ]) {
      expect(emailUsernameProblemV1(bad)).toBeString();
    }
  });
});

describe("the email view", () => {
  const state: InboundEmailStateV1 = {
    schemaVersion: 1,
    slug: "fox",
    enabled: true,
    senders: [
      {
        address: "tim@work.example",
        addedAt: "2026-09-23T09:00:00.000Z",
        verifiedAt: "2026-09-23T09:05:00.000Z",
      },
      {
        address: "tim@home.example",
        addedAt: "2026-09-24T09:00:00.000Z",
        code: "7K3P9QXM",
        expiresAt: "2026-09-25T09:00:00.000Z",
      },
      {
        address: "old@home.example",
        addedAt: "2026-09-20T09:00:00.000Z",
        code: "ABCDEFGH",
        expiresAt: "2026-09-21T09:00:00.000Z",
      },
    ],
  };

  test("names the address from the slug and username, and every sender's standing", () => {
    expect(
      inboundEmailViewV1(state, {
        domain: "frock.test",
        username: "tim",
        signInEmail: "tim@example.com",
        now: NOW,
      }),
    ).toEqual({
      schemaVersion: 1,
      available: true,
      username: "tim",
      address: "fox.tim@frock.test",
      enabled: true,
      senders: [
        { address: "tim@example.com", status: "sign-in" },
        {
          address: "tim@work.example",
          status: "verified",
          verifiedAt: "2026-09-23T09:05:00.000Z",
        },
        {
          address: "tim@home.example",
          status: "pending",
          code: "FROCK-7K3P-9QXM",
          expiresAt: "2026-09-25T09:00:00.000Z",
        },
        {
          address: "old@home.example",
          status: "expired",
          expiresAt: "2026-09-21T09:00:00.000Z",
        },
      ],
    });
  });

  test("has no address without a username or a domain", () => {
    const noUsername = inboundEmailViewV1(state, {
      domain: "frock.test",
      now: NOW,
    });
    expect(noUsername).toMatchObject({ available: true, enabled: true });
    expect(noUsername.address).toBeUndefined();
    const noDomain = inboundEmailViewV1(state, { username: "tim", now: NOW });
    expect(noDomain).toMatchObject({ available: false, username: "tim" });
    expect(noDomain.address).toBeUndefined();
  });

  test("reads a domain, a code and a Message-ID only in their shapes", () => {
    expect(emailDomainV1({ EMAIL_DOMAIN: " In.Frock.Test " })).toBe(
      "in.frock.test",
    );
    expect(emailDomainV1({ EMAIL_DOMAIN: "not a domain" })).toBe(undefined);
    expect(emailDomainV1({})).toBeUndefined();
    expect(
      senderCodesInV1("re: FROCK-7k3p-9qxm and frock-ABCD1234 and FROCK-XXXX"),
    ).toEqual(["7K3P9QXM", "ABCD1234"]);
    // `I`, `L`, `O` and `U` are not Crockford base32.
    expect(senderCodesInV1("FROCK-IIII-LLLL")).toEqual([]);
    expect(inboundMessageIdV1("<CAF=x+y@mail.gmail.com>")).toBe(
      "CAF=x+y@mail.gmail.com",
    );
    expect(inboundMessageIdV1("<a b@c>")).toBeUndefined();
    expect(inboundMessageIdV1(undefined)).toBeUndefined();
  });
});

function gateway(overrides: Partial<InboundEmailGatewayHostV1> = {}) {
  const commands: unknown[] = [];
  let username: string | undefined;
  const host: InboundEmailGatewayHostV1 = {
    emailDomain: "frock.test",
    emailSignIn: async () => "tim@example.com",
    readEmailUsername: async () => username,
    claimEmailUsername: async (userId, wanted) => {
      commands.push(["username", userId, wanted]);
      if (wanted === "taken") return { status: "taken" };
      username = wanted;
      return { status: "claimed" };
    },
    readInboundEmail: async () => ({
      schemaVersion: 1,
      slug: "fox",
      enabled: false,
      senders: [],
    }),
    setBotEmailEnabled: async (...args) => {
      commands.push(["switch", ...args]);
      return { status: "applied" };
    },
    commandInboundEmailSender: async (...args) => {
      commands.push(["sender", ...args]);
      return { status: "applied" };
    },
    ...overrides,
  };
  const contribution = createInboundEmailBackendContribution(host);
  const call = (path: string, body?: unknown) =>
    contribution.route(
      new Request(`https://bot.frockbot.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      new URL(`https://bot.frockbot.test${path}`),
      { userId: "u1", client: "browser" },
    );
  return { call, commands };
}

describe("the email settings routes", () => {
  test("claim a username, and a Bot's address follows it", async () => {
    const { call, commands } = gateway();
    const before = await call("/api/bots/fox/email");
    expect((await before!.json()) as unknown).toEqual({
      schemaVersion: 1,
      available: true,
      enabled: false,
      senders: [{ address: "tim@example.com", status: "sign-in" }],
    });
    const claimed = await call("/api/email/username", { username: " Tim " });
    expect(claimed?.status).toBe(200);
    expect((await claimed!.json()) as unknown).toEqual({
      schemaVersion: 1,
      available: true,
      domain: "frock.test",
      username: "tim",
    });
    const after = await call("/api/bots/fox/email");
    expect((await after!.json()) as unknown).toMatchObject({
      username: "tim",
      address: "fox.tim@frock.test",
    });
    const released = await call("/api/email/username", { username: null });
    expect((await released!.json()) as unknown).toEqual({
      schemaVersion: 1,
      available: true,
      domain: "frock.test",
    });
    expect(commands).toEqual([
      ["username", "u1", "tim"],
      ["username", "u1", undefined],
    ]);
  });

  test("refuse a username out of shape, reserved or taken", async () => {
    const { call, commands } = gateway();
    for (const [username, status] of [
      ["ab", 400],
      ["fox.tim", 400],
      ["abuse", 400],
      [7, 400],
      ["taken", 409],
    ] as const) {
      const answer = await call("/api/email/username", { username });
      expect(answer?.status).toBe(status);
      expect(((await answer!.json()) as { error: string }).error).toBeString();
    }
    expect(commands).toEqual([["username", "u1", "taken"]]);
  });

  test("carry the switch and the senders to the User's object", async () => {
    const { call, commands } = gateway();
    expect(
      (await call("/api/bots/fox/email/switch", { enabled: true }))?.status,
    ).toBe(200);
    expect(
      (
        await call("/api/bots/fox/email/senders", {
          action: "add",
          address: " Tim@Work.Example ",
        })
      )?.status,
    ).toBe(200);
    expect(commands).toEqual([
      ["switch", "u1", "fox", true],
      [
        "sender",
        "u1",
        {
          action: "add",
          address: "tim@work.example",
          signInEmail: "tim@example.com",
        },
      ],
    ]);
  });

  test("refuse what cannot be done, and leave other paths alone", async () => {
    const { call } = gateway({
      emailDomain: undefined,
      commandInboundEmailSender: async () => ({
        status: "rejected",
        reason: "Up to 10 addresses can email your Bots.",
      }),
    });
    expect(
      (await call("/api/bots/fox/email/switch", { enabled: true }))?.status,
    ).toBe(503);
    expect(
      (await call("/api/email/username", { username: "tim" }))?.status,
    ).toBe(503);
    expect(
      (await call("/api/bots/fox/email/switch", { enabled: "yes" }))?.status,
    ).toBe(400);
    // Turning off needs no domain.
    expect(
      (await call("/api/bots/fox/email/switch", { enabled: false }))?.status,
    ).toBe(200);
    const full = await call("/api/bots/fox/email/senders", {
      action: "add",
      address: "a@b.example",
    });
    expect(full?.status).toBe(409);
    expect((await full!.json()) as unknown).toEqual({
      error: "Up to 10 addresses can email your Bots.",
    });
    expect(
      (
        await call("/api/bots/fox/email/senders", {
          action: "add",
          address: "not an address",
        })
      )?.status,
    ).toBe(400);
    expect(await call("/api/bots/fox/settings")).toBeUndefined();
    expect((await call("/api/bots/fox/email/address"))?.status).toBe(405);
  });
});
