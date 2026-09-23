import { describe, expect, test } from "bun:test";

import {
  APPLET_BUILD_TOKEN_HEADER,
  PLUGIN_BUILD_ROUTE,
  encodePluginBuildRequestV1,
  type PluginBuildRequestV1,
} from "@frockbot/applets/build-contract";
import {
  fnv1aV1,
  pluginBuildShardCountV1,
  pluginBuildShardV1,
  routePluginBuildRequestV1,
} from "./router.ts";

const TOKEN = "shared-token";
const PLUGIN_ID = "weather";

function body(overrides: Partial<PluginBuildRequestV1> = {}): string {
  return JSON.stringify(
    encodePluginBuildRequestV1({
      version: 1,
      effectId: "effect-1",
      id: PLUGIN_ID,
      mode: "build",
      files: [{ path: "plugin.ts", text: "export const tools = [];\n" }],
      ...overrides,
    }),
  );
}

function post(headers: Record<string, string> = {}, text = body()): Request {
  return new Request(`https://applet-build.internal${PLUGIN_BUILD_ROUTE}`, {
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
  return routePluginBuildRequestV1(
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

describe("the Plugin build router", () => {
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
    const response = await routePluginBuildRequestV1(
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

  test("forwards the body and the token to the Plugin's shard", async () => {
    const seen: Seen = {};
    const text = body();
    const response = await route(
      post({ [APPLET_BUILD_TOKEN_HEADER]: TOKEN }, text),
      seen,
    );
    expect(await response.json<{ status: string }>()).toEqual({
      status: "built",
    });
    expect(seen.shard).toBe(pluginBuildShardV1(PLUGIN_ID, 2));
    expect(seen.request?.method).toBe("POST");
    expect(new URL(seen.request!.url).pathname).toBe(PLUGIN_BUILD_ROUTE);
    expect(seen.request?.headers.get(APPLET_BUILD_TOKEN_HEADER)).toBe(TOKEN);
    expect(await seen.request!.text()).toBe(text);
  });
});

describe("Plugin build sharding", () => {
  test("uses the neutral UTF-8 FNV-1a vectors", () => {
    expect(fnv1aV1("")).toBe(2_166_136_261);
    expect(fnv1aV1("a")).toBe(0xe40c_292c);
    expect(fnv1aV1("💡")).toBe(0x3091_f3c5);
  });

  test("sends every build of one Plugin to one container", () => {
    expect(pluginBuildShardV1(PLUGIN_ID, 4)).toBe(
      pluginBuildShardV1(PLUGIN_ID, 4),
    );
    expect(pluginBuildShardV1(PLUGIN_ID, 4)).toMatch(/^applet-build-[0-3]$/);
  });

  test("spreads different Plugins", () => {
    const shards = new Set(
      Array.from({ length: 32 }, (_, index) =>
        pluginBuildShardV1(`plugin-${index}`, 4),
      ),
    );
    expect(shards.size).toBeGreaterThan(1);
  });

  test("a pool is at least one container, whatever the configuration held", () => {
    expect(pluginBuildShardV1(PLUGIN_ID, 0)).toBe("applet-build-0");
    expect(pluginBuildShardCountV1(undefined)).toBe(1);
    expect(pluginBuildShardCountV1("nonsense")).toBe(1);
    expect(pluginBuildShardCountV1("3")).toBe(3);
  });
});
