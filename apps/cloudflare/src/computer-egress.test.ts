import { describe, expect, test } from "bun:test";
import { signComputerEgressTokenV1 } from "@frockbot/computer/egress";
import {
  routeComputerEgressV1,
  type ComputerEgressAnswerInputV1,
} from "./computer-egress.js";

const forwarded = {
  method: "GET",
  url: "https://api.github.com/user",
  headers: { accept: "application/json" },
};

async function tokenFor(object: string, expiresAt = 10_000) {
  return signComputerEgressTokenV1("secret", {
    v: 1,
    o: object,
    n: "nonce-1",
    x: expiresAt,
    u: "https://bot.example/api/computer/egress",
  });
}

function post(token: string | undefined, body: unknown = forwarded) {
  return new Request("https://bot.example/api/computer/egress", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe("the computer egress door", () => {
  test("addresses the object the signed token names, and relays its answer", async () => {
    const asked: ComputerEgressAnswerInputV1[] = [];
    const response = await routeComputerEgressV1(
      post(await tokenFor("user-1:bot-1")),
      {
        secret: "secret",
        now: 5_000,
        answer: async (input) => {
          asked.push(input);
          return { status: 200, headers: {}, bodyBase64: "e30=" };
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toEqual({
      status: 200,
      headers: {},
      bodyBase64: "e30=",
    });
    expect(asked).toEqual([
      {
        schemaVersion: 1,
        object: "user-1:bot-1",
        nonce: "nonce-1",
        request: forwarded,
      },
    ]);
  });

  test("addresses nothing for a missing, forged or expired token", async () => {
    const asked: unknown[] = [];
    const dependencies = {
      secret: "secret",
      now: 5_000,
      answer: async (input: unknown) => {
        asked.push(input);
        return {};
      },
    };
    expect(
      (await routeComputerEgressV1(post(undefined), dependencies)).status,
    ).toBe(401);
    const other = await signComputerEgressTokenV1("other", {
      v: 1,
      o: "user-1:bot-1",
      n: "n",
      x: 10_000,
      u: "https://bot.example/api/computer/egress",
    });
    expect(
      (await routeComputerEgressV1(post(other), dependencies)).status,
    ).toBe(401);
    expect(
      (
        await routeComputerEgressV1(
          post(await tokenFor("user-1:bot-1", 4_000)),
          dependencies,
        )
      ).status,
    ).toBe(401);
    expect(asked).toHaveLength(0);
  });

  test("is closed without a secret and refuses a malformed request", async () => {
    const answer = async () => ({});
    expect(
      (
        await routeComputerEgressV1(post(await tokenFor("user-1:bot-1")), {
          answer,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await routeComputerEgressV1(
          post(await tokenFor("user-1:bot-1"), {
            method: "GET",
            url: "http://api.github.com/",
          }),
          { secret: "secret", now: 5_000, answer },
        )
      ).status,
    ).toBe(400);
  });
});
