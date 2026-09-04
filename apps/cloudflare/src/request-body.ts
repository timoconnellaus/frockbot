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
 * Requests whose body has been handed to a subrequest.
 *
 * `new Request(request, init)` and `fetch(request)` pipe the incoming body
 * onward without ever setting `bodyUsed` on the request we were handed, so
 * `bodyUsed` cannot tell a forwarded body from an unread one. It has to be
 * recorded where the handoff happens.
 *
 * A `WeakSet` because the entry is worth exactly as long as the request is.
 */
const forwardedBodies = new WeakSet<Request>();

/**
 * Record that this request's body now belongs to a subrequest.
 *
 * Call it at every handoff, before awaiting the subrequest. Once the
 * subrequest has answered, the pipe is closed from the far end and touching
 * the near end — a cancel included — raises "Can't read from request stream
 * after response has been sent". That error surfaces on the isolate rather
 * than on the promise, so no `try`/`catch` around the cancel can contain it:
 * it took workerd down mid-suite, every run, on the one POST whose body no
 * route reads.
 */
export function forwardingBodyV1<T>(request: Request, forwarded: T): T {
  forwardedBodies.add(request);
  return forwarded;
}

/** Whether this request's body was handed on rather than read here. */
export function bodyWasForwardedV1(request: Request): boolean {
  return forwardedBodies.has(request);
}

/**
 * How many bytes a drain will read before it gives up and cancels.
 *
 * Generous: every route that admits a body of its own is bounded far below
 * this, so reaching it means a client is sending something no route wanted.
 * Past it the connection is worth less than the time spent reading it.
 */
const DRAIN_BUDGET_BYTES_V1 = 8 * 1024 * 1024;

/**
 * Read the body out and throw it away, a chunk at a time.
 *
 * Cancelling is not enough, and this is the whole lesson of the incident.
 * `cancel()` tears the stream down from the reading end; the writing end — the
 * gateway pumping the browser's bytes into the loaded application's isolate —
 * is still holding bytes it has not delivered when the response goes out, and
 * that is what workerd reports as "Can't read from request stream after
 * response has been sent". Reading to `done` is what actually retires the
 * pipe. Verified against the dev stack: with a cancel the error is on every
 * `POST /conversations`; with a read there is none.
 *
 * A reader loop rather than `arrayBuffer()`, so the bytes are dropped as they
 * arrive and a large body is never held whole.
 */
async function consumeBodyV1(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  let seen = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    seen += chunk.value?.byteLength ?? 0;
    if (seen > DRAIN_BUDGET_BYTES_V1) {
      await reader.cancel();
      return;
    }
  }
}

/**
 * Answer, having consumed the request's body.
 *
 * A body already read is left alone by `bodyUsed`; a body handed to a
 * subrequest is left alone by `forwardingBodyV1`, because that subrequest's
 * own wrapper is the one that owes it a read and the stream is no longer this
 * isolate's to touch. Anything else is drained here, and a drain that throws
 * anyway must never become the answer the client sees.
 */
export async function drainedAnswerV1(
  request: Request,
  response: Response,
): Promise<Response> {
  const body = request.body;
  if (body && !request.bodyUsed && !bodyWasForwardedV1(request)) {
    try {
      await consumeBodyV1(body);
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
