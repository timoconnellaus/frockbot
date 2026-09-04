import { describe, expect, test } from "bun:test";
import {
  decodePendingBotInputV1,
  decodeRoutineInboxEntryV1,
  pendingBotInputPreambleV1,
  routineAttributionV1,
  routineHandoffTextV1,
  subagentAttributionV1,
} from "./inbox.js";
import {
  retainedPendingInputsV1,
  RoutineInboxStore,
  routineTerminalRecordsV1,
} from "./inbox-store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import {
  ROUTINE_INBOX_LIMIT,
  ROUTINE_INBOX_PREFIX,
  ROUTINE_PENDING_INPUT_LIMIT,
  ROUTINE_WAKE_PREFIX,
} from "./storage-keys.js";

const NOW = "2026-08-31T00:00:00.000Z";

function storage() {
  return createMemoryRoutineStorageV1();
}

async function settle(
  store: ReturnType<typeof storage>,
  input: { runId: string; handoff?: string; responseText?: string },
): Promise<void> {
  const contributed = await routineTerminalRecordsV1({
    runId: input.runId,
    routineId: "morning-brief",
    routineName: "Morning brief",
    now: NOW,
    read: (key) => store.get(key),
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
    ...(input.responseText === undefined
      ? {}
      : { responseText: input.responseText }),
  });
  if (!contributed) return;
  for (const [key, value] of Object.entries(contributed.records)) {
    await store.put(key, value);
  }
}

describe("the completion inbox", () => {
  test("a hand-off writes an entry and a pending wake together", async () => {
    const store = storage();
    await settle(store, { runId: "rf-1", handoff: "Three emails need you." });
    const inbox = new RoutineInboxStore(store);
    const entries = await inbox.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attribution).toBe("Automation: Morning brief");
    expect(entries[0]!.acknowledged).toBe(false);
    expect(entries[0]!.text).toBe("Three emails need you.");
    const pending = await inbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.input.kind).toBe("wake");
    expect(entries[0]!.wakeId).toBe(
      pending[0]!.input.kind === "wake" ? pending[0]!.input.wakeId : "",
    );
  });

  test("a silent completion writes an entry and no wake", async () => {
    const store = storage();
    await settle(store, { runId: "rf-2", responseText: "Nothing to report." });
    const inbox = new RoutineInboxStore(store);
    expect(await inbox.list()).toHaveLength(1);
    expect(await inbox.pending()).toHaveLength(0);
    expect((await inbox.list())[0]!.wakeId).toBeUndefined();
  });

  test("the inbox is trimmed to its bound, oldest first", async () => {
    const store = storage();
    for (let index = 0; index < ROUTINE_INBOX_LIMIT + 5; index += 1) {
      await settle(store, {
        runId: `rf-${String(index).padStart(4, "0")}`,
        responseText: `run ${index}`,
      });
    }
    const inbox = new RoutineInboxStore(store);
    const entries = await inbox.list();
    expect(entries).toHaveLength(ROUTINE_INBOX_LIMIT);
    // Newest first, and the five oldest are the ones that went.
    expect(entries[0]!.text).toBe(`run ${ROUTINE_INBOX_LIMIT + 4}`);
    expect(entries.at(-1)!.text).toBe("run 5");
    expect(
      store.keys().filter((key) => key.startsWith(ROUTINE_INBOX_PREFIX)),
    ).toHaveLength(ROUTINE_INBOX_LIMIT);
  });

  test("acknowledging is explicit, targeted, and idempotent", async () => {
    const store = storage();
    await settle(store, { runId: "rf-a", responseText: "first" });
    await settle(store, { runId: "rf-b", responseText: "second" });
    const inbox = new RoutineInboxStore(store);
    expect(await inbox.acknowledge(["ri-rf-a"])).toBe(1);
    expect(await inbox.acknowledge(["ri-rf-a"])).toBe(0);
    const entries = await inbox.list();
    expect(
      entries.filter((entry) => entry.acknowledged).map((entry) => entry.runId),
    ).toEqual(["rf-a"]);
    expect(await inbox.acknowledge([])).toBe(1);
    expect((await inbox.list()).every((entry) => entry.acknowledged)).toBe(
      true,
    );
  });
});

describe("the pending-input queue", () => {
  test("a drain is idempotent on the run that performed it", async () => {
    const store = storage();
    await settle(store, { runId: "rf-1", handoff: "one" });
    await settle(store, { runId: "rf-2", handoff: "two" });
    const inbox = new RoutineInboxStore(store);
    const first = await inbox.drainInto("chat-run-1");
    expect(first.map((input) => input.kind)).toEqual(["wake", "wake"]);
    expect(
      store.keys().filter((key) => key.startsWith(ROUTINE_WAKE_PREFIX)),
    ).toHaveLength(0);
    // The same run asks again — an eviction and a recovery — and reads back the
    // receipt rather than draining an empty queue.
    expect(await inbox.drainInto("chat-run-1")).toEqual(first);
    // A later Turn drains nothing, because the wakes are already delivered.
    expect(await inbox.drainInto("chat-run-2")).toEqual([]);
  });

  test("a wake is re-notified at most once", async () => {
    const store = storage();
    await settle(store, { runId: "rf-1", handoff: "one" });
    const inbox = new RoutineInboxStore(store);
    const [pending] = await inbox.pending();
    await inbox.markRenotified(pending!.key);
    await inbox.markRenotified(pending!.key);
    const [after] = await inbox.pending();
    expect(
      after!.input.kind === "wake" ? after!.input.renotifiedAt : undefined,
    ).toBeString();
  });

  test("the preamble names the hand-off and never speaks as the user", () => {
    const preamble = pendingBotInputPreambleV1([
      {
        schemaVersion: 1,
        kind: "wake",
        wakeId: "rw-1",
        runId: "rf-1",
        routineId: "morning-brief",
        title: "Automation: Morning brief",
        text: "Three emails need you.",
        createdAt: NOW,
        quiet: { automation: true },
      },
    ]);
    expect(preamble).toContain("Automation: Morning brief");
    expect(preamble).toContain("Three emails need you.");
    expect(pendingBotInputPreambleV1([])).toBe("");
  });
});

describe("the pending-input codec", () => {
  test("decodes the reserved approval variant that has no producer yet", () => {
    const approval = {
      schemaVersion: 1,
      kind: "approval",
      approvalId: "ap-1",
      decision: "approved",
      createdAt: NOW,
    };
    expect(decodePendingBotInputV1(approval)).toEqual({
      schemaVersion: 1,
      kind: "approval",
      approvalId: "ap-1",
      decision: "approved",
      createdAt: NOW,
    });
  });

  test("refuses an unknown kind, an unknown field and a loud wake", () => {
    expect(() =>
      decodePendingBotInputV1({ schemaVersion: 1, kind: "x" }),
    ).toThrow("kind is invalid");
    const wake = {
      schemaVersion: 1,
      kind: "wake",
      wakeId: "rw-1",
      runId: "rf-1",
      routineId: "morning-brief",
      title: "Automation: Morning brief",
      text: "hi",
      createdAt: NOW,
      quiet: { automation: true },
    };
    expect(decodePendingBotInputV1(wake)).toEqual(wake as never);
    expect(() =>
      decodePendingBotInputV1({ ...wake, quiet: { automation: false } }),
    ).toThrow("quiet.automation must be true");
    expect(() => decodePendingBotInputV1({ ...wake, extra: 1 })).toThrow(
      'unknown field "extra"',
    );
  });

  test("an inbox entry is exact-field and versioned", () => {
    const entry = {
      schemaVersion: 1 as const,
      entryId: "ri-1",
      runId: "rf-1",
      routineId: "morning-brief",
      text: "hi",
      attribution: routineAttributionV1("Morning brief"),
      createdAt: NOW,
      acknowledged: false,
    };
    expect(decodeRoutineInboxEntryV1(entry)).toEqual(entry);
    expect(() =>
      decodeRoutineInboxEntryV1({ ...entry, schemaVersion: 2 }),
    ).toThrow("schemaVersion is unsupported");
    expect(() =>
      decodeRoutineInboxEntryV1({ ...entry, acknowledged: "yes" }),
    ).toThrow("acknowledged must be a boolean");
  });

  test("the hand-off is the last `wake/parent` the Turn recorded", () => {
    expect(
      routineHandoffTextV1([
        { type: "assistant/message" },
        { type: "wake/parent", message: "first" },
        { type: "wake/parent", message: "second" },
      ] as never),
    ).toBe("second");
    expect(
      routineHandoffTextV1([{ type: "turn/end" }] as never),
    ).toBeUndefined();
  });
});

describe("the approval variant's producer", () => {
  test("an enqueued approval joins the same queue and drains with the wakes", async () => {
    const store = storage();
    await settle(store, { runId: "rf-1", handoff: "one" });
    const inbox = new RoutineInboxStore(store);
    await inbox.enqueue({
      schemaVersion: 1,
      kind: "approval",
      approvalId: "ap-1",
      decision: "approved",
      createdAt: NOW,
    });
    const drained = await inbox.drainInto("chat-run-1");
    expect(drained.map((input) => input.kind)).toEqual(["wake", "approval"]);
    expect(pendingBotInputPreambleV1(drained)).toContain(
      'The decision on "ap-1" is approved.',
    );
  });

  test("enqueuing the same approval twice queues it once", async () => {
    const store = storage();
    const inbox = new RoutineInboxStore(store);
    const input = {
      schemaVersion: 1 as const,
      kind: "approval" as const,
      approvalId: "ap-1",
      decision: "denied" as const,
      createdAt: NOW,
    };
    await inbox.enqueue(input);
    // A retried decision — the same answer arriving twice — must not tell the
    // Bot the same thing twice.
    await inbox.enqueue({ ...input, decision: "expired" });
    const pending = await inbox.pending();
    expect(pending).toHaveLength(1);
    expect(
      pending[0]!.input.kind === "approval"
        ? pending[0]!.input.decision
        : undefined,
    ).toBe("denied");
  });
});

describe("a subagent completion in the same two records", () => {
  test("attributes a subagent by its description, not as an Automation", () => {
    expect(subagentAttributionV1("Read the release notes")).toBe(
      "Subagent: Read the release notes",
    );
  });

  test("reads back with its source, so an entry says what produced it", () => {
    const entry = decodeRoutineInboxEntryV1({
      schemaVersion: 1,
      entryId: "ti-tk-1",
      runId: "tk-1",
      routineId: "tk-1",
      text: "executor subagent finished.",
      attribution: "Subagent: Read the release notes",
      createdAt: "2026-09-01T00:00:00.000Z",
      acknowledged: false,
      source: "subagent",
    });
    expect(entry.source).toBe("subagent");
    // An entry written before subagents existed reads as what it was.
    expect(
      decodeRoutineInboxEntryV1({
        schemaVersion: 1,
        entryId: "ri-fire-1",
        runId: "fire-1",
        routineId: "brief",
        text: "The Routine finished.",
        attribution: "Automation: Morning brief",
        createdAt: "2026-09-01T00:00:00.000Z",
        acknowledged: false,
      }).source,
    ).toBeUndefined();
  });

  test("refuses a source it does not know", () => {
    expect(() =>
      decodePendingBotInputV1({
        schemaVersion: 1,
        kind: "wake",
        wakeId: "tw-tk-1",
        runId: "tk-1",
        routineId: "tk-1",
        title: "Subagent: Read the release notes",
        text: "It finished.",
        createdAt: "2026-09-01T00:00:00.000Z",
        quiet: { automation: true },
        source: "somewhere-else",
      }),
    ).toThrow();
  });

  test("preambles a subagent wake as a summary, never as a Routine hand-off", () => {
    const preamble = pendingBotInputPreambleV1([
      {
        schemaVersion: 1,
        kind: "wake",
        wakeId: "tw-tk-1",
        runId: "tk-1",
        routineId: "tk-1",
        title: "Subagent: Read the release notes",
        text: "They changed on Tuesday.",
        createdAt: "2026-09-01T00:00:00.000Z",
        quiet: { automation: true },
        source: "subagent",
      },
    ]);
    expect(preamble).toContain("the subagent");
    expect(preamble).toContain("not its transcript");
    expect(preamble).toContain("They changed on Tuesday.");
    expect(preamble).not.toContain("your Routine");
  });
});

describe("the machine-result variant", () => {
  const delivery = {
    schemaVersion: 1 as const,
    kind: "machine-result" as const,
    commandId: "cmd-1",
    machineId: "mac-1",
    outcome: "ok" as const,
    preview: "exit 0 — nothing to commit",
    createdAt: NOW,
  };

  test("round-trips through the codec and refuses an unknown outcome", () => {
    expect(decodePendingBotInputV1(delivery)).toEqual(delivery);
    expect(() =>
      decodePendingBotInputV1({ ...delivery, outcome: "maybe" }),
    ).toThrow("outcome is invalid");
    expect(() => decodePendingBotInputV1({ ...delivery, stdout: "…" })).toThrow(
      'unknown field "stdout"',
    );
  });

  test("its preamble line names the command and points at the full read", () => {
    const preamble = pendingBotInputPreambleV1([delivery]);
    expect(preamble).toContain('Command "cmd-1" on machine mac-1 finished ok');
    expect(preamble).toContain("exit 0 — nothing to commit");
    // The whole result is read on demand: a megabyte of stdout must never ride
    // the preamble and push the person's own words out of the request.
    expect(preamble).toContain("machine_command_check");
  });

  test("joins the one queue and de-duplicates on its command id", async () => {
    const store = storage();
    await settle(store, { runId: "rf-1", handoff: "one" });
    const inbox = new RoutineInboxStore(store);
    await inbox.enqueue(delivery);
    // A machine that answered twice — its own retry — must not tell the Bot
    // twice; `commandId` is the id the queue de-duplicates on.
    await inbox.enqueue({ ...delivery, preview: "a second telling" });
    const pending = await inbox.pending();
    expect(pending).toHaveLength(2);
    const drained = await inbox.drainInto("rf-2");
    expect(drained.map((input) => input.kind)).toEqual([
      "wake",
      "machine-result",
    ]);
    expect(
      drained[1]!.kind === "machine-result" ? drained[1]!.preview : undefined,
    ).toBe("exit 0 — nothing to commit");
  });
});

describe("a Turn the User's next message replaced", () => {
  const superseded = {
    schemaVersion: 1 as const,
    kind: "superseded-turn" as const,
    runId: "run-1",
    unfinishedWork: true,
    createdAt: NOW,
  };

  test("round-trips, and is keyed by the Turn it replaced", () => {
    expect(decodePendingBotInputV1(superseded, "input")).toEqual(superseded);
    expect(() =>
      decodePendingBotInputV1(
        { ...superseded, unfinishedWork: "yes" },
        "input",
      ),
    ).toThrow(/unfinishedWork is invalid/);
    expect(() =>
      decodePendingBotInputV1({ ...superseded, extra: 1 }, "input"),
    ).toThrow();
  });

  test("tells the next Turn what happened and what is still running", () => {
    const preamble = pendingBotInputPreambleV1([superseded]);

    expect(preamble).toContain("[Superseded]");
    expect(preamble).toContain("must not be assumed to have happened");
    expect(preamble).toContain("Subagents that Turn dispatched are still");
    // With nothing left running the reminder says nothing about subagents.
    expect(
      pendingBotInputPreambleV1([{ ...superseded, unfinishedWork: false }]),
    ).not.toContain("Subagents");
  });
});

describe("the pending-input cap", () => {
  /**
   * The four input kinds are not interchangeable. A dropped `wake` still has
   * an inbox entry the user can read; an `approval`, a `machine-result` or a
   * `superseded-turn` writes no entry anywhere, so dropping one loses a
   * decision the user made or a result a machine produced, silently.
   */
  test("keeps every non-wake input and spends the budget on the wakes", async () => {
    const store = storage();
    const inbox = new RoutineInboxStore(store);
    for (let index = 0; index < ROUTINE_PENDING_INPUT_LIMIT + 4; index += 1) {
      await settle(store, { runId: `rf-${index}`, handoff: `wake ${index}` });
    }
    await inbox.enqueue({
      schemaVersion: 1,
      kind: "approval",
      approvalId: "ap-1",
      decision: "approved",
      createdAt: NOW,
    });
    await inbox.enqueue({
      schemaVersion: 1,
      kind: "superseded-turn",
      runId: "run-9",
      unfinishedWork: true,
      createdAt: NOW,
    });

    const drained = await inbox.drainInto("chat-run-1");
    expect(drained).toHaveLength(ROUTINE_PENDING_INPUT_LIMIT);
    // The approval decision and the superseded Turn survive; a flat
    // `slice(-16)` used to drop whichever of them sat behind enough wakes.
    expect(drained.filter((input) => input.kind === "approval")).toHaveLength(
      1,
    );
    expect(
      drained.filter((input) => input.kind === "superseded-turn"),
    ).toHaveLength(1);
    expect(drained.filter((input) => input.kind === "wake")).toHaveLength(
      ROUTINE_PENDING_INPUT_LIMIT - 2,
    );
  });

  test("keeps every durable input even when they alone exceed the bound", () => {
    const approvals = Array.from(
      { length: ROUTINE_PENDING_INPUT_LIMIT + 3 },
      (_unused, index) =>
        ({
          schemaVersion: 1,
          kind: "approval",
          approvalId: `ap-${index}`,
          decision: "approved",
          createdAt: NOW,
        }) as const,
    );
    // Over the bound is a problem worth having; losing an approval decision
    // with nothing anywhere recording it is not.
    expect(retainedPendingInputsV1(approvals)).toHaveLength(approvals.length);
  });
});

describe("inbox retention", () => {
  test("gives up read entries before unread ones", async () => {
    const store = storage();
    const inbox = new RoutineInboxStore(store);
    for (let index = 0; index < ROUTINE_INBOX_LIMIT; index += 1) {
      await settle(store, {
        runId: `rf-${String(index).padStart(4, "0")}`,
        responseText: `run ${index}`,
      });
    }
    // The reader has caught up on everything so far.
    await inbox.acknowledge([]);
    // Five more land while they are away.
    for (let index = 0; index < 5; index += 1) {
      await settle(store, {
        runId: `rf-new-${index}`,
        responseText: `fresh ${index}`,
      });
    }

    const entries = await inbox.list();
    expect(entries).toHaveLength(ROUTINE_INBOX_LIMIT);
    // Trimming purely by age used to drop whatever was oldest regardless of
    // whether it had ever been read. Nothing unread is gone here.
    const unread = entries.filter((entry) => !entry.acknowledged);
    expect(unread.map((entry) => entry.text)).toEqual([
      "fresh 4",
      "fresh 3",
      "fresh 2",
      "fresh 1",
      "fresh 0",
    ]);
  });
});
