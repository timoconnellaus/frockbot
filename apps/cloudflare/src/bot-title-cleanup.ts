// Disposable cleanup for the retired Bot title.
//
// A Bot's profile no longer has a `title`, and its exact decoder refuses one.
// The Bot's settings record loses it, with the revision moved so an open
// settings surface fences on the record it now reads. Every run keeps the
// settings it was admitted under twice — the configuration snapshot and the
// prepared inputs — and both are decoded whenever the run is read, so each
// loses the title too. The run walk pages rather than loading the archive
// into one value, and the receipt makes a second load free.

import { BOT_CONFIGURATION_KEY } from "@frockbot/app/settings/bot";
import { RUN_PREFIX } from "@frockbot/core/durable";

const RECEIPT = "maintenance:bot-title-removal:2026-09-25";
const PAGE = 50;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  list(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

type Plain = Record<string, unknown>;

function record(value: unknown): Plain | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Plain;
}

/** `value` with `title` gone from the profile at `path`, or undefined. */
function withoutTitleAt(value: unknown, path: readonly string[]): unknown {
  const outer = record(value);
  if (!outer) return undefined;
  if (path.length === 0) {
    if (!Object.hasOwn(outer, "title")) return undefined;
    const { title: _retired, ...rest } = outer;
    return rest;
  }
  const [head, ...tail] = path as [string, ...string[]];
  const inner = withoutTitleAt(outer[head], tail);
  return inner === undefined ? undefined : { ...outer, [head]: inner };
}

const RUN_SETTINGS_PATHS = [
  ["configurationSnapshot", "profile"],
  ["preparedInputs", "bot", "settings", "profile"],
] as const;

/** The run without either copy of the title; undefined when it had none. */
function runWithoutTitle(value: unknown): unknown {
  let current = value;
  let changed = false;
  for (const path of RUN_SETTINGS_PATHS) {
    const next = withoutTitleAt(current, path);
    if (next === undefined) continue;
    current = next;
    changed = true;
  }
  return changed ? current : undefined;
}

export async function cleanBotTitleV1(storage: CleanupStorage): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let settings = false;
  const stored = record(await storage.get(BOT_CONFIGURATION_KEY));
  const cleaned = record(withoutTitleAt(stored, ["profile"]));
  if (stored && cleaned && typeof stored.revision === "number") {
    await storage.put(BOT_CONFIGURATION_KEY, {
      ...cleaned,
      revision: stored.revision + 1,
    });
    settings = true;
  }
  let runs = 0;
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix: RUN_PREFIX,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    let last = "";
    for (const [key, value] of listed) {
      last = key;
      const run = runWithoutTitle(value);
      if (run === undefined) continue;
      runs += 1;
      await storage.put(key, run);
    }
    if (listed.size < PAGE) break;
    start = `${last}\0`;
  }
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    settings,
    runs,
    completedAt: new Date().toISOString(),
  });
}
