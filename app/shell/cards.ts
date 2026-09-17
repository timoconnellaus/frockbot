/**
 * Cards, as durable state (ADR 0030).
 *
 * A `card` send carries the A2UI messages for one surface; this is where those
 * messages become something a client can read. The record is the folded
 * surface — its component set, its data model and its revision — so a client
 * that reconnects reads the current Card over REST and never replays a stream.
 *
 * Four rules live here and nowhere else.
 *
 *  * **Folded where the Turn settles.** `cardTerminalRecordsV1` is handed the
 *    settled run and a reader bound to the transaction settling it, and
 *    returns the records that transaction writes — the same seam an approval's
 *    pending decision comes through. The card in the transcript and the record
 *    an action is posted against become durable at the same instant.
 *
 *  * **Fold semantics are the specification's.** `createSurface` replaces the
 *    surface, `updateComponents` upserts by `id` and keeps the order the
 *    components were first seen in, `updateDataModel` writes `value` at its
 *    JSON Pointer — resolved as RFC 6901 does, through lists as well as
 *    objects, and `null` deletes the member — and `deleteSurface` tombstones
 *    the record rather than removing it, because the send that drew the card
 *    is still on the Turn's log and the transcript still has to say something.
 *
 *  * **Every fold bumps the revision.** An action names the revision it was
 *    drawn against; a stale one is refused, so nobody answers a card that has
 *    moved under them.
 *
 *  * **The Session's surfaces are bounded.** Cards do not tear down, so the
 *    index caps how many a Session may hold. A fold past a surface budget is
 *    refused whole and says so on the record it did not change: a card that
 *    silently stopped updating is worse than one that says it stopped. A first
 *    send refused this way still writes an empty record carrying the refusal,
 *    so the transcript has something to draw where the send sits. The index is
 *    the bound and a stored record is not: a surface the index does not list
 *    is new to the Session however much of it is still in storage. When the
 *    index is already full, its oldest surface is tombstoned with a refusal
 *    saying it made room, and the new card is written and indexed normally —
 *    trimming loses a row and never a fact, because the send that drew the
 *    trimmed card is still on its Turn's log. So no card send ever leaves no
 *    trace, not even a Turn drawing more surfaces than a Session may hold.
 */
import {
  A2UI_IDENTIFIER_V1,
  A2UI_LIMITS_V1,
  a2uiActionCountV1,
  a2uiByteLengthV1,
  a2uiMessageSurfaceIdV1,
  decodeA2uiActionV1,
  type A2uiActionV1,
  type A2uiAgentMessageV1,
  type A2uiComponentV1,
  type A2uiJsonObjectV1,
  type A2uiJsonValueV1,
} from "@frockbot/core/contracts";

/** One `CardRecordV1`, keyed by the surface the Bot named. */
export const CARD_PREFIX = "shell:card:";
/** The Session's surface roll, which is what bounds how many Cards it holds. */
export const CARD_INDEX_KEY = "shell:card-index";

const MAX_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;
/** Why a fold was refused, or why a press could not be answered, in words for the card. */
export const CARD_REFUSAL_MAX_V1 = 256;

export class CardDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardDecodeError";
  }
}

/** The folded surface, as it is stored and as a client reads it. */
export interface CardRecordV1 {
  schemaVersion: 1;
  surfaceId: string;
  /** The Turn whose fold last changed it. Any writer may be the last one. */
  runId: string;
  /**
   * The Turn that last folded its own sends onto it, written only when a Turn
   * settles. A press folding a handler's answer never touches it, so a
   * recovered Turn still knows it has already folded.
   */
  foldedRunId?: string;
  sessionId: string;
  /** The adjacency list, in the order the components were first seen. */
  components: A2uiComponentV1[];
  dataModel: A2uiJsonObjectV1;
  /** Bumped by every fold that changed the surface. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** The catalog the surface was created under, when it named one. */
  catalogId?: string;
  /** Whether a renderer `action` carries the data model with it. */
  sendDataModel?: boolean;
  /** The surface's own properties, under 1.0's name for them. */
  surfaceProperties?: A2uiJsonObjectV1;
  /** Set by `deleteSurface`. The record stays; the surface is gone. */
  deleted?: true;
  /** Why the last fold changed nothing. Cleared by the next one that does. */
  refusal?: string;
}

/** The Session's surfaces, oldest first. */
export interface CardIndexV1 {
  schemaVersion: 1;
  surfaces: string[];
}

export function cardKeyV1(surfaceId: string): string {
  return `${CARD_PREFIX}${surfaceId}`;
}

function record(input: unknown, label: string): A2uiJsonObjectV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CardDecodeError(`${label} must be an object`);
  }
  return input as A2uiJsonObjectV1;
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CardDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new CardDecodeError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

/**
 * A surface id, held to the same shape the send decoder holds it to. A surface
 * id is a durable key and a URL path segment, so one that could never have
 * been written is refused wherever it is read rather than only where it would
 * be stored.
 */
function surfaceIdentifier(value: unknown, label: string): string {
  const said = text(value, A2UI_LIMITS_V1.surfaceId, label);
  if (!A2UI_IDENTIFIER_V1.test(said)) {
    throw new CardDecodeError(
      `${label} must be letters, digits, dot, underscore or dash`,
    );
  }
  return said;
}

/**
 * A flag, decoded by its value rather than by its presence. A key carrying
 * `false` says the opposite of what carrying it at all would say, so a
 * decoder that read presence alone would answer `true` to a producer that
 * said `false`; anything that is not a boolean is refused outright.
 */
function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CardDecodeError(`${label} must be a boolean`);
  }
  return value;
}

/** A flag carried only when it is true, and refused when it is neither. */
function trueFlag(value: unknown, label: string): boolean {
  return value === undefined ? false : flag(value, label);
}

/** A surface id as a client names one, for a read keyed by the path. */
export function decodeCardSurfaceIdV1(
  value: unknown,
  label = "card surfaceId",
): string {
  return surfaceIdentifier(value, label);
}

function timestamp(value: unknown, label: string): string {
  const stamp = text(value, MAX_TIMESTAMP_LENGTH, label);
  if (Number.isNaN(Date.parse(stamp))) {
    throw new CardDecodeError(`${label} is not a timestamp`);
  }
  return stamp;
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
      throw new CardDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new CardDecodeError(`${label} is missing "${key}"`);
    }
  }
}

export function decodeCardRecordV1(
  value: unknown,
  label = "card record",
): CardRecordV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "surfaceId",
      "runId",
      "sessionId",
      "components",
      "dataModel",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    [
      "foldedRunId",
      "catalogId",
      "sendDataModel",
      "surfaceProperties",
      "deleted",
      "refusal",
    ],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new CardDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!Array.isArray(candidate.components)) {
    throw new CardDecodeError(`${label} components must be an array`);
  }
  if (
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    throw new CardDecodeError(`${label} revision is invalid`);
  }
  return {
    schemaVersion: 1,
    surfaceId: surfaceIdentifier(candidate.surfaceId, `${label} surfaceId`),
    runId: text(candidate.runId, MAX_ID_LENGTH, `${label} runId`),
    ...(candidate.foldedRunId === undefined
      ? {}
      : {
          foldedRunId: text(
            candidate.foldedRunId,
            MAX_ID_LENGTH,
            `${label} foldedRunId`,
          ),
        }),
    sessionId: text(candidate.sessionId, MAX_ID_LENGTH, `${label} sessionId`),
    components: candidate.components as A2uiComponentV1[],
    dataModel: record(candidate.dataModel, `${label} dataModel`),
    revision: candidate.revision as number,
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
    updatedAt: timestamp(candidate.updatedAt, `${label} updatedAt`),
    ...(candidate.catalogId === undefined
      ? {}
      : {
          catalogId: text(
            candidate.catalogId,
            A2UI_LIMITS_V1.catalogId,
            `${label} catalogId`,
          ),
        }),
    ...(candidate.sendDataModel === undefined
      ? {}
      : {
          sendDataModel: flag(
            candidate.sendDataModel,
            `${label} sendDataModel`,
          ),
        }),
    ...(candidate.surfaceProperties === undefined
      ? {}
      : {
          surfaceProperties: record(
            candidate.surfaceProperties,
            `${label} surfaceProperties`,
          ),
        }),
    ...(trueFlag(candidate.deleted, `${label} deleted`)
      ? { deleted: true as const }
      : {}),
    ...(candidate.refusal === undefined
      ? {}
      : {
          refusal: text(
            candidate.refusal,
            CARD_REFUSAL_MAX_V1,
            `${label} refusal`,
          ),
        }),
  };
}

export function decodeCardIndexV1(
  value: unknown,
  label = "card index",
): CardIndexV1 {
  const candidate = record(value, label);
  exactKeys(candidate, ["schemaVersion", "surfaces"], [], label);
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.surfaces)) {
    throw new CardDecodeError(`${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    surfaces: candidate.surfaces.map((surfaceId, index) =>
      surfaceIdentifier(surfaceId, `${label} surfaces[${index}]`),
    ),
  };
}

/**
 * Raised when a fold would put a surface past one of its budgets, or would
 * write somewhere the data model has nowhere to land it.
 */
export class CardBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardBudgetError";
  }
}

/**
 * The tokens of a JSON Pointer, unescaped. An absent or empty pointer names
 * the whole data model; every other pointer resolves as RFC 6901 says, so `/`
 * names the key whose name is the empty string rather than the root.
 */
function pointerTokens(path: string | undefined): string[] {
  if (path === undefined || path === "") return [];
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** An array index as RFC 6901 spells one: digits, and no leading zero. */
const POINTER_INDEX = /^(?:0|[1-9][0-9]*)$/;

type PointerParent = Record<string, unknown> | unknown[];

/**
 * The index `token` names in `array`, or a refusal. The one-past-the-end `-`
 * belongs to the leaf of a write, so a walk through it has nothing to descend
 * into and is refused with the rest.
 */
function pointerIndex(
  array: readonly unknown[],
  token: string,
  path: string | undefined,
): number {
  if (!POINTER_INDEX.test(token)) {
    throw new CardBudgetError(
      `a data-model update at "${path}" names "${token}" in a list, which is not an index`,
    );
  }
  const index = Number(token);
  if (index >= array.length) {
    throw new CardBudgetError(
      `a data-model update at "${path}" names index ${index} of a list that has ${array.length}`,
    );
  }
  return index;
}

/** The member `token` names, read as an own property and never inherited. */
function readMember(
  parent: PointerParent,
  token: string,
  path: string | undefined,
): unknown {
  if (Array.isArray(parent)) {
    return parent[pointerIndex(parent, token, path)];
  }
  return Object.hasOwn(parent, token) ? parent[token] : undefined;
}

/** Put `value` at `token`, always as an own property of `parent`. */
function writeMember(
  parent: PointerParent,
  token: string,
  value: unknown,
  path: string | undefined,
): void {
  if (Array.isArray(parent)) {
    if (token === "-") {
      parent.push(value);
      return;
    }
    parent[pointerIndex(parent, token, path)] = value;
    return;
  }
  Object.defineProperty(parent, token, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Take `token` out: a list closes over the gap, an object loses the key. */
function deleteMember(
  parent: PointerParent,
  token: string,
  path: string | undefined,
): void {
  if (Array.isArray(parent)) {
    parent.splice(pointerIndex(parent, token, path), 1);
    return;
  }
  delete parent[token];
}

/**
 * Write `value` at `path` in `model`. `null` deletes the member, as the
 * specification says, and a delete through a member that is not there leaves
 * the model exactly as it was; a numeric token against a list indexes it, and `-` at
 * the leaf appends. A pointer through a scalar is a write with nowhere to
 * land, and is refused rather than made to fit.
 */
function writeAtPointer(
  model: A2uiJsonObjectV1,
  path: string | undefined,
  value: A2uiJsonValueV1,
): A2uiJsonObjectV1 {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CardBudgetError(
        "a data-model update at the root must be an object",
      );
    }
    return { ...value };
  }
  // The walk is plain objects and arrays: the stored types spell JSON out to a
  // fixed depth so a Card can cross a Durable Object RPC boundary, and that
  // depth is a statement about what crosses the seam, not about how a pointer
  // is resolved. The byte budget is what actually bounds a data model.
  const next = { ...model } as Record<string, unknown>;
  let cursor: PointerParent = next;
  for (const token of tokens.slice(0, -1)) {
    const child = readMember(cursor, token, path);
    if (child === undefined) {
      if (value === null) return model;
      const created: Record<string, unknown> = {};
      writeMember(cursor, token, created, path);
      cursor = created;
      continue;
    }
    if (typeof child !== "object" || child === null) {
      throw new CardBudgetError(
        `a data-model update at "${path}" runs through a value that is not an object`,
      );
    }
    const copied = Array.isArray(child)
      ? [...child]
      : { ...(child as Record<string, unknown>) };
    writeMember(cursor, token, copied, path);
    cursor = copied;
  }
  const leaf = tokens.at(-1)!;
  if (value === null) deleteMember(cursor, leaf, path);
  else writeMember(cursor, leaf, value, path);
  return next as A2uiJsonObjectV1;
}

/** Upsert by `id`, keeping the order the components were first seen in. */
function upsertComponents(
  current: readonly A2uiComponentV1[],
  incoming: readonly A2uiComponentV1[],
): A2uiComponentV1[] {
  const folded = [...current];
  for (const component of incoming) {
    const at = folded.findIndex((existing) => existing.id === component.id);
    if (at < 0) folded.push(component);
    else folded[at] = component;
  }
  return folded;
}

function assertSurfaceBudgets(card: CardRecordV1): void {
  if (card.components.length > A2UI_LIMITS_V1.componentsPerSurface) {
    throw new CardBudgetError(
      `the surface exceeds ${A2UI_LIMITS_V1.componentsPerSurface} components`,
    );
  }
  if (a2uiActionCountV1(card.components) > A2UI_LIMITS_V1.actionsPerSurface) {
    throw new CardBudgetError(
      `the surface exceeds ${A2UI_LIMITS_V1.actionsPerSurface} actions`,
    );
  }
  if (a2uiByteLengthV1(card.dataModel) > A2UI_LIMITS_V1.dataModelBytes) {
    throw new CardBudgetError(
      `the data model exceeds ${A2UI_LIMITS_V1.dataModelBytes} bytes`,
    );
  }
  if (a2uiByteLengthV1(card) > A2UI_LIMITS_V1.cardRecordBytes) {
    throw new CardBudgetError(
      `the card exceeds ${A2UI_LIMITS_V1.cardRecordBytes} bytes`,
    );
  }
}

export interface CardFoldContextV1 {
  surfaceId: string;
  runId: string;
  sessionId: string;
  now: string;
}

/**
 * The messages of one send, folded onto the record the Session holds. Throws
 * `CardBudgetError` when the folded surface would be past a budget; the caller
 * decides what to say about a card it did not change.
 */
export function foldCardMessagesV1(
  current: CardRecordV1 | undefined,
  messages: readonly A2uiAgentMessageV1[],
  context: CardFoldContextV1,
): CardRecordV1 {
  let card: CardRecordV1 = current
    ? { ...current, runId: context.runId, updatedAt: context.now }
    : {
        schemaVersion: 1,
        surfaceId: context.surfaceId,
        runId: context.runId,
        sessionId: context.sessionId,
        components: [],
        dataModel: {},
        revision: 0,
        createdAt: context.now,
        updatedAt: context.now,
      };
  delete card.refusal;
  for (const message of messages) {
    if (a2uiMessageSurfaceIdV1(message) !== context.surfaceId) {
      throw new CardBudgetError("a message named a different surface");
    }
    if ("createSurface" in message) {
      const created = message.createSurface;
      // A create is the surface starting again, not a patch on the one that
      // was there: the components and the model it carries are all of it.
      card = {
        schemaVersion: 1,
        surfaceId: card.surfaceId,
        runId: card.runId,
        ...(card.foldedRunId === undefined
          ? {}
          : { foldedRunId: card.foldedRunId }),
        sessionId: card.sessionId,
        components: [...(created.components ?? [])],
        dataModel: { ...(created.dataModel ?? {}) },
        revision: card.revision,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        ...(created.catalogId === undefined
          ? {}
          : { catalogId: created.catalogId }),
        ...(created.sendDataModel === undefined
          ? {}
          : { sendDataModel: created.sendDataModel }),
        ...(created.surfaceProperties === undefined
          ? {}
          : { surfaceProperties: created.surfaceProperties }),
      };
      continue;
    }
    if ("updateComponents" in message) {
      if (card.deleted) {
        throw new CardBudgetError("the surface was deleted");
      }
      card = {
        ...card,
        components: upsertComponents(
          card.components,
          message.updateComponents.components,
        ),
      };
      continue;
    }
    if ("updateDataModel" in message) {
      if (card.deleted) {
        throw new CardBudgetError("the surface was deleted");
      }
      const update = message.updateDataModel;
      card = {
        ...card,
        dataModel: writeAtPointer(card.dataModel, update.path, update.value),
      };
      continue;
    }
    card = { ...card, components: [], dataModel: {}, deleted: true as const };
  }
  assertSurfaceBudgets(card);
  return { ...card, revision: card.revision + 1 };
}

/** One card send that a settled Turn made, in the order it made them. */
export interface CardSendV1 {
  surfaceId: string;
  messages: A2uiAgentMessageV1[];
}

/**
 * The card sends on a settled Turn's durable log, gathered per surface in the
 * order the surfaces were first named. Read off `send/to-user` events rather
 * than off anything the Agent returned, because the log is the reconstruction
 * surface and a recovered Turn has only the log.
 */
export function cardSendsV1(events: readonly { type: string }[]): CardSendV1[] {
  const sends = new Map<string, CardSendV1>();
  for (const event of events) {
    if (event.type !== "send/to-user") continue;
    const payload = (event as { payload?: { type?: string } }).payload;
    if (!payload || payload.type !== "card") continue;
    const send = payload as unknown as CardSendV1;
    const existing = sends.get(send.surfaceId);
    // Several sends to one surface in one Turn fold in the order they were
    // made, which is the order the person would have watched them arrive in.
    if (existing) existing.messages.push(...send.messages);
    else
      sends.set(send.surfaceId, {
        surfaceId: send.surfaceId,
        messages: [...send.messages],
      });
  }
  return [...sends.values()];
}

/** The settled Turn a terminal record set is computed from. */
export interface CardTerminalInputV1 {
  run: {
    runId: string;
    sessionId: string;
    events: readonly { type: string }[];
  };
  now: string;
  read<T>(key: string): Promise<T | undefined>;
}

/**
 * The card records one settled Turn contributes to the transaction that
 * settles it, and the surface index they advance.
 *
 * Re-settling the same Turn folds the same messages onto a record that already
 * carries them: `foldedRunId` says which Turn last settled onto it, written
 * only here, and a record already at this one is left exactly as it is, so a
 * recovered Turn never bumps a revision twice and never invalidates an action
 * a person has in flight. `runId` is not that fact — a press folding a
 * handler's answer rewrites it — so the guard never reads it.
 */
export async function cardTerminalRecordsV1(
  input: CardTerminalInputV1,
): Promise<Record<string, unknown>> {
  const sends = cardSendsV1(input.run.events);
  if (sends.length === 0) return {};
  const records: Record<string, unknown> = {};
  const stored = await input.read<unknown>(CARD_INDEX_KEY);
  const index =
    stored === undefined
      ? { schemaVersion: 1 as const, surfaces: [] }
      : decodeCardIndexV1(stored);
  const surfaces = [...index.surfaces];
  let movedIndex = false;
  for (const send of sends) {
    const key = cardKeyV1(send.surfaceId);
    const existing = await input.read<unknown>(key);
    const current =
      existing === undefined ? undefined : decodeCardRecordV1(existing);
    if (current?.foldedRunId === input.run.runId) continue;
    // The index is the bound, not whether a record happens to still be in
    // storage: a surface evicted earlier is as new to the Session as one never
    // drawn, tombstone and all, and is admitted the same way.
    const indexed = surfaces.includes(send.surfaceId);
    if (!indexed && surfaces.length >= A2UI_LIMITS_V1.surfacesPerSession) {
      const evicted = surfaces.shift()!;
      const evictedKey = cardKeyV1(evicted);
      const staged = records[evictedKey] as CardRecordV1 | undefined;
      const storedEvicted = await input.read<unknown>(evictedKey);
      const evictedCard =
        staged ??
        (storedEvicted === undefined
          ? undefined
          : decodeCardRecordV1(storedEvicted));
      const tombstone: CardRecordV1 = evictedCard
        ? {
            ...evictedCard,
            runId: input.run.runId,
            components: [],
            dataModel: {},
            revision: evictedCard.revision + 1,
            updatedAt: input.now,
            deleted: true,
            refusal: "the card was dropped to make room for a newer card",
          }
        : {
            schemaVersion: 1,
            surfaceId: evicted,
            runId: input.run.runId,
            sessionId: input.run.sessionId,
            components: [],
            dataModel: {},
            revision: 1,
            createdAt: input.now,
            updatedAt: input.now,
            deleted: true,
            refusal: "the card was dropped to make room for a newer card",
          };
      records[evictedKey] = tombstone;
      movedIndex = true;
    }
    const context = {
      surfaceId: send.surfaceId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      now: input.now,
    };
    let folded: CardRecordV1;
    try {
      folded = foldCardMessagesV1(current, send.messages, context);
    } catch (error) {
      if (!(error instanceof CardBudgetError)) throw error;
      const refusal = error.message.slice(0, CARD_REFUSAL_MAX_V1);
      records[key] =
        current === undefined
          ? ({
              schemaVersion: 1,
              surfaceId: send.surfaceId,
              runId: input.run.runId,
              sessionId: input.run.sessionId,
              components: [],
              dataModel: {},
              revision: 1,
              createdAt: input.now,
              updatedAt: input.now,
              refusal,
              foldedRunId: input.run.runId,
            } satisfies CardRecordV1)
          : ({
              ...current,
              runId: input.run.runId,
              updatedAt: input.now,
              refusal,
              foldedRunId: input.run.runId,
            } satisfies CardRecordV1);
      if (!indexed) {
        surfaces.push(send.surfaceId);
        movedIndex = true;
      }
      continue;
    }
    records[key] = { ...folded, foldedRunId: input.run.runId };
    if (!indexed) {
      surfaces.push(send.surfaceId);
      movedIndex = true;
    }
  }
  if (movedIndex) {
    records[CARD_INDEX_KEY] = {
      schemaVersion: 1,
      surfaces,
    } satisfies CardIndexV1;
  }
  return records;
}

/** One Card, as the client is told it. */
export interface CardViewV1 {
  schemaVersion: 1;
  surfaceId: string;
  revision: number;
  components: A2uiComponentV1[];
  dataModel: A2uiJsonObjectV1;
  createdAt: string;
  updatedAt: string;
  catalogId?: string;
  sendDataModel?: boolean;
  surfaceProperties?: A2uiJsonObjectV1;
  deleted?: true;
  refusal?: string;
}

export function projectCardV1(stored: CardRecordV1): CardViewV1 {
  return {
    schemaVersion: 1,
    surfaceId: stored.surfaceId,
    revision: stored.revision,
    components: stored.components,
    dataModel: stored.dataModel,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.catalogId === undefined ? {} : { catalogId: stored.catalogId }),
    ...(stored.sendDataModel === undefined
      ? {}
      : { sendDataModel: stored.sendDataModel }),
    ...(stored.surfaceProperties === undefined
      ? {}
      : { surfaceProperties: stored.surfaceProperties }),
    ...(stored.deleted === undefined ? {} : { deleted: true as const }),
    ...(stored.refusal === undefined ? {} : { refusal: stored.refusal }),
  };
}

/** The Bot's Cards, newest first. */
export interface CardListViewV1 {
  schemaVersion: 1;
  botId: string;
  cards: CardViewV1[];
  /** Set when the listing stopped at its byte budget with cards left unread. */
  truncated?: true;
}

/** One renderer action, as the client posts it. */
export interface CardActionCommandV1 {
  schemaVersion: 1;
  surfaceId: string;
  /** The revision the surface was drawn at; a stale one is refused. */
  revision: number;
  event: A2uiActionV1;
  /** The surface's data model, when it was created with `sendDataModel`. */
  dataModel?: A2uiJsonObjectV1;
}

export function decodeCardActionCommandV1(
  value: unknown,
  label = "card action",
): CardActionCommandV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ["schemaVersion", "surfaceId", "revision", "event"],
    ["dataModel"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new CardDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    throw new CardDecodeError(`${label} revision is invalid`);
  }
  let event: A2uiActionV1;
  try {
    event = decodeA2uiActionV1(candidate.event, `${label} event`);
  } catch (error) {
    throw new CardDecodeError(
      error instanceof Error ? error.message : `${label} event is invalid`,
    );
  }
  let dataModel: A2uiJsonObjectV1 | undefined;
  if (candidate.dataModel !== undefined) {
    dataModel = record(candidate.dataModel, `${label} dataModel`);
    if (a2uiByteLengthV1(dataModel) > A2UI_LIMITS_V1.dataModelBytes) {
      throw new CardDecodeError(
        `${label} dataModel exceeds ${A2UI_LIMITS_V1.dataModelBytes} bytes`,
      );
    }
  }
  return {
    schemaVersion: 1,
    surfaceId: surfaceIdentifier(candidate.surfaceId, `${label} surfaceId`),
    revision: candidate.revision as number,
    event,
    ...(dataModel === undefined ? {} : { dataModel }),
  };
}

/** What an action's name asks the kernel to do. */
export type CardActionRouteV1 =
  | { kind: "approval"; approvalId: string }
  | { kind: "plugin"; pluginId: string; action: string }
  | { kind: "input" };

const APPROVAL_ID_PATTERN_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PLUGIN_ID_PATTERN_V1 = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_ACTION_PATTERN_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * What one action name means. The two reserved namespaces are the kernel's:
 * `approval/<approvalId>` is a decision recorded exactly as an Approval is,
 * and `plugin/<pluginId>/<action>` is a Plugin handler. A malformed name in
 * either namespace is not conversation input — a Card must not be able to
 * reach the kernel by writing a name the kernel almost understood.
 */
export function cardActionRouteV1(name: string): CardActionRouteV1 {
  if (name.startsWith("approval/")) {
    const approvalId = name.slice("approval/".length);
    if (!APPROVAL_ID_PATTERN_V1.test(approvalId)) {
      throw new CardDecodeError("the action names an invalid approval");
    }
    return { kind: "approval", approvalId };
  }
  if (name.startsWith("plugin/")) {
    const [pluginId, ...rest] = name.slice("plugin/".length).split("/");
    const action = rest.join("/");
    if (
      pluginId === undefined ||
      !PLUGIN_ID_PATTERN_V1.test(pluginId) ||
      !PLUGIN_ACTION_PATTERN_V1.test(action)
    ) {
      throw new CardDecodeError("the action names an invalid plugin handler");
    }
    return { kind: "plugin", pluginId, action };
  }
  return { kind: "input" };
}

/** What the action route answers. */
export interface CardActionReceiptV1 {
  schemaVersion: 1;
  /**
   * What the kernel did with it: recorded a decision, ran a Plugin handler,
   * or queued the event as the Bot's next input.
   */
  routed: CardActionRouteV1["kind"];
  /** The card as it stands after the action, so the client redraws once. */
  card: CardViewV1;
  /** Why a Plugin handler changed nothing, when it did not. */
  failure?: string;
}

export function decodeCardViewV1(value: unknown, label = "card"): CardViewV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "surfaceId",
      "revision",
      "components",
      "dataModel",
      "createdAt",
      "updatedAt",
    ],
    ["catalogId", "sendDataModel", "surfaceProperties", "deleted", "refusal"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new CardDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!Array.isArray(candidate.components)) {
    throw new CardDecodeError(`${label} components must be an array`);
  }
  if (
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    throw new CardDecodeError(`${label} revision is invalid`);
  }
  return {
    schemaVersion: 1,
    surfaceId: surfaceIdentifier(candidate.surfaceId, `${label} surfaceId`),
    revision: candidate.revision as number,
    components: candidate.components as A2uiComponentV1[],
    dataModel: record(candidate.dataModel, `${label} dataModel`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
    updatedAt: timestamp(candidate.updatedAt, `${label} updatedAt`),
    ...(candidate.catalogId === undefined
      ? {}
      : {
          catalogId: text(
            candidate.catalogId,
            A2UI_LIMITS_V1.catalogId,
            `${label} catalogId`,
          ),
        }),
    ...(candidate.sendDataModel === undefined
      ? {}
      : {
          sendDataModel: flag(
            candidate.sendDataModel,
            `${label} sendDataModel`,
          ),
        }),
    ...(candidate.surfaceProperties === undefined
      ? {}
      : {
          surfaceProperties: record(
            candidate.surfaceProperties,
            `${label} surfaceProperties`,
          ),
        }),
    ...(trueFlag(candidate.deleted, `${label} deleted`)
      ? { deleted: true as const }
      : {}),
    ...(candidate.refusal === undefined
      ? {}
      : {
          refusal: text(
            candidate.refusal,
            CARD_REFUSAL_MAX_V1,
            `${label} refusal`,
          ),
        }),
  };
}

export function decodeCardListViewV1(
  value: unknown,
  label = "card list",
): CardListViewV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ["schemaVersion", "botId", "cards"],
    ["truncated"],
    label,
  );
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.cards)) {
    throw new CardDecodeError(`${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    botId: text(candidate.botId, MAX_ID_LENGTH, `${label} botId`),
    cards: candidate.cards.map((card) =>
      decodeCardViewV1(card, `${label} entry`),
    ),
    ...(trueFlag(candidate.truncated, `${label} truncated`)
      ? { truncated: true as const }
      : {}),
  };
}

export function decodeCardActionReceiptV1(
  value: unknown,
  label = "card action receipt",
): CardActionReceiptV1 {
  const candidate = record(value, label);
  exactKeys(candidate, ["schemaVersion", "routed", "card"], ["failure"], label);
  if (candidate.schemaVersion !== 1) {
    throw new CardDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    candidate.routed !== "approval" &&
    candidate.routed !== "plugin" &&
    candidate.routed !== "input"
  ) {
    throw new CardDecodeError(`${label} routed is invalid`);
  }
  return {
    schemaVersion: 1,
    routed: candidate.routed,
    card: decodeCardViewV1(candidate.card, `${label} card`),
    ...(candidate.failure === undefined
      ? {}
      : {
          failure: text(
            candidate.failure,
            CARD_REFUSAL_MAX_V1,
            `${label} failure`,
          ),
        }),
  };
}
