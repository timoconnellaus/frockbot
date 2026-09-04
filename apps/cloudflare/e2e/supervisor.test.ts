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

function harness(overrides: { maxRestarts?: number } = {}): Harness {
  const spawned: ChildProcess[] = [];
  const reports: string[] = [];
  const ready = { value: async () => {} };
  const supervised = superviseProcess({
    label: "test server",
    spawnChild: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
    waitUntilReady: () => ready.value(),
    stopChild: async () => {},
    forwardOutput: () => {},
    // No real waiting: the backoff schedule is tested on its own below.
    sleep: async () => {},
    delayMs: () => 0,
    report: (message) => reports.push(message),
    maxRestarts: overrides.maxRestarts,
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
    const { spawned, supervised, ready } = harness();
    ready.value = () => new Promise<void>(() => {});
    const started = supervised.start();
    (spawned[0] as unknown as FakeChild).exit(1);
    await expect(started).rejects.toThrow(/exited early with code 1/);
    expect(spawned).toHaveLength(1);
    expect(supervised.restarts()).toBe(0);
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

  test("tolerates five crashes by default", () => {
    expect(MAX_RESTARTS).toBe(5);
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
