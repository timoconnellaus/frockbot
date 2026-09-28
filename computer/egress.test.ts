import { describe, expect, test } from "bun:test";
import type {
  ToolCall,
  ToolExecutionContext,
  ToolPreparation,
} from "@frockbot/core/contracts";
import {
  answerComputerEgressV1,
  base64ToBytesV1,
  COMPUTER_EGRESS_HOSTS_V1,
  bytesToBase64V1,
  computerEgressReadsV1,
  computerEgressRouteV1,
  createComputerEgressHandlerV1,
  openComputerEgressV1,
  signComputerEgressTokenV1,
  syntheticReviewIdsV1,
  verifyComputerEgressTokenV1,
  type ComputerEgressAccountV1,
  type ComputerEgressRequestV1,
  type ComputerEgressResponseV1,
  type ComputerEgressTokenV1,
} from "./egress.js";

const context: ToolExecutionContext = {
  botId: "bot-1",
  agentId: "run-1",
  sessionId: "session-1",
  compositionGenerationId: "bootstrap",
  effectId: "tool:2:1:0",
  turnType: "chat",
  signal: new AbortController().signal,
};

function body(value: unknown): string {
  return bytesToBase64V1(new TextEncoder().encode(JSON.stringify(value)));
}

function messageOf(response: ComputerEgressResponseV1): string {
  const text = new TextDecoder().decode(base64ToBytesV1(response.bodyBase64));
  return (JSON.parse(text) as { message: string }).message;
}

function ok(): ComputerEgressResponseV1 {
  return { status: 200, headers: {}, bodyBase64: body({ ok: true }) };
}

function account(
  sent: ComputerEgressRequestV1[],
  send: () => Promise<ComputerEgressResponseV1> = async () => ok(),
): ComputerEgressAccountV1 {
  return {
    toolkit: "github",
    label: "GitHub",
    send: async (request, endpoint) => {
      sent.push(request);
      expect(endpoint).toBe(
        `${new URL(request.url).origin}${new URL(request.url).pathname}`,
      );
      return send();
    },
  };
}

describe("computer egress routes", () => {
  test("attaches an account to GitHub's and Gmail's APIs and nothing else", () => {
    expect(
      computerEgressRouteV1(new URL("https://api.github.com/user"))?.toolkit,
    ).toBe("github");
    expect(
      computerEgressRouteV1(
        new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"),
      )?.toolkit,
    ).toBe("gmail");
    expect(
      computerEgressReadsV1({
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: {},
      }),
    ).toBe(false);
    expect(
      computerEgressRouteV1(new URL("https://github.com/o/r.git")),
    ).toBeUndefined();
    expect(
      computerEgressRouteV1(new URL("https://example.com/")),
    ).toBeUndefined();
  });

  test("reads are GET and HEAD, and GraphQL documents with no mutation", () => {
    const graphql = (query: string): ComputerEgressRequestV1 => ({
      method: "POST",
      url: "https://api.github.com/graphql",
      headers: {},
      bodyBase64: body({ query }),
    });
    expect(
      computerEgressReadsV1({
        method: "GET",
        url: "https://api.github.com/user",
        headers: {},
      }),
    ).toBe(true);
    expect(computerEgressReadsV1(graphql("query { viewer { login } }"))).toBe(
      true,
    );
    expect(
      computerEgressReadsV1(graphql('{ search(query: "mutation") { x } }')),
    ).toBe(true);
    expect(computerEgressReadsV1(graphql("mutation { addStar { x } }"))).toBe(
      false,
    );
    // A mutation behind a query or a fragment is still a mutation.
    expect(
      computerEgressReadsV1(
        graphql("query A { viewer { login } } mutation B { addStar { x } }"),
      ),
    ).toBe(false);
    expect(
      computerEgressReadsV1(
        graphql("fragment F on User { login }\nmutation { x }"),
      ),
    ).toBe(false);
    expect(
      computerEgressReadsV1({
        method: "POST",
        url: "https://api.github.com/repos/o/r/issues",
        headers: {},
        bodyBase64: body({ title: "x" }),
      }),
    ).toBe(false);
  });
});

describe("computer egress handler", () => {
  test("refuses a host with no route and an app with no connected account", async () => {
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [],
      context,
    });
    const unrouted = await handler({
      method: "GET",
      url: "https://example.com/",
      headers: {},
    });
    expect(unrouted.status).toBe(403);
    const unconnected = await handler({
      method: "GET",
      url: "https://api.github.com/user",
      headers: {},
    });
    expect(unconnected.status).toBe(403);
    expect(messageOf(unconnected)).toContain("connect GitHub in Connectors");
  });

  test("reviews a read once per API path, and reaches any app on its generic address", async () => {
    const sent: { url: string; endpoint: string }[] = [];
    const reviewed: ToolCall[] = [];
    const notion: ComputerEgressAccountV1 = {
      toolkit: "notion",
      label: "Notion",
      send: async (request, endpoint) => {
        sent.push({ url: request.url, endpoint });
        return ok();
      },
    };
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [notion],
      context,
      review: async (call) => {
        reviewed.push(call);
        return { kind: "ready", call, idempotent: false };
      },
    });
    for (const page of ["1", "2", "3"]) {
      const response = await handler({
        method: "GET",
        url: `https://notion.connected.internal/v1/users?page=${page}`,
        headers: {},
      });
      expect(response.status).toBe(200);
    }
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.input).toMatchObject({
      account: "Notion",
      method: "GET",
      url: "https://notion.connected.internal/v1/users?page=1",
    });
    expect(sent.map((entry) => entry.endpoint)).toEqual([
      "/v1/users",
      "/v1/users",
      "/v1/users",
    ]);
  });

  test("a read the review refuses is not sent", async () => {
    const sent: ComputerEgressRequestV1[] = [];
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [account(sent)],
      context,
      review: async (call): Promise<ToolPreparation> => ({
        kind: "denied",
        call,
        result: { content: "Nobody asked for this.", isError: true },
      }),
    });
    const response = await handler({
      method: "GET",
      url: "https://api.github.com/user/emails",
      headers: {},
    });
    expect(response.status).toBe(403);
    expect(messageOf(response)).toContain("Nobody asked for this.");
    expect(sent).toHaveLength(0);
  });

  test("reviews a write as a mutate call of the exec's Turn before sending it", async () => {
    const sent: ComputerEgressRequestV1[] = [];
    const reviews: { call: ToolCall; context: ToolExecutionContext }[] = [];
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [account(sent)],
      context,
      review: async (call, reviewContext) => {
        reviews.push({ call, context: reviewContext });
        return { kind: "ready", call, idempotent: false };
      },
    });
    const request: ComputerEgressRequestV1 = {
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues",
      headers: {},
      bodyBase64: body({ title: "Broken build" }),
    };
    expect((await handler(request)).status).toBe(200);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.context).toMatchObject({ effect: "mutate" });
    expect(reviews[0]!.context.effectId).toMatch(
      /^tool:2:1:0:egress:[0-9a-f]{32}:0$/,
    );
    expect(reviews[0]!.call).toMatchObject({
      name: "credentialed_request",
      input: {
        account: "GitHub",
        method: "POST",
        url: "https://api.github.com/repos/o/r/issues",
        body: { title: "Broken build" },
      },
    });
    // The same write again inside the same exec is the same effect.
    expect((await handler(request)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(reviews).toHaveLength(1);
  });

  test("a write is reviewed under an id its content names, never its position", async () => {
    async function reviewIds(
      requests: ComputerEgressRequestV1[],
    ): Promise<string[]> {
      const ids: string[] = [];
      const handler = createComputerEgressHandlerV1({
        productName: "FrockBot",
        accounts: () => [account([])],
        context,
        review: async (call, reviewContext) => {
          ids.push(reviewContext.effectId);
          return { kind: "ready", call, idempotent: false };
        },
      });
      for (const request of requests) await handler(request);
      return ids;
    }
    const issue: ComputerEgressRequestV1 = {
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues",
      headers: {},
      bodyBase64: body({ title: "Broken build" }),
    };
    const removal: ComputerEgressRequestV1 = {
      method: "DELETE",
      url: "https://api.github.com/repos/o/r",
      headers: {},
    };
    const [first, second] = await reviewIds([issue, removal]);
    expect(first).not.toBe(second);
    // Another exec that sends the same requests in a different order gets
    // the same id for each, so no verdict follows a position.
    expect(await reviewIds([removal, issue])).toEqual([second, first]);
    // A different body is a different request.
    const [other] = await reviewIds([
      { ...issue, bodyBase64: body({ title: "Delete everything" }) },
    ]);
    expect(other).not.toBe(first);
  });

  test("an exact repeat is counted, and counted the same way every time", async () => {
    const mint = () => syntheticReviewIdsV1("tool:2:1:0:review");
    const once = mint();
    const ids = [
      await once({ click: "Place order" }),
      await once({ click: "Place order" }),
      await once({ click: "Cancel" }),
    ];
    expect(ids[0]).toMatch(/^tool:2:1:0:review:[0-9a-f]{32}:0$/);
    expect(ids[1]).toBe(ids[0]!.replace(/:0$/, ":1"));
    expect(ids[2]).toMatch(/:0$/);
    expect(ids[2]).not.toBe(ids[0]);
    const again = mint();
    expect([
      await again({ click: "Place order" }),
      await again({ click: "Place order" }),
    ]).toEqual([ids[0], ids[1]]);
  });

  test("a refused write never leaves, and the CLI is told why", async () => {
    const sent: ComputerEgressRequestV1[] = [];
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [account(sent)],
      context,
      review: async (call): Promise<ToolPreparation> => ({
        kind: "denied",
        call,
        result: { content: "Ask the person first.", isError: true },
      }),
    });
    const response = await handler({
      method: "DELETE",
      url: "https://api.github.com/repos/o/r",
      headers: {},
    });
    expect(response.status).toBe(403);
    expect(messageOf(response)).toContain("Ask the person first.");
    expect(sent).toHaveLength(0);
  });

  test("a write with no reviewer is not sent", async () => {
    const sent: ComputerEgressRequestV1[] = [];
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [account(sent)],
      context,
    });
    const response = await handler({
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues",
      headers: {},
    });
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test("a write whose send failed is answered as unknown", async () => {
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [
        account([], async () => {
          throw new Error("socket closed");
        }),
      ],
      context,
      review: async (call) => ({ kind: "ready", call, idempotent: false }),
    });
    const response = await handler({
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues",
      headers: {},
    });
    expect(response.status).toBe(502);
    expect(messageOf(response)).toContain("Do not repeat it");
  });

  test("an account whose Connection is no longer permitted is not used", async () => {
    const sent: ComputerEgressRequestV1[] = [];
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [{ ...account(sent), permit: async () => false }],
      context,
    });
    const response = await handler({
      method: "GET",
      url: "https://api.github.com/user",
      headers: {},
    });
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe("Jev from the terminal", () => {
  const request = (
    overrides: Partial<ComputerEgressRequestV1> = {},
  ): ComputerEgressRequestV1 => ({
    method: "POST",
    url: "https://jev.internal/v1/system-one",
    headers: { "content-type": "application/json" },
    bodyBase64: body({ state: {}, questions: {} }),
    ...overrides,
  });

  test("is one of the hosts the Computer's proxy intercepts", () => {
    expect(COMPUTER_EGRESS_HOSTS_V1).toContain("jev.internal");
  });

  test("is answered under its own effect id per request, with no review and no account", async () => {
    const asked: { body: string; effectId: string }[] = [];
    let reviewed = false;
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [],
      context,
      review: async () => {
        reviewed = true;
        return { kind: "denied", result: { content: "no" } } as never;
      },
      jev: async (input) => {
        asked.push({
          body: new TextDecoder().decode(input.body),
          effectId: input.effectId,
        });
        return ok();
      },
    });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    expect(asked.map((a) => a.effectId)).toEqual([
      "tool:2:1:0:jev:0",
      "tool:2:1:0:jev:1",
    ]);
    expect(JSON.parse(asked[0]!.body)).toEqual({ state: {}, questions: {} });
    expect(reviewed).toBe(false);
  });

  test("answers only POST to its one path, and nothing where Jev is not offered", async () => {
    const jev = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [],
      context,
      jev: async () => ok(),
    });
    expect((await jev(request({ method: "GET" }))).status).toBe(404);
    expect(
      (await jev(request({ url: "https://jev.internal/other" }))).status,
    ).toBe(404);
    const without = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [],
      context,
    });
    const refused = await without(request());
    expect(refused.status).toBe(403);
    expect(messageOf(refused)).toContain("Jev is not available");
  });

  test("a Jev seam that throws is answered as unconfirmed", async () => {
    const handler = createComputerEgressHandlerV1({
      productName: "FrockBot",
      accounts: () => [],
      context,
      jev: async () => {
        throw new Error("down");
      },
    });
    expect((await handler(request())).status).toBe(502);
  });
});

describe("computer egress liveness and tokens", () => {
  test("a request is answered only while its exec call is open, by its own object", async () => {
    const request: ComputerEgressRequestV1 = {
      method: "GET",
      url: "https://api.github.com/user",
      headers: {},
    };
    const close = openComputerEgressV1("nonce-1", {
      object: "user-1:bot-1",
      expiresAt: 2_000,
      answer: async () => ok(),
    });
    expect(
      (
        await answerComputerEgressV1({
          object: "user-1:bot-1",
          nonce: "nonce-1",
          request,
          now: 1_000,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await answerComputerEgressV1({
          object: "user-1:bot-2",
          nonce: "nonce-1",
          request,
          now: 1_000,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await answerComputerEgressV1({
          object: "user-1:bot-1",
          nonce: "nonce-1",
          request,
          now: 3_000,
        })
      ).status,
    ).toBe(410);
    close();
    expect(
      (
        await answerComputerEgressV1({
          object: "user-1:bot-1",
          nonce: "nonce-1",
          request,
          now: 1_000,
        })
      ).status,
    ).toBe(410);
  });

  test("a token verifies only unaltered, unexpired and naming an object", async () => {
    const token: ComputerEgressTokenV1 = {
      v: 1,
      o: "user-1:bot-1#task:t-1",
      n: "nonce",
      x: 10_000,
      u: "https://bot.example/api/computer/egress",
    };
    const signed = await signComputerEgressTokenV1("secret", token);
    expect(await verifyComputerEgressTokenV1("secret", signed, 5_000)).toEqual(
      token,
    );
    expect(
      await verifyComputerEgressTokenV1("other", signed, 5_000),
    ).toBeUndefined();
    expect(
      await verifyComputerEgressTokenV1("secret", signed, 10_000),
    ).toBeUndefined();
    const [, signature] = signed.split(".");
    const forged = `${btoa(JSON.stringify({ ...token, o: "user-2:bot-9" })).replace(/=+$/, "")}.${signature}`;
    expect(
      await verifyComputerEgressTokenV1("secret", forged, 5_000),
    ).toBeUndefined();
    const badObject = await signComputerEgressTokenV1("secret", {
      ...token,
      o: "user-1:bot-1:extra",
    });
    expect(
      await verifyComputerEgressTokenV1("secret", badObject, 5_000),
    ).toBeUndefined();
  });
});
