import { describe, expect, test } from "bun:test";
import {
  createInboundEmailBackendContribution,
  type InboundEmailGatewayHostV1,
} from "./backend.ts";
import {
  inboundEmailDomainV1,
  inboundEmailViewV1,
  inboundMessageIdV1,
  senderCodesInV1,
  type InboundEmailStateV1,
} from "./shared.ts";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");

describe("the email view", () => {
  test("names the address on the deployment's domain and every sender's standing", () => {
    const state: InboundEmailStateV1 = {
      schemaVersion: 1,
      address: {
        token: "abcdefghijklmnopqrstuvwxyz",
        createdAt: "2026-09-24T09:00:00.000Z",
      },
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
    expect(
      inboundEmailViewV1(state, {
        domain: "in.frock.test",
        signInEmail: "tim@example.com",
        now: NOW,
      }),
    ).toEqual({
      schemaVersion: 1,
      available: true,
      address: "abcdefghijklmnopqrstuvwxyz@in.frock.test",
      createdAt: "2026-09-24T09:00:00.000Z",
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
    // No domain: nothing to write to, whatever is stored.
    expect(inboundEmailViewV1(state, { now: NOW })).toMatchObject({
      available: false,
    });
    expect(inboundEmailViewV1(state, { now: NOW }).address).toBeUndefined();
  });

  test("reads a domain, a code and a Message-ID only in their shapes", () => {
    expect(
      inboundEmailDomainV1({ INBOUND_EMAIL_DOMAIN: " In.Frock.Test " }),
    ).toBe("in.frock.test");
    expect(inboundEmailDomainV1({ INBOUND_EMAIL_DOMAIN: "not a domain" })).toBe(
      undefined,
    );
    expect(inboundEmailDomainV1({})).toBeUndefined();
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
  const host: InboundEmailGatewayHostV1 = {
    inboundEmailDomain: "in.frock.test",
    inboundEmailSignIn: async () => "tim@example.com",
    readInboundEmail: async () => ({ schemaVersion: 1, senders: [] }),
    commandInboundEmailAddress: async (...args) => {
      commands.push(args);
      return { status: "applied" };
    },
    commandInboundEmailSender: async (...args) => {
      commands.push(args);
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
  test("answer the view, and carry each command to the User's object", async () => {
    const { call, commands } = gateway();
    const read = await call("/api/bots/fox/email");
    expect(read?.status).toBe(200);
    expect((await read!.json()) as unknown).toMatchObject({
      available: true,
      senders: [{ address: "tim@example.com", status: "sign-in" }],
    });
    expect(
      (await call("/api/bots/fox/email/address", { action: "rotate" }))?.status,
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
      ["u1", "fox", "rotate"],
      [
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
      inboundEmailDomain: undefined,
      commandInboundEmailSender: async () => ({
        status: "rejected",
        reason: "Up to 10 addresses can email your Bots.",
      }),
    });
    expect(
      (await call("/api/bots/fox/email/address", { action: "create" }))?.status,
    ).toBe(503);
    expect(
      (await call("/api/bots/fox/email/address", { action: "explode" }))
        ?.status,
    ).toBe(400);
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
  });
});
