// Disposable pre-user cleanup for ADR 0034: Applets are deleted.
//
// There are no Users yet. Directory entries, Composition `applets[]`, the
// account feature flag, cleanup to-dos and the Bot's focused-Applet pointer
// are dropped rather than migrated. A receipt makes a second load free. The
// key strings are restated here so this file does not import the Applet
// product it is deleting.
import { COMPOSITION_GENERATION_PREFIX } from "@frockbot/core/durable";

export const PLUGIN_PANELS_USER_CLEANUP_RECEIPT_KEY =
  "maintenance:plugin-panels:2026-09-21";
export const PLUGIN_PANELS_BOT_CLEANUP_RECEIPT_KEY =
  "maintenance:plugin-panels:2026-09-21";

const USER_FEATURES_KEY = "user:features:v1";
const APPLET_DIRECTORY_ENTRY_PREFIX = "applets:entry:";
const APPLET_DIRECTORY_REVISION_KEY = "applets:directory-revision";
const APPLET_CLEANUP_PREFIX = "applets:cleanup:";
const APPLET_FOCUSED_KEY = "applets:focused";

export async function cleanUserAppletsV1(
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(PLUGIN_PANELS_USER_CLEANUP_RECEIPT_KEY)) return;
  const at = now.toISOString();
  let removedEntries = 0;
  let removedCleanups = 0;
  let strippedGenerations = 0;
  let strippedFeatures = false;
  let removedRevision = false;

  await storage.transaction(async (tx) => {
    if (await tx.get(PLUGIN_PANELS_USER_CLEANUP_RECEIPT_KEY)) return;
    const entryKeys = [
      ...(await tx.list({ prefix: APPLET_DIRECTORY_ENTRY_PREFIX })).keys(),
    ];
    if (entryKeys.length > 0) {
      removedEntries = await tx.delete(entryKeys);
    }
    const cleanupKeys = [
      ...(await tx.list({ prefix: APPLET_CLEANUP_PREFIX })).keys(),
    ];
    if (cleanupKeys.length > 0) {
      removedCleanups = await tx.delete(cleanupKeys);
    }
    if ((await tx.get(APPLET_DIRECTORY_REVISION_KEY)) !== undefined) {
      await tx.delete(APPLET_DIRECTORY_REVISION_KEY);
      removedRevision = true;
    }
    for (const [key, value] of await tx.list<unknown>({
      prefix: COMPOSITION_GENERATION_PREFIX,
    })) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (!Object.hasOwn(value, "applets")) continue;
      const { applets: _dropped, ...rest } = value as Record<string, unknown>;
      await tx.put(key, rest);
      strippedGenerations += 1;
    }
    const features = await tx.get<unknown>(USER_FEATURES_KEY);
    if (
      features &&
      typeof features === "object" &&
      !Array.isArray(features) &&
      Object.hasOwn(features, "applets")
    ) {
      const { applets: _dropped, ...rest } = features as Record<
        string,
        unknown
      >;
      await tx.put(USER_FEATURES_KEY, rest);
      strippedFeatures = true;
    }
    await tx.put(PLUGIN_PANELS_USER_CLEANUP_RECEIPT_KEY, {
      schemaVersion: 1,
      at,
      removedEntries,
      removedCleanups,
      strippedGenerations,
      strippedFeatures,
      removedRevision,
    });
  });
}

export async function cleanBotAppletsV1(
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(PLUGIN_PANELS_BOT_CLEANUP_RECEIPT_KEY)) return;
  await storage.transaction(async (tx) => {
    if (await tx.get(PLUGIN_PANELS_BOT_CLEANUP_RECEIPT_KEY)) return;
    const hadFocus = (await tx.get(APPLET_FOCUSED_KEY)) !== undefined;
    if (hadFocus) await tx.delete(APPLET_FOCUSED_KEY);
    await tx.put(PLUGIN_PANELS_BOT_CLEANUP_RECEIPT_KEY, {
      schemaVersion: 1,
      at: now.toISOString(),
      clearedFocus: hadFocus,
    });
  });
}
