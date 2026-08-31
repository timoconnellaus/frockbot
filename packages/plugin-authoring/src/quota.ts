// D7 quotas, as durable per-User configuration in the User Durable Object.
//
// "Generation creation rate, artifact size, retained generations ... are
// bounded by durable per-User quotas; exceeding a quota refuses the operation
// and records a visible failure." The User's Durable Object is the authority
// for User-scoped quotas, so the counter and the configured limits live there
// and the Bot's Durable Object reserves a unit over a narrow RPC before it
// records an authorship intent.
//
// Reservation is idempotent on the authoring `effectId`: a resumed Turn that
// re-executes the same tool call must not consume a second unit.

export const AUTHORING_QUOTA_CONFIG_KEY = "quota:authoring";
export const AUTHORING_QUOTA_COUNTER_PREFIX = "quota:generations:";
export const AUTHORING_QUOTA_RESERVATION_PREFIX = "quota:reservation:";

/** D7 defaults. Durable per-User config overrides them. */
export const AUTHORING_QUOTA_DEFAULTS_V1: AuthoringQuotaConfigV1 = {
  schemaVersion: 1,
  retainedGenerationsPerBot: 50,
  authoredPerUserPerDay: 100,
  maxSourceBytes: 256 * 1024,
};

export interface AuthoringQuotaConfigV1 {
  schemaVersion: 1;
  retainedGenerationsPerBot: number;
  authoredPerUserPerDay: number;
  maxSourceBytes: number;
}

export type AuthoringQuotaLimitV1 =
  "source-bytes" | "retained-generations" | "authored-per-day";

export interface AuthoringQuotaRequestV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  /** The authoring effect this unit is reserved for; reservation is per effect. */
  effectId: string;
  /** `yyyy-mm-dd`, resolved by the caller from its own clock. */
  day: string;
  sourceBytes: number;
  retainedGenerations: number;
}

export type AuthoringQuotaReceiptV1 =
  | {
      schemaVersion: 1;
      status: "reserved";
      effectId: string;
      day: string;
      used: number;
      limit: number;
    }
  | {
      schemaVersion: 1;
      status: "refused";
      effectId: string;
      day: string;
      limitName: AuthoringQuotaLimitV1;
      reason: string;
      used: number;
      limit: number;
    };

export const AUTHORING_QUOTA_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function authoringQuotaCounterKey(day: string): string {
  if (!AUTHORING_QUOTA_DAY.test(day)) {
    throw new Error("authoring quota day must be yyyy-mm-dd");
  }
  return `${AUTHORING_QUOTA_COUNTER_PREFIX}${day}`;
}

export function authoringQuotaReservationKey(effectId: string): string {
  return `${AUTHORING_QUOTA_RESERVATION_PREFIX}${effectId}`;
}

/** `yyyy-mm-dd` in UTC; the counter key is a calendar day, not a rolling window. */
export function authoringQuotaDayV1(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The narrow storage surface this module needs from the User Durable Object. */
export interface AuthoringQuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export function decodeAuthoringQuotaConfigV1(
  input: unknown,
): AuthoringQuotaConfigV1 {
  if (input === undefined) return { ...AUTHORING_QUOTA_DEFAULTS_V1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("authoring quota configuration is invalid");
  }
  const value = input as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "retainedGenerationsPerBot",
    "authoredPerUserPerDay",
    "maxSourceBytes",
  ];
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error("authoring quota configuration is invalid");
  }
  const bounded = (name: keyof AuthoringQuotaConfigV1, maximum: number) => {
    const candidate = value[name];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > maximum
    ) {
      throw new Error(`authoring quota ${String(name)} is invalid`);
    }
    return candidate as number;
  };
  return {
    schemaVersion: 1,
    retainedGenerationsPerBot: bounded("retainedGenerationsPerBot", 10_000),
    authoredPerUserPerDay: bounded("authoredPerUserPerDay", 100_000),
    maxSourceBytes: bounded("maxSourceBytes", 8 * 1024 * 1024),
  };
}

function counterValue(input: unknown): number {
  if (input === undefined) return 0;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("authoring quota counter is invalid");
  }
  const value = (input as { count?: unknown }).count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("authoring quota counter is invalid");
  }
  return value as number;
}

function refusal(
  request: AuthoringQuotaRequestV1,
  limitName: AuthoringQuotaLimitV1,
  reason: string,
  used: number,
  limit: number,
): AuthoringQuotaReceiptV1 {
  return {
    schemaVersion: 1,
    status: "refused",
    effectId: request.effectId,
    day: request.day,
    limitName,
    reason,
    used,
    limit,
  };
}

/**
 * Reserves one authored-generation unit for the day, or refuses. Never throws
 * for a breach: a quota breach is an observable outcome the Bot's tool result
 * reports and the durable failure record preserves.
 */
export async function reserveAuthoringQuotaV1(
  storage: AuthoringQuotaStorage,
  request: AuthoringQuotaRequestV1,
): Promise<AuthoringQuotaReceiptV1> {
  const reservationKey = authoringQuotaReservationKey(request.effectId);
  const existing = await storage.get<AuthoringQuotaReceiptV1>(reservationKey);
  if (existing) return existing;

  const config = decodeAuthoringQuotaConfigV1(
    await storage.get<unknown>(AUTHORING_QUOTA_CONFIG_KEY),
  );
  const counterKey = authoringQuotaCounterKey(request.day);
  const used = counterValue(await storage.get<unknown>(counterKey));

  let receipt: AuthoringQuotaReceiptV1;
  if (request.sourceBytes > config.maxSourceBytes) {
    receipt = refusal(
      request,
      "source-bytes",
      `Package source is ${request.sourceBytes} bytes; this User's quota allows ${config.maxSourceBytes}`,
      request.sourceBytes,
      config.maxSourceBytes,
    );
  } else if (request.retainedGenerations >= config.retainedGenerationsPerBot) {
    receipt = refusal(
      request,
      "retained-generations",
      `this Bot retains ${request.retainedGenerations} Composition generations; this User's quota allows ${config.retainedGenerationsPerBot}`,
      request.retainedGenerations,
      config.retainedGenerationsPerBot,
    );
  } else if (used >= config.authoredPerUserPerDay) {
    receipt = refusal(
      request,
      "authored-per-day",
      `this User has authored ${used} generations on ${request.day}; the daily quota is ${config.authoredPerUserPerDay}`,
      used,
      config.authoredPerUserPerDay,
    );
  } else {
    receipt = {
      schemaVersion: 1,
      status: "reserved",
      effectId: request.effectId,
      day: request.day,
      used: used + 1,
      limit: config.authoredPerUserPerDay,
    };
    await storage.put(counterKey, { day: request.day, count: used + 1 });
  }
  // Refusals are recorded too: a replayed effect must get the same answer.
  await storage.put(reservationKey, receipt);
  return receipt;
}

export function decodeAuthoringQuotaReceiptV1(
  input: unknown,
  label = "authoring quota receipt",
): AuthoringQuotaReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const text = (name: string, maximum: number): string => {
    const candidate = value[name];
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > maximum
    ) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate;
  };
  const integer = (name: string): number => {
    const candidate = value[name];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`${label}.${name} is invalid`);
    }
    return candidate as number;
  };
  const effectId = text("effectId", 200);
  const day = text("day", 10);
  if (value.status === "reserved") {
    return {
      schemaVersion: 1,
      status: "reserved",
      effectId,
      day,
      used: integer("used"),
      limit: integer("limit"),
    };
  }
  if (value.status === "refused") {
    const limitName = value.limitName;
    if (
      limitName !== "source-bytes" &&
      limitName !== "retained-generations" &&
      limitName !== "authored-per-day"
    ) {
      throw new Error(`${label}.limitName is invalid`);
    }
    return {
      schemaVersion: 1,
      status: "refused",
      effectId,
      day,
      limitName,
      reason: text("reason", 1_024),
      used: integer("used"),
      limit: integer("limit"),
    };
  }
  throw new Error(`${label}.status is invalid`);
}

/** The narrow RPC the Bot Durable Object calls on the User Durable Object. */
export interface AuthoringQuotaBinding {
  reserve(request: AuthoringQuotaRequestV1): Promise<AuthoringQuotaReceiptV1>;
}
