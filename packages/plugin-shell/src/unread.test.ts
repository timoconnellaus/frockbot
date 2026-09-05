import { describe, expect, test } from "bun:test";
import {
  advanceUnreadActivityV1,
  botUnreadCommandFingerprintV1,
  decodeSidebarMessagePreviewV1,
  decodeBotNotificationDirectoryViewV1,
  decodeBotUnreadCommandV1,
  decodeBotUnreadDirectoryViewV1,
  decodeUnreadStateV1,
  emptyUnreadStateV1,
  markUnreadReadV1,
  markUnreadV1,
  optionalUnreadStateV1,
  projectBotUnreadViewV1,
  sidebarMessagePreviewForTurnV1,
  sidebarMessagePreviewFromRunsV1,
  UNREAD_COUNT_CAP,
  type UnreadStateV1,
  type BotPendingNotificationV1,
} from "./unread.js";

/** A cursor in the exact shape the Bot's admission index writes. */
function cursor(minute: number, runId = `run-${minute}`): string {
  const at = new Date(Date.UTC(2026, 7, 31, 0, minute, 0)).toISOString();
  return `run-index:${at}:${runId}`;
}

/** Newest-first, exactly as `listRunIndex` returns it. */
function index(count: number): string[] {
  return Array.from({ length: count }, (_, offset) => cursor(count - offset));
}

describe("the unread codec", () => {
  test("accepts the empty record and a full one", () => {
    expect(decodeUnreadStateV1(emptyUnreadStateV1())).toEqual({
      schemaVersion: 1,
      manuallyUnread: false,
    });
    const full: UnreadStateV1 = {
      schemaVersion: 1,
      lastActivityCursor: cursor(2),
      lastActivityAt: "2026-08-31T00:02:00.000Z",
      lastSeenCursor: cursor(1),
      lastViewedAt: "2026-08-31T00:01:30.000Z",
      manuallyUnread: true,
    };
    expect(decodeUnreadStateV1(full)).toEqual(full);
  });

  test("refuses anything that is not the record it claims to be", () => {
    const base = emptyUnreadStateV1();
    for (const invalid of [
      undefined,
      null,
      [],
      "unread",
      { ...base, schemaVersion: 2 },
      { ...base, manuallyUnread: "yes" },
      { ...base, surprise: true },
      { schemaVersion: 1 },
      // A cursor that is not an admission-index key.
      { ...base, lastSeenCursor: "yesterday", lastViewedAt: base.lastViewedAt },
      { ...base, lastSeenCursor: cursor(1) },
      { ...base, lastActivityAt: "2026-08-31T00:01:00.000Z" },
      {
        ...base,
        lastActivityCursor: cursor(1),
        lastActivityAt: "not-a-time",
      },
    ]) {
      expect(() => decodeUnreadStateV1(invalid)).toThrow();
    }
  });

  test("reads an absent record as the empty one", () => {
    expect(optionalUnreadStateV1(undefined)).toEqual(emptyUnreadStateV1());
    expect(() => optionalUnreadStateV1({ schemaVersion: 3 })).toThrow();
  });
});

describe("the sidebar message preview", () => {
  const preview = {
    schemaVersion: 1 as const,
    text: "Done",
    at: "2026-08-31T00:02:00.000Z",
    role: "assistant" as const,
  };

  test("decodes the exact bounded projection", () => {
    expect(decodeSidebarMessagePreviewV1(preview)).toEqual(preview);
    for (const invalid of [
      { ...preview, extra: true },
      { ...preview, text: "" },
      { ...preview, text: "x".repeat(121) },
      { ...preview, at: "yesterday" },
      { ...preview, role: "system" },
    ]) {
      expect(() => decodeSidebarMessagePreviewV1(invalid)).toThrow();
    }
  });

  test("prefers assistant text, falls back to the User, and bounds both", () => {
    expect(
      sidebarMessagePreviewForTurnV1(
        {
          acceptedAt: "2026-08-31T00:01:00.000Z",
          input: "Question",
          responseText: "Answer",
        },
        preview.at,
      ),
    ).toMatchObject({ text: "Answer", at: preview.at, role: "assistant" });
    expect(
      sidebarMessagePreviewForTurnV1(
        {
          acceptedAt: "2026-08-31T00:01:00.000Z",
          input: "Q".repeat(140),
          responseText: "",
        },
        preview.at,
      ),
    ).toMatchObject({
      text: "Q".repeat(120),
      at: "2026-08-31T00:01:00.000Z",
      role: "user",
    });
  });
});

describe("unread transitions", () => {
  test("activity is monotonic, so a re-settled Turn cannot move it", () => {
    const first = advanceUnreadActivityV1(emptyUnreadStateV1(), {
      cursor: cursor(2),
      at: "2026-08-31T00:02:00.000Z",
    });
    // Recovery settling the same Turn again, and an older Turn arriving late.
    const replayed = advanceUnreadActivityV1(first, {
      cursor: cursor(2),
      at: "2026-08-31T00:09:00.000Z",
    });
    expect(replayed).toEqual(first);
    expect(
      advanceUnreadActivityV1(first, {
        cursor: cursor(1),
        at: "2026-08-31T00:01:00.000Z",
      }),
    ).toEqual(first);
    const later = advanceUnreadActivityV1(first, {
      cursor: cursor(3),
      at: "2026-08-31T00:03:00.000Z",
    });
    expect(later.lastActivityCursor).toBe(cursor(3));
  });

  test("mark-read takes the max, so out-of-order marks are safe", () => {
    const read = markUnreadReadV1(emptyUnreadStateV1(), {
      upToCursor: cursor(5),
      at: "2026-08-31T00:05:00.000Z",
    });
    const stale = markUnreadReadV1(read, {
      upToCursor: cursor(2),
      at: "2026-08-31T00:02:00.000Z",
    });
    expect(stale.lastSeenCursor).toBe(cursor(5));
    expect(stale.lastViewedAt).toBe("2026-08-31T00:05:00.000Z");
    const newer = markUnreadReadV1(stale, {
      upToCursor: cursor(7),
      at: "2026-08-31T00:07:00.000Z",
    });
    expect(newer.lastSeenCursor).toBe(cursor(7));
  });

  test("a later mark-read clears manual unread", () => {
    const marked = markUnreadV1(
      markUnreadReadV1(emptyUnreadStateV1(), {
        upToCursor: cursor(1),
        at: "2026-08-31T00:01:00.000Z",
      }),
    );
    expect(marked.manuallyUnread).toBe(true);
    // Even a mark that moves no cursor: the User is looking at the thread.
    const read = markUnreadReadV1(marked, {
      upToCursor: cursor(1),
      at: "2026-08-31T00:04:00.000Z",
    });
    expect(read).toMatchObject({
      manuallyUnread: false,
      lastSeenCursor: cursor(1),
    });
  });
});

describe("the unread projection", () => {
  test("counts only settled chat Turns the User has not seen", () => {
    const state: UnreadStateV1 = {
      schemaVersion: 1,
      lastActivityCursor: cursor(3),
      lastActivityAt: "2026-08-31T00:03:00.000Z",
      lastSeenCursor: cursor(1),
      lastViewedAt: "2026-08-31T00:01:00.000Z",
      manuallyUnread: false,
    };
    // Four admitted Turns; the newest has not settled, so it is not counted.
    const view = projectBotUnreadViewV1("alpha", state, index(4));
    expect(view).toMatchObject({ botId: "alpha", count: 2, unread: true });
  });

  test("a manual mark shows unread with no count", () => {
    const view = projectBotUnreadViewV1(
      "alpha",
      markUnreadV1(emptyUnreadStateV1()),
      [],
    );
    expect(view).toMatchObject({
      count: 0,
      unread: true,
      manuallyUnread: true,
    });
  });

  test("caps the count and says so", () => {
    const entries = index(UNREAD_COUNT_CAP + 1);
    const state = advanceUnreadActivityV1(emptyUnreadStateV1(), {
      cursor: entries[0]!,
      at: "2026-08-31T02:00:00.000Z",
    });
    const view = projectBotUnreadViewV1("alpha", state, entries);
    expect(view).toMatchObject({ count: UNREAD_COUNT_CAP, capped: true });
  });

  test("nothing settled means nothing unread", () => {
    const view = projectBotUnreadViewV1(
      "alpha",
      emptyUnreadStateV1(),
      index(3),
    );
    expect(view).toMatchObject({ count: 0, capped: false, unread: false });
  });

  // A Routine failing every minute left the badge at zero, because an
  // automation Turn never advances the activity cursor.
  test("badges a Bot whose Routine is failing, with nothing else unread", () => {
    const view = projectBotUnreadViewV1(
      "alpha",
      emptyUnreadStateV1(),
      index(3),
      undefined,
      2,
    );
    expect(view).toMatchObject({ count: 2, unread: true, capped: false });
  });

  test("adds Routine failures to the unread chat Turns", () => {
    const state: UnreadStateV1 = {
      schemaVersion: 1,
      lastActivityCursor: cursor(3),
      lastActivityAt: "2026-08-31T00:03:00.000Z",
      lastSeenCursor: cursor(1),
      lastViewedAt: "2026-08-31T00:01:00.000Z",
      manuallyUnread: false,
    };
    expect(
      projectBotUnreadViewV1("alpha", state, index(4), undefined, 1),
    ).toMatchObject({ count: 3, unread: true });
  });

  test("carries the already-bounded latest message without deriving it", () => {
    const preview = decodeSidebarMessagePreviewV1({
      schemaVersion: 1,
      text: "Latest answer",
      at: "2026-08-31T00:03:00.000Z",
      role: "assistant",
    });
    const projected = projectBotUnreadViewV1(
      "alpha",
      emptyUnreadStateV1(),
      [],
      preview,
    );
    expect(
      decodeBotUnreadDirectoryViewV1({
        schemaVersion: 1,
        unread: [projected],
      }).unread[0]?.lastMessage,
    ).toEqual(preview);
    expect(() =>
      decodeBotUnreadDirectoryViewV1({
        schemaVersion: 1,
        unread: [{ ...projected, lastMessage: { ...preview, extra: true } }],
      }),
    ).toThrow();
  });
});

// The record is written at settlement, so a Bot whose Turns settled before
// that projection existed has a full transcript and no preview — and its
// sidebar row said "No messages yet" over six messages. A read derives it.
describe("the sidebar preview derived from stored runs", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    acceptedAt: "2026-08-31T00:02:00.000Z",
    input: "What is the plan?",
    responseText: "Here is the plan.",
    status: "completed",
    events: [{ timestamp: "2026-08-31T00:02:05.000Z" }],
    ...over,
  });

  test("takes the newest settled chat Turn's reply, stamped when it settled", () => {
    expect(sidebarMessagePreviewFromRunsV1([run()])).toEqual({
      schemaVersion: 1,
      text: "Here is the plan.",
      at: "2026-08-31T00:02:05.000Z",
      role: "assistant",
    });
  });

  test("walks past a running Turn and an automation to the newest chat reply", () => {
    expect(
      sidebarMessagePreviewFromRunsV1([
        run({ status: "running", responseText: undefined }),
        run({
          admission: { turnType: "automation" },
          responseText: "Routine ran.",
        }),
        run({ responseText: "The older answer." }),
      ]),
    ).toMatchObject({ text: "The older answer.", role: "assistant" });
  });

  test("falls back to the User's own words when the reply was empty", () => {
    expect(
      sidebarMessagePreviewFromRunsV1([run({ responseText: "" })]),
    ).toEqual({
      schemaVersion: 1,
      text: "What is the plan?",
      at: "2026-08-31T00:02:00.000Z",
      role: "user",
    });
  });

  test("a Bot with no settled chat Turn still has no preview", () => {
    expect(sidebarMessagePreviewFromRunsV1([])).toBeUndefined();
    expect(
      sidebarMessagePreviewFromRunsV1([
        run({ status: "running", responseText: undefined, input: "" }),
      ]),
    ).toBeUndefined();
  });

  // A read of durable data never throws: a run whose stamps are unreadable
  // costs the row, not the whole sidebar.
  test("skips a run whose stored timestamps cannot be read", () => {
    expect(
      sidebarMessagePreviewFromRunsV1([
        run({ acceptedAt: "not a time", events: [] }),
        run({ responseText: "The readable one." }),
      ]),
    ).toMatchObject({ text: "The readable one." });
  });
});

describe("the unread command", () => {
  test("decodes each type and refuses a mismatched cursor", () => {
    expect(
      decodeBotUnreadCommandV1({
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: "mark-1",
        botId: "alpha",
        upToCursor: cursor(1),
      }),
    ).toMatchObject({ type: "bot/mark-read", upToCursor: cursor(1) });
    expect(
      decodeBotUnreadCommandV1({
        schemaVersion: 1,
        type: "bot/mark-unread",
        commandId: "mark-2",
        botId: "alpha",
      }),
    ).toMatchObject({ type: "bot/mark-unread" });
    for (const invalid of [
      // mark-read with no cursor, mark-unread with one.
      {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: "mark-3",
        botId: "alpha",
      },
      {
        schemaVersion: 1,
        type: "bot/mark-unread",
        commandId: "mark-4",
        botId: "alpha",
        upToCursor: cursor(1),
      },
      {
        schemaVersion: 1,
        type: "bot/archive",
        commandId: "mark-5",
        botId: "alpha",
      },
    ]) {
      expect(() => decodeBotUnreadCommandV1(invalid)).toThrow();
    }
  });

  test("fingerprints the meaning, not the command id", () => {
    const command = decodeBotUnreadCommandV1({
      schemaVersion: 1,
      type: "bot/mark-read",
      commandId: "mark-1",
      botId: "alpha",
      upToCursor: cursor(1),
    });
    expect(botUnreadCommandFingerprintV1(command)).toBe(
      botUnreadCommandFingerprintV1({ ...command, commandId: "mark-2" }),
    );
    expect(botUnreadCommandFingerprintV1(command)).not.toBe(
      botUnreadCommandFingerprintV1({ ...command, upToCursor: cursor(2) }),
    );
  });
});

describe("the fan-out views", () => {
  test("decode exactly what the routes answer", () => {
    expect(
      decodeBotUnreadDirectoryViewV1({
        schemaVersion: 1,
        unread: [projectBotUnreadViewV1("alpha", emptyUnreadStateV1(), [])],
      }).unread,
    ).toHaveLength(1);
    expect(() =>
      decodeBotUnreadDirectoryViewV1({ schemaVersion: 1, unread: [{}] }),
    ).toThrow();
    expect(
      decodeBotNotificationDirectoryViewV1({
        schemaVersion: 1,
        notifications: [
          {
            schemaVersion: 1,
            botId: "alpha",
            notificationId: "run-1",
            runId: "run-1",
            createdAt: "2026-08-31T00:01:00.000Z",
            title: "Alpha replied",
            body: "hello",
          },
        ],
      }).notifications,
    ).toHaveLength(1);
    expect(() =>
      decodeBotNotificationDirectoryViewV1({
        schemaVersion: 1,
        notifications: [{ schemaVersion: 1, botId: "alpha" }],
      }),
    ).toThrow();
  });
});

test("notification fan-out preserves critical urgency without accepting arbitrary fields", () => {
  const notice = {
    schemaVersion: 1,
    botId: "alpha",
    notificationId: "approval-1",
    runId: "run-1",
    createdAt: "2026-09-05T10:00:00.000Z",
    title: "Your decision is needed",
    body: "Open the Bot",
    urgency: "critical",
  } satisfies BotPendingNotificationV1;
  expect(
    decodeBotNotificationDirectoryViewV1({
      schemaVersion: 1,
      notifications: [notice],
    }).notifications[0],
  ).toEqual(notice);
  expect(() =>
    decodeBotNotificationDirectoryViewV1({
      schemaVersion: 1,
      notifications: [{ ...notice, secret: "invalid" }],
    }),
  ).toThrow();
});
