// Disposable cleanup for the state Supersede left behind when steering
// replaced it.
//
// A run that settled `superseded` becomes `cancelled`, which is what it now
// reads as: it stopped because the person moved on, and its stop time is the
// moment that happened. Every run loses the two supersede fields and the
// model-intent flag only supersede read. The single waiting slot joins the
// user queue in its place. Queued `superseded-turn` inputs, and the drain
// receipts that carried one, are removed: nothing decodes that kind any more,
// and a receipt is only read back by the Turn that drained it. Projected rows
// and replayable updates carry whole runs to clients, whose schema no longer
// has the status, so they are rewritten the same way. The walk is once per
// Bot; it pages rather than loading the archive into one value.

import {
  CONVERSATION_ROW_PREFIX,
  CONVERSATION_UPDATE_PREFIX,
  pendingUserRunKey,
  RUN_PREFIX,
} from "@frockbot/core/durable";
import {
  ROUTINE_DRAIN_PREFIX,
  ROUTINE_WAKE_PREFIX,
} from "@frockbot/app/routines/storage-keys";

const RECEIPT = "maintenance:supersede-removal:2026-09-23";
const RETIRED_PENDING_RUN_KEY = "pending-run";
const RETIRED_INPUT_KIND = "superseded-turn";
const RETIRED_RUN_FIELDS = ["supersededAt", "supersededBy", "hasModelIntent"];
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

/** The run with supersede's fields gone, or `undefined` when it had none. */
function withoutSupersede(
  run: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const superseded = run.status === "superseded";
  if (!superseded && !RETIRED_RUN_FIELDS.some((field) => field in run)) {
    return undefined;
  }
  const cleaned = { ...run };
  for (const field of RETIRED_RUN_FIELDS) delete cleaned[field];
  if (superseded) {
    cleaned.status = "cancelled";
    cleaned.stopRequestedAt =
      run.stopRequestedAt ?? run.supersededAt ?? run.acceptedAt;
  }
  return cleaned;
}

/** A projected row or update whose run is `superseded`, rewritten. */
function projectedWithoutSupersede(value: unknown): unknown {
  const stored = record(value);
  const payload = record(stored?.payload);
  const run = record(payload?.run);
  if (!stored || !payload || !run || run.status !== "superseded") {
    return undefined;
  }
  const outcome = record(run.outcome);
  return {
    ...stored,
    payload: {
      ...payload,
      run: {
        ...run,
        status: "cancelled",
        stopRequestedAt: run.stopRequestedAt ?? run.admittedAt,
        outcome: { ...outcome, type: "cancelled" },
      },
    },
  };
}

function carriesRetiredInput(value: unknown): boolean {
  const inputs = record(value)?.inputs;
  return (
    Array.isArray(inputs) &&
    inputs.some((input) => record(input)?.kind === RETIRED_INPUT_KIND)
  );
}

export async function cleanSupersedeStateV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let runs = 0;
  await page(storage, RUN_PREFIX, async (key, value) => {
    const run = record(value);
    const cleaned = run && withoutSupersede(run);
    if (!cleaned) return;
    runs += 1;
    await storage.put(key, cleaned);
  });
  const waiting = await storage.get(RETIRED_PENDING_RUN_KEY);
  if (typeof waiting === "string") {
    const run = record(await storage.get(`${RUN_PREFIX}${waiting}`));
    if (run?.status === "running" && typeof run.acceptedAt === "string") {
      await storage.put(pendingUserRunKey(run.acceptedAt, waiting), waiting);
    }
    await storage.delete(RETIRED_PENDING_RUN_KEY);
  }
  for (const prefix of [CONVERSATION_ROW_PREFIX, CONVERSATION_UPDATE_PREFIX]) {
    await page(storage, prefix, async (key, value) => {
      const cleaned = projectedWithoutSupersede(value);
      if (cleaned === undefined) return;
      runs += 1;
      await storage.put(key, cleaned);
    });
  }
  let inputs = 0;
  await page(storage, ROUTINE_WAKE_PREFIX, async (key, value) => {
    if (record(value)?.kind !== RETIRED_INPUT_KIND) return;
    inputs += 1;
    await storage.delete(key);
  });
  await page(storage, ROUTINE_DRAIN_PREFIX, async (key, value) => {
    if (!carriesRetiredInput(value)) return;
    inputs += 1;
    await storage.delete(key);
  });
  await storage.put(RECEIPT, { schemaVersion: 1, runs, inputs });
}
