// The hosted model rate table on Cloudflare: its storage inside the
// `DeploymentPolicy` authority, and the short-lived copy each Bot object reads
// its prices from (docs/billing.md).

import {
  decodeHostedModelRatesV1,
  decodeReportUnpricedServedModelRequestV1,
  decodeSaveHostedModelRatesRequestV1,
  decodeUnpricedServedModelV1,
  hostedModelLimitsV1,
  MODEL_RATES_HISTORY_LIMIT,
  seedHostedModelRatesV1,
  servedRateV1,
  type HostedModelRatesV1,
  type HostedModelRatesViewV1,
  type UnpricedServedModelV1,
} from "@frockbot/app/billing/rates";
import { rpcJsonSnapshotV1 } from "./durable-rpc.js";

const CURRENT_KEY = "model-rates:v1:current";
const VERSION_PREFIX = "model-rates:v1:version:";
const UNPRICED_PREFIX = "model-rates:v1:unpriced:";
export const MODEL_RATES_SEED_RECEIPT_KEY =
  "maintenance:model-rates-seed:2026-09-24";

/** The synchronous key-value half of SQLite-backed Durable Object storage. */
export interface ModelRatesStorageV1 {
  kv: Pick<SyncKvStorage, "get" | "put" | "list">;
  transactionSync<T>(callback: () => T): T;
}

/** Zero-padded, so the key order is the version order. */
function versionKey(version: number): string {
  return `${VERSION_PREFIX}${String(version).padStart(12, "0")}`;
}

function unpricedKey(servedModel: string | null): string {
  return `${UNPRICED_PREFIX}${servedModel ?? ""}`;
}

/**
 * Writes version 1 from the prices production ran on before the table, when
 * no version exists. Runs whenever the authority starts; the receipt makes a
 * second start a no-op, and it never overwrites a table an administrator
 * saved.
 */
export function seedHostedModelRatesStorageV1(
  storage: ModelRatesStorageV1,
  now: () => Date = () => new Date(),
): void {
  storage.transactionSync(() => {
    if (storage.kv.get(MODEL_RATES_SEED_RECEIPT_KEY) !== undefined) return;
    const present = storage.kv.get(CURRENT_KEY) !== undefined;
    if (!present) {
      const seed = seedHostedModelRatesV1(now().toISOString());
      storage.kv.put(versionKey(seed.version), seed);
      storage.kv.put(CURRENT_KEY, seed.version);
    }
    storage.kv.put(MODEL_RATES_SEED_RECEIPT_KEY, {
      at: now().toISOString(),
      seeded: present ? 0 : 1,
    });
  });
}

function currentVersion(storage: ModelRatesStorageV1): number | undefined {
  const version = storage.kv.get<unknown>(CURRENT_KEY);
  if (version === undefined) return undefined;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error("stored hosted model rate version is invalid");
  }
  return version as number;
}

export function currentHostedModelRatesV1(
  storage: ModelRatesStorageV1,
): HostedModelRatesV1 {
  const version = currentVersion(storage);
  if (version === undefined) {
    throw new Error("this deployment has no hosted model rates");
  }
  const table = decodeHostedModelRatesV1(
    storage.kv.get(versionKey(version)),
    "stored hosted model rates",
  );
  if (table.version !== version) {
    throw new Error("stored hosted model rates name another version");
  }
  return table;
}

export function hostedModelRatesViewV1(
  storage: ModelRatesStorageV1,
): HostedModelRatesViewV1 {
  const current = currentHostedModelRatesV1(storage);
  const history = [
    ...storage.kv.list({
      prefix: VERSION_PREFIX,
      reverse: true,
      limit: MODEL_RATES_HISTORY_LIMIT,
    }),
  ].map(([, value]) =>
    decodeHostedModelRatesV1(value, "stored hosted model rates"),
  );
  const unpriced = [...storage.kv.list({ prefix: UNPRICED_PREFIX })]
    .map(([, value]) => decodeUnpricedServedModelV1(value))
    .filter(
      (report) =>
        report.servedModel === null ||
        !servedRateV1(current, report.servedModel),
    )
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { schemaVersion: 1, current, history, unpriced };
}

/**
 * A compare-and-swap answered as a value, like the authority's other writes:
 * a lost race is an answer the admin portal shows, not a failure.
 */
export type ModelRatesWriteV1 =
  | { status: "applied"; value: HostedModelRatesV1 }
  | { status: "conflict"; currentRevision: number };

/** Each save is the next version; a saved version is never rewritten. */
export function saveHostedModelRatesV1(
  storage: ModelRatesStorageV1,
  input: unknown,
  now: () => Date = () => new Date(),
): ModelRatesWriteV1 {
  const request = decodeSaveHostedModelRatesRequestV1(input);
  return storage.transactionSync<ModelRatesWriteV1>(() => {
    const current = currentVersion(storage) ?? 0;
    if (request.command.baseVersion !== current) {
      return { status: "conflict", currentRevision: current };
    }
    const next: HostedModelRatesV1 = {
      schemaVersion: 1,
      version: current + 1,
      createdAt: now().toISOString(),
      createdBy: request.createdBy,
      routes: request.command.routes,
      served: request.command.served,
    };
    storage.kv.put(versionKey(next.version), next);
    storage.kv.put(CURRENT_KEY, next.version);
    return { status: "applied", value: next };
  });
}

export function reportUnpricedServedModelV1(
  storage: ModelRatesStorageV1,
  input: unknown,
  now: () => Date = () => new Date(),
): void {
  const report = decodeReportUnpricedServedModelRequestV1(input);
  storage.transactionSync(() => {
    const key = unpricedKey(report.servedModel);
    const stored = storage.kv.get<unknown>(key);
    const at = now().toISOString();
    const next: UnpricedServedModelV1 = {
      schemaVersion: 1,
      servedModel: report.servedModel,
      route: report.route,
      version: report.version,
      firstSeenAt:
        stored === undefined
          ? at
          : decodeUnpricedServedModelV1(stored).firstSeenAt,
      lastSeenAt: at,
    };
    storage.kv.put(key, next);
  });
}

// --- The Bot object's copy -------------------------------------------------------

/** How long a Bot object prices from its copy before reading the table again. */
export const HOSTED_MODEL_RATES_CACHE_MS_V1 = 60_000;

export interface HostedModelRatesAuthorityV1 {
  readModelRates(input: unknown): Promise<unknown>;
  reportUnpricedServedModel(input: unknown): Promise<unknown>;
}

export interface HostedModelRatesReaderV1 {
  rates(): Promise<HostedModelRatesV1>;
  /** Each route's prepaid bounds, keyed by the model id it prices. */
  limits(): Promise<ReturnType<typeof hostedModelLimitsV1>>;
  reportUnpriced(report: {
    servedModel: string | null;
    route: string;
    version: number;
  }): Promise<void>;
}

/**
 * The table as one Bot object prices from it: read at most once a minute, so
 * a model call is not a call to the authority. A failed read falls back to the
 * copy already held — the table it last priced from is still a real table —
 * and only a Bot that has never read one is refused.
 */
export function createHostedModelRatesReaderV1(
  authority: () => HostedModelRatesAuthorityV1,
  options: { now?: () => number; ttlMs?: number } = {},
): HostedModelRatesReaderV1 {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HOSTED_MODEL_RATES_CACHE_MS_V1;
  let held: { table: HostedModelRatesV1; readAt: number } | undefined;
  let reading: Promise<HostedModelRatesV1> | undefined;
  const reported = new Map<string, number>();
  const read = async (): Promise<HostedModelRatesV1> => {
    try {
      const table = decodeHostedModelRatesV1(
        rpcJsonSnapshotV1(
          await authority().readModelRates({ schemaVersion: 1 }),
        ),
      );
      held = { table, readAt: now() };
      return table;
    } catch (error) {
      if (held) return held.table;
      throw error;
    }
  };
  const rates = (): Promise<HostedModelRatesV1> => {
    if (held && now() - held.readAt < ttlMs) return Promise.resolve(held.table);
    // Concurrent calls share one read; a failed one is not kept.
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  };
  return {
    rates,
    limits: async () => hostedModelLimitsV1(await rates()),
    async reportUnpriced(report) {
      const key = report.servedModel ?? "";
      const last = reported.get(key);
      if (last !== undefined && now() - last < ttlMs) return;
      reported.set(key, now());
      try {
        await authority().reportUnpricedServedModel({
          schemaVersion: 1,
          ...report,
        });
      } catch {
        // The settlement carries the flag; the next unpriced call reports again.
        reported.delete(key);
      }
    },
  };
}
