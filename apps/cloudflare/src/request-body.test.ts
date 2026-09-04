// The drain, pinned at the one behaviour that fixed the incident.
//
// `POST /conversations` carries `{"schemaVersion":1}` and no route reads it.
// The gateway pumps those bytes into the loaded application's isolate, and
// when that isolate answered without reading them workerd logged, on every
// single request:
//
//   ✘ [ERROR] Uncaught TypeError: Can't read from request stream after
//     response has been sent.
//
// followed by a broken pipe and `wrangler dev exited unexpectedly (code 1)`.
// The wrapper was already calling `drainedAnswerV1` — and still crashed —
// because it cancelled the body instead of reading it. Cancelling tears down
// the reading end and leaves the writing end holding undelivered bytes; only
// a read to `done` retires the pipe. That is the distinction these tests
// exist to keep, because both spellings look like "the body was disturbed"
// and only one of them is.
import { describe, expect, test } from "bun:test";
import {
  bodyWasForwardedV1,
  drainedAnswerV1,
  forwardingBodyV1,
} from "./request-body.js";

/** A body that reports what was done to it. */
function watchedBody(chunks: string[]) {
  const record = { read: 0, cancelled: false };
  const encoder = new TextEncoder();
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close();
        return;
      }
      record.read += 1;
      controller.enqueue(encoder.encode(chunks[next]!));
      next += 1;
    },
    cancel() {
      record.cancelled = true;
    },
  });
  return { record, stream };
}

function postWith(stream: ReadableStream<Uint8Array>): Request {
  return new Request("https://frockbot.test/api/bots/a/conversations", {
    method: "POST",
    body: stream,
    // Required for a streaming request body; the gateway's own forwarded
    // requests carry the same.
    duplex: "half",
  } as RequestInit);
}

describe("answering without reading the body", () => {
  test("reads the body to the end rather than cancelling it", async () => {
    const { record, stream } = watchedBody(["one", "two", "three"]);
    const request = postWith(stream);

    const answer = await drainedAnswerV1(request, new Response("ok"));

    expect(await answer.text()).toBe("ok");
    // Every chunk pulled: the pipe is retired, which a cancel would not do.
    expect(record.read).toBe(3);
    expect(record.cancelled).toBe(false);
  });

  test("leaves a body the handler already read alone", async () => {
    const { record, stream } = watchedBody(['{"schemaVersion":1}']);
    const request = postWith(stream);
    expect(await request.json<unknown>()).toEqual({ schemaVersion: 1 });

    await drainedAnswerV1(request, new Response("ok"));

    expect(record.cancelled).toBe(false);
  });

  test("leaves a body handed to a subrequest alone", async () => {
    // The far end owes this one a read. Reaching for it here is the same
    // "after response has been sent" error by another route: by the time the
    // subrequest has answered, the stream is not this isolate's to touch.
    const { record, stream } = watchedBody(["one", "two", "three"]);
    const request = postWith(stream);
    expect(bodyWasForwardedV1(request)).toBe(false);

    const forwarded = forwardingBodyV1(request, "handed on");

    expect(forwarded).toBe("handed on");
    expect(bodyWasForwardedV1(request)).toBe(true);

    await drainedAnswerV1(request, new Response("ok"));

    // Untouched: nothing cancelled the stream out from under the subrequest
    // that now owns it.
    expect(record.cancelled).toBe(false);
  });

  test("answers even when the body cannot be drained", async () => {
    const request = postWith(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("the stream was already gone");
        },
      }),
    );

    const answer = await drainedAnswerV1(request, new Response("ok"));

    // A failed drain is never what the client hears about.
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe("ok");
  });
});
