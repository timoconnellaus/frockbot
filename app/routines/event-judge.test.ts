import { describe, expect, test } from "bun:test";
import {
  createFakeRoutineEventJudgeV1,
  createUnavailableRoutineEventJudgeV1,
} from "@frockbot/core/contracts";
import { routineCueV1, routineFireIdV1, type RoutineFireV1 } from "./firing.js";
import { renderRoutineDeliveryV1 } from "./hook.js";
import type { RoutineRecordV1 } from "./records.js";
import {
  classifyRoutineFireOnceV1,
  connectionEventIdFromFireV1,
  connectionFireSkipV1,
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
  test("schedule, webhook, and manual firings are not evidence", () => {
    expect(routineEventEvidenceV1({ fire: fire("cron") })).toBeUndefined();
    expect(routineEventEvidenceV1({ fire: fire("webhook") })).toBeUndefined();
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

  test("unwraps the production webhook cue and ignores the marker in the prompt", () => {
    const mimeJunk = {
      mimeType: "multipart/alternative",
      parts: Array.from({ length: 12 }, (_, index) => ({
        mimeType: "text/plain",
        body: `part-${index}-${"x".repeat(40)}`,
      })),
    };
    const cue = routineCueV1({
      name: "Shipping",
      prompt:
        "When a shipping confirmation arrives. Never mention Delivered payload: in the reply.",
      trigger: "connection",
      delivery: renderRoutineDeliveryV1(
        JSON.stringify({
          payload: mimeJunk,
          subject: "Your Amazon order has shipped",
          sender: "ship-confirm@amazon.com",
          snippet: "Track your package.",
          labels: ["INBOX"],
        }),
        "application/json",
      ),
    });
    expect(projectRoutineEventPayloadV1(cue)).toEqual({
      subject: "Your Amazon order has shipped",
      sender: "ship-confirm@amazon.com",
      snippet: "Track your package.",
      labels: ["INBOX"],
    });
  });
});

describe("classifyRoutineFireOnceV1", () => {
  test("schedule, webhook, and manual firings never ask", async () => {
    let asked = 0;
    const judge = createFakeRoutineEventJudgeV1({
      classify: async () => {
        asked += 1;
        return "is_or_might_be";
      },
    });
    const { read, write } = memory();
    for (const trigger of ["cron", "webhook", "manual"] as const) {
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
    for (const [key, value] of durable.store)
      afterEviction.store.set(key, value);
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

  test("unrelated is skipped; related and Yes. still admit", async () => {
    const cases = [
      {
        name: "newsletter",
        verdict: "clearly_unrelated" as const,
        payload: {
          subject: "This week in design",
          snippet: "Unsubscribe at any time.",
        },
      },
      {
        name: "shipping",
        verdict: "is_or_might_be" as const,
        payload: {
          subject: "Your Amazon order has shipped",
          snippet: "Track your package.",
        },
      },
      {
        name: "yes-reply",
        verdict: "is_or_might_be" as const,
        payload: { subject: "Re: your order", snippet: "Yes." },
      },
    ];
    let admitted = 0;
    let skipped = 0;
    for (const row of cases) {
      const judge = createFakeRoutineEventJudgeV1({
        classify: async () => row.verdict,
      });
      const { read, write } = memory();
      const connection = fire("connection", {
        fireId: routineFireIdV1("inbox", `connect-${row.name}`),
        cue: routineCueV1({
          name: "Shipping",
          prompt: routine.prompt,
          trigger: "connection",
          delivery: JSON.stringify(row.payload),
        }),
      });
      const verdict = await classifyRoutineFireOnceV1({
        fire: connection,
        routine,
        judge,
        read,
        write,
      });
      const skip = connectionFireSkipV1(verdict);
      if (skip) skipped += 1;
      else admitted += 1;
    }
    expect(skipped).toBe(1);
    expect(admitted).toBe(2);
    expect(connectionFireSkipV1(undefined)).toBeUndefined();
    expect(connectionFireSkipV1("is_or_might_be")).toBeUndefined();
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
