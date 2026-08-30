import {
  isBotIdV1,
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "@frockbot/configuration-core";

export { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

const MAX_BODY_BYTES = 64 * 1024;
const AUTH_CALLBACK_PREFIX = "com.frockbot.desktop://auth/callback#";

export interface DesktopApiRequest {
  schemaVersion: 1;
  path: string;
  method: "GET" | "POST";
  body?: string;
}

export interface DesktopApiResponse {
  schemaVersion: 1;
  status: number;
  contentType: string | null;
  body: string;
}

export interface DesktopExternalAuthorizationRequest {
  schemaVersion: 1;
  url: string;
  nativeReturnNonce: string;
}

export interface DesktopExternalAuthorizationAcknowledgement {
  schemaVersion: 1;
  status: "accepted";
}

export interface DesktopAuthUserV1 {
  id: string;
  name: string;
  email: string;
}

export type DesktopAuthRequestV1 =
  | { schemaVersion: 1; type: "auth/get-user" }
  | { schemaVersion: 1; type: "auth/request"; provider?: string }
  | { schemaVersion: 1; type: "auth/sign-out" };

export interface DesktopAuthUserResponseV1 {
  schemaVersion: 1;
  type: "auth/user";
  user: DesktopAuthUserV1 | null;
}

export interface DesktopAuthAcknowledgementV1 {
  schemaVersion: 1;
  type: "auth/accepted";
}

export type DesktopAuthEventV1 =
  | {
      schemaVersion: 1;
      type: "auth/authenticated";
      user: DesktopAuthUserV1;
    }
  | {
      schemaVersion: 1;
      type: "auth/user-updated";
      user: DesktopAuthUserV1 | null;
    }
  | { schemaVersion: 1; type: "auth/error"; message: string };

export function decodeDesktopAuthCallbackToken(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || !value.startsWith(AUTH_CALLBACK_PREFIX)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "com.frockbot.desktop:" ||
    url.hostname !== "auth" ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.port ||
    url.search
  ) {
    return undefined;
  }
  const parameters = new URLSearchParams(url.hash.slice(1));
  const token = parameters.get("token");
  if (
    parameters.size !== 1 ||
    !token ||
    token.length > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    return undefined;
  }
  return token;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function decodeDesktopAuthUser(value: unknown): DesktopAuthUserV1 {
  const user = record(value);
  if (
    !user ||
    !hasExactKeys(user, ["id", "name", "email"]) ||
    !boundedString(user.id, 1, 256) ||
    !boundedString(user.name, 1, 256) ||
    !boundedString(user.email, 1, 320)
  ) {
    throw new Error("invalid desktop auth user");
  }
  return { id: user.id, name: user.name, email: user.email };
}

export function decodeDesktopAuthRequest(value: unknown): DesktopAuthRequestV1 {
  const request = record(value);
  if (!request || request.schemaVersion !== 1) {
    throw new Error("invalid desktop auth request");
  }
  if (request.type === "auth/get-user" || request.type === "auth/sign-out") {
    if (!hasExactKeys(request, ["schemaVersion", "type"])) {
      throw new Error("invalid desktop auth request");
    }
    return { schemaVersion: 1, type: request.type };
  }
  if (
    request.type !== "auth/request" ||
    !hasExactKeys(request, ["schemaVersion", "type"], ["provider"]) ||
    (request.provider !== undefined && !boundedString(request.provider, 1, 100))
  ) {
    throw new Error("invalid desktop auth request");
  }
  return {
    schemaVersion: 1,
    type: "auth/request",
    ...(request.provider === undefined ? {} : { provider: request.provider }),
  };
}

export function decodeDesktopAuthUserResponse(
  value: unknown,
): DesktopAuthUserResponseV1 {
  const response = record(value);
  if (
    !response ||
    !hasExactKeys(response, ["schemaVersion", "type", "user"]) ||
    response.schemaVersion !== 1 ||
    response.type !== "auth/user"
  ) {
    throw new Error("invalid desktop auth response");
  }
  return {
    schemaVersion: 1,
    type: "auth/user",
    user: response.user === null ? null : decodeDesktopAuthUser(response.user),
  };
}

export function decodeDesktopAuthAcknowledgement(
  value: unknown,
): DesktopAuthAcknowledgementV1 {
  const response = record(value);
  if (
    !response ||
    !hasExactKeys(response, ["schemaVersion", "type"]) ||
    response.schemaVersion !== 1 ||
    response.type !== "auth/accepted"
  ) {
    throw new Error("invalid desktop auth acknowledgement");
  }
  return { schemaVersion: 1, type: "auth/accepted" };
}

export function decodeDesktopAuthEvent(value: unknown): DesktopAuthEventV1 {
  const event = record(value);
  if (!event || event.schemaVersion !== 1) {
    throw new Error("invalid desktop auth event");
  }
  if (event.type === "auth/error") {
    if (
      !hasExactKeys(event, ["schemaVersion", "type", "message"]) ||
      !boundedString(event.message, 1, 2_000)
    ) {
      throw new Error("invalid desktop auth event");
    }
    return { schemaVersion: 1, type: "auth/error", message: event.message };
  }
  if (
    (event.type !== "auth/authenticated" &&
      event.type !== "auth/user-updated") ||
    !hasExactKeys(event, ["schemaVersion", "type", "user"]) ||
    (event.type === "auth/authenticated" && event.user === null)
  ) {
    throw new Error("invalid desktop auth event");
  }
  if (event.type === "auth/authenticated") {
    return {
      schemaVersion: 1,
      type: "auth/authenticated",
      user: decodeDesktopAuthUser(event.user),
    };
  }
  return {
    schemaVersion: 1,
    type: "auth/user-updated",
    user: event.user === null ? null : decodeDesktopAuthUser(event.user),
  };
}

export function decodeDesktopApiResponse(value: unknown): DesktopApiResponse {
  const response = record(value);
  if (
    !response ||
    !hasExactKeys(response, [
      "schemaVersion",
      "status",
      "contentType",
      "body",
    ]) ||
    response.schemaVersion !== 1 ||
    !Number.isInteger(response.status) ||
    (response.status as number) < 100 ||
    (response.status as number) > 599 ||
    (response.contentType !== null &&
      typeof response.contentType !== "string") ||
    typeof response.body !== "string"
  ) {
    throw new Error("invalid API response");
  }
  return {
    schemaVersion: 1,
    status: response.status as number,
    contentType: response.contentType as string | null,
    body: response.body,
  };
}

const exactRoute = (pattern: RegExp) => (path: string) => pattern.test(path);
function botRoute(path: string, pattern: RegExp, runIdIndex?: number): boolean {
  const match = pattern.exec(path);
  const botId = match?.[1];
  if (!isBotIdV1(botId)) return false;
  if (runIdIndex === undefined) return true;
  return isRpcIdentifier(match?.[runIdIndex]);
}

function pluginConnectionRoute(path: string, revoke: boolean): boolean {
  const match = (
    revoke
      ? /^\/api\/plugins\/([^/]+)\/connections\/([^/]+)\/revoke$/
      : /^\/api\/plugins\/([^/]+)\/connections$/
  ).exec(path);
  if (!isPublicIdentifier(match?.[1])) return false;
  return !revoke || isConnectionIdentifier(match?.[2]);
}

const API_ROUTES: Array<{
  matches(path: string): boolean;
  methods: ReadonlySet<DesktopApiRequest["method"]>;
}> = [
  { matches: exactRoute(/^\/app-manifest$/), methods: new Set(["GET"]) },
  { matches: exactRoute(/^\/api\/identity$/), methods: new Set(["GET"]) },
  {
    matches: exactRoute(/^\/api\/settings$/),
    methods: new Set(["GET", "POST"]),
  },
  {
    matches: exactRoute(/^\/api\/bots$/),
    methods: new Set(["GET", "POST"]),
  },
  {
    matches: (path) =>
      botRoute(
        path,
        /^\/api\/bots\/([^/]+)\/(turns|settings|notifications|sheep)$/,
      ),
    methods: new Set(["GET", "POST"]),
  },
  {
    matches: (path) =>
      botRoute(path, /^\/api\/bots\/([^/]+)\/turns\/([^/]+)$/, 2),
    methods: new Set(["GET"]),
  },
  {
    matches: (path) =>
      botRoute(
        path,
        /^\/api\/bots\/([^/]+)\/turns\/([^/]+)\/(reconcile|fence)$/,
        2,
      ),
    methods: new Set(["POST"]),
  },
  {
    matches: (path) => pluginConnectionRoute(path, false),
    methods: new Set(["POST"]),
  },
  {
    matches: (path) => pluginConnectionRoute(path, true),
    methods: new Set(["POST"]),
  },
];

export function decodeDesktopApiRequest(value: unknown): DesktopApiRequest {
  const request = record(value);
  if (
    !request ||
    !hasExactKeys(request, ["schemaVersion", "path", "method"], ["body"]) ||
    request.schemaVersion !== 1
  ) {
    throw new Error("invalid API request");
  }
  const route =
    typeof request.path === "string"
      ? API_ROUTES.find((candidate) =>
          candidate.matches(request.path as string),
        )
      : undefined;
  if (
    !route ||
    (request.method !== "GET" && request.method !== "POST") ||
    !route.methods.has(request.method) ||
    (request.body !== undefined &&
      (typeof request.body !== "string" ||
        new TextEncoder().encode(request.body).byteLength > MAX_BODY_BYTES))
  ) {
    throw new Error("invalid API request");
  }
  return {
    schemaVersion: 1,
    path: request.path as string,
    method: request.method,
    ...(request.body === undefined ? {} : { body: request.body as string }),
  };
}

export function decodeDesktopExternalAuthorizationRequest(
  value: unknown,
): DesktopExternalAuthorizationRequest {
  const request = record(value);
  if (
    !request ||
    !hasExactKeys(request, ["schemaVersion", "url", "nativeReturnNonce"]) ||
    request.schemaVersion !== 1 ||
    typeof request.url !== "string" ||
    !isPublicIdentifier(request.nativeReturnNonce)
  ) {
    throw new Error("invalid external authorization request");
  }
  return {
    schemaVersion: 1,
    url: request.url,
    nativeReturnNonce: request.nativeReturnNonce,
  };
}

export function decodeExternalAuthorizationAcknowledgement(
  value: unknown,
): DesktopExternalAuthorizationAcknowledgement {
  const acknowledgement = record(value);
  if (
    !acknowledgement ||
    !hasExactKeys(acknowledgement, ["schemaVersion", "status"]) ||
    acknowledgement.schemaVersion !== 1 ||
    acknowledgement.status !== "accepted"
  ) {
    throw new Error("invalid external authorization acknowledgement");
  }
  return { schemaVersion: 1, status: "accepted" };
}
