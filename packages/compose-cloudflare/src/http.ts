import type {
  HttpGrantResponse,
  HttpOperation,
  HttpRequestOptions,
  HttpServices,
} from "@frockbot/compose-core/grants";

/** The structural service-binding surface used by the HTTP grant. */
export interface HttpBinding {
  fetch(request: Request): Response | Promise<Response>;
}

/** Limits applied to each host-side HTTP grant call. */
export interface HttpGrantLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HttpGrantEnvironment extends HttpGrantLimits {
  services: HttpServices;
  bindings?: Readonly<Record<string, HttpBinding>>;
  fetch?: (request: Request) => Response | Promise<Response>;
}

const defaultTimeoutMs = 5_000;
const defaultMaxResponseBytes = 1024 * 1024;
const allowedRequestFields = new Set(["method", "headers", "body"]);
const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const string = (value: unknown, what: string): string => {
  if (typeof value !== "string") {
    throw new Error(`@frockbot/compose-cloudflare: ${what} must be a string`);
  }
  return value;
};

const plainRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `@frockbot/compose-cloudflare: ${what} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `@frockbot/compose-cloudflare: ${what} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
};

/** Decode only the request fields the grant's wire contract declares. */
const requestOptions = (value: unknown): HttpRequestOptions => {
  if (value === undefined) return {};
  const record = plainRecord(value, "HTTP request options");
  const unknown = Object.keys(record).find(
    (field) => !allowedRequestFields.has(field),
  );
  if (unknown) {
    throw new Error(
      `@frockbot/compose-cloudflare: HTTP request field "${unknown}" is not allowed`,
    );
  }

  const method = record.method;
  if (
    method !== undefined &&
    (typeof method !== "string" || !httpToken.test(method))
  ) {
    throw new Error(
      "@frockbot/compose-cloudflare: HTTP method must be a valid token",
    );
  }

  let headers: Record<string, string> | undefined;
  if (record.headers !== undefined) {
    const decoded = plainRecord(record.headers, "HTTP headers");
    headers = {};
    for (const [name, value] of Object.entries(decoded)) {
      headers[name] = string(value, `HTTP header "${name}"`);
    }
  }

  const body = record.body;
  if (
    body !== undefined &&
    typeof body !== "string" &&
    !(body instanceof ArrayBuffer)
  ) {
    throw new Error(
      "@frockbot/compose-cloudflare: HTTP body must be a string or ArrayBuffer",
    );
  }
  return {
    ...(method === undefined ? {} : { method }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
};

const positiveLimit = (
  value: number | undefined,
  fallback: number,
  name: string,
) => {
  const limit = value ?? fallback;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(
      `@frockbot/compose-cloudflare: ${name} must be a positive number`,
    );
  }
  return limit;
};

const boundedText = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(
      `@frockbot/compose-cloudflare: HTTP response exceeds ${maxBytes} bytes`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `@frockbot/compose-cloudflare: HTTP response exceeds ${maxBytes} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

/** Execute one approved HTTP grant operation inside the trusted host. */
export async function performHttpGrant(
  environment: HttpGrantEnvironment,
  value: unknown,
): Promise<HttpGrantResponse> {
  const input = value as HttpOperation | null;
  if (input?.method !== "fetch" || !Array.isArray(input.args)) {
    throw new Error("@frockbot/compose-cloudflare: unknown http operation");
  }
  const [service, path, rawOptions] = input.args;
  const name = string(service, "HTTP service");
  const policy = environment.services[name];
  if (!policy) throw new Error(`no service named "${name}" is granted`);

  const base = new URL(policy.origin);
  const url = new URL(string(path, "HTTP path"), base);
  if (url.origin !== base.origin) {
    throw new Error(`HTTP path leaves the granted "${name}" origin`);
  }

  const decoded = requestOptions(rawOptions);
  const headers = new Headers(decoded.headers);
  if (policy.credential) {
    headers.set(policy.credential.header, policy.credential.value);
  }
  const timeoutMs = positiveLimit(
    environment.timeoutMs,
    defaultTimeoutMs,
    "HTTP deadline",
  );
  const maxResponseBytes = positiveLimit(
    environment.maxResponseBytes,
    defaultMaxResponseBytes,
    "HTTP response limit",
  );
  const controller = new AbortController();
  const outgoing = new Request(url.toString(), {
    ...decoded,
    headers,
    redirect: "manual",
    signal: controller.signal,
  });
  const binding = environment.bindings?.[name];
  const send = binding
    ? () => binding.fetch(outgoing)
    : () => (environment.fetch ?? fetch)(outgoing);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await send();
        if (response.status >= 300 && response.status < 400) {
          throw new Error(
            `@frockbot/compose-cloudflare: redirect from granted "${name}" service was refused`,
          );
        }
        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: await boundedText(response, maxResponseBytes),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort("HTTP grant deadline exceeded");
          reject(
            new Error(
              `@frockbot/compose-cloudflare: HTTP request exceeded ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
