import {
  COMPUTER_HOST_TOKEN_HEADER,
  computerHostOperationKindV1,
  decodeComputerHostHttpRequestV1,
  problem,
} from "@frockbot/computer-host-protocol";

export interface ComputerHostRouteConfiguration {
  /** The shared secret the app Worker presents and the container re-checks. */
  hostToken: string;
  shards: number;
}

export interface ComputerHostContainerStub {
  fetch(request: Request): Promise<Response>;
}

export type ComputerHostContainerResolver = (
  shard: string,
) => ComputerHostContainerStub;

/**
 * FNV-1a over the UTF-8 bytes of a key.
 *
 * Deterministic and stable across deploys is the whole requirement: a User
 * must land on the same container every time, so its Computer's slot
 * allocation, provisioning, and human-control lease serialize in one place.
 */
export function fnv1aV1(key: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * The container a User's Computer lives on.
 *
 * Keyed on **userId**, not botId. "One Computer serves all of a User's Bots"
 * (ADR 0012), and the `flock`-serialized takeover lease and the display-slot
 * registry live on that one Sprite — so every Bot of one User must reach it
 * through one container, or two containers would race on one box.
 */
export function computerHostShardV1(userId: string, shards: number): string {
  return `computer-host-${fnv1aV1(userId) % poolSize(shards)}`;
}

/** A pool is at least one container, whatever nonsense the configuration held. */
function poolSize(shards: number): number {
  return Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
}

export function computerHostShardCountV1(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The whole Worker: authorize, decode, shard, forward.
 *
 * The request is decoded here as well as in the container. That is not
 * belt-and-braces duplication for its own sake — "every inbound value is
 * decoded at its seam", and this Worker is a seam: a malformed body should
 * never reach a container and start one.
 */
export async function routeComputerHostRequestV1(
  request: Request,
  configuration: ComputerHostRouteConfiguration,
  resolveContainer: ComputerHostContainerResolver,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return problem(400, "invalid-request", "invalid-url");
  }
  if (pathname === "/healthz") {
    return Response.json({ ok: true, shards: configuration.shards });
  }
  if (!computerHostOperationKindV1(pathname)) {
    return problem(404, "not-found", "no such Computer host route");
  }
  const presented = request.headers.get(COMPUTER_HOST_TOKEN_HEADER);
  if (!configuration.hostToken || presented !== configuration.hostToken) {
    return problem(
      401,
      "not-authorized",
      "Computer host token is missing or wrong",
    );
  }

  const body = await request.clone().text();
  const decoded = await decodeComputerHostHttpRequestV1(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? body : undefined,
    }),
  );
  if (!decoded.ok) return decoded.response;

  const container = resolveContainer(
    computerHostShardV1(decoded.value.identity.userId, configuration.shards),
  );
  return container.fetch(
    new Request(`http://computer-host.internal${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [COMPUTER_HOST_TOKEN_HEADER]: configuration.hostToken,
      },
      body,
      signal: request.signal,
    }),
  );
}

/**
 * The container shard the superseded single-effect seam routes to.
 *
 * It keys on **botId** and names shards `shared-<n>`, which is wrong for a
 * Computer — ADR 0012 makes a Computer a property of its User — and is exactly
 * why `computerHostShardV1` exists. It is preserved verbatim because live
 * `ComputerEffectJournal` objects already resolved containers this way, and a
 * superseding deploy must not silently re-place them.
 */
export function legacyEffectShardV1(botId: string, shards: number): string {
  return `shared-${fnv1aV1(botId) % poolSize(shards)}`;
}
