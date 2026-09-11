/**
 * Applet wire protocol, versions 1 and 2.
 *
 * One JSON frame per WebSocket message, at most 64 KB encoded. Both ends decode
 * with the functions here and nothing else: an unknown type, an unknown field,
 * or an out-of-range value fails closed. The server additionally refuses frames
 * that name a table or column it did not declare — that check needs the schema,
 * so it lives in `server/`, not here.
 *
 * Sequence, v2 (a page that opened its socket with `v=2` in the URL):
 *   server -> hello        on accept, carrying the `snapshot` when the URL
 *                          named no `since` cursor; the page renders on it
 *   client -> hello        only when it is resuming (`since`), or when the
 *                          server's hello carried no snapshot
 *   server -> changes      catch-up for a resumable cursor, else `snapshot`
 *   client -> mutate       one client transaction
 *   server -> ack|reject   to the originator; `changes` to every other socket
 *
 * Sequence, v1 (a page built before v2 sends no `v`):
 *   server -> hello        on accept (contract, generation, viewer, cursor)
 *   client -> hello        with `since` when it is resuming, otherwise absent
 *   server -> snapshot     full state, or `changes` when the cursor is resumable
 *   then as above
 *
 * The version a socket speaks is settled by its URL before the first frame,
 * so a server never has to guess: the frames it sends carry that `v`, and a
 * v1 page is spoken to exactly as it always was.
 */

export const APPLET_CONTRACT_VERSION = 1 as const;
/** The newest protocol this code speaks; a socket may still be spoken to in 1. */
export const APPLET_PROTOCOL_VERSION = 2 as const;
export type AppletProtocolVersion = 1 | 2;
export const APPLET_FRAME_BYTE_LIMIT = 64 * 1024;

/**
 * What a socket's URL says about how to greet it: the protocol the page
 * speaks and, on a reconnect, the cursor it will ask to resume from. Read on
 * the server before the first frame, written by the client transport.
 */
export interface AppletHandshakeV1 {
  protocol: AppletProtocolVersion;
  since?: number;
}

export function appletHandshakeFromUrlV1(url: URL): AppletHandshakeV1 {
  const protocol = url.searchParams.get("v") === "2" ? 2 : 1;
  const since = url.searchParams.get("since");
  const parsed = since === null ? Number.NaN : Number(since);
  return {
    protocol,
    ...(Number.isSafeInteger(parsed) && parsed > 0 ? { since: parsed } : {}),
  };
}

export type ChangeOperation = "insert" | "update" | "delete";

export interface AppletChangeV1 {
  table: string;
  op: ChangeOperation;
  key: string;
  /** The resulting row for insert and update; absent for delete. */
  row?: Record<string, unknown>;
}

export interface AppletMutationV1 {
  table: string;
  op: ChangeOperation;
  /** Required for update and delete; server-generated for insert when absent. */
  key?: string;
  /** Full row for insert, partial patch for update, absent for delete. */
  value?: Record<string, unknown>;
}

export interface AppletViewerV1 {
  id: string;
  /** Whether this socket may send `mutate` frames. */
  canWrite: boolean;
}

export type AppletSnapshotTablesV1 = Record<
  string,
  Array<Record<string, unknown>>
>;

export type AppletServerFrameV1 =
  | {
      v: AppletProtocolVersion;
      type: "hello";
      contract: 1;
      generationId: string;
      viewer: AppletViewerV1;
      tables: string[];
      schemaRevision: number;
      lastChangeId: number;
      /**
       * Every row of every table as of `lastChangeId`, on a v2 socket that
       * opened with no cursor: the page renders on this frame and sends no
       * hello of its own. Absent when it would not fit the frame, in which
       * case the v1 exchange follows.
       */
      snapshot?: AppletSnapshotTablesV1;
    }
  | {
      v: AppletProtocolVersion;
      type: "snapshot";
      lastChangeId: number;
      tables: AppletSnapshotTablesV1;
    }
  | {
      v: AppletProtocolVersion;
      type: "changes";
      lastChangeId: number;
      txnId?: string;
      changes: AppletChangeV1[];
    }
  | {
      v: AppletProtocolVersion;
      type: "ack";
      txnId: string;
      lastChangeId: number;
      changes: AppletChangeV1[];
    }
  | {
      v: AppletProtocolVersion;
      type: "reject";
      txnId: string;
      reason: string;
    };

export type AppletClientFrameV1 =
  | {
      v: AppletProtocolVersion;
      type: "hello";
      contract: 1;
      since?: number;
    }
  | {
      v: AppletProtocolVersion;
      type: "mutate";
      txnId: string;
      mutations: AppletMutationV1[];
    };

export class AppletProtocolError extends Error {}

function fail(message: string): never {
  throw new AppletProtocolError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const field of required) {
    if (!Object.hasOwn(value, field)) fail(`${label} is missing "${field}"`);
  }
  for (const field of Object.keys(value)) {
    if (!required.includes(field) && !optional.includes(field)) {
      fail(`${label} has an unknown field "${field}"`);
    }
  }
}

function name(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value)
  ) {
    fail(`${label} must be an identifier`);
  }
  return value;
}

function bounded(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    fail(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function cursor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function jsonDepth(value: unknown, label: string, depth = 0): void {
  if (depth > 16) fail(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) fail(`${label} has too many entries`);
    for (const entry of value) jsonDepth(entry, label, depth + 1);
    return;
  }
  const record = object(value, label);
  if (Object.keys(record).length > 256) fail(`${label} has too many fields`);
  for (const entry of Object.values(record)) jsonDepth(entry, label, depth + 1);
}

function row(value: unknown, label: string): Record<string, unknown> {
  const record = object(value, label);
  for (const key of Object.keys(record)) name(key, `${label} column`);
  jsonDepth(record, label);
  return record;
}

/** Encode a frame, refusing anything over the wire limit. */
export function encodeFrame(
  frame: AppletServerFrameV1 | AppletClientFrameV1,
): string {
  const wire = JSON.stringify(frame);
  if (wire === undefined) fail("Applet frame is not JSON");
  if (new TextEncoder().encode(wire).byteLength > APPLET_FRAME_BYTE_LIMIT) {
    fail("Applet frame exceeds the 64 KB wire limit");
  }
  return wire;
}

function parse(message: unknown, label: string): Record<string, unknown> {
  if (typeof message !== "string") fail(`${label} must be a text frame`);
  if (new TextEncoder().encode(message).byteLength > APPLET_FRAME_BYTE_LIMIT) {
    fail(`${label} exceeds the 64 KB wire limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  const value = object(parsed, label);
  if (value.v !== 1 && value.v !== 2) {
    fail(`${label} speaks an unsupported protocol version`);
  }
  return value;
}

function versionOf(value: Record<string, unknown>): AppletProtocolVersion {
  return value.v === 2 ? 2 : 1;
}

function snapshotTables(value: unknown, label: string): AppletSnapshotTablesV1 {
  const tables = object(value, label);
  const decoded: AppletSnapshotTablesV1 = {};
  for (const [table, rows] of Object.entries(tables)) {
    const rowsLabel = `${label}.${table}`;
    name(table, rowsLabel);
    if (!Array.isArray(rows)) fail(`${rowsLabel} must be an array`);
    decoded[table] = rows.map((entry, index) =>
      row(entry, `${rowsLabel}[${index}]`),
    );
  }
  return decoded;
}

function decodeChange(candidate: unknown, label: string): AppletChangeV1 {
  const value = object(candidate, label);
  exact(value, ["table", "op", "key"], ["row"], label);
  const op = value.op;
  if (op !== "insert" && op !== "update" && op !== "delete") {
    fail(`${label}.op is invalid`);
  }
  const change: AppletChangeV1 = {
    table: name(value.table, `${label}.table`),
    op,
    key: bounded(value.key, `${label}.key`),
  };
  if (op === "delete") {
    if (value.row !== undefined) fail(`${label} must not carry a row`);
    return change;
  }
  change.row = row(value.row, `${label}.row`);
  return change;
}

/** Decode a client -> server frame. */
export function decodeClientFrame(message: unknown): AppletClientFrameV1 {
  const value = parse(message, "Applet client frame");
  if (value.type === "hello") {
    exact(value, ["v", "type", "contract"], ["since"], "Applet hello");
    if (value.contract !== APPLET_CONTRACT_VERSION) {
      fail("Applet hello declares an unsupported contract");
    }
    const since =
      value.since === undefined
        ? undefined
        : cursor(value.since, "Applet hello.since");
    return {
      v: versionOf(value),
      type: "hello",
      contract: 1,
      ...(since === undefined ? {} : { since }),
    };
  }
  if (value.type === "mutate") {
    exact(value, ["v", "type", "txnId", "mutations"], [], "Applet mutate");
    if (!Array.isArray(value.mutations) || value.mutations.length === 0) {
      fail("Applet mutate.mutations must be a non-empty array");
    }
    if (value.mutations.length > 256) {
      fail("Applet mutate.mutations has too many entries");
    }
    const mutations = value.mutations.map((candidate, index) => {
      const label = `Applet mutate.mutations[${index}]`;
      const mutation = object(candidate, label);
      exact(mutation, ["table", "op"], ["key", "value"], label);
      const op = mutation.op;
      if (op !== "insert" && op !== "update" && op !== "delete") {
        fail(`${label}.op is invalid`);
      }
      const decoded: AppletMutationV1 = {
        table: name(mutation.table, `${label}.table`),
        op,
      };
      if (mutation.key !== undefined) {
        decoded.key = bounded(mutation.key, `${label}.key`);
      }
      if (op === "delete") {
        if (mutation.value !== undefined)
          fail(`${label} must not carry a value`);
        if (decoded.key === undefined) fail(`${label} requires a key`);
        return decoded;
      }
      if (op === "update" && decoded.key === undefined) {
        fail(`${label} requires a key`);
      }
      decoded.value = row(mutation.value, `${label}.value`);
      return decoded;
    });
    return {
      v: versionOf(value),
      type: "mutate",
      txnId: bounded(value.txnId, "Applet mutate.txnId", 64),
      mutations,
    };
  }
  return fail("Applet client frame type is invalid");
}

/** Decode a server -> client frame. */
export function decodeServerFrame(message: unknown): AppletServerFrameV1 {
  const value = parse(message, "Applet server frame");
  if (value.type === "hello") {
    exact(
      value,
      [
        "v",
        "type",
        "contract",
        "generationId",
        "viewer",
        "tables",
        "schemaRevision",
        "lastChangeId",
      ],
      // A v1 speaker never sends a snapshot in its hello, so a v1 frame that
      // carries one is not one this code produced.
      versionOf(value) === 2 ? ["snapshot"] : [],
      "Applet server hello",
    );
    if (value.contract !== APPLET_CONTRACT_VERSION) {
      fail("Applet server speaks an unsupported contract");
    }
    const viewer = object(value.viewer, "Applet server hello.viewer");
    exact(viewer, ["id", "canWrite"], [], "Applet server hello.viewer");
    if (typeof viewer.canWrite !== "boolean") {
      fail("Applet server hello.viewer.canWrite must be a boolean");
    }
    if (!Array.isArray(value.tables) || value.tables.length > 32) {
      fail("Applet server hello.tables must be a bounded array");
    }
    return {
      v: versionOf(value),
      type: "hello",
      contract: 1,
      generationId: bounded(
        value.generationId,
        "Applet server hello.generationId",
      ),
      viewer: {
        id: bounded(viewer.id, "Applet server hello.viewer.id"),
        canWrite: viewer.canWrite,
      },
      tables: value.tables.map((entry, index) =>
        name(entry, `Applet server hello.tables[${index}]`),
      ),
      schemaRevision: cursor(
        value.schemaRevision,
        "Applet server hello.schemaRevision",
      ),
      lastChangeId: cursor(
        value.lastChangeId,
        "Applet server hello.lastChangeId",
      ),
      ...(value.snapshot === undefined
        ? {}
        : {
            snapshot: snapshotTables(
              value.snapshot,
              "Applet server hello.snapshot",
            ),
          }),
    };
  }
  if (value.type === "snapshot") {
    exact(
      value,
      ["v", "type", "lastChangeId", "tables"],
      [],
      "Applet snapshot",
    );
    return {
      v: versionOf(value),
      type: "snapshot",
      lastChangeId: cursor(value.lastChangeId, "Applet snapshot.lastChangeId"),
      tables: snapshotTables(value.tables, "Applet snapshot.tables"),
    };
  }
  if (value.type === "changes") {
    exact(
      value,
      ["v", "type", "lastChangeId", "changes"],
      ["txnId"],
      "Applet changes",
    );
    if (!Array.isArray(value.changes))
      fail("Applet changes.changes must be an array");
    const changes = value.changes.map((candidate, index) =>
      decodeChange(candidate, `Applet changes.changes[${index}]`),
    );
    const txnId =
      value.txnId === undefined
        ? undefined
        : bounded(value.txnId, "Applet changes.txnId", 64);
    return {
      v: versionOf(value),
      type: "changes",
      lastChangeId: cursor(value.lastChangeId, "Applet changes.lastChangeId"),
      ...(txnId === undefined ? {} : { txnId }),
      changes,
    };
  }
  if (value.type === "ack") {
    exact(
      value,
      ["v", "type", "txnId", "lastChangeId", "changes"],
      [],
      "Applet ack",
    );
    if (!Array.isArray(value.changes))
      fail("Applet ack.changes must be an array");
    return {
      v: versionOf(value),
      type: "ack",
      txnId: bounded(value.txnId, "Applet ack.txnId", 64),
      lastChangeId: cursor(value.lastChangeId, "Applet ack.lastChangeId"),
      changes: value.changes.map((candidate, index) =>
        decodeChange(candidate, `Applet ack.changes[${index}]`),
      ),
    };
  }
  if (value.type === "reject") {
    exact(value, ["v", "type", "txnId", "reason"], [], "Applet reject");
    return {
      v: versionOf(value),
      type: "reject",
      txnId: bounded(value.txnId, "Applet reject.txnId", 64),
      reason: bounded(value.reason, "Applet reject.reason", 512),
    };
  }
  return fail("Applet server frame type is invalid");
}
