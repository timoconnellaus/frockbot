/** The hardened HTTP grant boundary shared by every host. */

import type {
  HttpGrantResponse,
  HttpRequestOptions,
  HttpServices,
} from "./definitions";

/** Limits applied to each host-side HTTP grant call. */
export interface HttpGrantLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Everything a host supplies to execute one approved `http.fetch` call. */
export interface HttpGrantExecution extends HttpGrantLimits {
  services: HttpServices;
  /** Package name used to prefix boundary errors. */
  prefix: string;
  send: (request: Request, service: string) => Response | Promise<Response>;
}

export const defaultHttpTimeoutMs = 5_000;
export const defaultHttpMaxResponseBytes = 1024 * 1024;

const allowedRequestFields = new Set(["method", "headers", "body"]);
const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const httpString = (
  value: unknown,
  what: string,
  prefix: string,
): string => {
  if (typeof value !== "string") {
    throw new Error(`${prefix}: ${what} must be a string`);
  }
  return value;
};

const plainRecord = (
  value: unknown,
  what: string,
  prefix: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${prefix}: ${what} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${prefix}: ${what} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

/** Decode only the request fields the grant's wire contract declares. */
export const decodeHttpRequestOptions = (
  value: unknown,
  prefix: string,
): HttpRequestOptions => {
  if (value === undefined) return {};
  const record = plainRecord(value, "HTTP request options", prefix);
  const unknown = Object.keys(record).find(
    (field) => !allowedRequestFields.has(field),
  );
  if (unknown) {
    throw new Error(
      `${prefix}: HTTP request field "${unknown}" is not allowed`,
    );
  }

  const method = record.method;
  if (
    method !== undefined &&
    (typeof method !== "string" || !httpToken.test(method))
  ) {
    throw new Error(`${prefix}: HTTP method must be a valid token`);
  }

  let headers: Record<string, string> | undefined;
  if (record.headers !== undefined) {
    const decoded = plainRecord(record.headers, "HTTP headers", prefix);
    headers = {};
    for (const [name, value] of Object.entries(decoded)) {
      headers[name] = httpString(value, `HTTP header "${name}"`, prefix);
    }
  }

  const body = record.body;
  if (
    body !== undefined &&
    typeof body !== "string" &&
    !(body instanceof ArrayBuffer)
  ) {
    throw new Error(`${prefix}: HTTP body must be a string or ArrayBuffer`);
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
  prefix: string,
) => {
  const limit = value ?? fallback;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`${prefix}: ${name} must be a positive number`);
  }
  return limit;
};

/** Read a response body without letting it grow past the host's limit. */
export const boundedResponseText = async (
  response: Response,
  maxBytes: number,
  prefix: string,
): Promise<string> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(`${prefix}: HTTP response exceeds ${maxBytes} bytes`);
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
        throw new Error(`${prefix}: HTTP response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

/**
 * Execute one approved `http.fetch` call: resolve the granted origin, attach
 * the server-held credential, refuse redirects, and read a bounded body under
 * a wall-clock deadline.
 */
export async function executeHttpGrantFetch(
  execution: HttpGrantExecution,
  service: unknown,
  path: unknown,
  rawOptions: unknown,
): Promise<HttpGrantResponse> {
  const { prefix } = execution;
  const name = httpString(service, "HTTP service", prefix);
  const policy = execution.services[name];
  if (!policy) throw new Error(`no service named "${name}" is granted`);

  const base = new URL(policy.origin);
  const url = new URL(httpString(path, "HTTP path", prefix), base);
  if (url.origin !== base.origin) {
    throw new Error(`HTTP path leaves the granted "${name}" origin`);
  }

  const decoded = decodeHttpRequestOptions(rawOptions, prefix);
  const headers = new Headers(decoded.headers);
  if (policy.credential) {
    headers.set(policy.credential.header, policy.credential.value);
  }
  const timeoutMs = positiveLimit(
    execution.timeoutMs,
    defaultHttpTimeoutMs,
    "HTTP deadline",
    prefix,
  );
  const maxResponseBytes = positiveLimit(
    execution.maxResponseBytes,
    defaultHttpMaxResponseBytes,
    "HTTP response limit",
    prefix,
  );
  const controller = new AbortController();
  const outgoing = new Request(url.toString(), {
    ...decoded,
    headers,
    redirect: "manual",
    signal: controller.signal,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await execution.send(outgoing, name);
        if (response.status >= 300 && response.status < 400) {
          throw new Error(
            `${prefix}: redirect from granted "${name}" service was refused`,
          );
        }
        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: await boundedResponseText(response, maxResponseBytes, prefix),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort("HTTP grant deadline exceeded");
          reject(new Error(`${prefix}: HTTP request exceeded ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
