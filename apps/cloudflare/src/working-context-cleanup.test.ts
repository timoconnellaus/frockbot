import { expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import {
  SessionEventLog,
  WORKING_CONTEXT_PREFIX,
  readSessionCursorV1,
  sessionEventLogIndexKeyV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { selectStoredWorkingContextV1 } from "@frockbot/app/shell/working-context-store";
import { projectUnprojectedSessionsV1 } from "./working-context-cleanup.js";

const SESSION = "user:bob";

function chatTurn(turn: number, text: string, start: number) {
  const inputs: SessionEventInput[] = [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    { type: "user/message", turn, step: 1, messageId: `m-${turn}`, text },
    {
      type: "assistant/message",
      turn,
      step: 1,
      requestId: `r-${turn}`,
      text: `answer ${turn}`,
      toolCalls: [],
    },
    { type: "step/end", turn, step: 1, outcome: "completed" },
    { type: "turn/end", turn, outcome: "completed" },
  ];
  return inputs.map((input, index) =>
    decodeSessionEvent({
      ...input,
      seq: start + index,
      timestamp: new Date(1_700_000_000_000 + start + index).toISOString(),
    }),
  );
}

/** A log written before the working-context head existed. */
async function unprojectedLog(): Promise<{
  storage: MemoryStorage;
  count: number;
}> {
  const storage = new MemoryStorage();
  const log = new SessionEventLog(storage);
  const first = chatTurn(1, "first question", 0);
  const second = chatTurn(2, "second question", first.length);
  await log.append(SESSION, first);
  await log.append(SESSION, second);
  for (const key of storage.values.keys()) {
    if (key.startsWith(WORKING_CONTEXT_PREFIX)) storage.values.delete(key);
  }
  return { storage, count: first.length + second.length };
}

test("a log with no head refuses the next append until it is projected", async () => {
  const { storage, count } = await unprojectedLog();
  const log = new SessionEventLog(storage);
  // Appends run inside the authority's transaction, so a refusal rolls back.
  await expect(
    storage.transaction((tx) =>
      new SessionEventLog(tx).append(SESSION, chatTurn(3, "third", count)),
    ),
  ).rejects.toThrow("projection is missing the events before this batch");

  await projectUnprojectedSessionsV1(storage);

  const cursor = await readSessionCursorV1(storage, SESSION);
  expect(cursor.availability).toBe("ready");
  expect(cursor.cursor.nextSeq).toBe(count);
  expect(cursor.cursor.nextTurn).toBe(3);
  const selected = await selectStoredWorkingContextV1(storage, {
    sessionId: SESSION,
    currentTurn: 3,
    currentTurnType: "chat",
    currentMessages: [{ role: "user", content: "third" }],
    budget: 100_000,
  });
  expect(selected.map((message) => message.content)).toContain(
    "second question",
  );
  await log.append(SESSION, chatTurn(3, "third", count));
});

test("an unreadable log gets an empty context after its end", async () => {
  const { storage, count } = await unprojectedLog();
  const index = storage.values.get(sessionEventLogIndexKeyV1(SESSION)) as {
    pageCount: number;
  };
  storage.values.set(sessionEventLogIndexKeyV1(SESSION), {
    ...index,
    pageCount: index.pageCount + 1,
  });

  await projectUnprojectedSessionsV1(storage);

  const cursor = await readSessionCursorV1(storage, SESSION);
  expect(cursor.availability).toBe("ready");
  expect(cursor.cursor.nextSeq).toBe(count);
  expect(cursor.cursor.nextTurn).toBeGreaterThan(2);
});

test("a projection that throws still leaves the next Turn able to append", async () => {
  const { storage, count } = await unprojectedLog();
  const transaction = storage.transaction.bind(storage);
  let refuse = true;
  storage.transaction = (<T>(body: (tx: MemoryStorage) => Promise<T>) => {
    if (refuse) {
      refuse = false;
      return Promise.reject(new Error("page exceeds its byte budget"));
    }
    return transaction(body);
  }) as typeof storage.transaction;

  await projectUnprojectedSessionsV1(storage);

  const cursor = await readSessionCursorV1(storage, SESSION);
  expect(cursor.availability).toBe("ready");
  expect(cursor.cursor.nextSeq).toBe(count);
  await storage.transaction((tx) =>
    new SessionEventLog(tx).append(
      SESSION,
      chatTurn(cursor.cursor.nextTurn, "next", count),
    ),
  );
  expect((await readSessionCursorV1(storage, SESSION)).cursor.nextSeq).toBe(
    count + 7,
  );
});

test("the walk runs once per object", async () => {
  const { storage } = await unprojectedLog();
  await projectUnprojectedSessionsV1(storage);
  for (const key of [...storage.values.keys()]) {
    if (key.startsWith(WORKING_CONTEXT_PREFIX)) storage.values.delete(key);
  }
  await projectUnprojectedSessionsV1(storage);
  expect(
    [...storage.values.keys()].some((key) =>
      key.startsWith(WORKING_CONTEXT_PREFIX),
    ),
  ).toBe(false);
});
