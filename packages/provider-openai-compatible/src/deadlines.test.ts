// A Turn once hung for seventeen minutes with nothing on screen: there was no
// time bound anywhere on a model request, so a provider that accepted the call
// and then went quiet held the socket — and the Turn — open indefinitely.
//
// The timer is injected, so these tests assert the behaviour rather than
// waiting two minutes for it.
import { describe, expect, test } from "bun:test";
import {
  ModelRequestDeadlineError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { OpenAICompatibleProvider } from "./index.js";

const request: NormalizedModelRequest = {
  requestId: "request-1",
  provider: "openai-compatible",
  model: "test-model",
  system: "Be useful.",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

/** A clock the test advances by hand. */
function manualClock() {
  const pending = new Map<number, { run: () => void; due: number }>();
  let next = 1;
  let now = 0;
  return {
    schedule(run: () => void, milliseconds: number): () => void {
      const id = next++;
      pending.set(id, { run, due: now + milliseconds });
      return () => pending.delete(id);
    },
    /** Fire everything due at or before `now + milliseconds`. */
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [id, timer] of [...pending]) {
        if (timer.due <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
  };
}

/** Let the generator's own pump run: the clock here is manual, real time is not. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("a model request that produces nothing", () => {
  test("is abandoned at the first-byte deadline, naming the deadline as the reason", async () => {
    const clock = manualClock();
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example",
      deadlines: { firstByteMs: 120_000, idleMs: 120_000 },
      schedule: clock.schedule,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    });

    const streaming = collect(
      provider.stream(request, new AbortController().signal),
    );
    // The provider has been sent the request and has said nothing.
    clock.advance(120_000);

    const failure = await streaming.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelRequestDeadlineError);
    expect((failure as ModelRequestDeadlineError).phase).toBe("first-byte");
    expect((failure as Error).message).toBe(
      "Model request produced nothing within 120s",
    );
  });
});

describe("a model response that stalls mid-answer", () => {
  test("is abandoned at the idle deadline, not at the first-byte one", async () => {
    const clock = manualClock();
    let push: ((chunk: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example",
      deadlines: { firstByteMs: 10_000, idleMs: 60_000 },
      schedule: clock.schedule,
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });

    const events: unknown[] = [];
    const streaming = (async () => {
      for await (const event of provider.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })();

    push?.(
      'data: {"choices":[{"delta":{"content":"Half a "}}]}\n\ndata: {"choices":[{"delta":{"content":"thought"}}]}\n\n',
    );
    await settle();

    // Past the first-byte allowance, inside the idle one: the answer started,
    // so the clock it is being held to is the idle one.
    clock.advance(10_000);
    await settle();
    clock.advance(60_000);

    const failure = await streaming.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelRequestDeadlineError);
    expect((failure as ModelRequestDeadlineError).phase).toBe("idle");
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("a model request that finishes", () => {
  test("leaves no timer armed", async () => {
    const clock = manualClock();
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example",
      schedule: clock.schedule,
      fetch: () =>
        Promise.resolve(
          new Response(
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200 },
          ),
        ),
    });

    const events = await collect(
      provider.stream(request, new AbortController().signal),
    );

    expect(events.length).toBeGreaterThan(0);
    // A live timer in a Worker isolate holds the request open long after
    // anybody is listening for it.
    expect(clock.armed).toBe(0);
  });

  test("a caller's own Stop still reports the cancellation, not a deadline", async () => {
    const clock = manualClock();
    const caller = new AbortController();
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example",
      schedule: clock.schedule,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted by caller")),
          );
        }),
    });

    const streaming = collect(provider.stream(request, caller.signal));
    caller.abort(new Error("Stop"));

    const failure = await streaming.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(ModelRequestDeadlineError);
    expect(clock.armed).toBe(0);
  });
});
