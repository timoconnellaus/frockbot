import { describe, expect, test } from "bun:test";
import {
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  decodeComputerHostProblemV1,
} from "@frockbot/computer-host-protocol";
import {
  computerHostShardCountV1,
  computerHostShardV1,
  fnv1aV1,
  legacyEffectShardV1,
  routeComputerHostRequestV1,
} from "./router.ts";

const hostToken = "host-token-0123456789abcdef";

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    effectId: "effect-1",
    identity: { userId: "user-1" },
    tenant: { botId: "bot-1" },
    credentialRef: "sprites:user:user-1",
    script: "printf hello",
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    stream: false,
    ...overrides,
  });
}

function execRequest(
  init: { token?: string | null; body?: string; path?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.token !== null) {
    headers.set(COMPUTER_HOST_TOKEN_HEADER, init.token ?? hostToken);
  }
  return new Request(
    `http://computer-host.internal${init.path ?? COMPUTER_HOST_ROUTES.exec}`,
    { method: "POST", headers, body: init.body ?? body() },
  );
}

function recordingResolver() {
  const shards: string[] = [];
  const forwarded: { url: string; token: string | null; body: string }[] = [];
  return {
    shards,
    forwarded,
    resolve: (shard: string) => {
      shards.push(shard);
      return {
        async fetch(request: Request) {
          forwarded.push({
            url: request.url,
            token: request.headers.get(COMPUTER_HOST_TOKEN_HEADER),
            body: await request.text(),
          });
          return Response.json({ forwarded: true });
        },
      };
    },
  };
}

describe("shard function", () => {
  test("is deterministic for one User", () => {
    expect(computerHostShardV1("user-1", 2)).toBe(
      computerHostShardV1("user-1", 2),
    );
  });

  test("names shards by index within the pool", () => {
    for (const userId of ["a", "b", "c", "user-1", "user-2", "user-3"]) {
      expect(computerHostShardV1(userId, 3)).toMatch(/^computer-host-[0-2]$/);
    }
  });

  test("every Bot of one User reaches one container", () => {
    // ADR 0012: the Computer, its slot registry, and its takeover lease are
    // all per-User, so the Bot must not appear in the key at all.
    const shard = computerHostShardV1("user-1", 8);
    expect(computerHostShardV1("user-1", 8)).toBe(shard);
  });

  test("distributes distinct Users across the pool", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_value, index) =>
        computerHostShardV1(`user-${index}`, 4),
      ),
    );
    expect(seen.size).toBe(4);
  });

  test("collapses to one shard for a nonsense pool size", () => {
    for (const shards of [0, -1, 0.5, Number.NaN]) {
      expect(computerHostShardV1("user-1", shards)).toBe("computer-host-0");
    }
  });

  test("FNV-1a matches its published constants", () => {
    // The empty string is the offset basis; "a" is one round.
    expect(fnv1aV1("")).toBe(2_166_136_261);
    expect(fnv1aV1("a")).toBe(0xe40c_292c);
  });

  test("the superseded seam keeps its own Bot-keyed shard names", () => {
    expect(legacyEffectShardV1("bot-1", 1)).toBe("shared-0");
    expect(legacyEffectShardV1("bot-1", 4)).toMatch(/^shared-[0-3]$/);
  });
});

describe("shard count", () => {
  test.each([
    ["2", 2],
    ["1", 1],
    ["16", 16],
    [undefined, 1],
    ["", 1],
    ["0", 1],
    ["-3", 1],
    ["many", 1],
  ])("reads %p as %p", (value, expected) => {
    expect(computerHostShardCountV1(value)).toBe(expected);
  });
});

describe("routing", () => {
  test("forwards an authorized request to the User's shard", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest(),
      { hostToken, shards: 2 },
      resolver.resolve,
    );
    expect(response.status).toBe(200);
    expect(resolver.shards).toEqual([computerHostShardV1("user-1", 2)]);
    expect(resolver.forwarded[0]?.url).toBe(
      `http://computer-host.internal${COMPUTER_HOST_ROUTES.exec}`,
    );
    expect(JSON.parse(resolver.forwarded[0]?.body ?? "{}")).toMatchObject({
      effectId: "effect-1",
      script: "printf hello",
    });
  });

  test("presents the shared token to the container", async () => {
    const resolver = recordingResolver();
    await routeComputerHostRequestV1(
      execRequest(),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(resolver.forwarded[0]?.token).toBe(hostToken);
  });

  test("refuses a request with no token", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({ token: null }),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(401);
    expect(decodeComputerHostProblemV1(await response.json()).code).toBe(
      "not-authorized",
    );
    expect(resolver.shards).toEqual([]);
  });

  test("refuses a request with the wrong token", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({ token: "not-the-token-0123456789ab" }),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(401);
    expect(resolver.shards).toEqual([]);
  });

  test("refuses every request when no token is configured", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({ token: "" }),
      { hostToken: "", shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(401);
    expect(resolver.shards).toEqual([]);
  });

  test("refuses an unknown route before authorizing it", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({ path: "/v1/computer/smoke", token: null }),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(404);
    expect(resolver.shards).toEqual([]);
  });

  test("refuses a malformed body without starting a container", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({ body: JSON.stringify({ version: 2 }) }),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(400);
    expect(resolver.shards).toEqual([]);
  });

  test("refuses a body whose identity is missing", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      execRequest({
        body: JSON.stringify({
          version: 1,
          effectId: "effect-1",
          tenant: { botId: "bot-1" },
          credentialRef: "sprites:user:user-1",
          script: "x",
          timeoutMs: 1,
          maxOutputBytes: 1,
          stream: false,
        }),
      }),
      { hostToken, shards: 1 },
      resolver.resolve,
    );
    expect(response.status).toBe(400);
    expect(resolver.shards).toEqual([]);
  });

  test("answers its own health check without a container", async () => {
    const resolver = recordingResolver();
    const response = await routeComputerHostRequestV1(
      new Request("http://computer-host.internal/healthz"),
      { hostToken, shards: 2 },
      resolver.resolve,
    );
    expect(await response.json<{ ok: boolean; shards: number }>()).toEqual({
      ok: true,
      shards: 2,
    });
    expect(resolver.shards).toEqual([]);
  });
});
