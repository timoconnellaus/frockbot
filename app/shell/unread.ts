import { sentTextV1 } from "./sent-text.js";
/** Cloud-owned message read cursors. Each explicit send advances activity;
 * reading is a separate authenticated, monotonic command shared by all devices.
 */
import {
  canonicalCommandFingerprintV1,
  isPublicIdentifier,
} from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "./backend-state.js";
import { runWorkingV1 } from "./reads.js";
import { isVisibleRunV1 } from "./run-protocol.js";
export function decodeMessageCursor(value: string): string {
  if (!/^message-[0-9]{20}$/.test(value))
    throw new UnreadDecodeError("message cursor is invalid");
  return value;
}
export const MESSAGE_PREFIX = "shell:message:";
export const MESSAGE_SEQUENCE_KEY = "shell:message-sequence";

/** The single durable key the whole record lives under. */
export const UNREAD_STATE_KEY = "shell:unread";
/** The newest visible chat line, written beside unread activity at settlement. */
export const SIDEBAR_PREVIEW_KEY = "shell:preview";
/** Idempotency receipts for `bot/mark-read` and `bot/mark-unread`. */
export const UNREAD_RECEIPT_PREFIX = "shell:unread-receipt:";
/** Everything past this is reported as "99+"; the sidebar never renders more. */
export const UNREAD_COUNT_CAP = 99;
/** A sidebar row never carries more transcript text than it can render. */
export const SIDEBAR_PREVIEW_TEXT_LIMIT = 120;

const MAX_CURSOR_LENGTH = 320;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_COMMAND_ID_LENGTH = 128;

export class UnreadDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadDecodeError";
  }
}

/** The durable record. One key, one schema version, no derived fields. */
export interface UnreadStateV1 {
  schemaVersion: 1;
  /** Newest sent message, as an message cursor. */
  lastActivityCursor?: string;
  lastMessageId?: string;
  /** When that Turn settled. */
  lastActivityAt?: string;
  /** How far the User has read, as an message cursor. */
  lastSeenCursor?: string;
  /** When the User last read it. */
  lastViewedAt?: string;
  /** User intent that is not derivable from any cursor. */
  manuallyUnread: boolean;
  unreadFromMessageId?: string;
}

/**
 * The small durable projection a sidebar row needs from the latest settled
 * chat Turn. It is not transcript authority: the stored run and Session events
 * remain that. This only avoids opening every run log during the bounded
 * sidebar fan-out.
 */
export interface SidebarMessagePreviewV1 {
  schemaVersion: 1;
  text: string;
  at: string;
  role: "assistant" | "user";
}

export function emptyUnreadStateV1(): UnreadStateV1 {
  return { schemaVersion: 1, manuallyUnread: false };
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new UnreadDecodeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)) ||
        !Object.prototype.propertyIsEnumerable.call(value, key),
    ) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new UnreadDecodeError(`${label} has unknown or missing fields`);
  }
}

function optionalCursor(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length > MAX_CURSOR_LENGTH) {
    throw new UnreadDecodeError(`${label} ${key} is invalid`);
  }
  try {
    return decodeMessageCursor(candidate);
  } catch {
    throw new UnreadDecodeError(`${label} ${key} is invalid`);
  }
}

function optionalTimestamp(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (
    typeof candidate !== "string" ||
    candidate.length > MAX_TIMESTAMP_LENGTH ||
    !Number.isFinite(Date.parse(candidate)) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    throw new UnreadDecodeError(`${label} ${key} is invalid`);
  }
  return candidate;
}

function messageBoundary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[-a-zA-Z0-9._]+:(?:user|send:(?:0|[1-9][0-9]*))(?![\s\S])/.test(value)
  ) {
    throw new UnreadDecodeError("unread message boundary is invalid");
  }
  return value;
}

/** Strict codec: exact keys, real cursors, real ISO timestamps. */
export function decodeUnreadStateV1(input: unknown): UnreadStateV1 {
  const value = record(input, "unread state");
  exactKeys(
    value,
    ["schemaVersion", "manuallyUnread"],
    [
      "lastActivityCursor",
      "lastMessageId",
      "lastSeenCursor",
      "lastActivityAt",
      "lastViewedAt",
      "unreadFromMessageId",
    ],
    "unread state",
  );
  if (value.schemaVersion !== 1) {
    throw new UnreadDecodeError("unread state schemaVersion is invalid");
  }
  if (typeof value.manuallyUnread !== "boolean") {
    throw new UnreadDecodeError("unread state manuallyUnread is invalid");
  }
  const lastActivityCursor = optionalCursor(
    value,
    "lastActivityCursor",
    "unread state",
  );
  const lastActivityAt = optionalTimestamp(
    value,
    "lastActivityAt",
    "unread state",
  );
  const lastSeenCursor = optionalCursor(
    value,
    "lastSeenCursor",
    "unread state",
  );
  const lastViewedAt = optionalTimestamp(value, "lastViewedAt", "unread state");
  // An activity cursor with no time it settled — or the reverse — is a record
  // no writer here produces, so it is a corrupt record, not an old one.
  if ((lastActivityCursor === undefined) !== (lastActivityAt === undefined)) {
    throw new UnreadDecodeError("unread state activity is incomplete");
  }
  if ((lastSeenCursor === undefined) !== (lastViewedAt === undefined)) {
    throw new UnreadDecodeError("unread state view is incomplete");
  }
  return {
    schemaVersion: 1,
    manuallyUnread: value.manuallyUnread,
    ...(value.unreadFromMessageId === undefined
      ? {}
      : { unreadFromMessageId: messageBoundary(value.unreadFromMessageId) }),
    ...(lastActivityCursor === undefined ? {} : { lastActivityCursor }),
    ...(value.lastMessageId === undefined
      ? {}
      : { lastMessageId: messageBoundary(value.lastMessageId) }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(lastSeenCursor === undefined ? {} : { lastSeenCursor }),
    ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
  };
}

/** An absent record reads as the empty one; a corrupt record still throws. */
export function optionalUnreadStateV1(input: unknown): UnreadStateV1 {
  return input === undefined
    ? emptyUnreadStateV1()
    : decodeUnreadStateV1(input);
}

/** Exact durable/client codec for one projected visible chat line. */
export function decodeSidebarMessagePreviewV1(
  input: unknown,
): SidebarMessagePreviewV1 {
  const value = record(input, "sidebar message preview");
  exactKeys(
    value,
    ["schemaVersion", "text", "at", "role"],
    [],
    "sidebar message preview",
  );
  if (value.schemaVersion !== 1) {
    throw new UnreadDecodeError(
      "sidebar message preview schemaVersion is invalid",
    );
  }
  if (
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    value.text.length > SIDEBAR_PREVIEW_TEXT_LIMIT
  ) {
    throw new UnreadDecodeError("sidebar message preview text is invalid");
  }
  const at = optionalTimestamp(value, "at", "sidebar message preview");
  if (at === undefined) {
    throw new UnreadDecodeError("sidebar message preview at is invalid");
  }
  if (value.role !== "assistant" && value.role !== "user") {
    throw new UnreadDecodeError("sidebar message preview role is invalid");
  }
  return {
    schemaVersion: 1,
    text: value.text,
    at,
    role: value.role,
  };
}

/** An absent preview means this Bot has no settled visible chat line yet. */
export function optionalSidebarMessagePreviewV1(
  input: unknown,
): SidebarMessagePreviewV1 | undefined {
  return input === undefined ? undefined : decodeSidebarMessagePreviewV1(input);
}

/**
 * Selects the last visible line of a completed chat Turn. The assistant reply
 * is later when it has text; an empty reply leaves the User's admitted input as
 * the preview. Both are bounded before they enter the durable projection.
 */
export function sidebarMessagePreviewForTurnV1(
  turn: {
    acceptedAt: string;
    input: string;
    responseText?: string;
    events?: Parameters<typeof sentTextV1>[0];
  },
  settledAt: string,
): SidebarMessagePreviewV1 | undefined {
  const delivered = sentTextV1(turn.events ?? []);
  const role = delivered ? "assistant" : "user";
  const text = (delivered || turn.input).slice(0, SIDEBAR_PREVIEW_TEXT_LIMIT);
  if (text.length === 0) return undefined;
  return decodeSidebarMessagePreviewV1({
    schemaVersion: 1,
    text,
    at: role === "assistant" ? settledAt : turn.acceptedAt,
    role,
  });
}

/** The little a settled run has to expose for a preview to be derived from it. */
export interface SidebarPreviewRunV1 {
  acceptedAt: string;
  input: string;
  responseText?: string;
  status: string;
  /** The journal supplies the latest delivery and settlement timestamp. */
  events?: readonly {
    timestamp?: string;
    type?: string;
    payload?: { type?: string; text?: string };
  }[];
  /** Absent means the Turn was admitted as `chat`, as everywhere else. */
  admission?: { turnType?: string };
}

/**
 * The preview for a Bot that has a transcript but no preview record.
 *
 * The record is written at settlement, so every Turn that settled before that
 * projection existed left one behind — and the row then claimed "No messages
 * yet" over a full conversation. A read cannot write the record it is missing,
 * so it derives the same line from the runs that are already durable. Runs
 * arrive newest-first and the walk stops at the first sent message with
 * text, which is exactly the line the settlement would have stored.
 */
export function sidebarMessagePreviewFromRunsV1(
  runs: readonly SidebarPreviewRunV1[],
): SidebarMessagePreviewV1 | undefined {
  for (const run of runs) {
    if (run.status === "running") continue;
    // An automation Turn reaches the User through its own inbox entry and
    // never became this row at settlement either.
    if ((run.admission?.turnType ?? "chat") !== "chat") continue;
    const settledAt = settlementTimestampV1(run);
    try {
      const preview = sidebarMessagePreviewForTurnV1(run, settledAt);
      if (preview) return preview;
    } catch {
      // A run whose stored timestamps cannot be read is not worth the row —
      // and a read of durable data never throws over one bad record.
      continue;
    }
  }
  return undefined;
}

/** When a stored run settled: its newest event's stamp, else its admission. */
function settlementTimestampV1(run: SidebarPreviewRunV1): string {
  for (let index = (run.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const timestamp = run.events?.[index]?.timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)))
      return timestamp;
  }
  return run.acceptedAt;
}

/**
 * Records a sent message. Monotonic: a cursor that is not newer than the
 * one already recorded leaves the record byte-for-byte unchanged, so a
 * recovered Turn settling a second time cannot move the badge.
 */
export function advanceUnreadActivityV1(
  current: UnreadStateV1,
  activity: { cursor: string; at: string },
): UnreadStateV1 {
  const cursor = decodeMessageCursor(activity.cursor);
  if (
    current.lastActivityCursor !== undefined &&
    current.lastActivityCursor >= cursor
  ) {
    return current;
  }
  return {
    ...current,
    lastActivityCursor: cursor,
    lastActivityAt: activity.at,
  };
}

/**
 * Records that the User read up to a cursor. `max()` makes out-of-order
 * delivery safe, and reading always clears the manual flag: the User is
 * looking at the thread they marked unread.
 */
export function markUnreadReadV1(
  current: UnreadStateV1,
  input: { upToCursor: string; at: string },
): UnreadStateV1 {
  const cursor = decodeMessageCursor(input.upToCursor);
  const lastSeenCursor =
    current.lastSeenCursor !== undefined && current.lastSeenCursor > cursor
      ? current.lastSeenCursor
      : cursor;
  const lastViewedAt =
    lastSeenCursor === current.lastSeenCursor &&
    current.lastViewedAt !== undefined &&
    current.lastViewedAt > input.at
      ? current.lastViewedAt
      : input.at;
  return {
    ...current,
    lastSeenCursor,
    lastViewedAt,
    manuallyUnread: false,
    unreadFromMessageId: undefined,
  };
}

/** User intent, stored because nothing derives it. */
export function markUnreadV1(current: UnreadStateV1): UnreadStateV1 {
  return { ...current, manuallyUnread: true };
}

/**
 * The projection the sidebar renders. `count` is derived from the message
 * index every read; nothing here is stored.
 */
export interface BotUnreadViewV1 {
  schemaVersion: 1;
  botId: string;
  /** Sent messages since `lastSeenCursor`, capped at {@link UNREAD_COUNT_CAP}. */
  count: number;
  /** True when the real count is above the cap — the "99+" case. */
  capped: boolean;
  /** Whether the row renders bold: a count, or the manual flag. */
  unread: boolean;
  manuallyUnread: boolean;
  unreadFromMessageId?: string;
  /** What a `bot/mark-read` should name as `upToCursor`. */
  lastSeenCursor?: string;
  lastActivityCursor?: string;
  lastMessageId?: string;
  lastActivityAt?: string;
  lastViewedAt?: string;
  /** Latest settled assistant/user line, projected for the sidebar only. */
  lastMessage?: SidebarMessagePreviewV1;
  /**
   * Whether this Bot has a Turn running right now.
   *
   * The sidebar draws it as an activity ring on the row's avatar, so somebody
   * reading one conversation can see another Bot still working rather than
   * assuming it stalled. Optional: a view a client older than the Bot decodes,
   * or one stored before this existed, simply draws no ring.
   */
  working?: boolean;
}

export interface BotUnreadDirectoryViewV1 {
  schemaVersion: 1;
  unread: BotUnreadViewV1[];
}

/**
 * Counts message cursors in `(lastSeenCursor, lastActivityCursor]`.
 * `cursors` is the newest-first index page; it only has to be one longer than
 * the cap for the cap to be exact.
 */
export function projectBotUnreadViewV1(
  botId: string,
  state: UnreadStateV1,
  cursors: readonly string[],
  lastMessage?: SidebarMessagePreviewV1,
  /**
   * Unacknowledged Routine failures. An automation Turn deliberately does not
   * advance the activity cursor, so a Routine failing every minute badged
   * nothing at all — the one Bot the User most needed to look at was the one
   * the sidebar stayed quiet about. A failure is the Bot addressing its User,
   * so it counts here even though the firing that produced it does not.
   */
  _automationFailures = 0,
  /** True while a Turn of this Bot's is running. Drawn as the row's ring. */
  working = false,
): BotUnreadViewV1 {
  const ceiling = state.lastActivityCursor;
  let counted = 0;
  if (ceiling !== undefined) {
    for (const cursor of cursors) {
      if (cursor > ceiling) continue;
      if (
        state.lastSeenCursor !== undefined &&
        cursor <= state.lastSeenCursor
      ) {
        break;
      }
      counted += 1;
      if (counted > UNREAD_COUNT_CAP) break;
    }
  }
  const capped = counted > UNREAD_COUNT_CAP;
  const count = capped ? UNREAD_COUNT_CAP : counted;
  return {
    schemaVersion: 1,
    botId,
    count,
    capped,
    unread: count > 0 || state.manuallyUnread,
    manuallyUnread: state.manuallyUnread,
    ...(state.unreadFromMessageId === undefined
      ? {}
      : { unreadFromMessageId: state.unreadFromMessageId }),
    ...(state.lastMessageId === undefined
      ? {}
      : { lastMessageId: state.lastMessageId }),
    ...(state.lastSeenCursor === undefined
      ? {}
      : { lastSeenCursor: state.lastSeenCursor }),
    ...(state.lastActivityCursor === undefined
      ? {}
      : { lastActivityCursor: state.lastActivityCursor }),
    ...(state.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: state.lastActivityAt }),
    ...(state.lastViewedAt === undefined
      ? {}
      : { lastViewedAt: state.lastViewedAt }),
    ...(lastMessage === undefined ? {} : { lastMessage }),
    ...(working ? { working: true } : {}),
  };
}

/**
 * An authenticated command, never a side effect of a read: a background poll
 * that listed runs must not clear a badge.
 */
export interface BotUnreadCommandV1 {
  schemaVersion: 1;
  type: "bot/mark-read" | "bot/mark-unread";
  commandId: string;
  botId: string;
  /** Required by `bot/mark-read`, refused on `bot/mark-unread`. */
  upToCursor?: string;
  fromMessageId?: string;
}

export interface BotUnreadReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied";
  unread: BotUnreadViewV1;
}

export function decodeBotUnreadCommandV1(input: unknown): BotUnreadCommandV1 {
  const value = record(input, "unread command");
  exactKeys(
    value,
    ["schemaVersion", "type", "commandId", "botId"],
    ["upToCursor", "fromMessageId"],
    "unread command",
  );
  if (value.schemaVersion !== 1) {
    throw new UnreadDecodeError("unread command schemaVersion is invalid");
  }
  if (value.type !== "bot/mark-read" && value.type !== "bot/mark-unread") {
    throw new UnreadDecodeError("unread command type is invalid");
  }
  if (
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    value.commandId.length > MAX_COMMAND_ID_LENGTH
  ) {
    throw new UnreadDecodeError("unread command commandId is invalid");
  }
  if (typeof value.botId !== "string" || !isPublicIdentifier(value.botId)) {
    throw new UnreadDecodeError("unread command botId is invalid");
  }
  const fromMessageId = messageBoundary(value.fromMessageId);
  if (fromMessageId !== undefined && value.type !== "bot/mark-unread") {
    throw new UnreadDecodeError(
      "message boundary belongs only to bot/mark-unread",
    );
  }
  const upToCursor = optionalCursor(value, "upToCursor", "unread command");
  if ((value.type === "bot/mark-read") !== (upToCursor !== undefined)) {
    throw new UnreadDecodeError(
      "unread command upToCursor belongs only to bot/mark-read",
    );
  }
  return {
    schemaVersion: 1,
    type: value.type,
    commandId: value.commandId,
    botId: value.botId,
    ...(upToCursor === undefined ? {} : { upToCursor }),
    ...(fromMessageId === undefined ? {} : { fromMessageId }),
  };
}

/** The same canonicalization every other command family is fingerprinted with. */
export function botUnreadCommandFingerprintV1(
  command: BotUnreadCommandV1,
): string {
  const { commandId: _commandId, ...semantic } = command;
  return canonicalCommandFingerprintV1("bot-unread-command-v1", semantic);
}

export function unreadReceiptKeyV1(commandId: string): string {
  return `${UNREAD_RECEIPT_PREFIX}${commandId}`;
}

function decodeBotUnreadViewV1(input: unknown): BotUnreadViewV1 {
  const value = record(input, "unread view");
  exactKeys(
    value,
    ["schemaVersion", "botId", "count", "capped", "unread", "manuallyUnread"],
    [
      "lastActivityCursor",
      "lastMessageId",
      "lastSeenCursor",
      "lastActivityAt",
      "lastViewedAt",
      "lastMessage",
      "working",
      "unreadFromMessageId",
    ],
    "unread view",
  );
  if (value.schemaVersion !== 1) {
    throw new UnreadDecodeError("unread view schemaVersion is invalid");
  }
  if (typeof value.botId !== "string" || !isPublicIdentifier(value.botId)) {
    throw new UnreadDecodeError("unread view botId is invalid");
  }
  if (
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    (value.count as number) > UNREAD_COUNT_CAP
  ) {
    throw new UnreadDecodeError("unread view count is invalid");
  }
  if (
    typeof value.capped !== "boolean" ||
    typeof value.unread !== "boolean" ||
    typeof value.manuallyUnread !== "boolean"
  ) {
    throw new UnreadDecodeError("unread view flags are invalid");
  }
  const lastActivityCursor = optionalCursor(
    value,
    "lastActivityCursor",
    "unread view",
  );
  const lastActivityAt = optionalTimestamp(
    value,
    "lastActivityAt",
    "unread view",
  );
  const lastViewedAt = optionalTimestamp(value, "lastViewedAt", "unread view");
  const lastMessage = optionalSidebarMessagePreviewV1(value.lastMessage);
  if (value.working !== undefined && typeof value.working !== "boolean") {
    throw new UnreadDecodeError("unread view working is invalid");
  }
  return {
    schemaVersion: 1,
    botId: value.botId,
    count: value.count as number,
    capped: value.capped,
    unread: value.unread,
    manuallyUnread: value.manuallyUnread,
    ...(value.unreadFromMessageId === undefined
      ? {}
      : { unreadFromMessageId: messageBoundary(value.unreadFromMessageId) }),
    ...(value.lastSeenCursor === undefined
      ? {}
      : {
          lastSeenCursor: optionalCursor(
            value,
            "lastSeenCursor",
            "unread view",
          ),
        }),
    ...(lastActivityCursor === undefined ? {} : { lastActivityCursor }),
    ...(value.lastMessageId === undefined
      ? {}
      : { lastMessageId: messageBoundary(value.lastMessageId) }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
    ...(lastMessage === undefined ? {} : { lastMessage }),
    ...(value.working === true ? { working: true } : {}),
  };
}

export function decodeBotUnreadDirectoryViewV1(
  input: unknown,
): BotUnreadDirectoryViewV1 {
  const value = record(input, "unread directory");
  exactKeys(value, ["schemaVersion", "unread"], [], "unread directory");
  if (value.schemaVersion !== 1 || !Array.isArray(value.unread)) {
    throw new UnreadDecodeError("unread directory is invalid");
  }
  return {
    schemaVersion: 1,
    unread: value.unread.map(decodeBotUnreadViewV1),
  };
}

export function decodeBotUnreadReceiptV1(input: unknown): BotUnreadReceiptV1 {
  const value = record(input, "unread receipt");
  exactKeys(
    value,
    ["schemaVersion", "commandId", "status", "unread"],
    [],
    "unread receipt",
  );
  if (
    value.schemaVersion !== 1 ||
    typeof value.commandId !== "string" ||
    value.status !== "applied"
  ) {
    throw new UnreadDecodeError("unread receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: value.commandId,
    status: "applied",
    unread: decodeBotUnreadViewV1(value.unread),
  };
}

/**
 * One pending notification intent, carrying the Bot it belongs to. The
 * per-Bot route already answers the open Bot's intents; this is the bounded
 * fan-out that lets a completion on a Bot nobody is looking at surface.
 */
export interface BotPendingNotificationV1 {
  urgency?: "normal" | "critical";
  schemaVersion: 1;
  botId: string;
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
}

export interface BotNotificationDirectoryViewV1 {
  schemaVersion: 1;
  notifications: BotPendingNotificationV1[];
}

const MAX_NOTIFICATION_TITLE_LENGTH = 512;
const MAX_NOTIFICATION_BODY_LENGTH = 2_000;
const MAX_NOTIFICATION_ID_LENGTH = 256;

function boundedText(
  value: unknown,
  maximum: number,
  label: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new UnreadDecodeError(`${label} is invalid`);
  }
  return value;
}

function decodeBotPendingNotificationV1(
  input: unknown,
): BotPendingNotificationV1 {
  const value = record(input, "pending notification");
  exactKeys(
    value,
    [
      "schemaVersion",
      "botId",
      "notificationId",
      "runId",
      "createdAt",
      "title",
      "body",
    ],
    ["urgency"],
    "pending notification",
  );
  if (value.schemaVersion !== 1) {
    throw new UnreadDecodeError(
      "pending notification schemaVersion is invalid",
    );
  }
  if (typeof value.botId !== "string" || !isPublicIdentifier(value.botId)) {
    throw new UnreadDecodeError("pending notification botId is invalid");
  }
  if (
    value.urgency !== undefined &&
    value.urgency !== "normal" &&
    value.urgency !== "critical"
  )
    throw new UnreadDecodeError("notification urgency is invalid");
  const createdAt = optionalTimestamp(
    value,
    "createdAt",
    "pending notification",
  );
  if (createdAt === undefined) {
    throw new UnreadDecodeError("pending notification createdAt is invalid");
  }
  return {
    schemaVersion: 1,
    botId: value.botId,
    ...(value.urgency === undefined ? {} : { urgency: value.urgency }),
    notificationId: boundedText(
      value.notificationId,
      MAX_NOTIFICATION_ID_LENGTH,
      "pending notification notificationId",
    ),
    runId: boundedText(
      value.runId,
      MAX_NOTIFICATION_ID_LENGTH,
      "pending notification runId",
    ),
    createdAt,
    title: boundedText(
      value.title,
      MAX_NOTIFICATION_TITLE_LENGTH,
      "pending notification title",
    ),
    body: boundedText(
      value.body,
      MAX_NOTIFICATION_BODY_LENGTH,
      "pending notification body",
      true,
    ),
  };
}

/**
 * The Bot's unread projection. The count is derived from the admission index
 * on every read, one page longer than the cap so "99+" is exact.
 */
export async function readUnread(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<BotUnreadViewV1> {
  await state.authority.validateIdentity(identity);
  const [storedState, storedPreview] = await state.ctx.storage.transaction(
    (transaction) =>
      Promise.all([
        transaction.get<unknown>(UNREAD_STATE_KEY),
        transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
      ]),
  );
  const unreadState = optionalUnreadStateV1(storedState);
  const index = await state.authority.listRunIndex({
    limit: UNREAD_COUNT_CAP + 1,
  });
  const messages = await state.ctx.storage.list<unknown>({
    prefix: MESSAGE_PREFIX,
    reverse: true,
    limit: UNREAD_COUNT_CAP + 1,
  });
  return projectBotUnreadViewV1(
    identity.botId,
    unreadState,
    [...messages.keys()].map((key) => key.slice(MESSAGE_PREFIX.length)),
    await sidebarPreview(state, storedPreview, index),
    0,
    await runWorkingV1(state, index[0]?.runId),
  );
}

/**
 * How many stored runs a read will open to recover a missing preview. The
 * newest sent message is almost always the first entry; the bound is what
 * keeps a Bot whose recent Turns are all automations from turning one sidebar
 * read into a scan of its whole history.
 */
const SIDEBAR_PREVIEW_BACKFILL_RUNS_V1 = 5;

/**
 * The preview record, or the same line derived from the runs when there is
 * none. A Bot whose Turns settled before the preview projection existed has a
 * full transcript and no record, and the row read "No messages yet" over it. A
 * read never writes what it derives: the next settlement stores it.
 */
async function sidebarPreview(
  state: ShellBotStateV1,
  storedPreview: unknown,
  index: readonly { runId: string }[],
): Promise<SidebarMessagePreviewV1 | undefined> {
  const stored = optionalSidebarMessagePreviewV1(storedPreview);
  if (stored) return stored;
  const runs: SidebarPreviewRunV1[] = [];
  for (const entry of index.slice(0, SIDEBAR_PREVIEW_BACKFILL_RUNS_V1)) {
    const run = await state.authority.readRun(entry.runId);
    if (run) runs.push(run);
  }
  return sidebarMessagePreviewFromRunsV1(runs);
}

/**
 * `bot/mark-read` and `bot/mark-unread`. Idempotent on the command id and
 * monotonic in the cursor, so a replay or an out-of-order delivery can only
 * ever produce the same durable record.
 */
export async function executeUnreadCommand(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: BotUnreadCommandV1,
): Promise<BotUnreadReceiptV1> {
  if (command.botId !== identity.botId) {
    throw new Error("unread command does not match its Bot");
  }
  await state.authority.validateIdentity(identity);
  const fingerprint = botUnreadCommandFingerprintV1(command);
  const receiptKey = unreadReceiptKeyV1(command.commandId);
  const stored = await state.ctx.storage.transaction(async (transaction) => {
    const existing = await transaction.get<{
      commandFingerprint: string;
      state: unknown;
    }>(receiptKey);
    if (existing) {
      if (existing.commandFingerprint !== fingerprint) {
        throw new Error(
          `unread command id "${command.commandId}" was reused for a different command`,
        );
      }
      return {
        state: optionalUnreadStateV1(existing.state),
        preview: await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
      };
    }
    if (command.fromMessageId !== undefined) {
      const [runId, kind, position] = command.fromMessageId.split(":");
      const run = await state.authority.readRun(runId!);
      const sessionId = await state.authority.readConversationSessionId();
      if (
        !run ||
        (run.admission?.turnType !== "automation" &&
          run.sessionId !== sessionId) ||
        !isVisibleRunV1(run) ||
        (kind === "send" &&
          Number(position) >=
            run.events.filter((event) => event.type === "send/to-user").length)
      ) {
        throw new Error(
          "Unread boundary does not name a message in this Bot’s chat",
        );
      }
    }
    const current = optionalUnreadStateV1(
      await transaction.get<unknown>(UNREAD_STATE_KEY),
    );
    let next = current;
    if (command.type === "bot/mark-read") {
      if (!command.upToCursor) {
        throw new Error("bot/mark-read requires upToCursor");
      }
      if (!(await transaction.get(`${MESSAGE_PREFIX}${command.upToCursor}`))) {
        throw new Error("Read cursor does not name a message in this Bot");
      }
      next = markUnreadReadV1(current, {
        upToCursor: command.upToCursor,
        at: new Date().toISOString(),
      });
    } else {
      next = {
        ...markUnreadV1(current),
        unreadFromMessageId: command.fromMessageId,
      };
    }
    if (command.type === "bot/mark-read") {
      await transaction.put("shell:push-read", { cursor: next.lastSeenCursor });
      const notices = await transaction.list<{ notificationId: string }>({
        prefix: "notification:",
      });
      for (const [key, notice] of notices) {
        if (
          notice.notificationId.startsWith("message-") &&
          notice.notificationId <= next.lastSeenCursor!
        )
          await transaction.delete(key);
      }
    }
    await transaction.put({
      [UNREAD_STATE_KEY]: next,
      [receiptKey]: { commandFingerprint: fingerprint, state: next },
    });
    await state.authority.refreshRecoveryAlarm(transaction);
    return {
      state: next,
      preview: await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
    };
  });
  const index = await state.authority.listRunIndex({
    limit: UNREAD_COUNT_CAP + 1,
  });
  const messages = await state.ctx.storage.list<unknown>({
    prefix: MESSAGE_PREFIX,
    reverse: true,
    limit: UNREAD_COUNT_CAP + 1,
  });
  return {
    schemaVersion: 1,
    commandId: command.commandId,
    status: "applied",
    unread: projectBotUnreadViewV1(
      identity.botId,
      stored.state,
      [...messages.keys()].map((key) => key.slice(MESSAGE_PREFIX.length)),
      // The open Bot is the one that gets marked read, so this receipt is the
      // sidebar row it renders from: it owes the same derived preview the
      // fan-out gives every other Bot.
      await sidebarPreview(state, stored.preview, index),
    ),
  };
}

export function decodeBotNotificationDirectoryViewV1(
  input: unknown,
): BotNotificationDirectoryViewV1 {
  const value = record(input, "notification directory");
  exactKeys(
    value,
    ["schemaVersion", "notifications"],
    [],
    "notification directory",
  );
  if (value.schemaVersion !== 1 || !Array.isArray(value.notifications)) {
    throw new UnreadDecodeError("notification directory is invalid");
  }
  return {
    schemaVersion: 1,
    notifications: value.notifications.map(decodeBotPendingNotificationV1),
  };
}
