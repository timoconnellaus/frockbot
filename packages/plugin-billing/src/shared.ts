export const USAGE_DETAIL_RETENTION_DAYS_V1 = 45;
export const USAGE_DETAIL_MAX_ROWS_V1 = 50_000;
export const USAGE_MONTH_RETENTION_V1 = 120;
export const USAGE_OUTBOX_MAX_V1 = 1_024;
export const USAGE_ENTRY_PAGE_MAX_V1 = 1_024;

export type UsageKindV1 = "model" | "voice";

export interface UsageEntryV1 {
  schemaVersion: 1;
  entryId: string;
  kind: UsageKindV1;
  botId?: string;
  runId?: string;
  turnId?: string;
  turn?: number;
  requestId?: string;
  at: string;
  provider: string;
  model: string;
  bindingId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  voiceSeconds: number;
  latencyMs: number;
  estimated: boolean;
  unknownPrice: boolean;
  priceTableVersion: string;
  costMicros: number;
}

export interface UsageBreakdownV1 {
  id: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  voiceSeconds: number;
  estimatedCalls: number;
  unknownPriceCalls: number;
}

export interface UsageDayV1 {
  day: string;
  costMicros: number;
}

export interface UsageReportV1 {
  schemaVersion: 1;
  month: string;
  currentMonthCostMicros: number;
  lifetimeCostMicros: number;
  currentMonthInputTokens: number;
  currentMonthOutputTokens: number;
  currentMonthVoiceSeconds: number;
  estimatedCalls: number;
  unknownPriceCalls: number;
  bots: UsageBreakdownV1[];
  models: UsageBreakdownV1[];
  days: UsageDayV1[];
}

export class UsageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageDecodeError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new UsageDecodeError(`${label}.${String(key)} is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new UsageDecodeError(`${label}.${key} is required`);
    }
  }
}

function text(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new UsageDecodeError(`${label} must be a bounded string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UsageDecodeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new UsageDecodeError(`${label} must be a boolean`);
  }
  return value;
}

const ENTRY_REQUIRED = [
  "schemaVersion",
  "entryId",
  "kind",
  "at",
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "voiceSeconds",
  "latencyMs",
  "estimated",
  "unknownPrice",
  "priceTableVersion",
  "costMicros",
] as const;
const ENTRY_OPTIONAL = [
  "botId",
  "runId",
  "turnId",
  "turn",
  "requestId",
  "bindingId",
] as const;

export function decodeUsageEntryV1(value: unknown): UsageEntryV1 {
  const entry = record(value, "usage entry");
  exactKeys(entry, ENTRY_REQUIRED, ENTRY_OPTIONAL, "usage entry");
  if (entry.schemaVersion !== 1) {
    throw new UsageDecodeError("usage entry.schemaVersion is invalid");
  }
  if (entry.kind !== "model" && entry.kind !== "voice") {
    throw new UsageDecodeError("usage entry.kind is invalid");
  }
  const at = text(entry.at, "usage entry.at", 64);
  if (!Number.isFinite(Date.parse(at))) {
    throw new UsageDecodeError("usage entry.at must be a timestamp");
  }
  const inputTokens = integer(entry.inputTokens, "usage entry.inputTokens");
  const outputTokens = integer(entry.outputTokens, "usage entry.outputTokens");
  const cachedInputTokens = integer(
    entry.cachedInputTokens,
    "usage entry.cachedInputTokens",
  );
  const reasoningTokens = integer(
    entry.reasoningTokens,
    "usage entry.reasoningTokens",
  );
  if (cachedInputTokens > inputTokens || reasoningTokens > outputTokens) {
    throw new UsageDecodeError("usage entry token details exceed their totals");
  }
  return {
    schemaVersion: 1,
    entryId: text(entry.entryId, "usage entry.entryId"),
    kind: entry.kind,
    ...(optionalText(entry.botId, "usage entry.botId")
      ? {
          botId: optionalText(entry.botId, "usage entry.botId"),
        }
      : {}),
    ...(optionalText(entry.runId, "usage entry.runId")
      ? {
          runId: optionalText(entry.runId, "usage entry.runId"),
        }
      : {}),
    ...(optionalText(entry.turnId, "usage entry.turnId")
      ? {
          turnId: optionalText(entry.turnId, "usage entry.turnId"),
        }
      : {}),
    ...(optionalInteger(entry.turn, "usage entry.turn") === undefined
      ? {}
      : {
          turn: optionalInteger(entry.turn, "usage entry.turn"),
        }),
    ...(optionalText(entry.requestId, "usage entry.requestId")
      ? {
          requestId: optionalText(entry.requestId, "usage entry.requestId"),
        }
      : {}),
    at,
    provider: text(entry.provider, "usage entry.provider"),
    model: text(entry.model, "usage entry.model"),
    ...(optionalText(entry.bindingId, "usage entry.bindingId")
      ? {
          bindingId: optionalText(entry.bindingId, "usage entry.bindingId"),
        }
      : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    voiceSeconds: integer(entry.voiceSeconds, "usage entry.voiceSeconds"),
    latencyMs: integer(entry.latencyMs, "usage entry.latencyMs"),
    estimated: flag(entry.estimated, "usage entry.estimated"),
    unknownPrice: flag(entry.unknownPrice, "usage entry.unknownPrice"),
    priceTableVersion: text(
      entry.priceTableVersion,
      "usage entry.priceTableVersion",
      64,
    ),
    costMicros: integer(entry.costMicros, "usage entry.costMicros"),
  };
}

function decodeBreakdownV1(value: unknown, label: string): UsageBreakdownV1 {
  const row = record(value, label);
  const keys = [
    "id",
    "costMicros",
    "inputTokens",
    "outputTokens",
    "voiceSeconds",
    "estimatedCalls",
    "unknownPriceCalls",
  ];
  exactKeys(row, keys, [], label);
  return {
    id: text(row.id, `${label}.id`, 512),
    costMicros: integer(row.costMicros, `${label}.costMicros`),
    inputTokens: integer(row.inputTokens, `${label}.inputTokens`),
    outputTokens: integer(row.outputTokens, `${label}.outputTokens`),
    voiceSeconds: integer(row.voiceSeconds, `${label}.voiceSeconds`),
    estimatedCalls: integer(row.estimatedCalls, `${label}.estimatedCalls`),
    unknownPriceCalls: integer(
      row.unknownPriceCalls,
      `${label}.unknownPriceCalls`,
    ),
  };
}

export function decodeUsageReportV1(value: unknown): UsageReportV1 {
  const report = record(value, "usage report");
  const keys = [
    "schemaVersion",
    "month",
    "currentMonthCostMicros",
    "lifetimeCostMicros",
    "currentMonthInputTokens",
    "currentMonthOutputTokens",
    "currentMonthVoiceSeconds",
    "estimatedCalls",
    "unknownPriceCalls",
    "bots",
    "models",
    "days",
  ];
  exactKeys(report, keys, [], "usage report");
  if (
    report.schemaVersion !== 1 ||
    !/^\d{4}-\d{2}$/.test(String(report.month))
  ) {
    throw new UsageDecodeError("usage report version or month is invalid");
  }
  if (
    !Array.isArray(report.bots) ||
    !Array.isArray(report.models) ||
    !Array.isArray(report.days)
  ) {
    throw new UsageDecodeError("usage report breakdowns must be arrays");
  }
  if (
    report.bots.length > 10_000 ||
    report.models.length > 10_000 ||
    report.days.length > 31
  ) {
    throw new UsageDecodeError("usage report exceeds its bounds");
  }
  return {
    schemaVersion: 1,
    month: String(report.month),
    currentMonthCostMicros: integer(
      report.currentMonthCostMicros,
      "usage report.currentMonthCostMicros",
    ),
    lifetimeCostMicros: integer(
      report.lifetimeCostMicros,
      "usage report.lifetimeCostMicros",
    ),
    currentMonthInputTokens: integer(
      report.currentMonthInputTokens,
      "usage report.currentMonthInputTokens",
    ),
    currentMonthOutputTokens: integer(
      report.currentMonthOutputTokens,
      "usage report.currentMonthOutputTokens",
    ),
    currentMonthVoiceSeconds: integer(
      report.currentMonthVoiceSeconds,
      "usage report.currentMonthVoiceSeconds",
    ),
    estimatedCalls: integer(
      report.estimatedCalls,
      "usage report.estimatedCalls",
    ),
    unknownPriceCalls: integer(
      report.unknownPriceCalls,
      "usage report.unknownPriceCalls",
    ),
    bots: report.bots.map((row, index) =>
      decodeBreakdownV1(row, `usage report.bots[${index}]`),
    ),
    models: report.models.map((row, index) =>
      decodeBreakdownV1(row, `usage report.models[${index}]`),
    ),
    days: report.days.map((value, index) => {
      const day = record(value, `usage report.days[${index}]`);
      exactKeys(day, ["day", "costMicros"], [], `usage report.days[${index}]`);
      const date = text(day.day, `usage report.days[${index}].day`, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new UsageDecodeError(
          `usage report.days[${index}].day is invalid`,
        );
      }
      return {
        day: date,
        costMicros: integer(
          day.costMicros,
          `usage report.days[${index}].costMicros`,
        ),
      };
    }),
  };
}
