// Disposable cleanup for Turns admitted before they carried prepared inputs.
//
// Those runs cannot be executed: recovery must not substitute the live
// account. Non-terminal ones are removed, and pointers that named them are
// cleared. Finished runs stay, so a transcript that only needed their record
// can still be read. The walk is once per Bot; it pages rather than loading
// the archive into one value.

import {
  ACTIVE_RUN_KEY,
  PENDING_AGENT_RUN_PREFIX,
  PENDING_USER_RUN_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:prepared-inputs:2026-09-22";
const PAGE = 50;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function nonTerminalRunId(value: unknown): string | undefined {
  const stored = record(value);
  if (!stored || stored.preparedInputs !== undefined) return undefined;
  if (
    stored.status === "completed" ||
    stored.status === "failed" ||
    stored.status === "cancelled"
  ) {
    return undefined;
  }
  return typeof stored.runId === "string" ? stored.runId : undefined;
}

async function page(
  storage: CleanupStorage,
  prefix: string,
  visit: (key: string, value: unknown) => Promise<void>,
): Promise<void> {
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    if (listed.size === 0) return;
    let last = "";
    for (const [key, value] of listed) {
      last = key;
      if (start !== undefined && key === start) continue;
      await visit(key, value);
    }
    if (listed.size < PAGE) return;
    start = `${last}\0`;
  }
}

export async function cleanUnpreparedRunsV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  const removed = new Set<string>();
  await page(storage, RUN_PREFIX, async (key, value) => {
    const runId = nonTerminalRunId(value);
    if (!runId) return;
    removed.add(runId);
    await storage.delete(key);
  });
  const active = await storage.get(ACTIVE_RUN_KEY);
  if (typeof active === "string" && removed.has(active)) {
    await storage.delete(ACTIVE_RUN_KEY);
  }
  for (const prefix of [PENDING_USER_RUN_PREFIX, PENDING_AGENT_RUN_PREFIX]) {
    await page(storage, prefix, async (key, value) => {
      if (typeof value === "string" && removed.has(value)) {
        await storage.delete(key);
      }
    });
  }
  await page(storage, RUN_INDEX_PREFIX, async (key, value) => {
    if (typeof value === "string" && removed.has(value)) {
      await storage.delete(key);
    }
  });
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    removed: removed.size,
  });
}
