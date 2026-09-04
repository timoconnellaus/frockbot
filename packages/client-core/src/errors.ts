/*
 * The client's one boundary between a failed request and a sentence a person
 * reads.
 *
 * Two habits produced the failures this module exists to stop. The first was
 * calling `response.json()` before looking at the response: a 502 whose body is
 * an HTML error page then fails inside `JSON.parse`, and what reached the
 * screen was `Unexpected token '<'` — a message about this client's own
 * parsing, in a place the User was told about their Bots. The second was
 * putting the server's `error` field on screen verbatim: a 500 whose body was
 * `{"error":"boom"}` rendered as the single red word `boom`.
 *
 * So: `readJsonResponseV1` is the only way a response becomes a value, and it
 * throws `TransportFailureV1` with the raw text kept out of the message;
 * `presentClientFailureV1` is the only way a caught error becomes text on a
 * surface. Callers pass what the User was trying to do — "load your plugins" —
 * and get one short sentence back. The raw detail stays on the error for the
 * console.
 */

/** What went wrong, at the coarseness a sentence can be written from. */
export type ClientFailureKindV1 =
  "offline" | "unreachable" | "server" | "denied" | "missing" | "rejected";

export interface ClientFailureV1 {
  readonly kind: ClientFailureKindV1;
  readonly status?: number;
  /** The raw text — for the console and for tests, never for the screen. */
  readonly detail: string;
  /**
   * The sentence the deployment wrote for a person, when it wrote one: the
   * `error` field of a refusal it decided on, like "Your message is too long."
   * A refusal is the product explaining a rule it holds, so that sentence is
   * the User's to read — unlike a fault's text, which is about plumbing. Only
   * set for a 4xx, and only when the body actually carried one.
   */
  readonly serverMessage?: string;
}

/** A request that did not produce a usable JSON body. */
export class TransportFailureV1 extends Error implements ClientFailureV1 {
  readonly kind: ClientFailureKindV1;
  readonly status?: number;
  readonly detail: string;
  readonly serverMessage?: string;
  /**
   * The server said this outcome is final, so a caller that retries pending
   * work must stop rather than try again. Carried through because the flock's
   * pending-create replay depends on it.
   */
  readonly definitive?: boolean;

  constructor(failure: ClientFailureV1 & { definitive?: boolean }) {
    // The message is the presentable sentence, so an error that escapes to a
    // `catch` that only reads `.message` still says something sane.
    super(presentClientFailureV1Kind(failure.kind));
    this.name = "TransportFailureV1";
    this.kind = failure.kind;
    if (failure.status !== undefined) this.status = failure.status;
    this.detail = failure.detail;
    if (failure.serverMessage !== undefined) {
      this.serverMessage = failure.serverMessage;
    }
    if (failure.definitive !== undefined) this.definitive = failure.definitive;
  }
}

function kindForStatusV1(status: number): ClientFailureKindV1 {
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || status === 410) return "missing";
  if (status === 408 || status === 429) return "unreachable";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  if (status >= 500) return "server";
  return "rejected";
}

function serverErrorStringV1(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  ) {
    const written = (value as { error: string }).error.trim();
    return written === "" ? undefined : written;
  }
  return undefined;
}

function isDefinitiveV1(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "definitive" in value &&
    (value as { definitive: unknown }).definitive === true
  );
}

/**
 * Read a response as JSON, or throw a failure that can be presented.
 *
 * The body is taken as text first so a non-JSON body is a *classified*
 * failure rather than a `SyntaxError` about this client's parser.
 */
export async function readJsonResponseV1(response: Response): Promise<unknown> {
  const body = await response.text().catch(() => "");
  let parsed: unknown;
  let readable = true;
  try {
    parsed = body.trim() === "" ? undefined : (JSON.parse(body) as unknown);
  } catch {
    readable = false;
  }
  if (!response.ok) {
    const written = readable ? serverErrorStringV1(parsed) : undefined;
    throw new TransportFailureV1({
      kind: kindForStatusV1(response.status),
      status: response.status,
      detail:
        written ??
        (readable
          ? `HTTP ${response.status}`
          : `HTTP ${response.status}: ${body.slice(0, 200)}`),
      // A refusal the deployment decided on, in words it chose for a person.
      // A fault's text is never that, whatever it happens to say.
      ...(written !== undefined && response.status < 500
        ? { serverMessage: written }
        : {}),
      ...(readable && isDefinitiveV1(parsed) ? { definitive: true } : {}),
    });
  }
  if (!readable) {
    // A 200 that is not JSON is something between this client and the
    // deployment answering — a proxy page, a captive portal, a stale worker.
    throw new TransportFailureV1({
      kind: "unreachable",
      status: response.status,
      detail: `Response body was not JSON: ${body.slice(0, 200)}`,
    });
  }
  return parsed;
}

/** What a caught value amounts to, whatever threw it. */
export function classifyClientFailureV1(error: unknown): ClientFailureV1 {
  if (error instanceof TransportFailureV1) return error;
  const detail =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  /*
   * A transport that is not this one may still have read a status and put it
   * on the error — the desktop bridge does, and so does anything that decodes
   * a refusal before throwing. A 4xx there means the same thing it means here:
   * the deployment read the request, refused it, and said why in words meant
   * for a person.
   */
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  if (status !== undefined && status >= 400) {
    return {
      kind: kindForStatusV1(status),
      status,
      detail,
      ...(status < 500 && detail !== "" ? { serverMessage: detail } : {}),
    };
  }
  // `fetch` rejects with a TypeError when the request never left, or never
  // came back. The browser's own offline flag is the only way to tell the two
  // apart, and it is advisory, so it only picks the wording.
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  if (error instanceof TypeError) {
    return { kind: offline ? "offline" : "unreachable", detail };
  }
  if (/JSON|Unexpected token/i.test(detail)) {
    return { kind: "unreachable", detail };
  }
  return { kind: offline ? "offline" : "rejected", detail };
}

function presentClientFailureV1Kind(
  kind: ClientFailureKindV1,
  action?: string,
): string {
  const doing = action ? ` ${action}` : "";
  switch (kind) {
    case "offline":
      return "You're offline. Reconnect and try again.";
    case "unreachable":
      return action
        ? `Couldn't${doing} — FrockBot didn't answer.`
        : "Couldn't reach FrockBot.";
    case "server":
      return action
        ? `Couldn't${doing}. Something went wrong at our end.`
        : "Something went wrong at our end.";
    case "denied":
      return "You're not signed in any more. Sign in again.";
    case "missing":
      return action
        ? `Couldn't${doing} — it isn't there.`
        : "That isn't there.";
    case "rejected":
      return action ? `Couldn't${doing}.` : "That didn't work.";
  }
}

/**
 * One short sentence for a failed request.
 *
 * `action` is what the User was doing, as a verb phrase that reads after
 * "Couldn't": `presentClientFailureV1(error, "load your plugins")`.
 */
export function presentClientFailureV1(
  error: unknown,
  action?: string,
): string {
  return presentClientFailureV1Kind(
    classifyClientFailureV1(error).kind,
    action,
  );
}

/**
 * The sentence the deployment wrote for a person, if it wrote one.
 *
 * Use it where a refusal's own reason is what the User needs — the send that
 * was too long, the plugin that needs another turned on first — and fall back
 * to `presentClientFailureV1`. A fault never carries one.
 */
export function serverRefusalMessageV1(error: unknown): string | undefined {
  return classifyClientFailureV1(error).serverMessage;
}

/** The raw text, for a console line or a log — never for a surface. */
export function clientFailureDetailV1(error: unknown): string {
  return classifyClientFailureV1(error).detail;
}
