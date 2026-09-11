import { describe, expect, test } from "vitest";
import {
  openVoiceDictationRelayV1,
  type VoiceDictationLeaseV1,
} from "../src/voice-dictation.ts";

/**
 * A stand-in for the OpenAI Realtime transcription socket.
 *
 * It records the audio bytes it was appended and emits a delta per append.
 * Turn detection is the test's to drive: `vadCommit()` commits the audio so
 * far into a new item and answers its transcription after `answerDelayMs`,
 * and the relay's own commit after `stop` is answered the way `onCommit`
 * says: a new item, silence, the empty-buffer refusal, or a failure.
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
    raceBeforeStopAck?: boolean;
    onCommit?: "answer" | "silent" | "empty" | "fail";
    answerDelayMs?: number;
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
        () => complete(itemId, `heard ${heard.join(",")}`),
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
          if (sessionUpdates.length === 2 && options.raceBeforeStopAck) {
            const id = newItem();
            complete(id, "earlier turn");
          }
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
            () => complete(itemId, `heard ${heard.join(",")}`),
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

  test("an automatic commit racing Stop cannot finalize before the explicit commit", async () => {
    const upstream = fakeUpstream({ raceBeforeStopAck: true });
    const opened = openRelay(upstream);
    await ready(upstream, opened);
    opened.socket.send(pcm(9));
    opened.socket.send(stop);
    await opened.waitFor((f) => f.type === "final", "final");
    expect(upstream.commits).toBe(1);
    expect(opened.segments()).toEqual(["earlier turn", "heard 9"]);
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
