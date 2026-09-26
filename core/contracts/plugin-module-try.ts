// Trying a Plugin's device module before it reaches a desktop (ADR 0037).
//
// A module runs on the person's Mac, where a Bot sees it only through
// `plugin_module_reports`, after a publish and an approval. So the Bot runs it
// on its own Computer first: under Deno, with the flags its declaration
// generates, served by a small stand-in for the desktop's host. The runner
// and the module runtime are the desktop's own code, bundled from
// `apps/device-host` into `plugin-module-try.generated.ts`, and travel with
// each try, so they are always this release's.

import type { PluginDeviceModuleV1 } from "./plugin-descriptor.js";

/** How long a call may take, or an event may take to arrive. */
export const PLUGIN_MODULE_TRY_WAIT_DEFAULT_MS_V1 = 10_000;
export const PLUGIN_MODULE_TRY_WAIT_MAX_MS_V1 = 30_000;
/** What the module may take to start, on top of the wait. */
export const PLUGIN_MODULE_TRY_START_MS_V1 = 15_000;
/** The seeded store and the stand-in keys, as JSON. */
export const PLUGIN_MODULE_TRY_SEED_MAX_BYTES_V1 = 16 * 1_024;

/**
 * The Deno the Computer runs a module under: the version the Mac app ships
 * (`scripts/fetch-deno.py`), for Linux, checked by hash when a Computer first
 * fetches it.
 */
export const PLUGIN_MODULE_TRY_DENO_V1 = {
  version: "2.9.7",
  sha256: {
    "x86_64-unknown-linux-gnu":
      "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490",
    "aarch64-unknown-linux-gnu":
      "c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf",
  },
} as const;

/** One call with its input, or one event the module's `start` should emit. */
export type PluginModuleTryActionV1 =
  { call: string; input: unknown } | { event: string };

/** What the runner is handed on the Computer, as `request.json`. */
export interface PluginModuleTryRequestV1 {
  module: Pick<
    PluginDeviceModuleV1,
    "id" | "read" | "net" | "appleEvents" | "calls" | "events"
  >;
  /** The module's built code. */
  code: string;
  action: PluginModuleTryActionV1;
  waitMs: number;
  /** What the module may take to start, on top of `waitMs`. */
  startMs: number;
  /** What `lastKey(event)` answers, by event. */
  lastKeys: Record<string, string>;
  /** What the module's store holds when it starts. */
  store: Record<string, unknown>;
}

/** What the runner prints: one JSON line. */
export interface PluginModuleTryResultV1 {
  /** The call's answer; absent when an event was played. */
  call?: { ok: true; value: unknown } | { ok: false; error: string };
  /** Whether the event asked for was emitted in time; absent for a call. */
  heard?: boolean;
  events: { event: string; key: string; payload: unknown }[];
  logs: { level: "log" | "error"; text: string }[];
  /** Each access Deno refused, as it said it: `read "/etc/hosts"`. */
  denials: string[];
  /** The module's process ended on its own: how, with its last stderr. */
  exited?: string;
  /** What had to be cut to fit the result into one line. */
  trimmed?: string[];
}

export class PluginModuleTryDecodeError extends Error {}

function fail(message: string): never {
  throw new PluginModuleTryDecodeError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    fail(`${field} must be a name`);
  }
  return value;
}

/** A Bot's try, checked before anything is built or any Computer woken. */
export function decodePluginModuleTryInputV1(input: unknown): {
  pluginId: string;
  moduleId?: string;
  action: PluginModuleTryActionV1;
  waitMs: number;
  lastKeys: Record<string, string>;
  store: Record<string, unknown>;
} {
  if (!record(input)) fail("the input must be an object");
  const pluginId = name(input.pluginId, "pluginId");
  const moduleId =
    input.moduleId === undefined ? undefined : name(input.moduleId, "moduleId");
  const hasCall = input.call !== undefined;
  const hasEvent = input.event !== undefined;
  if (hasCall === hasEvent) {
    fail("name exactly one of call (with its input) or event");
  }
  if (!hasCall && input.input !== undefined) {
    fail("input goes with a call, not an event");
  }
  const action: PluginModuleTryActionV1 = hasCall
    ? { call: name(input.call, "call"), input: input.input ?? null }
    : { event: name(input.event, "event") };
  const waitMs = input.waitMs ?? PLUGIN_MODULE_TRY_WAIT_DEFAULT_MS_V1;
  if (
    typeof waitMs !== "number" ||
    !Number.isInteger(waitMs) ||
    waitMs < 100 ||
    waitMs > PLUGIN_MODULE_TRY_WAIT_MAX_MS_V1
  ) {
    fail(`waitMs must be 100 to ${PLUGIN_MODULE_TRY_WAIT_MAX_MS_V1}`);
  }
  const lastKeys = input.lastKeys ?? {};
  if (
    !record(lastKeys) ||
    !Object.values(lastKeys).every((key) => typeof key === "string")
  ) {
    fail("lastKeys maps an event to the key lastKey answers for it");
  }
  const store = input.store ?? {};
  if (!record(store)) fail("store must be an object");
  const seeded = JSON.stringify({ lastKeys, store, input: input.input });
  if (
    new TextEncoder().encode(seeded).byteLength >
    PLUGIN_MODULE_TRY_SEED_MAX_BYTES_V1
  ) {
    fail(
      `input, lastKeys and store together must be under ${PLUGIN_MODULE_TRY_SEED_MAX_BYTES_V1} bytes`,
    );
  }
  return {
    pluginId,
    ...(moduleId === undefined ? {} : { moduleId }),
    action,
    waitMs,
    lastKeys: lastKeys as Record<string, string>,
    store,
  };
}
