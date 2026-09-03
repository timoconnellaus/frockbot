/**
 * Answering a request without reading it.
 *
 * workerd tears the whole isolate down — "Can't read from request stream after
 * response has been sent" — when a handler answers a request whose body it
 * never touched. Every early return is such a handler: a body refused for its
 * size before it was parsed, a bad origin, a 404 on a POST. A 111 KB message
 * took the dev stack down twice this way, because the size refusal that
 * answered it 400 was the one path guaranteed never to read the body.
 *
 * So the drain is not per-route diligence. It is one helper on the outermost
 * wrapper of each Worker in the request path — the gateway and the loaded User
 * application are separate isolates with separate `Request` objects, and both
 * have to drain their own.
 */

/** The longest message a Turn will carry. */
export const TURN_TEXT_MAX_CHARACTERS_V1 = 32_000;

/**
 * The largest body the send route will read.
 *
 * Generous over the text limit because the same JSON also carries a command
 * id, Skill refs and the supersede intent; a body past it cannot contain an
 * acceptable `text` no matter how it is shaped.
 */
export const TURN_BODY_MAX_BYTES_V1 = TURN_TEXT_MAX_CHARACTERS_V1 * 2;

export const TURN_SEND_PATH_V1 = /^\/api\/bots\/[^/]+\/turns$/;

/**
 * What the composer shows when a send is refused for size.
 *
 * A person wrote too much. That is not a fault and not a server error, so the
 * answer is 413 with a sentence that says what to do about it, rather than a
 * 400 naming a byte budget nobody chose.
 */
export const TURN_TOO_LONG_MESSAGE_V1 = `Your message is too long. Keep it under ${TURN_TEXT_MAX_CHARACTERS_V1.toLocaleString("en-US")} characters.`;

/** A size refusal, told apart from an unreadable body. */
export class RequestTooLargeError extends Error {
  override readonly name = "RequestTooLargeError";
  constructor(message = TURN_TOO_LONG_MESSAGE_V1) {
    super(message);
  }
}

export function isRequestTooLargeV1(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "RequestTooLargeError"
  );
}

/**
 * Answer, having disturbed the request's body.
 *
 * Cancelling rather than reading is deliberate: the bytes are not wanted, only
 * the stream's disturbance is, and cancelling an oversized body never
 * allocates it. A body already consumed — or already handed to a subrequest —
 * reports `bodyUsed` and is left alone, and a cancel that throws anyway must
 * never become the answer the client sees.
 */
export async function drainedAnswerV1(
  request: Request,
  response: Response,
): Promise<Response> {
  if (request.body && !request.bodyUsed) {
    try {
      await request.body.cancel();
    } catch {
      // The stream was already gone. The answer stands either way.
    }
  }
  return response;
}

/**
 * A declared body too large to be worth reading.
 *
 * Content-Length is what a browser's `fetch` always sends for a string body,
 * which is every send the composer makes. A chunked request declaring no
 * length falls through to the route's own decoder, which is bounded too — this
 * guard exists so the common oversized send is never parsed at all.
 */
export function turnBodyIsOversizedV1(request: Request, url: URL): boolean {
  if (request.method !== "POST") return false;
  if (!TURN_SEND_PATH_V1.test(url.pathname)) return false;
  const declared = Number(request.headers.get("content-length") ?? "");
  return Number.isFinite(declared) && declared > TURN_BODY_MAX_BYTES_V1;
}
