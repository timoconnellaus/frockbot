// Account-owned Composio catalogs. The User Durable Object holds them; a Turn
// pins one tool's schema when it first discloses it. Credentials never appear
// here.
//
// An app's catalog is every tool it has — up to several hundred — so the
// schemas are stored in chunks, each well under a Durable Object value, and
// the directory says which chunk holds each tool. A Turn reads the one chunk
// it needs, never the whole catalog.
//
// R2 is not involved. The directory and the schema chunks are all Durable
// Object records, written chunks-then-directory because a directory must not
// name bytes that were not stored. They are still not one atomic publish
// with the provider: the fetch happens outside the transaction, and the
// directory is updated only when the Connection generation still matches.

import { createHash } from "node:crypto";
import type { ConnectToolV1 } from "./composio.js";

/** Freshness policy these records were published under. */
export const CONNECT_CATALOG_POLICY_VERSION_V1 = 2;
/** A successful catalog is refreshed after this age. Starting value. */
export const CONNECT_CATALOG_REFRESH_AFTER_MS_V1 = 60 * 60 * 1000;
/** First disclosure refuses a catalog older than this until a refresh succeeds. */
export const CONNECT_CATALOG_DISCLOSURE_MAX_AGE_MS_V1 = 24 * 60 * 60 * 1000;
/** How long first-use discovery may block the Turn. Starting value. */
export const CONNECT_CATALOG_FIRST_USE_MS_V1 = 5_000;
/** One provider fetch per User alarm, so other deadlines on that firing still run. */
export const CONNECT_CATALOG_ALARM_FETCHES_V1 = 1;
/** Schema bodies kept per Connection: the published one and the one before it. */
export const CONNECT_CATALOG_RETAINED_BODIES_V1 = 2;
/** Largest one app's schemas may encode to, all chunks together. */
export const CONNECT_CATALOG_MAX_BYTES_V1 = 16_000_000;
/**
 * Largest one stored chunk of schemas: under a Durable Object value, and under
 * what a Turn pins for one tool, so a tool that fits a chunk fits its pin.
 */
export const CONNECT_CATALOG_CHUNK_BYTES_V1 = 900_000;
/** The provider's listing bound: ten pages of a hundred. */
export const CONNECT_CATALOG_MAX_TOOLS_V1 = 1_000;
export const CONNECT_CATALOG_PROVIDER_V1 = "composio";

export const CONNECT_CATALOG_DIR_PREFIX_V1 = "connect:tool-catalog:v1:dir:";
export const CONNECT_CATALOG_BODY_PREFIX_V1 = "connect:tool-catalog:v1:body:";
export const CONNECT_CATALOG_JOB_PREFIX_V1 = "connect:tool-catalog:v1:job:";

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 300_000;

export interface ConnectCatalogToolNameV1 {
  name: string;
  description: string;
  version: string;
  /** Which stored chunk holds this tool's schema. */
  chunk: number;
}

export interface ConnectCatalogDirectoryV1 {
  schemaVersion: 1;
  connectionId: string;
  generation: string;
  provider: typeof CONNECT_CATALOG_PROVIDER_V1;
  toolkitSlug: string;
  namespace: string;
  contentHash: string;
  fetchedAt: string;
  policyVersion: number;
  status: "ready" | "failed" | "revoked";
  refreshError?: string;
  tools: ConnectCatalogToolNameV1[];
}

/** One stored chunk of an app's schemas. */
export interface ConnectCatalogChunkV1 {
  schemaVersion: 1;
  contentHash: string;
  index: number;
  tools: ConnectToolV1[];
}

export interface ConnectCatalogJobV1 {
  schemaVersion: 1;
  connectionId: string;
  generation: string;
  toolkitSlug: string;
  namespace: string;
  dueAt: number;
  attempts: number;
}

export interface ConnectCatalogStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T>(options: {
    prefix: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, T>>;
  transaction<T>(
    callback: (tx: ConnectCatalogTransactionV1) => Promise<T>,
  ): Promise<T>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export interface ConnectCatalogTransactionV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export function connectCatalogDirectoryKeyV1(connectionId: string): string {
  return `${CONNECT_CATALOG_DIR_PREFIX_V1}${connectionId}`;
}

export function connectCatalogJobKeyV1(connectionId: string): string {
  return `${CONNECT_CATALOG_JOB_PREFIX_V1}${connectionId}`;
}

export function connectCatalogBodyKeyV1(
  connectionId: string,
  contentHash: string,
  index: number,
): string {
  return `${CONNECT_CATALOG_BODY_PREFIX_V1}${connectionId}:${contentHash}:${index}`;
}

export function connectCatalogRetryDelayMsV1(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
}

export function connectCatalogContentHashV1(
  tools: readonly ConnectToolV1[],
): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

export const CONNECT_STALE_CONTRACT_MESSAGE_V1 =
  "stale-contract: Access to this app was revoked. Connect it again.";
export const CONNECT_CATALOG_UNAVAILABLE_MESSAGE_V1 =
  "This app's tools are unavailable for this Turn. Other tools still work.";

export type ConnectAccountCatalogAnswerV1 =
  | {
      kind: "directory";
      tools: readonly { name: string; description: string }[];
    }
  | {
      /** The one tool a Turn asked for, as a catalog of one. */
      kind: "catalog";
      catalog: {
        schemaVersion: 1;
        toolkitSlug: string;
        tools: ConnectToolV1[];
      };
    }
  | { kind: "unavailable"; message: string }
  | { kind: "stale-contract"; message: string };

export class ConnectCatalogInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectCatalogInvalidError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function decodeConnectCatalogDirectoryV1(
  value: unknown,
): ConnectCatalogDirectoryV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.connectionId !== "string" ||
    typeof record.generation !== "string" ||
    record.provider !== CONNECT_CATALOG_PROVIDER_V1 ||
    typeof record.toolkitSlug !== "string" ||
    typeof record.namespace !== "string" ||
    typeof record.contentHash !== "string" ||
    typeof record.fetchedAt !== "string" ||
    record.policyVersion !== CONNECT_CATALOG_POLICY_VERSION_V1 ||
    (record.status !== "ready" &&
      record.status !== "failed" &&
      record.status !== "revoked") ||
    !Array.isArray(record.tools)
  ) {
    throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
  }
  const tools = record.tools.map((entry) => {
    const tool = asRecord(entry);
    if (
      !tool ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      typeof tool.version !== "string" ||
      !Number.isInteger(tool.chunk) ||
      (tool.chunk as number) < 0
    ) {
      throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
    }
    return {
      name: tool.name,
      description: tool.description,
      version: tool.version,
      chunk: tool.chunk as number,
    };
  });
  return {
    schemaVersion: 1,
    connectionId: record.connectionId,
    generation: record.generation,
    provider: CONNECT_CATALOG_PROVIDER_V1,
    toolkitSlug: record.toolkitSlug,
    namespace: record.namespace,
    contentHash: record.contentHash,
    fetchedAt: record.fetchedAt,
    policyVersion: CONNECT_CATALOG_POLICY_VERSION_V1,
    status: record.status,
    ...(typeof record.refreshError === "string"
      ? { refreshError: record.refreshError }
      : {}),
    tools,
  };
}

export function decodeConnectCatalogChunkV1(
  value: unknown,
): ConnectCatalogChunkV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.contentHash !== "string" ||
    !Number.isInteger(record.index) ||
    (record.index as number) < 0 ||
    !Array.isArray(record.tools)
  ) {
    throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
  }
  return {
    schemaVersion: 1,
    contentHash: record.contentHash,
    index: record.index as number,
    tools: record.tools.map(decodeStoredToolV1),
  };
}

function decodeStoredToolV1(value: unknown): ConnectToolV1 {
  const tool = asRecord(value);
  if (
    !tool ||
    typeof tool.slug !== "string" ||
    typeof tool.name !== "string" ||
    typeof tool.description !== "string" ||
    typeof tool.version !== "string" ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema)
  ) {
    throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
  }
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    version: tool.version,
  };
}

export function decodeConnectCatalogJobV1(value: unknown): ConnectCatalogJobV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    typeof record.connectionId !== "string" ||
    typeof record.generation !== "string" ||
    typeof record.toolkitSlug !== "string" ||
    typeof record.namespace !== "string" ||
    typeof record.dueAt !== "number" ||
    typeof record.attempts !== "number"
  ) {
    throw new ConnectCatalogInvalidError("Stored tool catalog job is invalid");
  }
  return {
    schemaVersion: 1,
    connectionId: record.connectionId,
    generation: record.generation,
    toolkitSlug: record.toolkitSlug,
    namespace: record.namespace,
    dueAt: record.dueAt,
    attempts: record.attempts,
  };
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * The tools in stored order, grouped into chunks under the chunk ceiling. A
 * single tool too large for a chunk on its own refuses the catalog: leaving it
 * out would hide a tool the app has.
 */
export function chunkConnectCatalogToolsV1(
  tools: readonly ConnectToolV1[],
): ConnectToolV1[][] {
  if (tools.length > CONNECT_CATALOG_MAX_TOOLS_V1) {
    throw new ConnectCatalogInvalidError("The tool catalog exceeds its limit");
  }
  const chunks: ConnectToolV1[][] = [];
  let current: ConnectToolV1[] = [];
  let currentBytes = 0;
  let total = 0;
  for (const tool of tools) {
    decodeStoredToolV1(tool);
    const bytes = encodedBytes(tool) + 1;
    if (bytes > CONNECT_CATALOG_CHUNK_BYTES_V1 - 512) {
      throw new ConnectCatalogInvalidError(
        "The tool catalog exceeds its limit",
      );
    }
    total += bytes;
    if (total > CONNECT_CATALOG_MAX_BYTES_V1) {
      throw new ConnectCatalogInvalidError(
        "The tool catalog exceeds its limit",
      );
    }
    if (
      current.length > 0 &&
      currentBytes + bytes > CONNECT_CATALOG_CHUNK_BYTES_V1 - 512
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(tool);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function connectCatalogAgeMsV1(
  directory: ConnectCatalogDirectoryV1,
  now: number,
): number {
  return now - Date.parse(directory.fetchedAt);
}

/** A catalog this Connection may disclose without a blocking refresh. */
export function connectCatalogDisclosableV1(
  directory: ConnectCatalogDirectoryV1 | undefined,
  generation: string,
  now: number,
): directory is ConnectCatalogDirectoryV1 {
  if (!directory || directory.status !== "ready") return false;
  if (directory.generation !== generation) return false;
  if (directory.policyVersion !== CONNECT_CATALOG_POLICY_VERSION_V1)
    return false;
  return (
    connectCatalogAgeMsV1(directory, now) <
    CONNECT_CATALOG_DISCLOSURE_MAX_AGE_MS_V1
  );
}

export function connectCatalogRefreshDueV1(
  directory: ConnectCatalogDirectoryV1,
  now: number,
): boolean {
  return (
    connectCatalogAgeMsV1(directory, now) >= CONNECT_CATALOG_REFRESH_AFTER_MS_V1
  );
}

function namesOf(
  chunks: readonly ConnectToolV1[][],
): ConnectCatalogToolNameV1[] {
  return chunks.flatMap((tools, chunk) =>
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description.slice(0, 240),
      version: tool.version,
      chunk,
    })),
  );
}

/** Moves the User alarm earlier when this job is due before whatever else is waiting. */
export async function armConnectCatalogAlarmV1(
  storage: {
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number): Promise<void>;
  },
  dueAt: number,
): Promise<void> {
  if (!storage.setAlarm) return;
  const existing = storage.getAlarm ? await storage.getAlarm() : null;
  if (existing === null || existing > dueAt) await storage.setAlarm(dueAt);
}

function coalesceJob(
  existing: ConnectCatalogJobV1 | undefined,
  next: ConnectCatalogJobV1,
): ConnectCatalogJobV1 {
  if (!existing || existing.generation !== next.generation) return next;
  return {
    ...existing,
    dueAt: Math.min(existing.dueAt, next.dueAt),
    toolkitSlug: next.toolkitSlug,
    namespace: next.namespace,
  };
}

export async function commitConnectCatalogJobV1(
  storage: ConnectCatalogStorageV1,
  job: ConnectCatalogJobV1,
): Promise<void> {
  const key = connectCatalogJobKeyV1(job.connectionId);
  let due = job.dueAt;
  await storage.transaction(async (tx) => {
    let existing: ConnectCatalogJobV1 | undefined;
    try {
      const stored = await tx.get(key);
      existing =
        stored === undefined ? undefined : decodeConnectCatalogJobV1(stored);
    } catch {
      existing = undefined;
    }
    const next = coalesceJob(existing, job);
    due = next.dueAt;
    await tx.put(key, next);
    await armConnectCatalogAlarmV1(tx, next.dueAt);
  });
  await armConnectCatalogAlarmV1(storage, due);
}

export async function invalidateConnectCatalogV1(
  storage: ConnectCatalogStorageV1,
  connectionId: string,
  status: "revoked" | "failed",
): Promise<void> {
  const key = connectCatalogDirectoryKeyV1(connectionId);
  await storage.transaction(async (tx) => {
    const stored = await tx.get(key);
    if (stored !== undefined) {
      try {
        const directory = decodeConnectCatalogDirectoryV1(stored);
        await tx.put(key, { ...directory, status });
      } catch {
        await tx.delete(key);
      }
    }
    await tx.delete(connectCatalogJobKeyV1(connectionId));
  });
}

async function retainBodiesV1(
  storage: ConnectCatalogStorageV1,
  connectionId: string,
  keep: readonly string[],
): Promise<void> {
  const prefix = `${CONNECT_CATALOG_BODY_PREFIX_V1}${connectionId}:`;
  const listed = await storage.list<unknown>({ prefix });
  const kept = new Set(keep);
  for (const [key] of listed) {
    const hash = key.slice(prefix.length).split(":")[0] ?? "";
    if (!kept.has(hash)) await storage.delete(key);
  }
}

export async function publishConnectCatalogV1(
  storage: ConnectCatalogStorageV1,
  input: {
    connectionId: string;
    generation: string;
    toolkitSlug: string;
    namespace: string;
    tools: readonly ConnectToolV1[];
    now: number;
    /** Read the Connection on the given transaction so the check and the write commit together. */
    readConnection(
      tx: ConnectCatalogTransactionV1,
    ): Promise<{ state?: string; generation?: string } | undefined>;
  },
): Promise<"published" | "stale-generation"> {
  const tools = input.tools.map(decodeStoredToolV1);
  const chunks = chunkConnectCatalogToolsV1(tools);
  const contentHash = connectCatalogContentHashV1(tools);
  const before = await input.readConnection(storage);
  if (before?.state !== "ready" || before.generation !== input.generation) {
    return "stale-generation";
  }
  for (const [index, chunk] of chunks.entries()) {
    await storage.put(
      connectCatalogBodyKeyV1(input.connectionId, contentHash, index),
      {
        schemaVersion: 1,
        contentHash,
        index,
        tools: chunk,
      } satisfies ConnectCatalogChunkV1,
    );
  }
  let previousHash = "";
  const directory: ConnectCatalogDirectoryV1 = {
    schemaVersion: 1,
    connectionId: input.connectionId,
    generation: input.generation,
    provider: CONNECT_CATALOG_PROVIDER_V1,
    toolkitSlug: input.toolkitSlug,
    namespace: input.namespace,
    contentHash,
    fetchedAt: new Date(input.now).toISOString(),
    policyVersion: CONNECT_CATALOG_POLICY_VERSION_V1,
    status: "ready",
    tools: namesOf(chunks),
  };
  const wrote = await storage.transaction(async (tx) => {
    const current = await input.readConnection(tx);
    if (current?.state !== "ready" || current.generation !== input.generation) {
      return false;
    }
    const stored = await tx.get(
      connectCatalogDirectoryKeyV1(input.connectionId),
    );
    if (stored !== undefined) {
      try {
        previousHash = decodeConnectCatalogDirectoryV1(stored).contentHash;
      } catch {
        previousHash = "";
      }
    }
    await tx.put(connectCatalogDirectoryKeyV1(input.connectionId), directory);
    const jobKey = connectCatalogJobKeyV1(input.connectionId);
    const job = await tx.get(jobKey);
    if (job !== undefined) {
      try {
        if (decodeConnectCatalogJobV1(job).generation === input.generation) {
          await tx.delete(jobKey);
        }
      } catch {
        await tx.delete(jobKey);
      }
    }
    return true;
  });
  if (!wrote) return "stale-generation";
  const keep = [contentHash, previousHash]
    .filter(Boolean)
    .slice(0, CONNECT_CATALOG_RETAINED_BODIES_V1);
  await retainBodiesV1(storage, input.connectionId, keep);
  await commitConnectCatalogJobV1(storage, {
    schemaVersion: 1,
    connectionId: input.connectionId,
    generation: input.generation,
    toolkitSlug: input.toolkitSlug,
    namespace: input.namespace,
    dueAt: input.now + CONNECT_CATALOG_REFRESH_AFTER_MS_V1,
    attempts: 0,
  });
  return "published";
}

export async function recordConnectCatalogFailureV1(
  storage: ConnectCatalogStorageV1,
  input: {
    job: ConnectCatalogJobV1;
    message: string;
    now: number;
    readConnection(
      tx: ConnectCatalogTransactionV1,
    ): Promise<{ state?: string; generation?: string } | undefined>;
  },
): Promise<void> {
  const key = connectCatalogDirectoryKeyV1(input.job.connectionId);
  const attempts = input.job.attempts + 1;
  await storage.transaction(async (tx) => {
    const stored = await tx.get(key);
    let directory: ConnectCatalogDirectoryV1 | undefined;
    if (stored !== undefined) {
      try {
        directory = decodeConnectCatalogDirectoryV1(stored);
      } catch {
        directory = undefined;
      }
    }
    const current = await input.readConnection(tx);
    const currentMatch =
      current?.state === "ready" && current.generation === input.job.generation;
    const keep =
      directory?.status === "ready" &&
      directory.generation === input.job.generation &&
      currentMatch;
    if (keep && directory) {
      await tx.put(key, { ...directory, refreshError: input.message });
    } else if (currentMatch) {
      const failed: ConnectCatalogDirectoryV1 = {
        schemaVersion: 1,
        connectionId: input.job.connectionId,
        generation: input.job.generation,
        provider: CONNECT_CATALOG_PROVIDER_V1,
        toolkitSlug: input.job.toolkitSlug,
        namespace: input.job.namespace,
        contentHash: "",
        fetchedAt: new Date(input.now).toISOString(),
        policyVersion: CONNECT_CATALOG_POLICY_VERSION_V1,
        status: "failed",
        refreshError: input.message,
        tools: [],
      };
      await tx.put(key, failed);
    }
    await tx.put(connectCatalogJobKeyV1(input.job.connectionId), {
      ...input.job,
      attempts,
      dueAt: input.now + connectCatalogRetryDelayMsV1(attempts),
    } satisfies ConnectCatalogJobV1);
  });
  await armConnectCatalogAlarmV1(
    storage,
    input.now + connectCatalogRetryDelayMsV1(attempts),
  );
}

export async function readConnectCatalogDirectoryV1(
  storage: ConnectCatalogStorageV1,
  connectionId: string,
): Promise<ConnectCatalogDirectoryV1 | undefined> {
  const stored = await storage.get(connectCatalogDirectoryKeyV1(connectionId));
  if (stored === undefined) return undefined;
  return decodeConnectCatalogDirectoryV1(stored);
}

/** One tool's schema from a published catalog, or nothing when it has none by that name. */
export async function readConnectCatalogToolV1(
  storage: ConnectCatalogStorageV1,
  directory: ConnectCatalogDirectoryV1,
  toolName: string,
): Promise<ConnectToolV1 | undefined> {
  const entry = directory.tools.find((tool) => tool.name === toolName);
  if (!entry) return undefined;
  const stored = await storage.get(
    connectCatalogBodyKeyV1(
      directory.connectionId,
      directory.contentHash,
      entry.chunk,
    ),
  );
  if (stored === undefined) {
    throw new ConnectCatalogInvalidError("The tool catalog is unavailable");
  }
  const chunk = decodeConnectCatalogChunkV1(stored);
  if (chunk.contentHash !== directory.contentHash) {
    throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
  }
  const tool = chunk.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new ConnectCatalogInvalidError("Stored tool catalog is invalid");
  }
  return tool;
}

export async function dueConnectCatalogJobsV1(
  storage: ConnectCatalogStorageV1,
  now: number,
): Promise<ConnectCatalogJobV1[]> {
  const listed = await storage.list<unknown>({
    prefix: CONNECT_CATALOG_JOB_PREFIX_V1,
  });
  const jobs: ConnectCatalogJobV1[] = [];
  for (const value of listed.values()) {
    try {
      const job = decodeConnectCatalogJobV1(value);
      if (job.dueAt <= now) jobs.push(job);
    } catch {
      // Undecodable jobs are cleanup's, not this drain's.
    }
  }
  return jobs.sort((left, right) => left.dueAt - right.dueAt);
}

const CLEANUP_RECEIPT = "maintenance:connect-catalog-decode:2026-09-23";
const CLEANUP_PAGE = 50;

export async function cleanUndecodableConnectCatalogsV1(
  storage: ConnectCatalogStorageV1,
): Promise<void> {
  if (await storage.get(CLEANUP_RECEIPT)) return;
  for (const prefix of [
    CONNECT_CATALOG_DIR_PREFIX_V1,
    CONNECT_CATALOG_BODY_PREFIX_V1,
    CONNECT_CATALOG_JOB_PREFIX_V1,
  ]) {
    let start: string | undefined;
    for (;;) {
      const listed = await storage.list<unknown>({
        prefix,
        limit: CLEANUP_PAGE,
        ...(start ? { start } : {}),
      });
      if (listed.size === 0) break;
      let last = "";
      for (const [key, value] of listed) {
        last = key;
        if (start !== undefined && key === start) continue;
        try {
          if (prefix === CONNECT_CATALOG_DIR_PREFIX_V1) {
            decodeConnectCatalogDirectoryV1(value);
          } else if (prefix === CONNECT_CATALOG_BODY_PREFIX_V1) {
            decodeConnectCatalogChunkV1(value);
          } else {
            decodeConnectCatalogJobV1(value);
          }
        } catch {
          await storage.delete(key);
        }
      }
      if (listed.size < CLEANUP_PAGE) break;
      start = `${last}\0`;
    }
  }
  await storage.put(CLEANUP_RECEIPT, { schemaVersion: 1 });
}

/** One in-flight discovery per Connection generation, shared by concurrent callers. */
export function coalesceConnectCatalogDiscoveryV1<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const work = start().finally(() => {
    if (inflight.get(key) === work) inflight.delete(key);
  });
  inflight.set(key, work);
  return work;
}
