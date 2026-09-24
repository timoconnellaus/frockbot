// The deployment's hosted model prices: one versioned table an administrator
// edits, held by the `DeploymentPolicy` authority.
//
// A table prices two different things. `routes` are the model ids a Bot asks
// for — `@frock/auto` among them — and each is a ceiling: the reservation is
// taken at its rate and its token bounds before anything is sent. `served`
// are the models the Gateway actually ran, keyed as the Gateway names them
// (`<cf-aig-provider>/<cf-aig-model>`), and the settlement is priced at that
// rate. Auto is a dashboard route that can be retargeted without a release, so
// the model that answered is the only honest thing to bill.
//
// A saved table is never edited: each save is a new version, and the version
// is recorded on every reservation priced from it.

import type { LlmUsageV1 } from "@frockbot/core/contracts";
import {
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_SUMMARY_MODEL,
  normalizeFrockModelIdV1,
} from "@frockbot/providers/frock-ai/catalog";
import { BillingError } from "./ledger.js";

/** What one model costs the deployment, in micro-US-dollars per token. */
export interface ServedModelRateV1 {
  inputMicrosPerToken: number;
  cachedInputMicrosPerToken: number;
  outputMicrosPerToken: number;
}

/** A requested model's price ceiling and the bounds its dispatch is held to. */
export interface ModelRate extends ServedModelRateV1 {
  maximumInputTokens: number;
  maximumOutputTokens: number;
}

export interface HostedModelRatesV1 {
  schemaVersion: 1;
  /** 1, 2, 3…: each save is the next one, and none is ever rewritten. */
  version: number;
  createdAt: string;
  /** The administrator who saved it, or `deployment-seed`. */
  createdBy: string;
  routes: Record<string, ModelRate>;
  served: Record<string, ServedModelRateV1>;
}

export interface SaveHostedModelRatesCommandV1 {
  schemaVersion: 1;
  type: "deployment/save-model-rates";
  /** The version the administrator read; saving over any other is a conflict. */
  baseVersion: number;
  routes: Record<string, ModelRate>;
  served: Record<string, ServedModelRateV1>;
}

export interface SaveHostedModelRatesRequestV1 {
  schemaVersion: 1;
  command: SaveHostedModelRatesCommandV1;
  createdBy: string;
}

/**
 * A hosted call settled at its route's ceiling because the model that
 * answered has no rate in the table, or the Gateway did not say which model
 * that was. Kept by the authority so the administrator sees it.
 */
export interface UnpricedServedModelV1 {
  schemaVersion: 1;
  /** `<provider>/<model>` as the Gateway named it; null when it named none. */
  servedModel: string | null;
  /** The requested model whose ceiling the call was charged at. */
  route: string;
  /** The table version the call was priced from. */
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ReportUnpricedServedModelRequestV1 {
  schemaVersion: 1;
  servedModel: string | null;
  route: string;
  version: number;
}

/** What the admin portal reads: the table, its past, and what it misses. */
export interface HostedModelRatesViewV1 {
  schemaVersion: 1;
  current: HostedModelRatesV1;
  /** Newest first, the current version included. */
  history: HostedModelRatesV1[];
  /** Models seen answering that the current version still does not price. */
  unpriced: UnpricedServedModelV1[];
}

export const MODEL_RATES_SEED_CREATED_BY = "deployment-seed";

/** How many past versions the admin portal is shown. */
export const MODEL_RATES_HISTORY_LIMIT = 20;

const ENTRY_LIMIT = 100;
const RATE_LIMIT = 1_000_000;
/** No single dispatch may reserve more than US$500,000 of provider cost. */
const MAXIMUM_DISPATCH_COST_MICROS = 500_000_000_000;

/**
 * The prices this deployment ran on before the table existed, written as
 * version 1 when no version does. Auto and the pinned DeepSeek model are
 * ceilings; the one model the Auto route serves today is priced as served.
 * Conversation summaries run on their own Gateway route for every Bot, so it
 * needs a ceiling too or no billed Bot could compact: it takes Auto's, and
 * what it actually serves is charged as served or shown to the administrator
 * as unpriced.
 */
export function seedHostedModelRatesV1(createdAt: string): HostedModelRatesV1 {
  const auto: ModelRate = {
    inputMicrosPerToken: 0.3,
    cachedInputMicrosPerToken: 0.006,
    outputMicrosPerToken: 1.2,
    maximumInputTokens: 400_000,
    maximumOutputTokens: 16_384,
  };
  const pinned: ModelRate = {
    inputMicrosPerToken: 0.44,
    cachedInputMicrosPerToken: 0.014,
    outputMicrosPerToken: 1.32,
    maximumInputTokens: 400_000,
    maximumOutputTokens: 16_384,
  };
  return {
    schemaVersion: 1,
    version: 1,
    createdAt,
    createdBy: MODEL_RATES_SEED_CREATED_BY,
    routes: {
      "@frock/auto": auto,
      "@flock/auto": auto,
      "@frock/deepseek-ai/deepseek-v4-flash-0731": pinned,
      "@flock/deepseek-ai/deepseek-v4-flash-0731": pinned,
      [FROCK_AI_SUMMARY_MODEL]: auto,
    },
    served: {
      "custom-together/deepseek-ai/DeepSeek-V4.1-Flash": {
        inputMicrosPerToken: 0.3,
        cachedInputMicrosPerToken: 0.006,
        outputMicrosPerToken: 1.2,
      },
    },
  };
}

/** The `pricing_version` a reservation priced from this table records. */
export function modelRatesPricingVersionV1(version: number): string {
  return `model-rates-${version}`;
}

export function modelCost(usage: LlmUsageV1, rate: ServedModelRateV1) {
  for (const n of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
    usage.reasoningTokens ?? 0,
  ])
    if (!Number.isSafeInteger(n) || n < 0)
      throw new BillingError("Invalid reported model usage", 502);
  const cached = usage.cachedInputTokens ?? 0;
  if (
    cached > usage.inputTokens ||
    (usage.reasoningTokens ?? 0) > usage.outputTokens
  )
    throw new BillingError("Invalid reported model usage", 502);
  return Math.ceil(
    (usage.inputTokens - cached) * rate.inputMicrosPerToken +
      cached * rate.cachedInputMicrosPerToken +
      usage.outputTokens * rate.outputMicrosPerToken,
  );
}

/**
 * The ceiling for a requested model. A Bot bound before the rename asks for
 * `@flock/…`; its own entry wins, and the `@frock/` one prices it otherwise.
 */
export function routeRateV1(
  table: HostedModelRatesV1,
  model: string,
): ModelRate | undefined {
  return Object.hasOwn(table.routes, model)
    ? table.routes[model]
    : Object.hasOwn(table.routes, normalizeFrockModelIdV1(model))
      ? table.routes[normalizeFrockModelIdV1(model)]
      : undefined;
}

export function servedRateV1(
  table: HostedModelRatesV1,
  servedModel: string,
): ServedModelRateV1 | undefined {
  return Object.hasOwn(table.served, servedModel)
    ? table.served[servedModel]
    : undefined;
}

/**
 * Each route's bounds, which the Gateway holds a request for that route to, so
 * no request can outgrow the reservation its route took for it.
 */
export function hostedModelLimitsV1(
  table: HostedModelRatesV1,
): Record<string, { inputTokens: number; outputTokens: number }> {
  return Object.fromEntries(
    Object.entries(table.routes).map(([model, rate]) => [
      model,
      {
        inputTokens: rate.maximumInputTokens,
        outputTokens: rate.maximumOutputTokens,
      },
    ]),
  );
}

// --- Decoding ------------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !expected.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${label} has an unknown field "${unknown}"`);
  }
  const missing = expected.find((key) => !keys.includes(key));
  if (missing !== undefined) {
    throw new Error(`${label} is missing "${missing}"`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** A model id as a table key: printable, no whitespace, bounded. */
function modelKey(key: string, label: string): string {
  if (!/^[\x21-\x7e]{1,300}$/.test(key)) {
    throw new Error(`${label} is not a usable model id`);
  }
  return key;
}

function version(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new Error(`${label} is invalid`);
  }
  return timestamp;
}

/** Fractions of a micro-dollar are ordinary: US$0.006 per million is 0.006. */
function micros(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > RATE_LIMIT
  ) {
    throw new Error(`${label} must be a number from 0 to ${RATE_LIMIT}`);
  }
  return value;
}

function tokens(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a whole number of tokens above 0`);
  }
  return value as number;
}

function servedRate(value: unknown, label: string): ServedModelRateV1 {
  const rate = record(value, label);
  exactKeys(
    rate,
    [
      "inputMicrosPerToken",
      "cachedInputMicrosPerToken",
      "outputMicrosPerToken",
    ],
    label,
  );
  const decoded = {
    inputMicrosPerToken: micros(
      rate.inputMicrosPerToken,
      `${label}.inputMicrosPerToken`,
    ),
    cachedInputMicrosPerToken: micros(
      rate.cachedInputMicrosPerToken,
      `${label}.cachedInputMicrosPerToken`,
    ),
    outputMicrosPerToken: micros(
      rate.outputMicrosPerToken,
      `${label}.outputMicrosPerToken`,
    ),
  };
  if (decoded.cachedInputMicrosPerToken > decoded.inputMicrosPerToken) {
    throw new Error(`${label} prices cached input above uncached input`);
  }
  return decoded;
}

function routeRate(value: unknown, label: string): ModelRate {
  const rate = record(value, label);
  exactKeys(
    rate,
    [
      "inputMicrosPerToken",
      "cachedInputMicrosPerToken",
      "outputMicrosPerToken",
      "maximumInputTokens",
      "maximumOutputTokens",
    ],
    label,
  );
  const decoded: ModelRate = {
    ...servedRate(
      {
        inputMicrosPerToken: rate.inputMicrosPerToken,
        cachedInputMicrosPerToken: rate.cachedInputMicrosPerToken,
        outputMicrosPerToken: rate.outputMicrosPerToken,
      },
      label,
    ),
    maximumInputTokens: tokens(
      rate.maximumInputTokens,
      `${label}.maximumInputTokens`,
    ),
    maximumOutputTokens: tokens(
      rate.maximumOutputTokens,
      `${label}.maximumOutputTokens`,
    ),
  };
  if (
    modelCost(
      {
        inputTokens: decoded.maximumInputTokens,
        outputTokens: decoded.maximumOutputTokens,
      },
      decoded,
    ) > MAXIMUM_DISPATCH_COST_MICROS
  ) {
    throw new Error(`${label} would reserve more than one dispatch may`);
  }
  return decoded;
}

function entries<T>(
  value: unknown,
  label: string,
  decode: (value: unknown, label: string) => T,
): Record<string, T> {
  const table = record(value, label);
  const keys = Object.keys(table);
  if (keys.length > ENTRY_LIMIT) {
    throw new Error(`${label} has more than ${ENTRY_LIMIT} entries`);
  }
  const decoded: Record<string, T> = {};
  for (const key of keys.toSorted()) {
    const entry = `${label}["${key}"]`;
    decoded[modelKey(key, entry)] = decode(table[key], entry);
  }
  return decoded;
}

function routes(value: unknown, label: string): Record<string, ModelRate> {
  const decoded = entries(value, label, routeRate);
  if (Object.keys(decoded).length === 0) {
    throw new Error(`${label} must price at least one model`);
  }
  return decoded;
}

function served(
  value: unknown,
  label: string,
): Record<string, ServedModelRateV1> {
  const decoded = entries(value, label, servedRate);
  for (const key of Object.keys(decoded)) {
    // The Gateway names a provider and a model; a key without both parts can
    // never match what it answers with.
    if (!/^[^/]+\/.+$/.test(key)) {
      throw new Error(`${label}["${key}"] must be "<provider>/<model>"`);
    }
  }
  return decoded;
}

export function decodeHostedModelRatesV1(
  input: unknown,
  label = "hosted model rates",
): HostedModelRatesV1 {
  const table = record(input, label);
  exactKeys(
    table,
    ["schemaVersion", "version", "createdAt", "createdBy", "routes", "served"],
    label,
  );
  if (table.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  return {
    schemaVersion: 1,
    version: version(table.version, `${label}.version`),
    createdAt: isoTimestamp(table.createdAt, `${label}.createdAt`),
    createdBy: boundedString(table.createdBy, `${label}.createdBy`, 512),
    routes: routes(table.routes, `${label}.routes`),
    served: served(table.served, `${label}.served`),
  };
}

export function decodeSaveHostedModelRatesCommandV1(
  input: unknown,
): SaveHostedModelRatesCommandV1 {
  const label = "model rates";
  const command = record(input, label);
  exactKeys(
    command,
    ["schemaVersion", "type", "baseVersion", "routes", "served"],
    label,
  );
  if (command.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  if (command.type !== "deployment/save-model-rates") {
    throw new Error(`${label}.type is invalid`);
  }
  const decoded: SaveHostedModelRatesCommandV1 = {
    schemaVersion: 1,
    type: "deployment/save-model-rates",
    baseVersion: version(command.baseVersion, `${label}.baseVersion`),
    routes: routes(command.routes, "routes"),
    served: served(command.served, "served"),
  };
  // The platform picks both of these, whatever a Bot chose, so a table without
  // either would refuse every billed Bot's reply or summary once saved.
  for (const [model, why] of [
    [FROCK_AI_DEFAULT_MODEL, "it is the model every Bot starts on"],
    [FROCK_AI_SUMMARY_MODEL, "every Bot's conversation summaries run on it"],
  ] as const) {
    if (!Object.hasOwn(decoded.routes, model)) {
      throw new Error(`routes must price "${model}": ${why}`);
    }
  }
  return decoded;
}

export function decodeSaveHostedModelRatesRequestV1(
  input: unknown,
): SaveHostedModelRatesRequestV1 {
  const request = record(input, "model rates request");
  exactKeys(
    request,
    ["schemaVersion", "command", "createdBy"],
    "model rates request",
  );
  if (request.schemaVersion !== 1) {
    throw new Error("model rates request.schemaVersion is invalid");
  }
  return {
    schemaVersion: 1,
    command: decodeSaveHostedModelRatesCommandV1(request.command),
    createdBy: boundedString(
      request.createdBy,
      "model rates request.createdBy",
      512,
    ),
  };
}

export function decodeModelRatesReadRequestV1(input: unknown): {
  schemaVersion: 1;
} {
  const request = record(input, "model rates read request");
  exactKeys(request, ["schemaVersion"], "model rates read request");
  if (request.schemaVersion !== 1) {
    throw new Error("model rates read request.schemaVersion is invalid");
  }
  return { schemaVersion: 1 };
}

function servedModelName(value: unknown, label: string): string | null {
  return value === null
    ? null
    : modelKey(boundedString(value, label, 300), label);
}

export function decodeReportUnpricedServedModelRequestV1(
  input: unknown,
): ReportUnpricedServedModelRequestV1 {
  const label = "unpriced model report";
  const report = record(input, label);
  exactKeys(
    report,
    ["schemaVersion", "servedModel", "route", "version"],
    label,
  );
  if (report.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  return {
    schemaVersion: 1,
    servedModel: servedModelName(report.servedModel, `${label}.servedModel`),
    route: modelKey(
      boundedString(report.route, `${label}.route`, 300),
      `${label}.route`,
    ),
    version: version(report.version, `${label}.version`),
  };
}

export function decodeUnpricedServedModelV1(
  input: unknown,
): UnpricedServedModelV1 {
  const label = "unpriced model";
  const report = record(input, label);
  exactKeys(
    report,
    [
      "schemaVersion",
      "servedModel",
      "route",
      "version",
      "firstSeenAt",
      "lastSeenAt",
    ],
    label,
  );
  if (report.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  return {
    schemaVersion: 1,
    servedModel: servedModelName(report.servedModel, `${label}.servedModel`),
    route: modelKey(
      boundedString(report.route, `${label}.route`, 300),
      `${label}.route`,
    ),
    version: version(report.version, `${label}.version`),
    firstSeenAt: isoTimestamp(report.firstSeenAt, `${label}.firstSeenAt`),
    lastSeenAt: isoTimestamp(report.lastSeenAt, `${label}.lastSeenAt`),
  };
}

export function decodeHostedModelRatesViewV1(
  input: unknown,
): HostedModelRatesViewV1 {
  const label = "model rates view";
  const view = record(input, label);
  exactKeys(view, ["schemaVersion", "current", "history", "unpriced"], label);
  if (view.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  if (!Array.isArray(view.history) || !Array.isArray(view.unpriced)) {
    throw new Error(`${label} lists are invalid`);
  }
  return {
    schemaVersion: 1,
    current: decodeHostedModelRatesV1(view.current, `${label}.current`),
    history: view.history.map((entry, index) =>
      decodeHostedModelRatesV1(entry, `${label}.history[${index}]`),
    ),
    unpriced: view.unpriced.map(decodeUnpricedServedModelV1),
  };
}

/**
 * A lost compare-and-swap on the table, carried as its name and the version
 * the next attempt must read; the admin operations match on both.
 */
export class ModelRatesConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`hosted model rates are at version ${currentRevision}`);
    this.name = "ModelRatesConflictError";
    this.currentRevision = currentRevision;
  }
}
