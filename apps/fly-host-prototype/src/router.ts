import { decodeSmokeHttpRequest } from "../container/contracts.ts";

interface FlyHostRouteConfiguration {
  credentialRef: string;
  shards: number;
}

interface FlyHostContainerStub {
  fetch(request: Request): Promise<Response>;
}

type FlyHostContainerResolver = (shard: string) => FlyHostContainerStub;

function shardForBot(botId: string, shards: number): string {
  const count = Math.max(1, Math.floor(shards));
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(botId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `shared-${(hash >>> 0) % count}`;
}

export async function routeFlyHostRequest(
  request: Request,
  configuration: FlyHostRouteConfiguration,
  resolveContainer: FlyHostContainerResolver,
): Promise<Response> {
  const decoded = await decodeSmokeHttpRequest(request);
  if (!decoded.ok) return decoded.response;
  const smokeRequest = decoded.value;
  if (smokeRequest.credentialRef !== configuration.credentialRef) {
    return Response.json(
      { error: "credential-reference-not-authorized" },
      { status: 403 },
    );
  }

  const container = resolveContainer(
    shardForBot(smokeRequest.botId, configuration.shards),
  );
  return container.fetch(
    new Request("http://fly-host.internal/v1/computer/smoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(smokeRequest),
      signal: request.signal,
    }),
  );
}
