import {
  APPLET_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  appletBuildProblemResponseV1,
  decodeAppletBuildHttpRequestV1,
} from "@frockbot/applets/build-contract";

export interface AppletBuildRouteConfiguration {
  /** The shared secret the app Worker presents and the container re-checks. */
  hostToken: string;
  shards: number;
}

export interface AppletBuildContainerStub {
  fetch(request: Request): Promise<Response>;
}

export type AppletBuildContainerResolver = (
  shard: string,
) => AppletBuildContainerStub;

/** FNV-1a over the UTF-8 bytes of a key. Deterministic across deploys. */
export function fnv1aV1(key: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function poolSize(shards: number): number {
  return Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
}

/**
 * The container one Applet's builds land on.
 *
 * A build is pure and the container holds nothing, so this is placement and
 * nothing more. Keying on the Applet rather than round-robin is the cheap
 * win: two builds of one Applet — a check then a publish — reach the same
 * warm instance, with esbuild and the type checker already resident.
 */
export function appletBuildShardV1(appletId: string, shards: number): string {
  return `applet-build-${fnv1aV1(appletId) % poolSize(shards)}`;
}

export function appletBuildShardCountV1(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The whole Worker: authorize, decode, shard, forward.
 *
 * The request is decoded here as well as in the container, because this Worker
 * is a seam: a malformed body should never reach a container and start one.
 */
export async function routeAppletBuildRequestV1(
  request: Request,
  configuration: AppletBuildRouteConfiguration,
  resolveContainer: AppletBuildContainerResolver,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return appletBuildProblemResponseV1(400, "invalid-request", "invalid-url");
  }
  if (pathname === "/healthz") {
    return Response.json({ ok: true, shards: configuration.shards });
  }
  if (pathname !== APPLET_BUILD_ROUTE) {
    return appletBuildProblemResponseV1(
      404,
      "not-found",
      "no such Applet build route",
    );
  }
  const presented = request.headers.get(APPLET_BUILD_TOKEN_HEADER);
  if (!configuration.hostToken || presented !== configuration.hostToken) {
    return appletBuildProblemResponseV1(
      401,
      "not-authorized",
      "Applet build token is missing or wrong",
    );
  }

  const body = await request.clone().text();
  const decoded = await decodeAppletBuildHttpRequestV1(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? body : undefined,
    }),
  );
  if (!decoded.ok) return decoded.response;

  const container = resolveContainer(
    appletBuildShardV1(decoded.value.id, configuration.shards),
  );
  return container.fetch(
    new Request(`http://applet-build.internal${APPLET_BUILD_ROUTE}`, {
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
