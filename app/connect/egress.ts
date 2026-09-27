// A connected account as the Computer's terminal reaches it: one HTTP request
// a CLI made, sent through the provider as that account. The provider
// attaches the credential, so it never reaches this deployment, let alone the
// Computer.
import {
  base64ToBytesV1,
  bytesToBase64V1,
  computerEgressMessageV1,
  type ComputerEgressRequestV1,
  type ComputerEgressResponseV1,
} from "@frockbot/computer/egress";
import type { ComposioClient, ProxyRequestInputV1 } from "./composio.js";

/** Request headers never forwarded: the provider sets its own auth and framing. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
]);

/** Answer headers a CLI relies on: paging, caching, rate limits, redirects. */
const KEPT_RESPONSE_HEADERS = new Set([
  "link",
  "etag",
  "last-modified",
  "location",
  "retry-after",
]);

/**
 * Sends one request as the account and relays the app's answer. A body the
 * provider cannot carry — anything but a JSON object — is refused before it
 * leaves, and the CLI is told why.
 */
export async function sendAsConnectedAccountV1(
  client: Pick<ComposioClient, "proxyRequest" | "readBinary">,
  connectedAccountId: string,
  request: ComputerEgressRequestV1,
  /** Absolute, or a path the provider resolves against the account's base URL. */
  endpoint: string,
): Promise<ComputerEgressResponseV1> {
  const url = new URL(request.url);
  let body: Record<string, unknown> | undefined;
  if (request.bodyBase64) {
    const text = new TextDecoder().decode(base64ToBytesV1(request.bodyBase64));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return computerEgressMessageV1(
        415,
        "Only JSON object request bodies can be sent through a connected account.",
      );
    }
    body = parsed as Record<string, unknown>;
  }
  const parameters: ProxyRequestInputV1["parameters"] = [];
  for (const [name, value] of url.searchParams) {
    parameters.push({ name, value, type: "query" });
  }
  for (const [name, value] of Object.entries(request.headers)) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
      parameters.push({ name, value, type: "header" });
    }
  }
  const result = await client.proxyRequest({
    connectedAccountId,
    endpoint,
    method: request.method as ProxyRequestInputV1["method"],
    ...(body ? { body } : {}),
    parameters,
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers)) {
    if (KEPT_RESPONSE_HEADERS.has(name) || name.startsWith("x-ratelimit-")) {
      headers[name] = value;
    }
  }
  if (result.binary) {
    return {
      status: result.status,
      headers: { ...headers, "content-type": result.binary.contentType },
      bodyBase64: bytesToBase64V1(await client.readBinary(result.binary.url)),
    };
  }
  const data = result.data;
  const text =
    data === null || data === undefined
      ? ""
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
  return {
    status: result.status,
    headers: {
      ...headers,
      "content-type":
        typeof data === "string" && result.headers["content-type"]
          ? result.headers["content-type"]
          : "application/json; charset=utf-8",
    },
    bodyBase64: bytesToBase64V1(new TextEncoder().encode(text)),
  };
}
