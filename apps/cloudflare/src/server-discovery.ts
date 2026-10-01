import {
  SUPPORTED_PROTOCOL_MAX,
  SUPPORTED_PROTOCOL_MIN,
} from "@frockbot/core/protocol-schemas";
import type { BrandV1 } from "@frockbot/core/contracts";

/**
 * Where an app finds out what a server is before anyone signs in to it: the
 * native app reads it when a person types an address under "Use another
 * server". Public and holding nothing secret; on a simple deployment Access
 * bypasses this one path.
 */
export const SERVER_DISCOVERY_PATH_V1 = "/.well-known/frockbot.json";

/**
 * The discovery document. Read by apps of every age, so a field is only ever
 * added: an app ignores what it does not know, and reads the protocol range
 * to say plainly whether this server is too old or needs a newer app.
 */
export interface ServerDiscoveryV1 {
  schemaVersion: 1;
  /** The product this deployment is. */
  name: string;
  /** The client protocol interval the compatibility gate serves. */
  protocol: { min: number; max: number };
  /**
   * How an app signs in: the browser with PKCE, returning on the brand's
   * scheme — an app built for another scheme cannot sign in here — or not at
   * all, on a deployment with no native door.
   */
  signIn:
    { method: "browser-pkce"; scheme: string } | { method: "unavailable" };
  /** The release tag the server was deployed from, where it knows one. */
  version?: string;
}

export function serverDiscoveryV1(options: {
  brand: Pick<BrandV1, "productName" | "nativeScheme">;
  nativeSignIn: boolean;
  version?: string | undefined;
}): ServerDiscoveryV1 {
  return {
    schemaVersion: 1,
    name: options.brand.productName,
    protocol: { min: SUPPORTED_PROTOCOL_MIN, max: SUPPORTED_PROTOCOL_MAX },
    signIn: options.nativeSignIn
      ? { method: "browser-pkce", scheme: options.brand.nativeScheme }
      : { method: "unavailable" },
    ...(options.version ? { version: options.version } : {}),
  };
}

/**
 * The document's answer, ahead of the compatibility gate: an app outside the
 * protocol range is exactly who needs to read it.
 */
export function serverDiscoveryResponseV1(
  request: Request,
  document: ServerDiscoveryV1,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const response = Response.json(document, {
    headers: {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers: response.headers })
    : response;
}
