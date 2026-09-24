import {
  PLUGIN_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  pluginBuildProblemResponseV1,
  decodePluginBuildHttpRequestV1,
} from "@frockbot/applets/build-contract";
import { constantTimeEqualsV1, fnv1a32Utf8V1 } from "@frockbot/core/crypto";

export interface PluginBuildRouteConfiguration {
  /** The shared secret the app Worker presents and the container re-checks. */
  hostToken: string;
  shards: number;
}

export interface PluginBuildContainerStub {
  fetch(request: Request): Promise<Response>;
}

export type PluginBuildContainerResolver = (
  shard: string,
) => PluginBuildContainerStub;

/** Kept as the router's public alias for the neutral stable-hash primitive. */
export const fnv1aV1 = fnv1a32Utf8V1;

function poolSize(shards: number): number {
  return Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
}

/**
 * The container one Plugin's builds land on.
 *
 * A build is pure and the container holds nothing, so this is placement and
 * nothing more. Keying on the Plugin rather than round-robin is the cheap
 * win: two builds of one Plugin — a check then a publish — reach the same
 * warm instance, with esbuild and the type checker already resident.
 */
export function pluginBuildShardV1(pluginId: string, shards: number): string {
  return `applet-build-${fnv1aV1(pluginId) % poolSize(shards)}`;
}

export function pluginBuildShardCountV1(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The whole Worker: authorize, decode, shard, forward.
 *
 * The request is decoded here as well as in the container, because this Worker
 * is a seam: a malformed body should never reach a container and start one.
 */
export async function routePluginBuildRequestV1(
  request: Request,
  configuration: PluginBuildRouteConfiguration,
  resolveContainer: PluginBuildContainerResolver,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return pluginBuildProblemResponseV1(400, "invalid-request", "invalid-url");
  }
  if (pathname === "/healthz") {
    return Response.json({ ok: true, shards: configuration.shards });
  }
  if (pathname !== PLUGIN_BUILD_ROUTE) {
    return pluginBuildProblemResponseV1(
      404,
      "not-found",
      "no such Plugin build route",
    );
  }
  const presented = request.headers.get(APPLET_BUILD_TOKEN_HEADER);
  if (
    !configuration.hostToken ||
    !constantTimeEqualsV1(presented ?? "", configuration.hostToken)
  ) {
    return pluginBuildProblemResponseV1(
      401,
      "not-authorized",
      "Plugin build token is missing or wrong",
    );
  }

  const body = await request.clone().text();
  const decoded = await decodePluginBuildHttpRequestV1(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? body : undefined,
    }),
  );
  if (!decoded.ok) return decoded.response;

  const container = resolveContainer(
    pluginBuildShardV1(decoded.value.id, configuration.shards),
  );
  return container.fetch(
    new Request(`http://applet-build.internal${PLUGIN_BUILD_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [APPLET_BUILD_TOKEN_HEADER]: configuration.hostToken,
      },
      body,
      signal: request.signal,
    }),
  );
}
