// The durable process record, its codec, and the one rule that decides what a
// process is after the Computer moved under it.
import { describe, expect, test } from "bun:test";
import {
  COMPUTER_PROCESS_LIMIT_PER_BOT,
  computerProcessKeyV1,
  computerProcessStatusV1,
  ComputerProcessDecodeError,
  decodeComputerProcessRecordV1,
  type ComputerProcessRecordV1,
} from "./process-records.js";
import {
  ComputerProcessLimitError,
  ComputerProcessStore,
  type ComputerProcessStorageV1,
} from "./process-store.js";

const record: ComputerProcessRecordV1 = {
  schemaVersion: 1,
  processId: "p-tool-1-1-0",
  botId: "bot-1",
  sessionId: "session-1",
  turnId: "run-9",
  command: "npm run build",
  cwd: "/workspaces/bot-1",
  startedAt: "2026-08-31T00:00:00.000Z",
  status: "running",
  generation: 3,
  effectId: "tool:1:1:0",
  pid: 4321,
  logPath: "/home/box/.frockbot/bots/bot-1/processes/p-tool-1-1-0/log",
};

/** Storage enough for the store: a map with a prefix listing. */
function storage(): ComputerProcessStorageV1 & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    list: <T>(options: { prefix: string; limit?: number }) => {
      const held = new Map<string, T>();
      for (const [key, value] of map) {
        if (!key.startsWith(options.prefix)) continue;
        if (options.limit !== undefined && held.size >= options.limit) break;
        held.set(key, value as T);
      }
      return Promise.resolve(held);
    },
  };
}

describe("the Computer process record codec", () => {
  test("round-trips an exact record and keys it by its id", () => {
    expect(decodeComputerProcessRecordV1(record)).toEqual(record);
    expect(computerProcessKeyV1(record.processId)).toBe(
      "computer-process:p-tool-1-1-0",
    );
  });

  test("refuses a record it does not exactly recognise", () => {
    // No migrations: a record the codec refuses is a visible failure rather
    // than something reshaped into a guess.
    expect(() =>
      decodeComputerProcessRecordV1({ ...record, schemaVersion: 2 }),
    ).toThrow(ComputerProcessDecodeError);
    expect(() =>
      decodeComputerProcessRecordV1({ ...record, extra: true }),
    ).toThrow(/unknown field "extra"/);
    expect(() =>
      decodeComputerProcessRecordV1({ ...record, status: "paused" }),
    ).toThrow(/status is invalid/);
    expect(() =>
      decodeComputerProcessRecordV1({ ...record, generation: -1 }),
    ).toThrow(/generation/);
    const { pid: _pid, ...withoutPid } = record;
    expect(decodeComputerProcessRecordV1(withoutPid)).toEqual(withoutPid);
  });
});

describe("the process store", () => {
  test("writes intent, reads it back, and bounds how many a Bot may hold", async () => {
    const held = storage();
    const store = new ComputerProcessStore(held);

    await store.record(record);
    expect(await store.read(record.processId)).toEqual(record);
    expect(await store.read("p-absent")).toBeUndefined();

    for (let index = 1; index < COMPUTER_PROCESS_LIMIT_PER_BOT; index += 1) {
      await store.record({ ...record, processId: `p-${index}` });
    }
    await expect(
      store.record({ ...record, processId: "p-one-too-many" }),
    ).rejects.toBeInstanceOf(ComputerProcessLimitError);
    // Updating one that already exists is not a new record and is admitted.
    await store.update({ ...record, status: "exited", exitCode: 0 });
    expect((await store.read(record.processId))?.status).toBe("exited");
  });

  test("drops a stored value the codec refuses rather than failing the listing", async () => {
    const held = storage();
    const store = new ComputerProcessStore(held);
    await store.record(record);
    held.map.set("computer-process:p-broken", { schemaVersion: 9 });

    expect((await store.list()).map((entry) => entry.processId)).toEqual([
      record.processId,
    ]);
  });
});

describe("the status a process holds", () => {
  test("is running only when the same Computer still holds a live pid", () => {
    expect(
      computerProcessStatusV1({
        recorded: record,
        currentGeneration: 3,
        observed: { alive: true },
      }),
    ).toEqual({ status: "running" });
  });

  test("is exited with its code once the Computer recorded one", () => {
    expect(
      computerProcessStatusV1({
        recorded: record,
        currentGeneration: 3,
        observed: { alive: false, exitCode: 2 },
      }),
    ).toEqual({ status: "exited", exitCode: 2 });
  });

  test("is unknown, never running, once the generation moved", () => {
    // "other processes are assumed dead after a cold pause": a rebuilt
    // Computer is a different Computer, and a live pid on it belongs to
    // whatever is running there now.
    expect(
      computerProcessStatusV1({
        recorded: record,
        currentGeneration: 4,
        observed: { alive: true },
      }),
    ).toEqual({ status: "unknown" });
    // An exit file written before the rebuild is still evidence.
    expect(
      computerProcessStatusV1({
        recorded: record,
        currentGeneration: 4,
        observed: { alive: false, exitCode: 0 },
      }),
    ).toEqual({ status: "exited", exitCode: 0 });
  });

  test("is unknown when the pid is gone with no recorded exit", () => {
    expect(
      computerProcessStatusV1({
        recorded: record,
        currentGeneration: 3,
        observed: { alive: false },
      }),
    ).toEqual({ status: "unknown" });
  });

  test("keeps a settled outcome settled", () => {
    expect(
      computerProcessStatusV1({
        recorded: { ...record, status: "exited", exitCode: 7 },
        currentGeneration: 99,
        observed: { alive: true },
      }),
    ).toEqual({ status: "exited", exitCode: 7 });
  });
});
