// A Plugin's page using an ability on the person's device (ADR 0036).
//
// The client opened the microphone, never the cloud, so the client says so
// when the use ends: one row naming the Plugin, the ability, the device and
// how long. The Bot keeps the rows it recorded, because the audit table is a
// projection a rebuild must reproduce, and these rows come from no run.
import {
  PLUGIN_DEVICE_ABILITIES_V1,
  type PluginDeviceAbilityV1,
} from "@frockbot/core/contracts";
import { auditArgumentDigestV1 } from "./redact.js";
import {
  AUDIT_MAX_PREVIEW_LENGTH_V1,
  AUDIT_TARGET_DEVICE_PREFIX_V1,
  AuditDecodeError,
  decodeAuditEntryV1,
  type AuditEntryV1,
  type AuditOutcomeV1,
} from "./shared.js";
import type { AuditOutboxStorageV1 } from "./bot.js";

/** Why a use ended, as the host that ended it knows. */
export const DEVICE_USE_ENDINGS_V1 = [
  /** The person pressed Stop, or the page closed it. */
  "stopped",
  /** The page left the screen. */
  "left",
  /** The app went to the background. */
  "background",
  /** Dictation or a call took the microphone. */
  "taken",
  /** The capture failed while it was open. */
  "failed",
] as const;

export type DeviceUseEndingV1 = (typeof DEVICE_USE_ENDINGS_V1)[number];

/** One use, as the client reports it once it has ended. */
export interface DeviceUseV1 {
  /** Minted by the client when the use began; the row is keyed by it. */
  useId: string;
  pluginId: string;
  surfaceId: string;
  ability: PluginDeviceAbilityV1;
  /** What kind of device — `web`, `android`, `ios`, `macos` and the like. */
  device: string;
  startedAt: string;
  endedAt: string;
  ending: DeviceUseEndingV1;
}

const OUTCOMES: Record<DeviceUseEndingV1, AuditOutcomeV1> = {
  stopped: "ok",
  left: "ok",
  background: "ok",
  taken: "interrupted",
  failed: "error",
};

const USE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DEVICE = /^[a-z][a-z0-9-]{0,31}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Longer than anyone tunes; a longer claim is a clock that jumped. */
const MAX_USE_MS = 24 * 60 * 60 * 1_000;

function field(
  value: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const found = value[key];
  if (typeof found !== "string" || !pattern.test(found)) {
    throw new AuditDecodeError(`device use.${key} is invalid`);
  }
  return found;
}

export function decodeDeviceUseV1(input: unknown): DeviceUseV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuditDecodeError("device use must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "ability,device,endedAt,ending,pluginId,startedAt,surfaceId,useId"
  ) {
    throw new AuditDecodeError("device use has invalid fields");
  }
  const ability = PLUGIN_DEVICE_ABILITIES_V1.find(
    (candidate) => candidate === value.ability,
  );
  if (!ability) throw new AuditDecodeError("device use.ability is invalid");
  const ending = DEVICE_USE_ENDINGS_V1.find(
    (candidate) => candidate === value.ending,
  );
  if (!ending) throw new AuditDecodeError("device use.ending is invalid");
  const startedAt = field(value, "startedAt", INSTANT);
  const endedAt = field(value, "endedAt", INSTANT);
  const lasted = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(lasted) || lasted < 0 || lasted > MAX_USE_MS) {
    throw new AuditDecodeError("device use must end after it starts");
  }
  return {
    useId: field(value, "useId", USE_ID),
    pluginId: field(value, "pluginId", PLUGIN_ID),
    surfaceId: field(value, "surfaceId", SURFACE_ID),
    ability,
    device: field(value, "device", DEVICE),
    startedAt,
    endedAt,
    ending,
  };
}

/** The client's report: a use and the wire version it was written for. */
export function decodeDeviceUseCommandV1(input: unknown): DeviceUseV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuditDecodeError("device use must be an object");
  }
  const { schemaVersion, ...use } = input as Record<string, unknown>;
  if (schemaVersion !== 1) {
    throw new AuditDecodeError("device use.schemaVersion must be 1");
  }
  return decodeDeviceUseV1(use);
}

/**
 * The row one use becomes. The Plugin's name is read when the use is
 * recorded and kept on the row, so a rebuild says what was said then.
 */
export async function auditEntryForDeviceUseV1(
  botId: string,
  use: DeviceUseV1,
  displayName: string,
): Promise<AuditEntryV1> {
  const id = `device:${use.useId}`;
  return decodeAuditEntryV1({
    schemaVersion: 1,
    botId,
    runId: id,
    occurrenceId: id,
    turn: 0,
    step: 0,
    ordinal: 0,
    effectId: use.useId,
    at: use.startedAt,
    kind: "device",
    target: `${AUDIT_TARGET_DEVICE_PREFIX_V1}${use.device}`,
    toolName: use.ability,
    argumentDigest: await auditArgumentDigestV1({
      pluginId: use.pluginId,
      surfaceId: use.surfaceId,
      ability: use.ability,
      device: use.device,
      startedAt: use.startedAt,
      endedAt: use.endedAt,
    }),
    preview: `${displayName} used the ${use.ability}`.slice(
      0,
      AUDIT_MAX_PREVIEW_LENGTH_V1,
    ),
    outcome: OUTCOMES[use.ending],
    durationMs: Date.parse(use.endedAt) - Date.parse(use.startedAt),
  });
}

export const DEVICE_USE_LOG_KEY_V1 = "audit:device-uses";
/**
 * Where a rebuild goes after a Bot's device rows, which it is handed first on
 * a page of their own: the start of its runs. Run cursors are the run index's
 * own and never take this shape.
 */
export const DEVICE_USE_PAGE_DONE_V1 = "device-uses:done";
/** Newest kept; a Durable Object value stays well inside its size limit. */
export const DEVICE_USE_LOG_MAX_V1 = 100;

/**
 * The rows this Bot recorded for device uses, newest last: what a rebuild
 * re-projects beside its runs, since no run holds them.
 */
export class DeviceUseLogV1 {
  constructor(
    private readonly storage: AuditOutboxStorageV1,
    private readonly maximum = DEVICE_USE_LOG_MAX_V1,
  ) {}

  async entries(): Promise<AuditEntryV1[]> {
    const stored = await this.storage.get<unknown>(DEVICE_USE_LOG_KEY_V1);
    if (!Array.isArray(stored)) return [];
    return stored.map((entry) => decodeAuditEntryV1(entry));
  }

  /** Keeps one row; false when a retry already recorded it. */
  async record(entry: AuditEntryV1): Promise<boolean> {
    const entries = await this.entries();
    if (entries.some((kept) => kept.occurrenceId === entry.occurrenceId)) {
      return false;
    }
    entries.push(entry);
    await this.storage.put(
      DEVICE_USE_LOG_KEY_V1,
      entries.slice(Math.max(0, entries.length - this.maximum)),
    );
    return true;
  }
}
