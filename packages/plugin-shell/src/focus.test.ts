// The rule the User stated, checked as arithmetic:
//
//   "This is one notification per message for a bot that is out of focus. If I
//    have the bot open then that shouldn't raise a notification (or a badge on
//    the list of bots). And when I open a chat that should clear the badge."
//
// Everything here composes the real durable pieces — `advanceUnreadActivityV1`
// for a settled Turn, `projectBotUnreadViewV1` for the count, `markUnreadReadV1`
// for the read receipt — with the focus rule on top, so a change to either side
// has to keep the sentence true rather than only its own unit test.
import { describe, expect, test } from "bun:test";
import {
  isBotFocusedV1,
  readViewerFocusV1,
  shouldNotifyForBotV1,
  suppressUnreadWhileFocusedV1,
  type ViewerFocusV1,
} from "./focus.js";
import {
  advanceUnreadActivityV1,
  emptyUnreadStateV1,
  markUnreadReadV1,
  projectBotUnreadViewV1,
  type BotUnreadViewV1,
  type UnreadStateV1,
} from "./unread.js";

const BOT = "alpha";
const OTHER = "beta";

/** A cursor in the exact shape the Bot's admission index writes. */
function cursor(minute: number): string {
  const at = new Date(Date.UTC(2026, 8, 4, 0, minute, 0)).toISOString();
  return `run-index:${at}:run-${minute}`;
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 4, 0, minute, 0)).toISOString();
}

/** Newest-first, exactly as the Bot's run index returns it. */
function index(minutes: readonly number[]): string[] {
  return [...minutes].sort((a, b) => b - a).map(cursor);
}

/** One settled chat Turn landing on the Bot's durable unread record. */
function settle(state: UnreadStateV1, minute: number): UnreadStateV1 {
  return advanceUnreadActivityV1(state, {
    cursor: cursor(minute),
    at: at(minute),
  });
}

/**
 * What the sidebar actually renders for a Bot: the Durable Object's own
 * projection, with the focus rule applied by the client that knows which chat
 * is on screen.
 */
function rowFor(
  state: UnreadStateV1,
  minutes: readonly number[],
  focus: ViewerFocusV1,
  botId = BOT,
): BotUnreadViewV1 {
  const view = projectBotUnreadViewV1(botId, state, index(minutes));
  return isBotFocusedV1(focus, botId)
    ? suppressUnreadWhileFocusedV1(view)
    : view;
}

const OPEN_AND_LOOKING: ViewerFocusV1 = {
  activeBotId: BOT,
  visible: true,
  focused: true,
};

describe("what counts as focused", () => {
  test("all three, and nothing less", () => {
    expect(isBotFocusedV1(OPEN_AND_LOOKING, BOT)).toBe(true);
    // A different chat is open.
    expect(isBotFocusedV1(OPEN_AND_LOOKING, OTHER)).toBe(false);
    expect(isBotFocusedV1({ visible: true, focused: true }, BOT)).toBe(false);
    // The chat is open in a tab nobody can see.
    expect(isBotFocusedV1({ ...OPEN_AND_LOOKING, visible: false }, BOT)).toBe(
      false,
    );
    // Visible, but behind another window.
    expect(isBotFocusedV1({ ...OPEN_AND_LOOKING, focused: false }, BOT)).toBe(
      false,
    );
  });

  test("notifying is exactly the inverse", () => {
    for (const focus of [
      OPEN_AND_LOOKING,
      { ...OPEN_AND_LOOKING, visible: false },
      { ...OPEN_AND_LOOKING, focused: false },
      { visible: true, focused: true },
    ] satisfies ViewerFocusV1[]) {
      for (const botId of [BOT, OTHER]) {
        expect(shouldNotifyForBotV1(focus, botId)).toBe(
          !isBotFocusedV1(focus, botId),
        );
      }
    }
  });

  test("a document that cannot be read is not a focused one", () => {
    // Bun has no DOM: the reader answers for the environment it is in rather
    // than assuming the User is watching.
    expect(readViewerFocusV1(BOT)).toEqual({
      activeBotId: BOT,
      visible: false,
      focused: false,
    });
    expect(readViewerFocusV1()).toEqual({ visible: false, focused: false });
  });
});

describe("a message while the Bot is focused", () => {
  test("raises no notification and no badge", () => {
    const state = settle(emptyUnreadStateV1(), 1);
    expect(shouldNotifyForBotV1(OPEN_AND_LOOKING, BOT)).toBe(false);
    expect(rowFor(state, [1], OPEN_AND_LOOKING)).toMatchObject({
      count: 0,
      capped: false,
      unread: false,
    });
  });

  test("and neither does the tenth one", () => {
    let state = emptyUnreadStateV1();
    for (const minute of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      state = settle(state, minute);
      expect(
        rowFor(state, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], OPEN_AND_LOOKING),
      ).toMatchObject({ count: 0, unread: false });
    }
  });

  test("but a Bot the User marked unread on purpose stays bold", () => {
    // Intent is not arithmetic: suppression clears a count, never a decision.
    const state = { ...settle(emptyUnreadStateV1(), 1), manuallyUnread: true };
    expect(rowFor(state, [1], OPEN_AND_LOOKING)).toMatchObject({
      unread: true,
      manuallyUnread: true,
    });
  });
});

describe("a message while the Bot is not focused", () => {
  test("is one badge per message, not one per burst", () => {
    let state = emptyUnreadStateV1();
    const away: ViewerFocusV1 = { ...OPEN_AND_LOOKING, activeBotId: OTHER };
    const settled: number[] = [];
    const counts: number[] = [];
    for (const minute of [1, 2, 3]) {
      settled.push(minute);
      state = settle(state, minute);
      counts.push(rowFor(state, settled, away).count);
    }
    expect(counts).toEqual([1, 2, 3]);
  });

  test("counts for the open chat too when the tab is hidden", () => {
    const state = settle(settle(emptyUnreadStateV1(), 1), 2);
    const backgrounded = { ...OPEN_AND_LOOKING, visible: false };
    expect(shouldNotifyForBotV1(backgrounded, BOT)).toBe(true);
    expect(rowFor(state, [1, 2], backgrounded)).toMatchObject({
      count: 2,
      unread: true,
    });
  });

  test("and when the window is behind another one", () => {
    const state = settle(emptyUnreadStateV1(), 1);
    const behind = { ...OPEN_AND_LOOKING, focused: false };
    expect(shouldNotifyForBotV1(behind, BOT)).toBe(true);
    expect(rowFor(state, [1], behind)).toMatchObject({ count: 1 });
  });
});

describe("opening the chat", () => {
  test("clears the badge, and it stays clear for the next message read there", () => {
    let state = settle(settle(emptyUnreadStateV1(), 1), 2);
    const away = { ...OPEN_AND_LOOKING, activeBotId: OTHER };
    expect(rowFor(state, [1, 2], away).count).toBe(2);

    // Opening is the authenticated read receipt, up to the cursor the fan-out
    // named. Nothing about focus is stored: the durable record is a cursor.
    const opened = projectBotUnreadViewV1(BOT, state, index([1, 2]));
    state = markUnreadReadV1(state, {
      upToCursor: opened.lastActivityCursor ?? cursor(2),
      at: at(3),
    });
    expect(rowFor(state, [1, 2], OPEN_AND_LOOKING).count).toBe(0);
    // Durable, not remembered: the same record read by any other tab is 0 too.
    expect(projectBotUnreadViewV1(BOT, state, index([1, 2]))).toMatchObject({
      count: 0,
      unread: false,
    });

    // A reply that arrives while the chat is open and read renders nothing,
    // and the receipt that follows keeps it that way after the tab is closed.
    state = settle(state, 4);
    expect(rowFor(state, [1, 2, 4], OPEN_AND_LOOKING).count).toBe(0);
    state = markUnreadReadV1(state, { upToCursor: cursor(4), at: at(5) });
    expect(projectBotUnreadViewV1(BOT, state, index([1, 2, 4]))).toMatchObject({
      count: 0,
      unread: false,
    });
  });

  test("clears a manual unread as well", () => {
    let state = { ...settle(emptyUnreadStateV1(), 1), manuallyUnread: true };
    state = markUnreadReadV1(state, { upToCursor: cursor(1), at: at(2) });
    expect(rowFor(state, [1], OPEN_AND_LOOKING)).toMatchObject({
      unread: false,
      manuallyUnread: false,
    });
  });
});
