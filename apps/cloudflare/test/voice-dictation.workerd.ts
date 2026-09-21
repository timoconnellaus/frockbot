import { describe, expect, test } from "vitest";
import { createFakeDictationCleanupJudgeV1 } from "@frockbot/app/supervision";
import {
  openVoiceDictationRelayV1,
  type VoiceDictationCleanupV1,
  type VoiceDictationLeaseV1,
  type VoiceDictationRelayOptions,
} from "../src/voice-dictation.ts";

/**
 * A stand-in for the OpenAI Realtime transcription socket.
 *
 * It records the audio bytes it was appended and emits a delta per append.
 * `vadCommit()` is a synthetic extra commit — the real upstream has no turn
 * detection and never commits on its own — kept so the relay's committed-order
 * handling stays covered: it closes the audio so far into a new item and
 * answers its transcription after `answerDelayMs`. The relay's own commit
 * after `stop` is answered the way `onCommit` says: a new item, silence, the
 * empty-buffer refusal, or a failure.
 */
interface FakeUpstream {
  socket: () => Promise<WebSocket>;
  appended: number[];
  sessionUpdates: unknown[];
  readonly commits: number;
  gate: { resolve: () => void; reject: (error: Error) => void };
  serverSide: () => WebSocket | undefined;
  /** Commit what was heard so far into a new item; returns its id. */
  vadCommit(): string;
  /** Answer an item's transcription now. */
  complete(itemId: string, text: string): void;
  failItem(itemId: string, message: string): void;
}

function fakeUpstream(
  options: {
    refuse?: boolean;
    onCommit?: "answer" | "silent" | "empty" | "fail";
    answerDelayMs?: number;
    /** What a committed item transcribes to, in place of "heard 1,2,3". */
    transcript?: string;
  } = {},
): FakeUpstream {
  const appended: number[] = [];
  const sessionUpdates: unknown[] = [];
  let commits = 0;
  let items = 0;
  let heardSinceCommit: number[] = [];
  let server: WebSocket | undefined;
  let release!: () => void;
  let refuse!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  const emit = (frame: Record<string, unknown>) =>
    server?.send(JSON.stringify(frame));
  const complete = (itemId: string, text: string) =>
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript: text,
    });
  const newItem = (): string => {
    items += 1;
    const itemId = `item_${items}`;
    emit({ type: "input_audio_buffer.committed", item_id: itemId });
    return itemId;
  };
  return {
    appended,
    sessionUpdates,
    get commits() {
      return commits;
    },
    gate: { resolve: release, reject: refuse },
    serverSide: () => server,
    vadCommit: () => {
      const itemId = newItem();
      const heard = heardSinceCommit;
      heardSinceCommit = [];
      setTimeout(
        () =>
          complete(itemId, options.transcript ?? `heard ${heard.join(",")}`),
        options.answerDelayMs ?? 0,
      );
      return itemId;
    },
    complete,
    failItem: (itemId, message) =>
      emit({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: itemId,
        error: { message },
      }),
    socket: async () => {
      if (options.refuse) throw new Error("refused");
      await gate;
      const pair = new WebSocketPair();
      const [client, upstream] = Object.values(pair);
      server = upstream;
      upstream.accept();
      upstream.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as {
          type: string;
          audio?: string;
        };
        if (frame.type === "session.update") {
          sessionUpdates.push(frame);
          emit({ type: "session.updated" });
          return;
        }
        if (frame.type === "input_audio_buffer.append") {
          const bytes = atob(frame.audio ?? "");
          appended.push(bytes.charCodeAt(0));
          heardSinceCommit.push(bytes.charCodeAt(0));
          emit({
            type: "conversation.item.input_audio_transcription.delta",
            delta: `d${bytes.charCodeAt(0)}`,
            item_id: `item_${items + 1}`,
          });
          return;
        }
        if (frame.type === "input_audio_buffer.commit") {
          commits += 1;
          const mode = options.onCommit ?? "answer";
          if (mode === "silent") return;
          if (mode === "empty") {
            emit({
              type: "error",
              error: {
                code: "input_audio_buffer_commit_empty",
                message: "the buffer is empty",
              },
            });
            return;
          }
          if (mode === "fail") {
            emit({ type: "error", error: { message: "provider exploded" } });
            return;
          }
          const itemId = newItem();
          const heard = heardSinceCommit;
          heardSinceCommit = [];
          setTimeout(
            () =>
              complete(
                itemId,
                options.transcript ?? `heard ${heard.join(",")}`,
              ),
            options.answerDelayMs ?? 0,
          );
        }
      });
      client.accept();
      return client;
    },
  };
}

function fakeLease(options: { refuse?: string; renewOk?: boolean } = {}) {
  const calls: string[] = [];
  const lease: VoiceDictationLeaseV1 = {
    acquire: async () => {
      calls.push("acquire");
      return options.refuse
        ? { status: "refused", reason: options.refuse }
        : { status: "acquired" };
    },
    renew: async () => {
      calls.push("renew");
      return options.renewOk ?? true;
    },
    release: async (activeSeconds) => {
      calls.push(`release:${activeSeconds >= 0 ? "ok" : "bad"}`);
    },
  };
  return { lease, calls };
}

/**
 * A stand-in for the model that tidies a transcript.
 *
 * `answer` is what comes back, `refuse` stands for an account with no tidy-up
 * allowance left, and `fail` for a gateway that threw. `hang` never answers
 * until it is aborted, which is how the deadline is exercised.
 */
function fakeCleanup(
  options: {
    answer?: string;
    refuse?: boolean;
    fail?: boolean;
    hang?: boolean;
  } = {},
) {
  const asked: Record<string, unknown>[] = [];
  let aborted = false;
  const cleanup: VoiceDictationCleanupV1 = {
    run: async (body, signal) => {
      asked.push(body);
      if (options.refuse) return undefined;
      if (options.fail) throw new Error("the gateway exploded");
      if (options.hang) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      }
      return options.answer ?? "";
    },
  };
  return {
    cleanup,
    asked,
    get aborted() {
      return aborted;
    },
  };
}

interface Opened {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    label: string,
  ): Promise<Record<string, unknown>>;
  closed: Promise<number>;
  segments(): string[];
}

function openRelay(
  upstream: FakeUpstream,
  env: { OPENAI_API_KEY?: string } = { OPENAI_API_KEY: "sk-test" },
  extra: {
    connectTimeoutMs?: number;
    finalTimeoutMs?: number;
    leaseRenewMs?: number;
    lease?: VoiceDictationLeaseV1;
    cleanup?: VoiceDictationCleanupV1;
    cleanupJudge?: VoiceDictationRelayOptions["cleanupJudge"];
    cleanupTimeoutMs?: number;
    maxCaptureMs?: number;
    now?: () => number;
  } = {},
): Opened {
  const response = openVoiceDictationRelayV1(
    new Request("https://bot.frockbot.com/api/voice/dictation", {
      headers: { upgrade: "websocket" },
    }),
    { env, connectUpstream: upstream.socket, ...extra },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
  return {
    socket,
    frames,
    closed,
    segments: () =>
      frames.filter((f) => f.type === "segment").map((f) => String(f.text)),
    waitFor(predicate, label) {
      const seen = frames.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          5_000,
        );
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

function pcm(tag: number): ArrayBuffer {
  const buffer = new Uint8Array(1536);
  buffer[0] = tag;
  return buffer.buffer;
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const start = JSON.stringify({
  schemaVersion: 1,
  type: "start",
  sampleRate: 24000,
});
const stop = JSON.stringify({ schemaVersion: 1, type: "stop" });

async function ready(upstream: FakeUpstream, opened: Opened) {
  opened.socket.send(start);
  upstream.gate.resolve();
  await opened.waitFor((f) => f.type === "ready", "ready");
}

describe("the dictation relay", () => {
  test("holds opening audio in order until the upstream accepts, then streams", async () => {
    const upstream = fakeUpstream();
    const opened = openRelay(upstream);
    opened.socket.send(start);
    opened.socket.send(pcm(1));
    opened.socket.send(pcm(2));
    await settle();
    expect(upstream.appended).toEqual([]);
    upstream.gate.resolve();
    await opened.waitFor((f) => f.type === "ready", "ready");
    await opened.waitFor(
      (f) => f.type === "delta" && f.text === "d1d2",
      "second delta",
    );
    expect(upstream.sessionUpdates).toHaveLength(1);
    expect(upstream.appended).toEqual([1, 2]);
    opened.socket.send(pcm(3));
    await opened.waitFor(
      (f) => f.type === "delta" && f.text === "d1d2d3",
      "third delta",
    );
    expect(upstream.appended).toEqual([1, 2, 3]);
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    expect(upstream.commits).toBe(1);
    expect(opened.segments()).toEqual(["heard 1,2,3"]);
    expect(opened.frames.at(-1)).toEqual({ schemaVersion: 1, type: "final" });
    expect(await opened.closed).toBe(1000);
  });

  test("a stop before the upstream is ready still commits what was captured", async () => {
    const upstream = fakeUpstream();
    const opened = openRelay(upstream);
    opened.socket.send(start);
    opened.socket.send(pcm(7));
    opened.socket.send(stop);
    await settle();
    upstream.gate.resolve();
    await opened.waitFor((f) => f.type === "final", "final");
    expect(upstream.appended).toEqual([7]);
    expect(upstream.commits).toBe(1);
    expect(opened.segments()).toEqual(["heard 7"]);
  });

  test("waits for every committed item, and hands segments over in committed order", async () => {
    // Two turns the upstream detected itself are still being transcribed
    // when the person presses stop; the relay's own commit makes a third.
    const upstream = fakeUpstream({ answerDelayMs: 5 });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    await opened.waitFor((f) => f.type === "delta" && f.text === "d1", "d1");
    upstream.vadCommit();
    opened.socket.send(pcm(2));
    await opened.waitFor((f) => f.type === "delta" && f.text === "d1 d2", "d2");
    upstream.vadCommit();
    opened.socket.send(pcm(3));
    await opened.waitFor(
      (f) => f.type === "delta" && f.text === "d1 d2 d3",
      "d3",
    );
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    expect(upstream.commits).toBe(1);
    expect(opened.segments()).toEqual(["heard 1", "heard 2", "heard 3"]);
  });

  test("a completion that arrives out of order is delivered in order, and final waits for the slow one", async () => {
    const upstream = fakeUpstream({ onCommit: "silent" });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    // Drive the items by hand so the second answers before the first.
    const server = upstream.serverSide()!;
    server.send(
      JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a" }),
    );
    server.send(
      JSON.stringify({ type: "input_audio_buffer.committed", item_id: "b" }),
    );
    opened.socket.send(stop);
    await settle();
    // The relay's commit is acknowledged as a third item, then b answers.
    server.send(
      JSON.stringify({ type: "input_audio_buffer.committed", item_id: "c" }),
    );
    upstream.complete("b", "second");
    await settle();
    expect(opened.segments()).toEqual([]);
    expect(opened.frames.some((f) => f.type === "final")).toBe(false);
    upstream.complete("a", "first");
    await settle();
    expect(opened.segments()).toEqual(["first", "second"]);
    expect(opened.frames.some((f) => f.type === "final")).toBe(false);
    upstream.complete("c", "third");
    await opened.waitFor((f) => f.type === "final", "final");
    expect(opened.segments()).toEqual(["first", "second", "third"]);
  });

  test("a stop whose last commit finds nothing is complete once the earlier items answer", async () => {
    const upstream = fakeUpstream({ onCommit: "empty", answerDelayMs: 30 });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    opened.socket.send(pcm(4));
    await opened.waitFor((f) => f.type === "delta" && f.text === "d4", "d4");
    upstream.vadCommit();
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    expect(opened.segments()).toEqual(["heard 4"]);
    expect(opened.frames.some((f) => f.type === "error")).toBe(false);
  });

  test("a provider failure after stop is reported as incomplete, and the draft keeps what arrived", async () => {
    const upstream = fakeUpstream({ onCommit: "fail" });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    opened.socket.send(pcm(5));
    await opened.waitFor((f) => f.type === "delta" && f.text === "d5", "d5");
    upstream.vadCommit();
    await opened.waitFor((f) => f.type === "segment", "segment");
    opened.socket.send(stop);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("upstream");
    expect(String(error.message)).toContain("What arrived is in your draft");
    expect(opened.frames.some((f) => f.type === "final")).toBe(false);
    expect(opened.segments()).toEqual(["heard 5"]);
  });

  test("a stop the upstream never finishes is a timeout, not a final", async () => {
    const quiet = fakeUpstream({ onCommit: "silent" });
    const opened = openRelay(quiet, undefined, { finalTimeoutMs: 100 });
    await ready(quiet, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("timeout");
    expect(quiet.commits).toBe(1);
    expect(opened.frames.some((f) => f.type === "final")).toBe(false);
  });

  test("an item the provider cannot transcribe is a notice; the rest still completes", async () => {
    const upstream = fakeUpstream({ onCommit: "empty" });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    const server = upstream.serverSide()!;
    server.send(
      JSON.stringify({ type: "input_audio_buffer.committed", item_id: "x" }),
    );
    server.send(
      JSON.stringify({ type: "input_audio_buffer.committed", item_id: "y" }),
    );
    upstream.failItem("x", "too noisy");
    upstream.complete("y", "fine");
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    expect(opened.frames.some((f) => f.type === "notice")).toBe(true);
    expect(opened.segments()).toEqual(["fine"]);
  });

  test("an unconfigured deployment says so and closes", async () => {
    const upstream = fakeUpstream();
    const opened = openRelay(upstream, {});
    opened.socket.send(start);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("unconfigured");
    expect(String(error.message)).toContain("isn't set up");
    await opened.closed;
  });

  test("audio before start is a protocol error", async () => {
    const upstream = fakeUpstream();
    const opened = openRelay(upstream);
    opened.socket.send(pcm(1));
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("protocol");
  });

  test("an upstream that never accepts times out with a retryable message", async () => {
    const upstream = fakeUpstream();
    const opened = openRelay(upstream, undefined, { connectTimeoutMs: 100 });
    opened.socket.send(start);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("timeout");
  });

  test("an upstream that refuses, or drops the session mid-capture, is an error", async () => {
    const refused = fakeUpstream({ refuse: true });
    const opened = openRelay(refused);
    opened.socket.send(start);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("upstream");

    const dropped = fakeUpstream();
    const third = openRelay(dropped);
    await ready(dropped, third);
    dropped.serverSide()!.close(1000, "gone");
    const closedError = await third.waitFor((f) => f.type === "error", "error");
    expect(closedError.code).toBe("upstream");
  });

  test("the account lease is taken before the provider is opened, renewed, and released", async () => {
    const upstream = fakeUpstream();
    const { lease, calls } = fakeLease();
    const opened = openRelay(upstream, undefined, { lease, leaseRenewMs: 30 });
    opened.socket.send(start);
    await settle();
    expect(calls).toEqual(["acquire"]);
    upstream.gate.resolve();
    await opened.waitFor((f) => f.type === "ready", "ready");
    await settle(80);
    expect(calls.filter((c) => c === "renew").length).toBeGreaterThanOrEqual(2);
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    await settle();
    expect(calls.at(-1)).toBe("release:ok");
  });

  test("a refused lease never opens the provider; a refused renewal ends the capture", async () => {
    const upstream = fakeUpstream();
    const { lease, calls } = fakeLease({
      refuse: "Dictation is already running elsewhere.",
    });
    const opened = openRelay(upstream, undefined, { lease });
    opened.socket.send(start);
    const error = await opened.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("limit");
    expect(String(error.message)).toContain("already running");
    expect(upstream.serverSide()).toBeUndefined();
    expect(calls).toEqual(["acquire"]);

    const second = fakeUpstream();
    const renewal = fakeLease({ renewOk: false });
    const capture = openRelay(second, undefined, {
      lease: renewal.lease,
      leaseRenewMs: 30,
    });
    await ready(second, capture);
    const limit = await capture.waitFor((f) => f.type === "error", "limit");
    expect(limit.code).toBe("limit");
    await settle();
    expect(renewal.calls.at(-1)).toBe("release:ok");
  });
});

// Tidying the finished capture. The relay owns what is asked for and what is
// accepted back; the model itself is a stand-in here, because the property
// worth testing is that none of these paths can cost the person their words.
describe("tidying a finished capture", () => {
  const RAW =
    "um so I I think we should check the Friday flights but don't book anything yet";
  const TIDY =
    "So I think we should check the Friday flights, but don't book anything yet.";

  test("says it is tidying, then hands the tidied span over before final", async () => {
    const upstream = fakeUpstream({ transcript: RAW });
    const model = fakeCleanup({ answer: TIDY });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
        cleanupJudge: createFakeDictationCleanupJudgeV1({
          verdict: "faithful",
        }),
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");

    expect(opened.segments()).toEqual([RAW]);
    const order = opened.frames
      .map((f) => String(f.type))
      .filter((type) =>
        ["segment", "cleaning", "cleaned", "final"].includes(type),
      );
    expect(order).toEqual(["segment", "cleaning", "cleaned", "final"]);
    expect(opened.frames.find((f) => f.type === "cleaned")).toEqual({
      schemaVersion: 1,
      type: "cleaned",
      text: TIDY,
    });
    // It was asked about the capture's own words, and only those.
    const asked = model.asked[0] as { messages: { content: string }[] };
    expect(asked.messages[1]!.content).toContain(RAW);
    expect(await opened.closed).toBe(1000);
  });

  // Every one of these is a way the tidy-up can go wrong. All of them end the
  // same way: final, no cleaned frame, and the raw segment standing.
  test.each([
    [
      "Jev refuses the tidy",
      fakeCleanup({ answer: "Check the Friday flights and book them." }),
      createFakeDictationCleanupJudgeV1({ verdict: "unfaithful" }),
    ],
    [
      "Jev is unavailable",
      fakeCleanup({ answer: TIDY }),
      createFakeDictationCleanupJudgeV1({ verdict: "unavailable" }),
    ],
    ["there is no Jev judge", fakeCleanup({ answer: TIDY }), undefined],
    [
      "the account has no tidy-up allowance left",
      fakeCleanup({ refuse: true }),
      createFakeDictationCleanupJudgeV1({ verdict: "faithful" }),
    ],
    [
      "the gateway failed",
      fakeCleanup({ fail: true }),
      createFakeDictationCleanupJudgeV1({ verdict: "faithful" }),
    ],
  ])("keeps the raw transcript when %s", async (_label, model, judge) => {
    const upstream = fakeUpstream({ transcript: RAW });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
        cleanupJudge: judge,
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");

    expect(opened.segments()).toEqual([RAW]);
    expect(opened.frames.some((f) => f.type === "cleaned")).toBe(false);
    expect(await opened.closed).toBe(1000);
  });

  // The person is watching a draft they can already read. A model that does
  // not answer loses its turn rather than the person's patience.
  test("gives up on a model that does not answer in time", async () => {
    const upstream = fakeUpstream({ transcript: RAW });
    const model = fakeCleanup({ hang: true });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
        cleanupTimeoutMs: 40,
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");

    expect(model.aborted).toBe(true);
    expect(opened.segments()).toEqual([RAW]);
    expect(opened.frames.some((f) => f.type === "cleaned")).toBe(false);
  });

  // The stop deadline exists to report a capture the provider never finished.
  // A capture that *is* finished and is merely being tidied must not trip it,
  // or the person is told dictation failed over the top of a working draft.
  test("the stop deadline does not fire over a tidy-up in progress", async () => {
    const upstream = fakeUpstream({ transcript: RAW });
    const model = fakeCleanup({ answer: TIDY });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
        cleanupJudge: createFakeDictationCleanupJudgeV1({
          verdict: "faithful",
        }),
        // Shorter than the tidy-up would ever be, had it stayed armed.
        finalTimeoutMs: 30,
        cleanupTimeoutMs: 5_000,
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "cleaning", "cleaning");
    await settle(80);
    await opened.waitFor((f) => f.type === "final", "final");

    expect(opened.frames.some((f) => f.type === "error")).toBe(false);
    expect(opened.frames.some((f) => f.type === "cleaned")).toBe(true);
  });

  // Two words are not worth a model call, and the person should not watch a
  // "finishing" state for them either.
  test("does not ask about a capture too short to be worth it", async () => {
    const upstream = fakeUpstream({ transcript: "book it" });
    const model = fakeCleanup({ answer: TIDY });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");

    expect(model.asked).toHaveLength(0);
    expect(opened.frames.some((f) => f.type === "cleaning")).toBe(false);
    expect(opened.segments()).toEqual(["book it"]);
  });

  // The dictation meter counts the seconds a microphone was open. A tidy-up
  // happens after the last word, with nothing being sent, so the wait for it
  // must not be booked against the account's daily dictation allowance.
  test("does not meter the tidy-up wait as dictation seconds", async () => {
    const upstream = fakeUpstream({ transcript: RAW });
    let clock = 0;
    let released: number | undefined;
    const lease: VoiceDictationLeaseV1 = {
      acquire: async () => ({ status: "acquired" }),
      renew: async () => true,
      release: async (activeSeconds) => {
        released = activeSeconds;
      },
    };
    const cleanup: VoiceDictationCleanupV1 = {
      run: async () => {
        clock += 8_000;
        return TIDY;
      },
    };
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup,
        cleanupJudge: createFakeDictationCleanupJudgeV1({
          verdict: "faithful",
        }),
        lease,
        now: () => clock,
      },
    );
    await ready(upstream, opened);
    clock += 2_000;
    opened.socket.send(pcm(1));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    await settle(10);

    expect(opened.frames.some((f) => f.type === "cleaned")).toBe(true);
    expect(released).toBe(2);
  });

  // A capture cut off at five minutes is not one whose false starts we can
  // tell from its words, and the person is being told why it ended. Tidying
  // on top of that would replace the message they need to read.
  test("does not tidy a capture the five-minute cap ended", async () => {
    const upstream = fakeUpstream({ transcript: RAW });
    const model = fakeCleanup({ answer: TIDY });
    const opened = openRelay(
      upstream,
      { OPENAI_API_KEY: "sk-test" },
      {
        cleanup: model.cleanup,
        maxCaptureMs: 30,
      },
    );
    await ready(upstream, opened);
    opened.socket.send(pcm(1));
    const error = await opened.waitFor((f) => f.type === "error", "limit");

    expect(error.code).toBe("limit");
    expect(model.asked).toHaveLength(0);
    expect(opened.segments()).toEqual([RAW]);
  });
});
