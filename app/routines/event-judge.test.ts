import { describe, expect, test } from "bun:test";
import {
  createFakeRoutineEventJudgeV1,
  createUnavailableRoutineEventJudgeV1,
} from "@frockbot/core/contracts";
import {
  routineCueV1,
  routineFireIdV1,
  type RoutineFireV1,
} from "./firing.js";
import type { RoutineRecordV1 } from "./records.js";
import {
  classifyRoutineFireOnceV1,
  connectionEventIdFromFireV1,
  projectRoutineEventPayloadV1,
  routineEventEvidenceV1,
} from "./event-judge.js";
import { routineEventJudgeKeyV1 } from "./storage-keys.js";

function fire(
  trigger: RoutineFireV1["trigger"],
  over: Partial<RoutineFireV1> = {},
): RoutineFireV1 {
  const discriminator =
    trigger === "connection" ? "connect-evt_1" : "1767225600000";
  const fireId = routineFireIdV1("inbox", discriminator);
  return {
    schemaVersion: 1,
    routineId: "inbox",
    fireId,
    trigger,
    cue: routineCueV1({
      name: "Shipping",
      prompt: "When a shipping confirmation arrives, file the tracking number.",
      trigger,
      ...(trigger === "connection"
        ? {
            delivery: JSON.stringify({
              subject: "Your Amazon order has shipped",
              sender: "ship-confirm@amazon.com",
              snippet: "Track your package.",
            }),
          }
        : {}),
    }),
    mintedAt: "2026-09-20T00:00:00.000Z",
    entryId: `${fireId}-entry`,
    ...over,
  };
}

const routine: RoutineRecordV1 = {
  schemaVersion: 1,
  routineId: "inbox",
  name: "Shipping",
  prompt: "When a shipping confirmation arrives, file the tracking number.",
  trigger: {
    kind: "connection",
    connectionId: "conn-gmail",
    triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  },
  enabled: true,
  createdBy: { kind: "bot", botId: "scout", sessionId: "s", turnId: "t" },
  updatedBy: { kind: "bot", botId: "scout", sessionId: "s", turnId: "t" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function memory() {
  const store = new Map<string, unknown>();
  return {
    store,
    read: async (key: string) => store.get(key),
    write: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe("routineEventEvidenceV1", () => {
  test("schedule, webhook, and Plugin firings are not evidence", () => {
    expect(routineEventEvidenceV1({ fire: fire("cron") })).toBeUndefined();
    expect(routineEventEvidenceV1({ fire: fire("webhook") })).toBeUndefined();
    expect(routineEventEvidenceV1({ fire: fire("plugin") })).toBeUndefined();
    expect(routineEventEvidenceV1({ fire: fire("manual") })).toBeUndefined();
  });

  test("a connection firing names the event and projects the payload", () => {
    const connection = fire("connection");
    expect(connectionEventIdFromFireV1(connection)).toBe("evt_1");
    expect(routineEventEvidenceV1({ fire: connection, routine })).toEqual({
      eventId: "evt_1",
      fireId: connection.fireId,
      routineName: "Shipping",
      prompt: "When a shipping confirmation arrives, file the tracking number.",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      payload: {
        subject: "Your Amazon order has shipped",
        sender: "ship-confirm@amazon.com",
        snippet: "Track your package.",
      },
    });
  });
});

describe("projectRoutineEventPayloadV1", () => {
  test("strips a nested raw payload object and keeps the words", () => {
    const cue = [
      'Routine "Shipping" fired (connection).',
      "",
      "When a shipping confirmation arrives.",
      "",
      "Delivered payload:",
      JSON.stringify({
        subject: "Invoice 44",
        payload: { mimeType: "multipart/alternative", parts: [] },
        message_text: "Please pay.",
      }),
    ].join("\n");
    expect(projectRoutineEventPayloadV1(cue)).toEqual({
      subject: "Invoice 44",
      snippet: "Please pay.",
    });
  });
});

describe("classifyRoutineFireOnceV1", () => {
  test("schedule, webhook, and Plugin firings never ask", async () => {
    let asked = 0;
    const judge = createFakeRoutineEventJudgeV1({
      classify: async () => {
        asked += 1;
        return "is_or_might_be";
      },
    });
    const { read, write } = memory();
    for (const trigger of ["cron", "webhook", "plugin", "manual"] as const) {
      expect(
        await classifyRoutineFireOnceV1({
          fire: fire(trigger),
          judge,
          read,
          write,
        }),
      ).toBeUndefined();
    }
    expect(asked).toBe(0);
  });

  test("a connection firing asks once per fire id", async () => {
    let asked = 0;
    const judge = createFakeRoutineEventJudgeV1({
      classify: async () => {
        asked += 1;
        return "is_or_might_be";
      },
    });
    const { read, write, store } = memory();
    const connection = fire("connection");
    const first = await classifyRoutineFireOnceV1({
      fire: connection,
      routine,
      judge,
      read,
      write,
    });
    const again = await classifyRoutineFireOnceV1({
      fire: connection,
      routine,
      judge,
      read,
      write,
    });
    expect(first).toBe("is_or_might_be");
    expect(again).toBe("is_or_might_be");
    expect(asked).toBe(1);
    expect(store.has(routineEventJudgeKeyV1(connection.fireId))).toBe(true);
  });

  test("a replay after eviction does not ask twice for the same event id", async () => {
    let asked = 0;
    const judge = createFakeRoutineEventJudgeV1({
      classify: async () => {
        asked += 1;
        return "clearly_unrelated";
      },
    });
    const durable = memory();
    const connection = fire("connection");
    await classifyRoutineFireOnceV1({
      fire: connection,
      routine,
      judge,
      read: durable.read,
      write: durable.write,
    });
    // Eviction drops the isolate. The fire is still unsettled; the receipt
    // is what the next drain reads.
    const afterEviction = memory();
    for (const [key, value] of durable.store) afterEviction.store.set(key, value);
    const replayed = await classifyRoutineFireOnceV1({
      fire: connection,
      routine,
      judge,
      read: afterEviction.read,
      write: afterEviction.write,
    });
    expect(replayed).toBe("clearly_unrelated");
    expect(asked).toBe(1);
  });

  test("an unavailable judge still keeps the event", async () => {
    const { read, write } = memory();
    await expect(
      classifyRoutineFireOnceV1({
        fire: fire("connection"),
        routine,
        judge: createUnavailableRoutineEventJudgeV1(),
        read,
        write,
      }),
    ).resolves.toBe("is_or_might_be");
  });
});
