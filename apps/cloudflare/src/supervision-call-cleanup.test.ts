import { expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import {
  SessionEventLog,
  sessionEventLogPagePrefixV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  cleanSupervisionCallDigestsV1,
  UNRECORDED_CALL_DIGEST_V1,
  withCallDigestV1,
} from "./supervision-call-cleanup.js";

const SESSION = "user:bob";

function events() {
  const inputs: SessionEventInput[] = [
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "supervision/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      tool: "post_to_slack",
      callDigest: "a".repeat(64),
      decision: { decision: "allow", reasonCode: "authorized", judgments: [] },
      latencyMs: 12,
    },
  ];
  return inputs.map((input, seq) =>
    decodeSessionEvent({
      ...input,
      seq,
      timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    }),
  );
}

/** A log as a Bot stored it before a verdict named its call. */
async function undigestedLog(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await new SessionEventLog(storage).append(SESSION, events());
  const [pageKey, page] = [
    ...(await storage.list<{ entries: Array<Record<string, any>> }>({
      prefix: sessionEventLogPagePrefixV1(SESSION),
    })),
  ][0]!;
  const entry = page.entries.find((candidate) => candidate.event?.seq === 2)!;
  const { callDigest: _, ...old } = entry.event;
  entry.event = old;
  storage.values.set(pageKey, page);
  await expect(new SessionEventLog(storage).read(SESSION)).rejects.toThrow();
  return storage;
}

test("an undigested verdict reads again and is never reused", async () => {
  const storage = await undigestedLog();

  await cleanSupervisionCallDigestsV1(storage);

  const read = await new SessionEventLog(storage).read(SESSION);
  expect(read.map((event) => event.seq)).toEqual([0, 1, 2]);
  expect(read[2]).toMatchObject({
    type: "supervision/call",
    callDigest: UNRECORDED_CALL_DIGEST_V1,
    decision: { decision: "allow" },
  });
});

test("the walk runs once per object", async () => {
  const storage = await undigestedLog();
  await cleanSupervisionCallDigestsV1(storage);
  expect(
    storage.values.get("maintenance:supervision-call-digest:2026-09-28"),
  ).toMatchObject({ sessions: 1, events: 1, unreadable: [] });
  const before = new Map(storage.values);
  await cleanSupervisionCallDigestsV1(storage);
  expect(storage.values).toEqual(before);
});

test("an event already in today's shape is left as it is", () => {
  for (const event of events()) {
    expect(
      withCallDigestV1(event as unknown as Record<string, unknown>),
    ).toBeUndefined();
  }
});
