import { describe, expect, test } from "bun:test";
import {
  createSleepingTranscriberV1,
  type VoiceTranscriberSessionOptionsV1,
  type VoiceTranscriberV1,
} from "./sleeping-transcriber.js";

interface FakeSession {
  fed: number[];
  closed: boolean;
  ready: () => void;
  fail: (error: Error) => void;
  options: VoiceTranscriberSessionOptionsV1;
}

function fakeTranscriber(): VoiceTranscriberV1 & { sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    createSession(options = {}) {
      let ready!: () => void;
      let fail!: (error: Error) => void;
      const readiness = new Promise<void>((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
      const session: FakeSession = {
        fed: [],
        closed: false,
        ready,
        fail,
        options,
      };
      sessions.push(session);
      return {
        feed: (chunk) => session.fed.push(new Uint8Array(chunk)[0]!),
        waitUntilReady: () => readiness,
        close: () => {
          session.closed = true;
        },
      };
    },
  };
}

function frame(tag: number): ArrayBuffer {
  return new Uint8Array([tag, 0]).buffer;
}

function clock() {
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as { at: number; run: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
      }
    },
  };
}

describe("the sleeping transcriber", () => {
  test("opens on the first frame and drains held frames in order once ready", async () => {
    const inner = fakeTranscriber();
    const time = clock();
    const states: string[] = [];
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      onState: (state) => states.push(state),
      ...time,
    }).createSession({});
    expect(session.state).toBe("asleep");
    session.feed(frame(1));
    session.feed(frame(2));
    expect(session.state).toBe("starting");
    expect(inner.sessions).toHaveLength(1);
    expect(inner.sessions[0]!.fed).toEqual([]);
    inner.sessions[0]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.state).toBe("awake");
    session.feed(frame(3));
    expect(inner.sessions[0]!.fed).toEqual([1, 2, 3]);
    expect(states).toEqual(["starting", "awake"]);
  });

  test("sleep closes the upstream; the next frame opens a fresh one", async () => {
    const inner = fakeTranscriber();
    const time = clock();
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      ...time,
    }).createSession({});
    session.feed(frame(1));
    inner.sessions[0]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    time.advance(5_000);
    session.sleep();
    expect(inner.sessions[0]!.closed).toBe(true);
    expect(session.state).toBe("asleep");
    expect(session.awakeSeconds()).toBe(5);
    session.feed(frame(9));
    expect(inner.sessions).toHaveLength(2);
    inner.sessions[1]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(inner.sessions[1]!.fed).toEqual([9]);
  });

  test("sleeps by itself after the idle bound with no frames", async () => {
    const inner = fakeTranscriber();
    const time = clock();
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      ...time,
    }).createSession({});
    session.feed(frame(1));
    inner.sessions[0]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    time.advance(20_000);
    session.feed(frame(2));
    time.advance(20_000);
    expect(session.state).toBe("awake");
    time.advance(11_000);
    expect(session.state).toBe("asleep");
    expect(inner.sessions[0]!.closed).toBe(true);
  });

  test("bounds what it holds while starting, dropping the oldest", () => {
    const inner = fakeTranscriber();
    const time = clock();
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 4,
      ...time,
    }).createSession({});
    for (const tag of [1, 2, 3, 4]) session.feed(frame(tag));
    inner.sessions[0]!.ready();
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        expect(inner.sessions[0]!.fed).toEqual([3, 4]);
      });
  });

  test("a startup failure reports fatal and returns to sleep", async () => {
    const inner = fakeTranscriber();
    const time = clock();
    const errors: string[] = [];
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      ...time,
    }).createSession({ onFatalError: (error) => errors.push(error.message) });
    session.feed(frame(1));
    inner.sessions[0]!.fail(new Error("upstream refused"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual(["upstream refused"]);
    expect(session.state).toBe("asleep");
  });

  test("a stale readiness after sleep never reopens the old session", async () => {
    const inner = fakeTranscriber();
    const time = clock();
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      ...time,
    }).createSession({});
    session.feed(frame(1));
    session.sleep();
    inner.sessions[0]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.state).toBe("asleep");
    expect(inner.sessions[0]!.closed).toBe(true);
  });

  test("close is final", () => {
    const inner = fakeTranscriber();
    const time = clock();
    const session = createSleepingTranscriberV1(inner, {
      idleSleepMs: 30_000,
      maxPendingBytes: 1_000,
      ...time,
    }).createSession({});
    session.feed(frame(1));
    session.close();
    session.feed(frame(2));
    expect(inner.sessions).toHaveLength(1);
    expect(inner.sessions[0]!.closed).toBe(true);
  });
});
