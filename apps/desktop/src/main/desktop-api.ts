const MAX_BODY_BYTES = 64 * 1024;

export interface DesktopApiRequest {
  path: string;
  method: "GET" | "POST";
  body?: string;
}

export interface DesktopApiResponse {
  status: number;
  contentType: string | null;
  body: string;
}

const API_ROUTES: Array<{
  pattern: RegExp;
  methods: ReadonlySet<DesktopApiRequest["method"]>;
}> = [
  { pattern: /^\/app-manifest$/, methods: new Set(["GET"]) },
  { pattern: /^\/api\/settings$/, methods: new Set(["GET", "POST"]) },
  {
    pattern: /^\/api\/bots\/[a-zA-Z0-9._-]+\/(turns|settings|notifications)$/,
    methods: new Set(["GET", "POST"]),
  },
  {
    pattern: /^\/api\/plugins\/[a-zA-Z0-9._-]+\/connections$/,
    methods: new Set(["POST"]),
  },
  {
    pattern:
      /^\/api\/plugins\/[a-zA-Z0-9._-]+\/connections\/[a-zA-Z0-9._-]+\/revoke$/,
    methods: new Set(["POST"]),
  },
];

export function decodeDesktopApiRequest(value: unknown): DesktopApiRequest {
  if (!value || typeof value !== "object") {
    throw new Error("invalid API request");
  }
  const request = value as Partial<DesktopApiRequest>;
  const route =
    typeof request.path === "string"
      ? API_ROUTES.find((candidate) => candidate.pattern.test(request.path!))
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
    path: request.path!,
    method: request.method,
    body: request.body,
  };
}

export function decodeExternalAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("invalid external authorization URL");
  }
  try {
    if (new URL(value).protocol !== "https:") throw new Error();
  } catch {
    throw new Error("invalid external authorization URL");
  }
  return value;
}
