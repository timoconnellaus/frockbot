// The Search Package's narrow, versioned DTOs and their decoders.
//
// Every value here crosses a runtime boundary — a Bot Durable Object to the
// User Durable Object, the User object to the gateway, the gateway to a
// browser — so each is decoded at its seam with exact keys, the discipline
// `packages/plugin-shell/src/run-protocol.ts` established.
//
// The index these rows feed is a *projection*. `AGENTS.md` § Memory: "Indexes,
// embeddings, and summaries are derived … and are always rebuildable". Nothing
// in this Package is authority: a row is reconstructable from the Bot Durable
// Object's stored runs, and `rebuild` proves it.

/** Most rows one User's index holds before the oldest are evicted. */
export const SEARCH_MAX_ROWS_V1 = 2_000_000;
/** Most bytes of body text one row carries; longer bodies are truncated. */
export const SEARCH_MAX_BODY_BYTES_V1 = 8 * 1024;
/** Longest accepted query string. */
export const SEARCH_MAX_QUERY_LENGTH_V1 = 256;
/** Most hits one page returns. */
export const SEARCH_MAX_RESULTS_V1 = 50;
/** Longest snippet one hit carries. */
export const SEARCH_MAX_SNIPPET_LENGTH_V1 = 300;
/** Longest accepted paging cursor. */
export const SEARCH_MAX_CURSOR_LENGTH_V1 = 64;
/** Most Bots one page of results groups. */
export const SEARCH_MAX_GROUPS_V1 = 200;
/** Most rows one Bot may offer the index in a single rebuild page. */
export const SEARCH_MAX_ROW_PAGE_V1 = 2_048;

const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_NAME_LENGTH = 256;
const MAX_DEEP_LINK_LENGTH = 512;

export class SearchDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchDecodeError";
  }
}

/**
 * What produced one indexed row.
 *
 * `media` exists because the parity register's `search-index.db` carries a
 * `media` table beside `messages` (`docs/research/grokbot-computer.md:169`).
 * FrockBot has no attachment concept yet, so the kind is declared and never
 * written: the schema does not change when attachments arrive.
 */
export type SearchRowKindV1 = "user" | "assistant" | "tool" | "media";

export const SEARCH_ROW_KINDS_V1: readonly SearchRowKindV1[] = [
  "user",
  "assistant",
  "tool",
  "media",
];

/**
 * Kinds a query returns when it names none.
 *
 * `tool` is indexed and excluded by default: a tool result can carry
 * credentials-adjacent text, so seeing it is an explicit opt-in.
 */
export const SEARCH_DEFAULT_ROW_KINDS_V1: readonly SearchRowKindV1[] = [
  "user",
  "assistant",
];

/** One indexed row. Idempotent on `(botId, runId, seq)`. */
export interface SearchRowV1 {
  botId: string;
  runId: string;
  /** Position within the run's projection; stable across rebuilds. */
  seq: number;
  kind: SearchRowKindV1;
  /** ISO-8601, the run's admission time. */
  at: string;
  body: string;
}

/** A page of rows one Bot offers the index during a rebuild. */
export interface SearchRowPageV1 {
  schemaVersion: 1;
  botId: string;
  rows: SearchRowV1[];
  /** Absent when the Bot has no further runs to project. */
  nextCursor?: string;
}

export type SearchIndexStateV1 = "ready" | "rebuilding" | "truncated";

export interface SearchQueryV1 {
  schemaVersion: 1;
  query: string;
  /** Opaque page cursor from a previous result's `page.nextCursor`. */
  before?: string;
  kinds?: SearchRowKindV1[];
  botId?: string;
  includeArchived?: boolean;
}

export interface SearchHitV1 {
  botId: string;
  runId: string;
  kind: SearchRowKindV1;
  at: string;
  snippet: string;
}

/** What the index itself answers, before Bot identity is joined on. */
export interface SearchIndexResultsV1 {
  schemaVersion: 1;
  query: string;
  hits: SearchHitV1[];
  truncated: boolean;
  nextCursor?: string;
  indexState: SearchIndexStateV1;
}

export interface ClientSearchHitV1 {
  runId: string;
  kind: SearchRowKindV1;
  at: string;
  snippet: string;
  /** `/?bot=<botId>#turn-<runId>`; the client never builds this itself. */
  deepLink: string;
}

export interface ClientSearchBotGroupV1 {
  botId: string;
  botName: string;
  archived: boolean;
  /** A Bot the sidebar hides is still searchable, and is labelled. */
  hidden: boolean;
  /**
   * The Bot's uploaded avatar, when it has one.
   *
   * Absent means the Bot's generated sheep, which only the Flock Package can
   * draw; the overlay falls back to a monogram rather than reaching into
   * another Package's client internals for a recipe.
   */
  avatarUrl?: string;
  hits: ClientSearchHitV1[];
  totalHits: number;
}

export interface ClientSearchPageV1 {
  truncated: boolean;
  nextCursor?: string;
}

export interface ClientSearchResultsV1 {
  schemaVersion: 1;
  query: string;
  groups: ClientSearchBotGroupV1[];
  page: ClientSearchPageV1;
  indexState: SearchIndexStateV1;
}

export interface ClientSearchRebuildReceiptV1 {
  schemaVersion: 1;
  status: "rebuilt";
  indexedRows: number;
  bots: number;
  indexState: SearchIndexStateV1;
}

/** The deep link one hit resolves to. The shell already reads `?bot=`. */
export function searchDeepLinkV1(botId: string, runId: string): string {
  return `/?bot=${encodeURIComponent(botId)}#${searchTurnAnchorV1(runId)}`;
}

/** The anchor id the conversation's turn renderer carries. */
export function searchTurnAnchorV1(runId: string): string {
  return `turn-${runId}`;
}

// ---------------------------------------------------------------------------
// Decoders.
// ---------------------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Reflect.ownKeys(value).find(
    (key) =>
      typeof key !== "string" ||
      !allowedKeys.has(key) ||
      !Object.prototype.propertyIsEnumerable.call(value, key),
  );
  if (unexpected !== undefined) {
    const field =
      typeof unexpected === "symbol" ? unexpected.toString() : unexpected;
    throw new SearchDecodeError(`${label}.${field} is not allowed`);
  }
}

function schemaVersion(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) {
    throw new SearchDecodeError(`${label}.schemaVersion must be 1`);
  }
}

function text(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length > maximum) {
    throw new SearchDecodeError(`${label}.${key} must be a bounded string`);
  }
  return field;
}

function identifier(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = text(value, key, MAX_ID_LENGTH, label);
  if (field.length === 0) {
    throw new SearchDecodeError(`${label}.${key} must not be empty`);
  }
  return field;
}

function timestamp(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = text(value, key, MAX_TIMESTAMP_LENGTH, label);
  if (!Number.isFinite(Date.parse(field))) {
    throw new SearchDecodeError(`${label}.${key} must be a timestamp`);
  }
  return field;
}

function rowKind(value: unknown, label: string): SearchRowKindV1 {
  if (
    typeof value !== "string" ||
    !SEARCH_ROW_KINDS_V1.includes(value as SearchRowKindV1)
  ) {
    throw new SearchDecodeError(`${label}.kind is invalid`);
  }
  return value as SearchRowKindV1;
}

function boolean(
  value: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  if (typeof value[key] !== "boolean") {
    throw new SearchDecodeError(`${label}.${key} must be a boolean`);
  }
  return value[key] as boolean;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SearchDecodeError(`${label} must be an array`);
  }
  return value;
}

/** Truncates a body to the durable per-row byte bound, on a code-point edge. */
export function boundSearchBodyV1(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= SEARCH_MAX_BODY_BYTES_V1)
    return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      encoder.encode(value.slice(0, middle)).byteLength <=
      SEARCH_MAX_BODY_BYTES_V1
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const bounded = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

export function decodeSearchRowV1(input: unknown): SearchRowV1 {
  const row = record(input, "search row");
  exactKeys(row, ["botId", "runId", "seq", "kind", "at", "body"], "search row");
  if (
    !Number.isSafeInteger(row.seq) ||
    (row.seq as number) < 0 ||
    (row.seq as number) > 1_000_000
  ) {
    throw new SearchDecodeError("search row.seq must be a bounded integer");
  }
  return {
    botId: identifier(row, "botId", "search row"),
    runId: identifier(row, "runId", "search row"),
    seq: row.seq as number,
    kind: rowKind(row.kind, "search row"),
    at: timestamp(row, "at", "search row"),
    body: boundSearchBodyV1(
      text(row, "body", SEARCH_MAX_BODY_BYTES_V1 * 4, "search row"),
    ),
  };
}

export function decodeSearchRowPageV1(input: unknown): SearchRowPageV1 {
  const page = record(input, "search row page");
  exactKeys(
    page,
    ["schemaVersion", "botId", "rows", "nextCursor"],
    "search row page",
  );
  schemaVersion(page, "search row page");
  const rows = list(page.rows, "search row page.rows");
  if (rows.length > SEARCH_MAX_ROW_PAGE_V1) {
    throw new SearchDecodeError("search row page.rows exceeds its bound");
  }
  const botId = identifier(page, "botId", "search row page");
  const decoded = rows.map(decodeSearchRowV1);
  const foreign = decoded.find((row) => row.botId !== botId);
  if (foreign) {
    throw new SearchDecodeError("search row page.rows names another Bot");
  }
  return {
    schemaVersion: 1,
    botId,
    rows: decoded,
    ...(page.nextCursor === undefined
      ? {}
      : {
          nextCursor: text(
            page,
            "nextCursor",
            SEARCH_MAX_CURSOR_LENGTH_V1 * 8,
            "search row page",
          ),
        }),
  };
}

export function decodeSearchQueryV1(input: unknown): SearchQueryV1 {
  const query = record(input, "search query");
  exactKeys(
    query,
    ["schemaVersion", "query", "before", "kinds", "botId", "includeArchived"],
    "search query",
  );
  schemaVersion(query, "search query");
  const kinds =
    query.kinds === undefined
      ? undefined
      : list(query.kinds, "search query.kinds").map((kind) =>
          rowKind(kind, "search query"),
        );
  if (
    kinds &&
    (kinds.length === 0 || kinds.length > SEARCH_ROW_KINDS_V1.length)
  ) {
    throw new SearchDecodeError("search query.kinds is invalid");
  }
  return {
    schemaVersion: 1,
    query: text(query, "query", SEARCH_MAX_QUERY_LENGTH_V1, "search query"),
    ...(query.before === undefined
      ? {}
      : {
          before: text(
            query,
            "before",
            SEARCH_MAX_CURSOR_LENGTH_V1,
            "search query",
          ),
        }),
    ...(kinds ? { kinds: [...new Set(kinds)] } : {}),
    ...(query.botId === undefined
      ? {}
      : { botId: identifier(query, "botId", "search query") }),
    ...(query.includeArchived === undefined
      ? {}
      : { includeArchived: boolean(query, "includeArchived", "search query") }),
  };
}

function indexState(value: unknown, label: string): SearchIndexStateV1 {
  if (value !== "ready" && value !== "rebuilding" && value !== "truncated") {
    throw new SearchDecodeError(`${label}.indexState is invalid`);
  }
  return value;
}

export function decodeSearchHitV1(input: unknown): SearchHitV1 {
  const hit = record(input, "search hit");
  exactKeys(hit, ["botId", "runId", "kind", "at", "snippet"], "search hit");
  return {
    botId: identifier(hit, "botId", "search hit"),
    runId: identifier(hit, "runId", "search hit"),
    kind: rowKind(hit.kind, "search hit"),
    at: timestamp(hit, "at", "search hit"),
    snippet: text(hit, "snippet", SEARCH_MAX_SNIPPET_LENGTH_V1, "search hit"),
  };
}

export function decodeSearchIndexResultsV1(
  input: unknown,
): SearchIndexResultsV1 {
  const results = record(input, "search results");
  exactKeys(
    results,
    ["schemaVersion", "query", "hits", "truncated", "nextCursor", "indexState"],
    "search results",
  );
  schemaVersion(results, "search results");
  const hits = list(results.hits, "search results.hits");
  if (hits.length > SEARCH_MAX_RESULTS_V1) {
    throw new SearchDecodeError("search results.hits exceeds its bound");
  }
  return {
    schemaVersion: 1,
    query: text(results, "query", SEARCH_MAX_QUERY_LENGTH_V1, "search results"),
    hits: hits.map(decodeSearchHitV1),
    truncated: boolean(results, "truncated", "search results"),
    ...(results.nextCursor === undefined
      ? {}
      : {
          nextCursor: text(
            results,
            "nextCursor",
            SEARCH_MAX_CURSOR_LENGTH_V1,
            "search results",
          ),
        }),
    indexState: indexState(results.indexState, "search results"),
  };
}

export function decodeClientSearchHitV1(input: unknown): ClientSearchHitV1 {
  const hit = record(input, "client search hit");
  exactKeys(
    hit,
    ["runId", "kind", "at", "snippet", "deepLink"],
    "client search hit",
  );
  return {
    runId: identifier(hit, "runId", "client search hit"),
    kind: rowKind(hit.kind, "client search hit"),
    at: timestamp(hit, "at", "client search hit"),
    snippet: text(
      hit,
      "snippet",
      SEARCH_MAX_SNIPPET_LENGTH_V1,
      "client search hit",
    ),
    deepLink: text(hit, "deepLink", MAX_DEEP_LINK_LENGTH, "client search hit"),
  };
}

export function decodeClientSearchBotGroupV1(
  input: unknown,
): ClientSearchBotGroupV1 {
  const group = record(input, "client search group");
  exactKeys(
    group,
    [
      "botId",
      "botName",
      "archived",
      "hidden",
      "avatarUrl",
      "hits",
      "totalHits",
    ],
    "client search group",
  );
  const hits = list(group.hits, "client search group.hits");
  if (hits.length > SEARCH_MAX_RESULTS_V1) {
    throw new SearchDecodeError("client search group.hits exceeds its bound");
  }
  if (
    !Number.isSafeInteger(group.totalHits) ||
    (group.totalHits as number) < hits.length
  ) {
    throw new SearchDecodeError("client search group.totalHits is invalid");
  }
  return {
    botId: identifier(group, "botId", "client search group"),
    botName: text(group, "botName", MAX_NAME_LENGTH, "client search group"),
    archived: boolean(group, "archived", "client search group"),
    hidden: boolean(group, "hidden", "client search group"),
    ...(group.avatarUrl === undefined
      ? {}
      : {
          avatarUrl: text(
            group,
            "avatarUrl",
            MAX_DEEP_LINK_LENGTH,
            "client search group",
          ),
        }),
    hits: hits.map(decodeClientSearchHitV1),
    totalHits: group.totalHits as number,
  };
}

export function decodeClientSearchResultsV1(
  input: unknown,
): ClientSearchResultsV1 {
  const results = record(input, "client search results");
  exactKeys(
    results,
    ["schemaVersion", "query", "groups", "page", "indexState"],
    "client search results",
  );
  schemaVersion(results, "client search results");
  const groups = list(results.groups, "client search results.groups");
  if (groups.length > SEARCH_MAX_GROUPS_V1) {
    throw new SearchDecodeError(
      "client search results.groups exceeds its bound",
    );
  }
  const page = record(results.page, "client search results.page");
  exactKeys(page, ["truncated", "nextCursor"], "client search results.page");
  return {
    schemaVersion: 1,
    query: text(
      results,
      "query",
      SEARCH_MAX_QUERY_LENGTH_V1,
      "client search results",
    ),
    groups: groups.map(decodeClientSearchBotGroupV1),
    page: {
      truncated: boolean(page, "truncated", "client search results.page"),
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextCursor: text(
              page,
              "nextCursor",
              SEARCH_MAX_CURSOR_LENGTH_V1,
              "client search results.page",
            ),
          }),
    },
    indexState: indexState(results.indexState, "client search results"),
  };
}

export function decodeClientSearchRebuildReceiptV1(
  input: unknown,
): ClientSearchRebuildReceiptV1 {
  const receipt = record(input, "client search rebuild receipt");
  exactKeys(
    receipt,
    ["schemaVersion", "status", "indexedRows", "bots", "indexState"],
    "client search rebuild receipt",
  );
  schemaVersion(receipt, "client search rebuild receipt");
  if (receipt.status !== "rebuilt") {
    throw new SearchDecodeError(
      "client search rebuild receipt.status is invalid",
    );
  }
  for (const key of ["indexedRows", "bots"] as const) {
    if (!Number.isSafeInteger(receipt[key]) || (receipt[key] as number) < 0) {
      throw new SearchDecodeError(
        `client search rebuild receipt.${key} must be a non-negative integer`,
      );
    }
  }
  return {
    schemaVersion: 1,
    status: "rebuilt",
    indexedRows: receipt.indexedRows as number,
    bots: receipt.bots as number,
    indexState: indexState(receipt.indexState, "client search rebuild receipt"),
  };
}
