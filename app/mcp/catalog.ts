// An MCP server's tool directory, kept by the User Durable Object so a Turn
// never waits on a server it is not using.
//
// One record per Connection holds every tool the server listed, schemas
// included: a remote server's list is tens of tools, not the hundreds a
// connected app carries, so it is bounded and stored whole rather than
// chunked. A Turn reads the names from it and pins one tool's schema when it
// first discloses or calls that tool. The record names the Connection
// generation it was listed under; a new credential is a new generation, and
// a directory from the old one is never disclosed under the new.
//
// Refreshes are due an hour after the last listing and run from the User
// alarm, one server per firing; a failing server is retried with backoff and
// keeps the tools it last listed.
import type { McpToolV1 } from "./client.js";

export const MCP_CATALOG_PREFIX_V1 = "mcp:catalog:v1:";
export const MCP_CATALOG_JOB_PREFIX_V1 = "mcp:catalog-job:v1:";
/** A listing is refreshed after this age. */
export const MCP_CATALOG_REFRESH_AFTER_MS_V1 = 60 * 60 * 1000;
/** The most tools one server's directory may hold. */
export const MCP_CATALOG_MAX_TOOLS_V1 = 500;
/** The largest one server's tools may encode to, under a stored value. */
export const MCP_CATALOG_MAX_BYTES_V1 = 900_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = MCP_CATALOG_REFRESH_AFTER_MS_V1;

export interface McpCatalogV1 {
  schemaVersion: 1;
  connectionId: string;
  /** The Connection generation the tools were listed under. */
  generation: string;
  fetchedAt: string;
  tools: McpToolV1[];
  /** Why the last refresh failed, while the tools before it are kept. */
  refreshError?: string;
}

export interface McpCatalogJobV1 {
  schemaVersion: 1;
  connectionId: string;
  generation: string;
  dueAt: number;
  attempts: number;
}

export interface McpCatalogTransactionV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export interface McpCatalogStorageV1 extends McpCatalogTransactionV1 {
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(
    callback: (tx: McpCatalogTransactionV1) => Promise<T>,
  ): Promise<T>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export class McpCatalogTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCatalogTooLargeError";
  }
}

export function mcpCatalogKeyV1(connectionId: string): string {
  return `${MCP_CATALOG_PREFIX_V1}${connectionId}`;
}

export function mcpCatalogJobKeyV1(connectionId: string): string {
  return `${MCP_CATALOG_JOB_PREFIX_V1}${connectionId}`;
}

export function mcpCatalogRetryDelayMsV1(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeTool(value: unknown): McpToolV1 | undefined {
  const tool = record(value);
  const schema = record(tool?.inputSchema);
  if (
    !tool ||
    typeof tool.name !== "string" ||
    typeof tool.description !== "string" ||
    !schema
  ) {
    return undefined;
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

/** A stored directory, or `undefined` when there is none a Turn may use. */
export function decodeMcpCatalogV1(value: unknown): McpCatalogV1 | undefined {
  const stored = record(value);
  if (
    !stored ||
    stored.schemaVersion !== 1 ||
    typeof stored.connectionId !== "string" ||
    typeof stored.generation !== "string" ||
    typeof stored.fetchedAt !== "string" ||
    !Array.isArray(stored.tools) ||
    (stored.refreshError !== undefined &&
      typeof stored.refreshError !== "string")
  ) {
    return undefined;
  }
  const tools = stored.tools.map(decodeTool);
  if (tools.some((tool) => tool === undefined)) return undefined;
  return {
    schemaVersion: 1,
    connectionId: stored.connectionId,
    generation: stored.generation,
    fetchedAt: stored.fetchedAt,
    tools: tools as McpToolV1[],
    ...(stored.refreshError === undefined
      ? {}
      : { refreshError: stored.refreshError }),
  };
}

export function decodeMcpCatalogJobV1(
  value: unknown,
): McpCatalogJobV1 | undefined {
  const job = record(value);
  if (
    !job ||
    job.schemaVersion !== 1 ||
    typeof job.connectionId !== "string" ||
    typeof job.generation !== "string" ||
    typeof job.dueAt !== "number" ||
    typeof job.attempts !== "number"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    connectionId: job.connectionId,
    generation: job.generation,
    dueAt: job.dueAt,
    attempts: job.attempts,
  };
}

/**
 * A listing within the directory's bounds. Leaving tools out would hide
 * ones the server has, so a listing past a bound is refused whole.
 */
export function boundMcpCatalogToolsV1(
  tools: readonly McpToolV1[],
): McpToolV1[] {
  if (tools.length > MCP_CATALOG_MAX_TOOLS_V1) {
    throw new McpCatalogTooLargeError(
      `The server lists ${tools.length} tools; FrockBot holds at most ${MCP_CATALOG_MAX_TOOLS_V1}.`,
    );
  }
  const bytes = new TextEncoder().encode(JSON.stringify(tools)).byteLength;
  if (bytes > MCP_CATALOG_MAX_BYTES_V1) {
    throw new McpCatalogTooLargeError(
      "The server's tool list is larger than FrockBot can hold.",
    );
  }
  const names = new Set<string>();
  return tools.filter((tool) => {
    // A second tool by the same name could never be addressed.
    if (names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}

export async function readMcpCatalogV1(
  storage: McpCatalogTransactionV1,
  connectionId: string,
): Promise<McpCatalogV1 | undefined> {
  return decodeMcpCatalogV1(await storage.get(mcpCatalogKeyV1(connectionId)));
}

/**
 * Moves the User alarm earlier when this is due before whatever else is. An
 * alarm already in the past is the one firing now, and counts as none.
 */
export async function armMcpCatalogAlarmV1(
  storage: Pick<McpCatalogStorageV1, "getAlarm" | "setAlarm">,
  dueAt: number,
  now: number,
): Promise<void> {
  if (!storage.setAlarm) return;
  const existing = storage.getAlarm ? await storage.getAlarm() : null;
  if (existing === null || existing <= now || existing > dueAt) {
    await storage.setAlarm(dueAt);
  }
}

type ReadConnection = (
  tx: McpCatalogTransactionV1,
) => Promise<{ state?: string; generation?: string } | undefined>;

/**
 * Stores a listing, when the Connection is still the one it was listed for,
 * and schedules the next refresh. Answers whether it was stored.
 */
export async function publishMcpCatalogV1(
  storage: McpCatalogStorageV1,
  input: {
    connectionId: string;
    generation: string;
    tools: readonly McpToolV1[];
    now: number;
    readConnection: ReadConnection;
  },
): Promise<boolean> {
  const tools = boundMcpCatalogToolsV1(input.tools);
  const dueAt = input.now + MCP_CATALOG_REFRESH_AFTER_MS_V1;
  const stored = await storage.transaction(async (tx) => {
    const current = await input.readConnection(tx);
    if (
      (current?.state !== "ready" && current?.state !== "disabled") ||
      current.generation !== input.generation
    ) {
      return false;
    }
    await tx.put(mcpCatalogKeyV1(input.connectionId), {
      schemaVersion: 1,
      connectionId: input.connectionId,
      generation: input.generation,
      fetchedAt: new Date(input.now).toISOString(),
      tools,
    } satisfies McpCatalogV1);
    await tx.put(mcpCatalogJobKeyV1(input.connectionId), {
      schemaVersion: 1,
      connectionId: input.connectionId,
      generation: input.generation,
      dueAt,
      attempts: 0,
    } satisfies McpCatalogJobV1);
    return true;
  });
  if (stored) await armMcpCatalogAlarmV1(storage, dueAt, input.now);
  return stored;
}

/**
 * A refresh that failed. The tools already listed under this generation are
 * kept and say why they are stale; the next attempt backs off.
 */
export async function recordMcpCatalogFailureV1(
  storage: McpCatalogStorageV1,
  input: {
    job: McpCatalogJobV1;
    message: string;
    now: number;
  },
): Promise<void> {
  const attempts = input.job.attempts + 1;
  const dueAt = input.now + mcpCatalogRetryDelayMsV1(attempts);
  await storage.transaction(async (tx) => {
    const catalog = await readMcpCatalogV1(tx, input.job.connectionId);
    if (catalog && catalog.generation === input.job.generation) {
      await tx.put(mcpCatalogKeyV1(input.job.connectionId), {
        ...catalog,
        refreshError: input.message,
      } satisfies McpCatalogV1);
    }
    await tx.put(mcpCatalogJobKeyV1(input.job.connectionId), {
      ...input.job,
      attempts,
      dueAt,
    } satisfies McpCatalogJobV1);
  });
  await armMcpCatalogAlarmV1(storage, dueAt, input.now);
}

/** A removed or re-credentialed server's directory and its refresh. */
export async function forgetMcpCatalogV1(
  storage: McpCatalogTransactionV1,
  connectionId: string,
): Promise<void> {
  await storage.delete(mcpCatalogKeyV1(connectionId));
  await storage.delete(mcpCatalogJobKeyV1(connectionId));
}

/** Every refresh job, due or not, soonest first. */
export async function listMcpCatalogJobsV1(
  storage: McpCatalogStorageV1,
): Promise<McpCatalogJobV1[]> {
  const listed = await storage.list<unknown>({
    prefix: MCP_CATALOG_JOB_PREFIX_V1,
  });
  return [...listed.values()]
    .flatMap((value) => {
      const job = decodeMcpCatalogJobV1(value);
      return job ? [job] : [];
    })
    .sort((left, right) => left.dueAt - right.dueAt);
}
