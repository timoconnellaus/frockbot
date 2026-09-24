import { expect, test } from "bun:test";
import { decodeSessionEvent } from "@frockbot/core/contracts";
import {
  ACTIVE_RUN_KEY,
  createStoredRunCodecV1,
  LATEST_EVENTS_KEY,
  pendingUserRunKey,
  repairDueKey,
  repairRunKey,
  RUN_PREFIX,
  runIndexKey,
  SessionEventLog,
  sessionEventLogPagePrefixV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  cleanPackagePageShapesV1,
  withoutPublishSyncV1,
} from "./package-page-shapes-cleanup.js";

const SESSION = "user:bob";
const at = "2026-09-20T00:00:00.000Z";
const directTool = {
  packageId: "applets",
  name: "applet_focus",
  input: { appletId: "notes" },
};

const codec = createStoredRunCodecV1({
  decodeRunId: (value) => {
    if (typeof value !== "string") throw new Error("invalid");
    return value;
  },
  decodeConfigurationSnapshot: (value) => value,
});

function sync(seq: number, reason: string) {
  return {
    type: "computer/sync",
    seq,
    timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    turn: 1,
    reason,
    status: "ok",
    detail: "",
    pulled: 1,
    pushed: 0,
    restored: 0,
    removed: 0,
    adopted: 0,
    conflicts: 0,
    failures: 0,
  };
}

function run(runId: string, status: string, extra: object = {}) {
  return {
    runId,
    commandFingerprint: `fingerprint-${runId}`,
    sessionId: SESSION,
    acceptedAt: at,
    input: "Applets · applet_focus",
    eventRange: { startSeq: 0, endSeq: 0 },
    effectAdmissions: [],
    status,
    phase: status === "running" ? "admitted" : "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: {},
    previousEventCount: 0,
    ...extra,
  };
}

/** A Bot as the Package page pipeline left it. */
async function packagePageEra(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await new SessionEventLog(storage).append(SESSION, [
    decodeSessionEvent({
      type: "turn/start",
      seq: 0,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      turn: 1,
    }),
    decodeSessionEvent(sync(1, "open")),
  ]);
  const [pageKey, page] = [
    ...(await storage.list<{ entries: Array<Record<string, any>> }>({
      prefix: sessionEventLogPagePrefixV1(SESSION),
    })),
  ][0]!;
  page.entries[1]!.event = sync(1, "publish");
  storage.values.set(pageKey, page);
  storage.values.set(LATEST_EVENTS_KEY, [sync(0, "publish")]);

  storage.values.set(
    `${RUN_PREFIX}finished`,
    run("finished", "failed", { directTool, failure: "refused" }),
  );
  storage.values.set(
    `${RUN_PREFIX}inline`,
    run("inline", "completed", {
      events: [sync(0, "publish")],
      eventRange: { startSeq: 0, endSeq: 1 },
      responseText: "",
    }),
  );
  storage.values.set(
    `${RUN_PREFIX}waiting`,
    run("waiting", "running", { directTool }),
  );
  storage.values.set(`${RUN_PREFIX}chat`, run("chat", "running"));
  storage.values.set(ACTIVE_RUN_KEY, "waiting");
  storage.values.set(pendingUserRunKey(at, "chat"), "chat");
  storage.values.set(runIndexKey(at, "waiting"), "waiting");
  storage.values.set(runIndexKey(at, "chat"), "chat");
  storage.values.set(repairRunKey("waiting"), 5);
  storage.values.set(repairDueKey(5, "waiting"), "waiting");

  await expect(new SessionEventLog(storage).read(SESSION)).rejects.toThrow();
  expect(() =>
    codec.require(storage.values.get(`${RUN_PREFIX}finished`)),
  ).toThrow();
  return storage;
}

test("every run and event decodes again, history in place", async () => {
  const storage = await packagePageEra();

  await cleanPackagePageShapesV1(storage);

  const finished = codec.require(storage.values.get(`${RUN_PREFIX}finished`));
  expect(finished).toMatchObject({ status: "failed", failure: "refused" });
  expect(finished).not.toHaveProperty("directTool");
  const inline = codec.require(storage.values.get(`${RUN_PREFIX}inline`));
  expect(inline.events).toMatchObject([{ reason: "signal" }]);

  const read = await new SessionEventLog(storage).read(SESSION);
  expect(read.map((event) => event.seq)).toEqual([0, 1]);
  expect(read[1]).toMatchObject({ type: "computer/sync", reason: "signal" });
  expect(
    (storage.values.get(LATEST_EVENTS_KEY) as unknown[]).map((event) =>
      decodeSessionEvent(event),
    ),
  ).toMatchObject([{ reason: "signal" }]);
});

test("an unfinished direct-tool run goes with every pointer to it", async () => {
  const storage = await packagePageEra();

  await cleanPackagePageShapesV1(storage);

  expect(storage.values.has(`${RUN_PREFIX}waiting`)).toBe(false);
  expect(storage.values.has(ACTIVE_RUN_KEY)).toBe(false);
  expect(storage.values.has(runIndexKey(at, "waiting"))).toBe(false);
  expect(storage.values.has(repairRunKey("waiting"))).toBe(false);
  expect(storage.values.has(repairDueKey(5, "waiting"))).toBe(false);
  // An ordinary Turn beside it is untouched.
  expect(storage.values.get(`${RUN_PREFIX}chat`)).toEqual(
    run("chat", "running"),
  );
  expect(storage.values.get(pendingUserRunKey(at, "chat"))).toBe("chat");
  expect(storage.values.get(runIndexKey(at, "chat"))).toBe("chat");
});

test("the walk runs once per object", async () => {
  const storage = await packagePageEra();
  await cleanPackagePageShapesV1(storage);
  expect(
    storage.values.get("maintenance:package-page-shapes:2026-09-24"),
  ).toMatchObject({
    rewrittenRuns: 2,
    removedRuns: 1,
    events: 2,
    unreadable: [],
  });
  const before = new Map(storage.values);
  await cleanPackagePageShapesV1(storage);
  expect(storage.values).toEqual(before);
});

test("an event in today's shape is left as it is", () => {
  for (const reason of ["open", "signal", "turn-end"]) {
    expect(withoutPublishSyncV1(sync(0, reason))).toBeUndefined();
  }
});
