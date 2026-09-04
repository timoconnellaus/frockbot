/**
 * One definition of "focused", shared by every surface that has to decide
 * whether a Bot's message is something the User is already looking at.
 *
 * The rule, stated once so the Shell and the Flock sidebar cannot drift:
 *
 * > A Bot is **focused** when its chat is the open one, the tab is visible,
 * > and the window holds focus.
 *
 * All three, because each one on its own gets a case wrong. Only the open Bot
 * is being read, so another Bot's reply is news however attentive the User is.
 * A tab in the background is not being read even though its chat is still
 * "open" — `document.visibilityState` is what says so. And a visible tab
 * behind another window is not being read either, which only
 * `document.hasFocus()` can tell: without it, a Bot that replied while the
 * User was in another app stayed silent and left no badge, so the message was
 * never heard about at all.
 *
 * A focused Bot raises no notification and carries no unread badge. Every
 * other message raises exactly one of each.
 */
import type { BotUnreadViewV1 } from "./unread.js";

/** What the rule needs to know about the browser, captured as plain data. */
export interface ViewerFocusV1 {
  /** The Bot whose chat is open, if any. */
  activeBotId?: string;
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
}

/**
 * Reads the rule's three inputs out of the live document.
 *
 * Outside a browser there is no viewer, so nothing is focused and every
 * message counts — the conservative answer, since a badge can be cleared and
 * an unheard message cannot be un-missed.
 */
export function readViewerFocusV1(activeBotId?: string): ViewerFocusV1 {
  const identity = activeBotId === undefined ? {} : { activeBotId };
  if (typeof document === "undefined") {
    return { visible: false, focused: false, ...identity };
  }
  return {
    visible: document.visibilityState === "visible",
    // A document without `hasFocus` is not a background window; it is a
    // runtime that does not report focus, and refusing to believe it would
    // badge the chat the User is reading.
    focused:
      typeof document.hasFocus === "function" ? document.hasFocus() : true,
    ...identity,
  };
}

/** The rule itself. */
export function isBotFocusedV1(focus: ViewerFocusV1, botId: string): boolean {
  return focus.activeBotId === botId && focus.visible && focus.focused;
}

/**
 * Whether a message from this Bot should raise a notification. The inverse of
 * the rule, named so the call site reads as the sentence it implements: one
 * notification per message, for a Bot that is out of focus.
 */
export function shouldNotifyForBotV1(
  focus: ViewerFocusV1,
  botId: string,
): boolean {
  return !isBotFocusedV1(focus, botId);
}

/**
 * The unread view a focused Bot renders: none.
 *
 * The Bot Durable Object counts every settled Turn, because it cannot know
 * which chat is on screen. A fan-out that returned mid-read would therefore
 * paint a badge on the row the User is looking at, for as long as it took the
 * read receipt to land. The receipt is still sent — "read" is durable, and it
 * is what makes the badge stay gone on the next reload and the next tab — but
 * the row never renders a count it is about to lose.
 *
 * `manuallyUnread` is the exception: a Bot the User deliberately marked unread
 * stays bold while they look at it, because that flag is intent rather than
 * arithmetic, and only opening the Bot again clears it.
 */
export function suppressUnreadWhileFocusedV1(
  view: BotUnreadViewV1,
): BotUnreadViewV1 {
  if (view.manuallyUnread) return view;
  return { ...view, count: 0, capped: false, unread: false };
}
