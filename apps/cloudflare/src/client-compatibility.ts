import {
  CLIENT_COMPATIBILITY,
  MINIMUM_NATIVE_VERSION,
  SUPPORTED_PROTOCOL_MAX,
  SUPPORTED_PROTOCOL_MIN,
  isProtocolValue,
} from "@frockbot/protocol-schemas";

export const CLIENT_HELLO_HEADER = "x-frockbot-client";
export const UPDATE_APP_MESSAGE = "Update the app to continue using FrockBot.";

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return true;
}

/** Version selection is compatibility, never authentication or a capability grant. */
export function clientCompatibilityResponse(
  request: Request,
  url: URL,
): Response | undefined {
  const header = request.headers.get(CLIENT_HELLO_HEADER);
  const nativeRoute =
    url.pathname.startsWith("/api/auth/native/") ||
    url.pathname.startsWith("/api/native/");
  if (header !== null || nativeRoute) {
    let hello: unknown;
    try {
      hello = header && header.length <= 4096 ? JSON.parse(header) : undefined;
    } catch {
      hello = undefined;
    }
    if (
      !isProtocolValue("ClientHello", hello) ||
      hello.protocolVersion < SUPPORTED_PROTOCOL_MIN ||
      hello.protocolVersion > SUPPORTED_PROTOCOL_MAX ||
      !versionAtLeast(hello.nativeVersion, MINIMUM_NATIVE_VERSION)
    ) {
      return new Response(UPDATE_APP_MESSAGE, {
        status: 426,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  }
  if (
    url.pathname === "/api/client-compatibility" &&
    request.method === "GET"
  ) {
    return Response.json(CLIENT_COMPATIBILITY, {
      headers: { "cache-control": "no-store" },
    });
  }
  return undefined;
}
