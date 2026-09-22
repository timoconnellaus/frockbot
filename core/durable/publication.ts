/**
 * Committed conversation publication: the visible projection, the replay
 * log, and the pending-broadcast obligation written in the same transaction
 * as the authoritative change.
 *
 * A cursor belongs to a publication epoch so a cleaned store cannot accept a
 * cursor from a previous one. Replay retention and pending broadcast are
 * separate lifetimes: an undrained obligation is never deleted merely to
 * fit the replay window.
 */
import {
  CONVERSATION_ROW_PREFIX,
  CONVERSATION_UPDATE_PREFIX,
  CONVERSATION_VISIBLE_ANNOUNCEMENT_LIMIT_V1,
  CONVERSATION_VISIBLE_INDEX_KEY,
  CONVERSATION_VISIBLE_RUN_LIMIT_V1,
  conversationRowKeyV1,
  conversationUpdateKeyV1,
  MAINTENANCE_BATCH_V1,
  PUBLICATION_HEAD_KEY,
  PUBLICATION_PENDING_PREFIX,
  PUBLICATION_REPLAY_MAX_BYTES_V1,
  PUBLICATION_REPLAY_MAX_EVENTS_V1,
  publicationPendingKey,
} from "./storage-keys.js";

export const CONVERSATION_KINDS_V1 = [
  "message",
  "run-status",
  "announcement",
  "card-revision",
  "computer",
] as const;

export type ConversationKindV1 = (typeof CONVERSATION_KINDS_V1)[number];

export interface PublicationHeadV1 {
  schemaVersion: 1;
  epoch: number;
  firstRetainedCursor: number;
  lastCursor: number;
  broadcastThrough: number;
}

export interface ConversationRowV1 {
  schemaVersion: 1;
  entityId: string;
  kind: ConversationKindV1;
  revision: number;
  payload: unknown;
}

export interface ConversationUpdateV1 {
  schemaVersion: 1;
  epoch: number;
  cursor: number;
  kind: ConversationKindV1;
  entityId: string;
  revision: number;
  payload: unknown;
}

export interface PendingPublicationV1 {
  schemaVersion: 1;
  epoch: number;
  cursor: number;
  entityId: string;
  kind: ConversationKindV1;
  revision: number;
}

export interface ConversationVisibleIndexV1 {
  schemaVersion: 1;
  runEntityIds: string[];
  announcementEntityIds: string[];
}

export interface PublicationContributionV1 {
  kind: ConversationKindV1;
  entityId: string;
  payload: unknown;
  /**
   * When set, the contribution is a no-op unless it is strictly greater than
   * the stored row revision. When omitted, the next revision is allocated.
   */
  revision?: number;
}

export interface PublicationTransactionV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number | boolean | void>;
  list?<T>(options: {
    prefix: string;
    limit?: number;
  }): Promise<Map<string, T>>;
}

export interface PublicationDrainStorageV1 extends PublicationTransactionV1 {
  list<T>(options: {
    prefix: string;
    limit?: number;
  }): Promise<Map<string, T>>;
  transaction<T>(
    callback: (transaction: PublicationTransactionV1) => Promise<T>,
  ): Promise<T>;
}

const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is ConversationKindV1 {
  return (
    typeof value === "string" &&
    (CONVERSATION_KINDS_V1 as readonly string[]).includes(value)
  );
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is not a safe non-negative integer`);
  }
  return value as number;
}

function requireEntityId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 320) {
    throw new Error("publication entity id is invalid");
  }
  return value;
}

export function emptyPublicationHeadV1(): PublicationHeadV1 {
  return {
    schemaVersion: 1,
    epoch: 1,
    firstRetainedCursor: 1,
    lastCursor: 0,
    broadcastThrough: 0,
  };
}

export function decodePublicationHeadV1(value: unknown): PublicationHeadV1 {
  if (value === undefined) return emptyPublicationHeadV1();
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("publication head is corrupt");
  }
  const epoch = requireSafeInteger(value.epoch, "publication epoch");
  const firstRetainedCursor = requireSafeInteger(
    value.firstRetainedCursor,
    "publication firstRetainedCursor",
  );
  const lastCursor = requireSafeInteger(
    value.lastCursor,
    "publication lastCursor",
  );
  const broadcastThrough = requireSafeInteger(
    value.broadcastThrough,
    "publication broadcastThrough",
  );
  if (epoch < 1) throw new Error("publication epoch is corrupt");
  if (firstRetainedCursor < 1) {
    throw new Error("publication firstRetainedCursor is corrupt");
  }
  if (lastCursor < 0 || lastCursor < firstRetainedCursor - 1) {
    throw new Error("publication lastCursor is corrupt");
  }
  if (broadcastThrough < 0 || broadcastThrough > lastCursor) {
    throw new Error("publication broadcastThrough is corrupt");
  }
  return {
    schemaVersion: 1,
    epoch,
    firstRetainedCursor,
    lastCursor,
    broadcastThrough,
  };
}

export function decodeConversationRowV1(value: unknown): ConversationRowV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isKind(value.kind)) {
    throw new Error("conversation row is corrupt");
  }
  return {
    schemaVersion: 1,
    entityId: requireEntityId(value.entityId),
    kind: value.kind,
    revision: requireSafeInteger(value.revision, "conversation row revision"),
    payload: value.payload,
  };
}

export function decodeConversationUpdateV1(
  value: unknown,
): ConversationUpdateV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isKind(value.kind)) {
    throw new Error("conversation update is corrupt");
  }
  return {
    schemaVersion: 1,
    epoch: requireSafeInteger(value.epoch, "conversation update epoch"),
    cursor: requireSafeInteger(value.cursor, "conversation update cursor"),
    kind: value.kind,
    entityId: requireEntityId(value.entityId),
    revision: requireSafeInteger(
      value.revision,
      "conversation update revision",
    ),
    payload: value.payload,
  };
}

export function decodePendingPublicationV1(
  value: unknown,
): PendingPublicationV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isKind(value.kind)) {
    throw new Error("pending publication is corrupt");
  }
  return {
    schemaVersion: 1,
    epoch: requireSafeInteger(value.epoch, "pending publication epoch"),
    cursor: requireSafeInteger(value.cursor, "pending publication cursor"),
    entityId: requireEntityId(value.entityId),
    kind: value.kind,
    revision: requireSafeInteger(value.revision, "pending publication revision"),
  };
}

function decodeVisibleIndex(
  value: unknown,
): ConversationVisibleIndexV1 {
  if (value === undefined) {
    return { schemaVersion: 1, runEntityIds: [], announcementEntityIds: [] };
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.runEntityIds) ||
    !Array.isArray(value.announcementEntityIds) ||
    value.runEntityIds.some((id) => typeof id !== "string") ||
    value.announcementEntityIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("conversation visible index is corrupt");
  }
  return {
    schemaVersion: 1,
    runEntityIds: value.runEntityIds as string[],
    announcementEntityIds: value.announcementEntityIds as string[],
  };
}

export function utf8BytesV1(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

export function runEntityIdV1(runId: string): string {
  return `run:${runId}`;
}

export function messageEntityIdV1(input: {
  sessionId: string;
  runId: string;
  occurrenceId: string;
}): string {
  return `msg:${input.sessionId}:${input.runId}:${input.occurrenceId}`;
}

export function announcementEntityIdV1(id: string): string {
  return `ann:${id}`;
}

export function cardEntityIdV1(surfaceId: string): string {
  return `card:${surfaceId}`;
}

export const COMPUTER_ENTITY_ID_V1 = "computer";

function pushBounded(ids: string[], entityId: string, limit: number): string[] {
  const next = ids.filter((id) => id !== entityId);
  next.push(entityId);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

async function trimReplay(
  transaction: PublicationTransactionV1,
  head: PublicationHeadV1,
  writes: Record<string, unknown>,
): Promise<PublicationHeadV1> {
  let first = head.firstRetainedCursor;
  const last = head.lastCursor;
  // Only already-attempted updates may be dropped to fit the window.
  const droppableThrough = Math.min(head.broadcastThrough, last);
  while (first <= droppableThrough) {
    const count = last - first + 1;
    if (count <= PUBLICATION_REPLAY_MAX_EVENTS_V1) {
      let bytes = 0;
      let over = false;
      for (let cursor = first; cursor <= last; cursor += 1) {
        const stored =
          writes[conversationUpdateKeyV1(cursor)] ??
          (await transaction.get<unknown>(conversationUpdateKeyV1(cursor)));
        if (stored === undefined) continue;
        bytes += utf8BytesV1(stored);
        if (bytes > PUBLICATION_REPLAY_MAX_BYTES_V1) {
          over = true;
          break;
        }
      }
      if (!over) break;
    }
    const expired = conversationUpdateKeyV1(first);
    delete writes[expired];
    await transaction.delete([expired]);
    first += 1;
  }
  return { ...head, firstRetainedCursor: first };
}

/**
 * Allocates cursors, updates conversation rows, appends publication events
 * and marks pending broadcast in the caller's transaction.
 *
 * Contributions whose revision does not advance are skipped. Order among
 * concurrent writers on this object is the transaction's commit order.
 */
export async function commitPublicationsV1(
  transaction: PublicationTransactionV1,
  contributions: readonly PublicationContributionV1[],
): Promise<ConversationUpdateV1[]> {
  if (contributions.length === 0) return [];
  let head = decodePublicationHeadV1(
    await transaction.get<unknown>(PUBLICATION_HEAD_KEY),
  );
  let index = decodeVisibleIndex(
    await transaction.get<unknown>(CONVERSATION_VISIBLE_INDEX_KEY),
  );
  const writes: Record<string, unknown> = {};
  const committed: ConversationUpdateV1[] = [];
  for (const contribution of contributions) {
    requireEntityId(contribution.entityId);
    if (!isKind(contribution.kind)) {
      throw new Error("publication kind is invalid");
    }
    const rowKey = conversationRowKeyV1(contribution.entityId);
    const stored = writes[rowKey] ?? (await transaction.get<unknown>(rowKey));
    const current =
      stored === undefined ? undefined : decodeConversationRowV1(stored);
    const nextRevision =
      contribution.revision ?? (current?.revision ?? 0) + 1;
    if (
      !Number.isSafeInteger(nextRevision) ||
      nextRevision < 1 ||
      (current !== undefined && nextRevision <= current.revision)
    ) {
      continue;
    }
    const last = head.lastCursor + 1;
    if (!Number.isSafeInteger(last)) {
      throw new Error("publication cursor is exhausted");
    }
    const row: ConversationRowV1 = {
      schemaVersion: 1,
      entityId: contribution.entityId,
      kind: contribution.kind,
      revision: nextRevision,
      payload: structuredClone(contribution.payload),
    };
    const update: ConversationUpdateV1 = {
      schemaVersion: 1,
      epoch: head.epoch,
      cursor: last,
      kind: contribution.kind,
      entityId: contribution.entityId,
      revision: nextRevision,
      payload: structuredClone(contribution.payload),
    };
    const pending: PendingPublicationV1 = {
      schemaVersion: 1,
      epoch: head.epoch,
      cursor: last,
      entityId: contribution.entityId,
      kind: contribution.kind,
      revision: nextRevision,
    };
    writes[rowKey] = row;
    writes[conversationUpdateKeyV1(last)] = update;
    writes[publicationPendingKey(last)] = pending;
    head = { ...head, lastCursor: last };
    if (contribution.kind === "run-status") {
      index = {
        ...index,
        runEntityIds: pushBounded(
          index.runEntityIds,
          contribution.entityId,
          CONVERSATION_VISIBLE_RUN_LIMIT_V1,
        ),
      };
    } else if (contribution.kind === "announcement") {
      index = {
        ...index,
        announcementEntityIds: pushBounded(
          index.announcementEntityIds,
          contribution.entityId,
          CONVERSATION_VISIBLE_ANNOUNCEMENT_LIMIT_V1,
        ),
      };
    }
    committed.push(update);
  }
  if (committed.length === 0) return [];
  head = await trimReplay(transaction, head, writes);
  writes[PUBLICATION_HEAD_KEY] = head;
  writes[CONVERSATION_VISIBLE_INDEX_KEY] = index;
  await transaction.put(writes);
  return committed;
}

export async function readPublicationHeadV1(
  storage: Pick<PublicationTransactionV1, "get">,
): Promise<PublicationHeadV1> {
  return decodePublicationHeadV1(
    await storage.get<unknown>(PUBLICATION_HEAD_KEY),
  );
}

export async function readConversationRowV1(
  storage: Pick<PublicationTransactionV1, "get">,
  entityId: string,
): Promise<ConversationRowV1 | undefined> {
  const stored = await storage.get<unknown>(conversationRowKeyV1(entityId));
  return stored === undefined ? undefined : decodeConversationRowV1(stored);
}

export async function readConversationUpdateV1(
  storage: Pick<PublicationTransactionV1, "get">,
  cursor: number,
): Promise<ConversationUpdateV1 | undefined> {
  const stored = await storage.get<unknown>(conversationUpdateKeyV1(cursor));
  return stored === undefined
    ? undefined
    : decodeConversationUpdateV1(stored);
}

export async function readVisibleIndexV1(
  storage: Pick<PublicationTransactionV1, "get">,
): Promise<ConversationVisibleIndexV1> {
  return decodeVisibleIndex(
    await storage.get<unknown>(CONVERSATION_VISIBLE_INDEX_KEY),
  );
}

export async function readReplayUpdatesV1(
  storage: Pick<PublicationTransactionV1, "get">,
  head: PublicationHeadV1,
  afterCursor: number,
): Promise<ConversationUpdateV1[]> {
  const updates: ConversationUpdateV1[] = [];
  for (let cursor = afterCursor + 1; cursor <= head.lastCursor; cursor += 1) {
    const update = await readConversationUpdateV1(storage, cursor);
    if (!update) {
      throw new Error(`publication replay gap at cursor ${cursor}`);
    }
    updates.push(update);
  }
  return updates;
}

async function reconstructUpdate(
  storage: Pick<PublicationTransactionV1, "get">,
  pending: PendingPublicationV1,
): Promise<ConversationUpdateV1 | undefined> {
  const stored = await readConversationUpdateV1(storage, pending.cursor);
  if (stored) return stored;
  const row = await readConversationRowV1(storage, pending.entityId);
  if (!row || row.revision < pending.revision) return undefined;
  return {
    schemaVersion: 1,
    epoch: pending.epoch,
    cursor: pending.cursor,
    kind: pending.kind,
    entityId: pending.entityId,
    revision: pending.revision,
    payload: structuredClone(row.payload),
  };
}

/**
 * Delivers one bounded batch of pending publication outside the authoritative
 * transaction, then advances `broadcastThrough`. Delivery is an attempt, not
 * proof every client received the frame. Missing subscribers still complete
 * the attempt so an idle object is not kept awake.
 */
export async function drainPendingPublicationV1(
  storage: PublicationDrainStorageV1,
  deliver: (updates: readonly ConversationUpdateV1[]) => Promise<void> | void,
  options: {
    refreshAlarm?: (transaction: PublicationTransactionV1) => Promise<void>;
    batch?: number;
  } = {},
): Promise<boolean> {
  if (!storage.list) return false;
  const pending = await storage.list<unknown>({
    prefix: PUBLICATION_PENDING_PREFIX,
    limit: options.batch ?? MAINTENANCE_BATCH_V1,
  });
  if (pending.size === 0) return false;
  const markers: PendingPublicationV1[] = [];
  for (const value of pending.values()) {
    markers.push(decodePendingPublicationV1(value));
  }
  markers.sort((left, right) => left.cursor - right.cursor);
  const updates: ConversationUpdateV1[] = [];
  for (const marker of markers) {
    const update = await reconstructUpdate(storage, marker);
    if (update) updates.push(update);
  }
  try {
    await deliver(updates);
  } catch {
    return true;
  }
  const through = markers[markers.length - 1]!.cursor;
  await storage.transaction(async (transaction) => {
    const head = decodePublicationHeadV1(
      await transaction.get<unknown>(PUBLICATION_HEAD_KEY),
    );
    const next: PublicationHeadV1 = {
      ...head,
      broadcastThrough: Math.max(head.broadcastThrough, through),
    };
    const trimmed = await trimReplay(transaction, next, {});
    await transaction.delete([...pending.keys()]);
    await transaction.put({ [PUBLICATION_HEAD_KEY]: trimmed });
    await options.refreshAlarm?.(transaction);
  });
  const more = await storage.list({
    prefix: PUBLICATION_PENDING_PREFIX,
    limit: 1,
  });
  return more.size > 0;
}

/** Prefixes a scoped S5 cleanup lists, so leftover invalidation records go. */
export const RETIRED_CHANNEL_META_KEY_V1 = "bot-state-channel:meta:v1";
export const RETIRED_CHANNEL_EVENT_PREFIX_V1 = "bot-state-channel:event:v1:";

export function isPublicationStorageKeyV1(key: string): boolean {
  return (
    key === PUBLICATION_HEAD_KEY ||
    key === CONVERSATION_VISIBLE_INDEX_KEY ||
    key.startsWith(PUBLICATION_PENDING_PREFIX) ||
    key.startsWith(CONVERSATION_ROW_PREFIX) ||
    key.startsWith(CONVERSATION_UPDATE_PREFIX)
  );
}
