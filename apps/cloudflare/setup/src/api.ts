/**
 * How the page reaches the account.
 *
 * Opened in a tab, the browser's own session reads it. Opened by the app,
 * the page arrives with a reader credential in its fragment (`#reader=`); it
 * is moved out of the address at once, kept for this tab only, and sent as a
 * bearer. When it expires the app that framed the page is asked for another.
 */

import { askHost, framedByApp } from "./bridge.ts";

const READER_KEY = "frockbot-setup-reader";

function stored(): string | undefined {
  try {
    return sessionStorage.getItem(READER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(token: string): void {
  try {
    sessionStorage.setItem(READER_KEY, token);
  } catch {
    // A tab that keeps nothing still has the credential in memory.
  }
}

let reader: string | undefined;

/** Takes the credential out of the address. Call once, before anything reads. */
export function adoptReader(): void {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fresh = hash.get("reader");
  if (fresh && /^[A-Za-z0-9_.-]{1,1024}$/.test(fresh)) {
    reader = fresh;
    store(fresh);
  } else {
    reader = stored();
  }
  if (location.hash)
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
}

export function hasReader(): boolean {
  return reader !== undefined;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function renewReader(): Promise<boolean> {
  if (!framedByApp()) return false;
  const answer = await askHost({ type: "renew" }, "reader", 15_000).catch(
    () => undefined,
  );
  const token = answer?.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{1,1024}$/.test(token))
    return false;
  reader = token;
  store(token);
  return true;
}

export async function api<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (reader) headers.authorization = `Bearer frockbot-setup.${reader}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      credentials: reader ? "omit" : "same-origin",
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError("Couldn’t reach FrockBot. Check your connection.", 0);
  }
  const text = await response.text();
  let value: unknown = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  if (!response.ok) {
    const record =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const code = typeof record.code === "string" ? record.code : undefined;
    if (
      response.status === 401 &&
      code === "setup-reader-expired" &&
      !retried &&
      (await renewReader())
    )
      return api<T>(path, options, true);
    throw new ApiError(
      typeof record.error === "string"
        ? record.error
        : `Something went wrong (${response.status}).`,
      response.status,
      code,
    );
  }
  return value as T;
}

export function newCommandId(): string {
  return crypto.randomUUID();
}
