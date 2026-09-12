import { describe, expect, test } from "bun:test";

import {
  APPLET_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  encodeAppletBuildRequestV1,
  type AppletBuildRequestV1,
} from "@frockbot/applets/build-contract";
import {
  appletBuildShardCountV1,
  appletBuildShardV1,
  routeAppletBuildRequestV1,
} from "./router.ts";

const TOKEN = "shared-token";
const APPLET_ID = "vgpqfaCcwnPlzjYdb2mI.weekly-todos";

function body(overrides: Partial<AppletBuildRequestV1> = {}): string {
  return JSON.stringify(
    encodeAppletBuildRequestV1({
      version: 1,
      effectId: "effect-1",
      kind: "applet",
      id: APPLET_ID,
      mode: "build",
      files: [{ path: "server.ts", text: "export default class {}\n" }],
      ...overrides,
    }),
  );
}

function post(headers: Record<string, string> = {}, text = body()): Request {
  return new Request(`https://applet-build.internal${APPLET_BUILD_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

interface Seen {
  shard?: string;
  request?: Request;
}

function route(request: Request, seen: Seen = {}): Promise<Response> {
  return routeAppletBuildRequestV1(
    request,
    { hostToken: TOKEN, shards: 2 },
    (shard) => ({
      fetch: async (forwarded) => {
        seen.shard = shard;
        seen.request = forwarded;
        return Response.json({ status: "built" });
      },
    }),
  );
}

describe("the Applet build router", () => {
  test("answers /healthz without a token", async () => {
    const response = await route(
      new Request("https://applet-build.internal/healthz"),
    );
    expect(await response.json<{ ok: boolean; shards: number }>()).toEqual({
      ok: true,
      shards: 2,
    });
  });

  test("refuses a missing or wrong token before any container starts", async () => {
    const seen: Seen = {};
    const attempts: Record<string, string>[] = [
      {},
      { [APPLET_BUILD_TOKEN_HEADER]: "wrong" },
    ];
    for (const headers of attempts) {
      const response = await route(post(headers), seen);
      expect(response.status).toBe(401);
    }
    expect(seen.request).toBeUndefined();
  });

  test("refuses every request when the Worker holds no token", async () => {
    const response = await routeAppletBuildRequestV1(
      post({ [APPLET_BUILD_TOKEN_HEADER]: "" }),
      { hostToken: "", shards: 1 },
      () => ({
        fetch: () => {
          throw new Error("must not reach a container");
        },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("404s a route it does not serve", async () => {
    const response = await route(
      new Request("https://applet-build.internal/v1/nope", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  test("decodes before it forwards, so a malformed body starts nothing", async () => {
    const seen: Seen = {};
    const response = await route(
      post(
        { [APPLET_BUILD_TOKEN_HEADER]: TOKEN },
        JSON.stringify({ version: 1 }),
      ),
      seen,
    );
    expect(response.status).toBe(400);
    expect(seen.request).toBeUndefined();
  });

  test("forwards the body and the token to the Applet's shard", async () => {
    const seen: Seen = {};
    const text = body();
    const response = await route(
      post({ [APPLET_BUILD_TOKEN_HEADER]: TOKEN }, text),
      seen,
    );
    expect(await response.json<{ status: string }>()).toEqual({
      status: "built",
    });
    expect(seen.shard).toBe(appletBuildShardV1(APPLET_ID, 2));
    expect(seen.request?.method).toBe("POST");
    expect(new URL(seen.request!.url).pathname).toBe(APPLET_BUILD_ROUTE);
    expect(seen.request?.headers.get(APPLET_BUILD_TOKEN_HEADER)).toBe(TOKEN);
    expect(await seen.request!.text()).toBe(text);
  });
});

describe("Applet build sharding", () => {
  test("sends every build of one Applet to one container", () => {
    expect(appletBuildShardV1(APPLET_ID, 4)).toBe(
      appletBuildShardV1(APPLET_ID, 4),
    );
    expect(appletBuildShardV1(APPLET_ID, 4)).toMatch(/^applet-build-[0-3]$/);
  });

  test("spreads different Applets", () => {
    const shards = new Set(
      Array.from({ length: 32 }, (_, index) =>
        appletBuildShardV1(`owner.applet-${index}`, 4),
      ),
    );
    expect(shards.size).toBeGreaterThan(1);
  });

  test("a pool is at least one container, whatever the configuration held", () => {
    expect(appletBuildShardV1(APPLET_ID, 0)).toBe("applet-build-0");
    expect(appletBuildShardCountV1(undefined)).toBe(1);
    expect(appletBuildShardCountV1("nonsense")).toBe(1);
    expect(appletBuildShardCountV1("3")).toBe(3);
  });
});
