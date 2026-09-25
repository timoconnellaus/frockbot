// Disposable cleanup for the retired sidebar label.
//
// A Bot's profile no longer has a `label`, and its exact decoder refuses one.
// The Bot's settings record loses it, with the revision moved so an open
// settings surface fences on the record it now reads. Every run keeps the
// settings it was admitted under twice — the configuration snapshot and the
// prepared inputs — and both are decoded whenever the run is read, so each
// loses the label too. A Group Chat's arrangement had the same label; the
// User's group list and the receipts that replay a group record lose it, and
// the list's revision moves. The walks are once per object, and page rather
// than loading the archive into one value.

import { BOT_CONFIGURATION_KEY } from "@frockbot/app/settings/bot";
import { RUN_PREFIX } from "@frockbot/core/durable";

const BOT_RECEIPT = "maintenance:bot-label-removal:2026-09-25";
const USER_RECEIPT = "maintenance:group-label-removal:2026-09-25";
const GROUP_LIST_KEY = "group-chat:list:v1";
const GROUP_RECEIPT_PREFIX = "group-chat:receipt:";
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

/** `value` with `label` gone from the record at `path`, or undefined. */
function withoutLabelAt(value: unknown, path: readonly string[]): unknown {
  const outer = record(value);
  if (!outer) return undefined;
  if (path.length === 0) {
    if (!Object.hasOwn(outer, "label")) return undefined;
    const { label: _retired, ...rest } = outer;
    return rest;
  }
  const [head, ...tail] = path as [string, ...string[]];
  const inner = withoutLabelAt(outer[head], tail);
  return inner === undefined ? undefined : { ...outer, [head]: inner };
}

/** Applies each path in turn; undefined when none of them carried a label. */
function withoutLabels(
  value: unknown,
  paths: readonly (readonly string[])[],
): unknown {
  let current = value;
  let changed = false;
  for (const path of paths) {
    const next = withoutLabelAt(current, path);
    if (next === undefined) continue;
    current = next;
    changed = true;
  }
  return changed ? current : undefined;
}

const RUN_SETTINGS_PATHS = [
  ["configurationSnapshot", "profile"],
  ["preparedInputs", "bot", "settings", "profile"],
] as const;

export async function cleanBotLabelV1(storage: CleanupStorage): Promise<void> {
  if (await storage.get(BOT_RECEIPT)) return;
  let settings = false;
  const stored = record(await storage.get(BOT_CONFIGURATION_KEY));
  const cleaned = record(withoutLabelAt(stored, ["profile"]));
  if (stored && cleaned && typeof stored.revision === "number") {
    await storage.put(BOT_CONFIGURATION_KEY, {
      ...cleaned,
      revision: stored.revision + 1,
    });
    settings = true;
  }
  let runs = 0;
  await page(storage, RUN_PREFIX, async (key, value) => {
    const run = withoutLabels(value, RUN_SETTINGS_PATHS);
    if (run === undefined) return;
    runs += 1;
    await storage.put(key, run);
  });
  await storage.put(BOT_RECEIPT, {
    schemaVersion: 1,
    settings,
    runs,
    completedAt: new Date().toISOString(),
  });
}

const GROUP_RECEIPT_PATHS = [
  ["result", "receipt", "group"],
  ["result", "change", "context", "group"],
] as const;

export async function cleanGroupChatLabelsV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(USER_RECEIPT)) return;
  let groups = 0;
  const list = record(await storage.get(GROUP_LIST_KEY));
  if (list && Array.isArray(list.groups) && typeof list.revision === "number") {
    const arranged = list.groups.map((group) => {
      const cleaned = withoutLabelAt(group, []);
      if (cleaned === undefined) return group;
      groups += 1;
      return cleaned;
    });
    if (groups > 0) {
      await storage.put(GROUP_LIST_KEY, {
        ...list,
        revision: list.revision + 1,
        groups: arranged,
      });
    }
  }
  let receipts = 0;
  await page(storage, GROUP_RECEIPT_PREFIX, async (key, value) => {
    const receipt = withoutLabels(value, GROUP_RECEIPT_PATHS);
    if (receipt === undefined) return;
    receipts += 1;
    await storage.put(key, receipt);
  });
  await storage.put(USER_RECEIPT, {
    schemaVersion: 1,
    groups,
    receipts,
    completedAt: new Date().toISOString(),
  });
}
