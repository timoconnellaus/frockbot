// The restart loop that keeps a shard alive when `wrangler dev` dies.
//
// The child here is an `EventEmitter` standing in for a `ChildProcess`: what
// is under test is the policy — first start fails loudly, a later exit is
// recovered from, a hopeless server is given up on — not `spawn`.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  OutputTail,
  restartDelayMs,
  superviseProcess,
} from "./supervisor.ts";

class FakeChild extends EventEmitter {
  exit(code = 1): void {
    this.emit("exit", code, null);
  }
}

function fakeChild(): ChildProcess {
  return new FakeChild() as unknown as ChildProcess;
}

/** Let every already-queued microtask and timer callback run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

interface Harness {
  spawned: ChildProcess[];
  reports: string[];
  supervised: ReturnType<typeof superviseProcess>;
  ready: { value: () => Promise<void> };
}

function harness(
  overrides: {
    maxRestarts?: number;
    windowMs?: number;
    now?: () => number;
    stopChild?: (child: ChildProcess) => Promise<void>;
    onSpawn?: (index: number) => void;
  } = {},
): Harness {
  const spawned: ChildProcess[] = [];
  const reports: string[] = [];
  const ready = { value: async () => {} };
  const supervised = superviseProcess({
    label: "test server",
    spawnChild: () => {
      const child = fakeChild();
      overrides.onSpawn?.(spawned.length);
      spawned.push(child);
      return child;
    },
    waitUntilReady: () => ready.value(),
    stopChild: overrides.stopChild ?? (async () => {}),
    forwardOutput: () => {},
    // No real waiting: the backoff schedule is tested on its own below.
    sleep: async () => {},
    delayMs: () => 0,
    report: (message) => reports.push(message),
    maxRestarts: overrides.maxRestarts,
    windowMs: overrides.windowMs,
    now: overrides.now,
  });
  return { spawned, reports, supervised, ready };
}

describe("restartDelayMs", () => {
  test("backs off and then caps", () => {
    expect(restartDelayMs(1)).toBe(1_000);
    expect(restartDelayMs(2)).toBe(2_000);
    expect(restartDelayMs(3)).toBe(4_000);
    expect(restartDelayMs(4)).toBe(8_000);
    expect(restartDelayMs(5)).toBe(15_000);
    expect(restartDelayMs(50)).toBe(15_000);
  });
});

describe("OutputTail", () => {
  test("keeps only the last lines, across chunk boundaries", () => {
    const tail = new OutputTail(3);
    tail.write("one\ntw");
    tail.write("o\nthree\nfour\nfi");
    expect(tail.lines()).toEqual(["three", "four", "fi"]);
  });

  test("is empty before anything is written", () => {
    expect(new OutputTail(3).lines()).toEqual([]);
  });
});

describe("superviseProcess", () => {
  test("a first start that exits is a start-up failure, not a restart", async () => {
    const stopped: ChildProcess[] = [];
    const { spawned, supervised, ready } = harness({
      stopChild: async (child) => {
        stopped.push(child);
      },
    });
    ready.value = () => new Promise<void>(() => {});
    const started = supervised.start();
    (spawned[0] as unknown as FakeChild).exit(1);
    await expect(started).rejects.toThrow(/exited early with code 1/);
    expect(spawned).toHaveLength(1);
    expect(supervised.restarts()).toBe(0);
    // Its workerd children outlive it, so the tree goes before start() throws.
    expect(stopped).toEqual([spawned[0]]);
  });

  test("an exit after the server was ready is restarted on the same settings", async () => {
    const { spawned, supervised, reports } = harness();
    await supervised.start();
    expect(spawned).toHaveLength(1);

    (spawned[0] as unknown as FakeChild).exit(1);
    await settle();

    expect(spawned).toHaveLength(2);
    expect(supervised.restarts()).toBe(1);
    expect(supervised.child()).toBe(spawned[1]);
    expect(reports.join("\n")).toContain("exited unexpectedly");
    expect(reports.join("\n")).toContain("is serving again");
  });

  test("a crashed child's tree is stopped before its replacement starts", async () => {
    // `wrangler dev` dying leaves workerd behind; the replacement must not
    // open the same state directory beside it.
    const order: string[] = [];
    let treeIsGone = () => {};
    const stopped = new Promise<void>((done) => {
      treeIsGone = done;
    });
    const { spawned, supervised } = harness({
      stopChild: (child) => {
        order.push(`stop:${spawned.indexOf(child)}`);
        return stopped;
      },
      onSpawn: (index) => order.push(`spawn:${index}`),
    });
    await supervised.start();
    (spawned[0] as unknown as FakeChild).exit(1);
    await settle();

    // The tree is still alive: nothing may have taken the port yet.
    expect(spawned).toHaveLength(1);
    expect(order).toEqual(["spawn:0", "stop:0"]);

    treeIsGone();
    await settle();

    expect(spawned).toHaveLength(2);
    expect(order).toEqual(["spawn:0", "stop:0", "spawn:1"]);
  });

  test("stop() waits for a crash's reaping to finish", async () => {
    // Playwright tears the harness down seconds after a crash; returning
    // before the dead child's tree is gone leaves workerd behind and wipes
    // the state directory under it.
    let treeIsGone = () => {};
    const stopped = new Promise<void>((done) => {
      treeIsGone = done;
    });
    const { spawned, supervised } = harness({
      stopChild: () => stopped,
    });
    await supervised.start();
    (spawned[0] as unknown as FakeChild).exit(1);
    await settle();

    let returned = false;
    const stopping = supervised.stop().then(() => {
      returned = true;
    });
    await settle();
    expect(returned).toBe(false);

    treeIsGone();
    await stopping;
    expect(returned).toBe(true);
  });

  test("stop() waits for a failed replacement's reaping to finish", async () => {
    // The replacement that never came up still owns a process group; the
    // harness must not wipe the state directory out from under it either.
    let treeIsGone = () => {};
    const secondStopped = new Promise<void>((done) => {
      treeIsGone = done;
    });
    const { spawned, supervised, ready } = harness({
      stopChild: (child) =>
        spawned.indexOf(child) === 0 ? Promise.resolve() : secondStopped,
    });
    await supervised.start();
    ready.value = () => Promise.reject(new Error("Address already in use"));
    (spawned[0] as unknown as FakeChild).exit(1);
    await settle();
    expect(spawned).toHaveLength(2);

    let returned = false;
    const stopping = supervised.stop().then(() => {
      returned = true;
    });
    await settle();
    expect(returned).toBe(false);

    treeIsGone();
    await stopping;
    expect(returned).toBe(true);
  });

  test("survives repeated crashes and then gives up", async () => {
    const { spawned, supervised, reports } = harness({ maxRestarts: 2 });
    await supervised.start();
    for (let index = 0; index < 3; index += 1) {
      const child = supervised.child();
      if (!child) break;
      (child as unknown as FakeChild).exit(1);
      await settle();
    }
    expect(spawned).toHaveLength(3); // first start plus two restarts
    expect(reports.join("\n")).toContain("giving up");
  });

  test("stop() ends supervision, so the child's exit starts nothing", async () => {
    const { spawned, supervised } = harness();
    await supervised.start();
    await supervised.stop();
    (spawned[0] as unknown as FakeChild).exit(0);
    await settle();
    expect(spawned).toHaveLength(1);
    expect(supervised.child()).toBeUndefined();
  });

  test("tolerates five crashes a window by default", () => {
    expect(MAX_RESTARTS).toBe(5);
    expect(RESTART_WINDOW_MS).toBe(5 * 60_000);
  });

  test("crashes spread over a long shard never exhaust the budget", async () => {
    // The failure this exists for: `wrangler dev` exits every few minutes on
    // a CI runner, so a lifetime budget is really a limit on how long a shard
    // may run. Ten crashes, ten minutes apart, are ten recoveries.
    let clock = 0;
    const { spawned, supervised, reports } = harness({
      maxRestarts: 5,
      windowMs: 5 * 60_000,
      now: () => clock,
    });
    await supervised.start();
    for (let index = 0; index < 10; index += 1) {
      clock += 10 * 60_000;
      const child = supervised.child();
      expect(child).toBeDefined();
      (child as unknown as FakeChild).exit(1);
      await settle();
    }
    expect(spawned).toHaveLength(11);
    expect(supervised.restarts()).toBe(10);
    expect(reports.join("\n")).not.toContain("giving up");
  });

  test("a server knocked over again and again inside one window is given up on", async () => {
    let clock = 0;
    const { supervised, reports } = harness({
      maxRestarts: 3,
      windowMs: 5 * 60_000,
      now: () => clock,
    });
    await supervised.start();
    for (let index = 0; index < 5; index += 1) {
      clock += 1_000;
      const child = supervised.child();
      if (!child) break;
      (child as unknown as FakeChild).exit(1);
      await settle();
    }
    expect(reports.join("\n")).toContain("giving up");
  });

  test("a restart whose replacement never becomes ready is retried", async () => {
    const { spawned, supervised, ready } = harness({ maxRestarts: 3 });
    await supervised.start();
    let readied = 0;
    ready.value = async () => {
      readied += 1;
      if (readied === 1) throw new Error("still not serving");
    };
    (spawned[0] as unknown as FakeChild).exit(1);
    await settle();
    expect(spawned).toHaveLength(3);
    expect(supervised.restarts()).toBe(2);
  });
});
