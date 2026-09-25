// What the User object, a Group Chat's own object and each member Bot agree on:
// the records, the commands people and Bots send, and the rules for reading a
// mention out of a message.
//
// The User Durable Object is the authority for which groups exist and who is
// in them. A group's `GroupChat` Durable Object holds its thread. A member's
// Turn runs in that member's own Bot Durable Object.

import { isPublicIdentifier } from "@frockbot/core/configuration";
import { sha256HexTextV1 } from "@frockbot/core/crypto";

export const GROUP_CHAT_MEMBERS_MIN_V1 = 2;
export const GROUP_CHAT_MEMBERS_MAX_V1 = 8;
/** Archived groups count: the User restores or deletes one to make room. */
export const GROUP_CHAT_LIMIT_V1 = 100;
export const GROUP_CHAT_NAME_MAX_V1 = 80;
export const GROUP_MESSAGE_TEXT_MAX_V1 = 8_000;
export const GROUP_MESSAGE_PAGE_MAX_V1 = 100;
/**
 * How many Bot-started Turns may follow one another without the person
 * speaking. Until Jev judges Bot-to-Bot Turns this bound is what ends a
 * loop; it is not a limit on a conversation the person is part of.
 */
export const GROUP_BOT_CHAIN_MAX_V1 = 8;

const GROUP_ID_PATTERN = /^g-[0-9a-f]{20}$/;
const GROUP_SESSION_PREFIX = "group:";

export class GroupChatDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupChatDecodeError";
  }
}

export class GroupChatNotFoundError extends Error {
  constructor(readonly groupId: string) {
    super(`Group Chat "${groupId}" does not exist`);
    this.name = "GroupChatNotFoundError";
  }
}

/** A command that cannot apply to the group as it stands. */
export class GroupChatConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupChatConflictError";
  }
}

export function isGroupIdV1(value: unknown): value is string {
  return typeof value === "string" && GROUP_ID_PATTERN.test(value);
}

export function decodeGroupIdV1(value: unknown): string {
  if (!isGroupIdV1(value)) {
    throw new GroupChatDecodeError("groupId is invalid");
  }
  return value;
}

/** The Session a member's group Turns run under, in that member's own object. */
export function groupSessionIdV1(groupId: string): string {
  return `${GROUP_SESSION_PREFIX}${groupId}`;
}

export function isGroupSessionIdV1(sessionId: string): boolean {
  return sessionId.startsWith(GROUP_SESSION_PREFIX);
}

/** The group a Session belongs to, when it is a group's. */
export function groupIdOfSessionV1(sessionId: string): string | undefined {
  if (!isGroupSessionIdV1(sessionId)) return undefined;
  const groupId = sessionId.slice(GROUP_SESSION_PREFIX.length);
  return isGroupIdV1(groupId) ? groupId : undefined;
}

/** The name a group's own Durable Object is addressed by. */
export function groupChatObjectNameV1(userId: string, groupId: string): string {
  return `${userId}:${groupId}`;
}

/** A create command names its group, so a replayed create is the same group. */
export async function groupIdForCommandV1(
  userId: string,
  commandId: string,
): Promise<string> {
  return `g-${(await sha256HexTextV1(`${userId}\n${commandId}`)).slice(0, 20)}`;
}

/**
 * The run a member's group Turn is admitted as.
 *
 * Derived from what the Turn answers — the group, the member, the last message
 * it reads — so asking the member twice for the same message is one Turn. A
 * Retry is a new attempt at the same message, and a new run.
 */
export async function groupTurnRunIdV1(input: {
  groupId: string;
  botId: string;
  throughSeq: number;
  attempt: number;
}): Promise<string> {
  const digest = await sha256HexTextV1(
    `${input.groupId}\n${input.botId}\n${input.throughSeq}\n${input.attempt}`,
  );
  return `grp-${digest.slice(0, 32)}`;
}

/** Where a group sits in the User's sidebar. */
export interface GroupChatArrangementV1 {
  pinnedAt?: string;
  sidebarOrder?: number;
  hiddenFromSidebar?: true;
}

export interface GroupChatRecordV1 extends GroupChatArrangementV1 {
  schemaVersion: 1;
  groupId: string;
  /** Absent until the User or a Bot names it; clients show the members. */
  name?: string;
  /** Bot ids, in the order they joined. */
  members: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface GroupChatListV1 {
  schemaVersion: 1;
  revision: number;
  groups: GroupChatRecordV1[];
}

export interface GroupMemberV1 {
  botId: string;
  name: string;
  /** What the member is for, as its profile says. */
  description?: string;
}

/** What a group's object reads from the User object before acting. */
export interface GroupChatContextV1 {
  schemaVersion: 1;
  group: GroupChatRecordV1;
  /** The members with the names the directory shows now. */
  members: GroupMemberV1[];
}

export type GroupActorV1 = { kind: "user" } | { kind: "bot"; botId: string };

export type GroupAuthorV1 = GroupActorV1;

/** A mention resolved when the message was posted, stored by Bot id. */
export interface GroupMentionV1 {
  botId: string;
  /** UTF-16 offsets of `@Name` in the text, for drawing it as a chip. */
  start: number;
  end: number;
}

/** A line in the thread that is not something anyone said. */
export type GroupEventV1 =
  | { type: "created"; members: string[]; name?: string }
  | { type: "renamed"; name: string | null }
  | { type: "member-added"; botId: string }
  | { type: "member-removed"; botId: string }
  | { type: "archived" }
  | { type: "restored" }
  /** A member's Turn was stopped before it said anything. */
  | { type: "turn-stopped"; botId: string; runId: string }
  /** A member's Turn did not finish; Retry runs that member again. */
  | { type: "turn-failed"; botId: string; runId: string }
  /**
   * A member asked a Bot outside the group, with `bot_message`. The exchange
   * itself is the member's; the thread shows that it happened.
   */
  | {
      type: "bot-message";
      botId: string;
      toBotId: string;
      runId: string;
      callId: string;
    };

export type GroupMessageBodyV1 =
  | {
      kind: "text";
      text: string;
      mentions: GroupMentionV1[];
      /** A member wrote `@User`: the person is notified, not just badged. */
      mentionsUser?: true;
    }
  | { kind: "event"; event: GroupEventV1 };

export interface GroupMessageV1 {
  schemaVersion: 1;
  /** Position in the thread, from 1. */
  seq: number;
  /** Stable across a replayed post; what makes posting idempotent. */
  messageId: string;
  at: string;
  author: GroupAuthorV1;
  body: GroupMessageBodyV1;
}

export interface GroupMessagePageV1 {
  schemaVersion: 1;
  messages: GroupMessageV1[];
  /** More messages exist beyond this page in the direction it was read. */
  hasMore: boolean;
}

export interface GroupChatViewV1 {
  schemaVersion: 1;
  group: GroupChatRecordV1;
  members: GroupMemberV1[];
  /** The last message's `seq`, or 0 for a thread with none. */
  head: number;
  readThrough: number;
  /** Bot messages after `readThrough`, capped at 99. */
  unread: number;
  /** Members whose group Turn is running now. A queued Turn is not listed. */
  working: string[];
}

export type GroupChatCommandV1 =
  | {
      type: "group/create";
      commandId: string;
      members: string[];
      name?: string;
    }
  | {
      type: "group/rename";
      commandId: string;
      groupId: string;
      name: string | null;
    }
  | {
      type: "group/add-member";
      commandId: string;
      groupId: string;
      botId: string;
    }
  | {
      type: "group/remove-member";
      commandId: string;
      groupId: string;
      botId: string;
    }
  | { type: "group/archive"; commandId: string; groupId: string }
  | { type: "group/restore"; commandId: string; groupId: string }
  | { type: "group/delete"; commandId: string; groupId: string }
  | {
      type: "group/arrange";
      commandId: string;
      groupId: string;
      pinned?: boolean;
      sidebarOrder?: number | null;
      hidden?: boolean;
    };

export interface GroupChatReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  groupId: string;
  /** `unchanged` for a command that asked for what was already so. */
  status: "applied" | "unchanged";
  /** The group after the command; absent once it is deleted. */
  group?: GroupChatRecordV1;
  revision: number;
}

export interface GroupPostCommandV1 {
  schemaVersion: 1;
  commandId: string;
  text: string;
}

export interface GroupReadCommandV1 {
  schemaVersion: 1;
  upTo: number;
}

export interface GroupStopCommandV1 {
  schemaVersion: 1;
  commandId: string;
  /** One member; absent stops every member Turn running for this group. */
  botId?: string;
}

export interface GroupRetryCommandV1 {
  schemaVersion: 1;
  commandId: string;
  botId: string;
  /** The Turn that did not finish, as its `turn-failed` line names it. */
  runId: string;
}

// ---- decoding -------------------------------------------------------------

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GroupChatDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new GroupChatDecodeError(`${label}.${key} is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new GroupChatDecodeError(`${label}.${key} is required`);
    }
  }
}

function identifier(value: unknown, label: string): string {
  if (!isPublicIdentifier(value)) {
    throw new GroupChatDecodeError(`${label} is invalid`);
  }
  return value;
}

/** Trimmed, single-line, bounded; empty means "no name". */
function nameOrNull(
  value: unknown,
  maximum: number,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new GroupChatDecodeError(`${label} must be a string or null`);
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length > maximum) {
    throw new GroupChatDecodeError(`${label} is longer than ${maximum}`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

function members(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new GroupChatDecodeError(`${label} must be an array`);
  }
  const ids = value.map((item, index) =>
    identifier(item, `${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new GroupChatDecodeError(`${label} names a Bot twice`);
  }
  if (
    ids.length < GROUP_CHAT_MEMBERS_MIN_V1 ||
    ids.length > GROUP_CHAT_MEMBERS_MAX_V1
  ) {
    throw new GroupChatDecodeError(
      `a Group Chat has ${GROUP_CHAT_MEMBERS_MIN_V1} to ${GROUP_CHAT_MEMBERS_MAX_V1} Bots`,
    );
  }
  return ids;
}

export function decodeGroupChatCommandV1(input: unknown): GroupChatCommandV1 {
  const value = objectOf(input, "command");
  const type = value.type;
  const label = "command";
  switch (type) {
    case "group/create": {
      exactKeys(value, ["type", "commandId", "members"], ["name"], label);
      const name =
        value.name === undefined
          ? null
          : nameOrNull(value.name, GROUP_CHAT_NAME_MAX_V1, `${label}.name`);
      return {
        type,
        commandId: identifier(value.commandId, `${label}.commandId`),
        members: members(value.members, `${label}.members`),
        ...(name ? { name } : {}),
      };
    }
    case "group/rename":
      exactKeys(value, ["type", "commandId", "groupId", "name"], [], label);
      return {
        type,
        commandId: identifier(value.commandId, `${label}.commandId`),
        groupId: decodeGroupIdV1(value.groupId),
        name: nameOrNull(value.name, GROUP_CHAT_NAME_MAX_V1, `${label}.name`),
      };
    case "group/add-member":
    case "group/remove-member":
      exactKeys(value, ["type", "commandId", "groupId", "botId"], [], label);
      return {
        type,
        commandId: identifier(value.commandId, `${label}.commandId`),
        groupId: decodeGroupIdV1(value.groupId),
        botId: identifier(value.botId, `${label}.botId`),
      };
    case "group/archive":
    case "group/restore":
    case "group/delete":
      exactKeys(value, ["type", "commandId", "groupId"], [], label);
      return {
        type,
        commandId: identifier(value.commandId, `${label}.commandId`),
        groupId: decodeGroupIdV1(value.groupId),
      };
    case "group/arrange": {
      exactKeys(
        value,
        ["type", "commandId", "groupId"],
        // Installed apps may still send the retired sidebar label. It is
        // accepted and dropped until those apps have updated.
        ["label", "pinned", "sidebarOrder", "hidden"],
        label,
      );
      const command: Extract<GroupChatCommandV1, { type: "group/arrange" }> = {
        type,
        commandId: identifier(value.commandId, `${label}.commandId`),
        groupId: decodeGroupIdV1(value.groupId),
      };
      if (value.pinned !== undefined) {
        if (typeof value.pinned !== "boolean") {
          throw new GroupChatDecodeError(`${label}.pinned must be a boolean`);
        }
        command.pinned = value.pinned;
      }
      if (value.sidebarOrder !== undefined) {
        if (
          value.sidebarOrder !== null &&
          (typeof value.sidebarOrder !== "number" ||
            !Number.isFinite(value.sidebarOrder))
        ) {
          throw new GroupChatDecodeError(
            `${label}.sidebarOrder must be a number or null`,
          );
        }
        command.sidebarOrder = value.sidebarOrder;
      }
      if (value.hidden !== undefined) {
        if (typeof value.hidden !== "boolean") {
          throw new GroupChatDecodeError(`${label}.hidden must be a boolean`);
        }
        command.hidden = value.hidden;
      }
      return command;
    }
    default:
      throw new GroupChatDecodeError(
        `${label}.type is not a Group Chat command`,
      );
  }
}

function schemaOne(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) {
    throw new GroupChatDecodeError(`${label}.schemaVersion must be 1`);
  }
}

export function decodeGroupPostCommandV1(input: unknown): GroupPostCommandV1 {
  const value = objectOf(input, "post");
  exactKeys(value, ["schemaVersion", "commandId", "text"], [], "post");
  schemaOne(value, "post");
  if (typeof value.text !== "string") {
    throw new GroupChatDecodeError("post.text must be a string");
  }
  const text = value.text.trim();
  if (text.length === 0 || text.length > GROUP_MESSAGE_TEXT_MAX_V1) {
    throw new GroupChatDecodeError(
      `post.text must be 1 to ${GROUP_MESSAGE_TEXT_MAX_V1} characters`,
    );
  }
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "post.commandId"),
    text,
  };
}

function sequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GroupChatDecodeError(`${label} must be a message position`);
  }
  return value;
}

export function decodeGroupReadCommandV1(input: unknown): GroupReadCommandV1 {
  const value = objectOf(input, "read");
  exactKeys(value, ["schemaVersion", "upTo"], [], "read");
  schemaOne(value, "read");
  return { schemaVersion: 1, upTo: sequence(value.upTo, "read.upTo") };
}

export function decodeGroupStopCommandV1(input: unknown): GroupStopCommandV1 {
  const value = objectOf(input, "stop");
  exactKeys(value, ["schemaVersion", "commandId"], ["botId"], "stop");
  schemaOne(value, "stop");
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "stop.commandId"),
    ...(value.botId === undefined
      ? {}
      : { botId: identifier(value.botId, "stop.botId") }),
  };
}

export function decodeGroupRetryCommandV1(input: unknown): GroupRetryCommandV1 {
  const value = objectOf(input, "retry");
  exactKeys(
    value,
    ["schemaVersion", "commandId", "botId", "runId"],
    [],
    "retry",
  );
  schemaOne(value, "retry");
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "retry.commandId"),
    botId: identifier(value.botId, "retry.botId"),
    runId: identifier(value.runId, "retry.runId"),
  };
}

/** `before` or `after` a position, never both; a page is at most 100. */
export function decodeGroupMessagePageQueryV1(url: URL): {
  before?: number;
  after?: number;
  limit: number;
} {
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit");
  if (before !== null && after !== null) {
    throw new GroupChatDecodeError("a page is read before or after, not both");
  }
  const parsed = (raw: string, label: string) => {
    if (!/^\d{1,15}$/.test(raw)) {
      throw new GroupChatDecodeError(`${label} must be a message position`);
    }
    return Number(raw);
  };
  const size = limit === null ? 50 : parsed(limit, "limit");
  if (size < 1 || size > GROUP_MESSAGE_PAGE_MAX_V1) {
    throw new GroupChatDecodeError(
      `limit must be 1 to ${GROUP_MESSAGE_PAGE_MAX_V1}`,
    );
  }
  return {
    ...(before !== null ? { before: parsed(before, "before") } : {}),
    ...(after !== null ? { after: parsed(after, "after") } : {}),
    limit: size,
  };
}

// ---- names and mentions ---------------------------------------------------

/** "General, Xero Books & Codex": what an unnamed group is called. */
export function groupDisplayNameV1(
  group: Pick<GroupChatRecordV1, "name" | "members">,
  members: readonly GroupMemberV1[],
): string {
  if (group.name) return group.name;
  const names = group.members.map(
    (botId) => members.find((member) => member.botId === botId)?.name ?? botId,
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Every `@Name` in the text that names a member, resolved to that member.
 *
 * Names are matched whole and without regard to case, longest first, so
 * "@Xero Books" is Xero Books and not a Bot called Xero. An `@` inside a word
 * — an email address — is not a mention.
 */
export function resolveMentionsV1(
  text: string,
  members: readonly GroupMemberV1[],
): GroupMentionV1[] {
  const candidates = members
    .filter((member) => member.name.trim().length > 0)
    .map((member) => ({ botId: member.botId, name: member.name.toLowerCase() }))
    .sort((left, right) => right.name.length - left.name.length);
  const lower = text.toLowerCase();
  const mentions: GroupMentionV1[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@") continue;
    if (isNameCharacter(text[index - 1])) continue;
    const rest = lower.slice(index + 1);
    const match = candidates.find(
      (candidate) =>
        rest.startsWith(candidate.name) &&
        !isNameCharacter(rest[candidate.name.length]),
    );
    if (!match) continue;
    const end = index + 1 + match.name.length;
    mentions.push({ botId: match.botId, start: index, end });
    index = end - 1;
  }
  return mentions;
}

/** `@User`, the one way a member calls the person's attention. */
export function mentionsUserV1(text: string): boolean {
  return /(^|[^\p{L}\p{N}_@])@user(?![\p{L}\p{N}_])/iu.test(text);
}

/** Each mentioned member once, in the order first mentioned. */
export function mentionedBotIdsV1(
  mentions: readonly GroupMentionV1[],
): string[] {
  return [...new Set(mentions.map((mention) => mention.botId))];
}

// ---- answers across a Durable Object call ------------------------------

/**
 * A refusal travels between objects as a value: an error's class does not
 * survive the call, and the gateway has to tell a bad request from a missing
 * group from a conflict.
 */
export type GroupRpcAnswerV1<T> =
  | { schemaVersion: 1; ok: true; value: T }
  | {
      schemaVersion: 1;
      ok: false;
      code: "invalid" | "not-found" | "conflict";
      message: string;
    };

export async function answerGroupRpcV1<T>(
  work: () => Promise<T>,
): Promise<GroupRpcAnswerV1<T>> {
  try {
    return { schemaVersion: 1, ok: true, value: await work() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GroupChatDecodeError) {
      return { schemaVersion: 1, ok: false, code: "invalid", message };
    }
    if (error instanceof GroupChatNotFoundError) {
      return { schemaVersion: 1, ok: false, code: "not-found", message };
    }
    if (error instanceof GroupChatConflictError) {
      return { schemaVersion: 1, ok: false, code: "conflict", message };
    }
    throw error;
  }
}

/** The answer's value, or the refusal thrown again as its own class. */
export function unwrapGroupRpcV1<T>(answer: unknown): T {
  const value = answer as GroupRpcAnswerV1<T>;
  if (value?.ok === true) return structuredClone(value.value);
  if (value?.ok === false) {
    switch (value.code) {
      case "invalid":
        throw new GroupChatDecodeError(value.message);
      case "not-found": {
        const error = new GroupChatNotFoundError("");
        error.message = value.message;
        throw error;
      }
      case "conflict":
        throw new GroupChatConflictError(value.message);
    }
  }
  throw new Error("Group Chat answer is invalid");
}
