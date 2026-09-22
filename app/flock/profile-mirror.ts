// The directory's current name is derived from the Bot's settings. The two
// objects cannot commit together, so the Bot stores one coalesced mirror and
// the User applies it only when it is newer than the registration it already
// holds. A queued mirror is not a cross-object atomic update.

import type { BotProfile } from "@frockbot/core/configuration";
import {
  decodeBotDirectoryProfileV1,
  type BotDirectoryProfileV1,
  type BotDirectoryViewV1,
} from "./shared.js";

/** One pending mirror per Bot. A later profile write replaces it. */
export const PROFILE_MIRROR_KEY_V1 = "flock:profile-mirror:v1";

/** How long a failed delivery waits before the Bot's existing alarm retries. */
export const PROFILE_MIRROR_RETRY_MS_V1 = 5_000;

export interface PendingProfileMirrorV1 {
  schemaVersion: 1;
  name: string;
  description?: string;
  sourceRevision: number;
  dueAt: number;
}

interface MirrorStoreV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

function directoryProfileFromPending(
  pending: PendingProfileMirrorV1,
): BotDirectoryProfileV1 {
  return {
    name: pending.name,
    ...(pending.description ? { description: pending.description } : {}),
    sourceRevision: pending.sourceRevision,
  };
}

export function directoryProfileFromBotProfileV1(
  profile: Pick<BotProfile, "name" | "description">,
  sourceRevision: number,
): BotDirectoryProfileV1 {
  return decodeBotDirectoryProfileV1({
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    sourceRevision,
  });
}

export function profileProjectionChangedV1(
  before: Pick<BotProfile, "name" | "description">,
  after: Pick<BotProfile, "name" | "description">,
): boolean {
  return (
    before.name !== after.name ||
    (before.description ?? "") !== (after.description ?? "")
  );
}

function decodePending(stored: unknown): PendingProfileMirrorV1 | undefined {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  const value = stored as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "name",
    "description",
    "sourceRevision",
    "dueAt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Object.hasOwn(value, "name") ||
    !Object.hasOwn(value, "sourceRevision") ||
    !Object.hasOwn(value, "dueAt") ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    return undefined;
  }
  if (typeof value.dueAt !== "number" || !Number.isFinite(value.dueAt)) {
    return undefined;
  }
  try {
    const profile = decodeBotDirectoryProfileV1({
      name: value.name,
      ...(value.description === undefined
        ? {}
        : { description: value.description }),
      sourceRevision: value.sourceRevision,
    });
    return {
      schemaVersion: 1,
      name: profile.name,
      ...(profile.description ? { description: profile.description } : {}),
      sourceRevision: profile.sourceRevision,
      dueAt: value.dueAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Replaces the pending mirror with this profile when it is at least as new.
 * An older retry of a command that already lost the race does not put the
 * previous name back into the queue.
 */
export async function queueProfileMirrorV1(
  storage: MirrorStoreV1,
  profile: BotDirectoryProfileV1,
  now: number,
): Promise<void> {
  const existing = decodePending(await storage.get(PROFILE_MIRROR_KEY_V1));
  if (existing && existing.sourceRevision > profile.sourceRevision) return;
  const next: PendingProfileMirrorV1 = {
    schemaVersion: 1,
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    sourceRevision: profile.sourceRevision,
    dueAt: now,
  };
  if (
    existing &&
    existing.sourceRevision === next.sourceRevision &&
    existing.name === next.name &&
    existing.description === next.description &&
    existing.dueAt <= now
  ) {
    return;
  }
  await storage.put(PROFILE_MIRROR_KEY_V1, next);
}

/** The Bot alarm fires at `dueAt` while a mirror is still owed. */
export async function profileMirrorDeadlineV1(storage: {
  get<T>(key: string): Promise<T | undefined>;
}): Promise<number[]> {
  const pending = decodePending(await storage.get(PROFILE_MIRROR_KEY_V1));
  return pending ? [pending.dueAt] : [];
}

export interface DeliverProfileMirrorV1 {
  storage: MirrorStoreV1 & {
    transaction<T>(
      callback: (storage: MirrorStoreV1) => Promise<T>,
    ): Promise<T>;
  };
  now: number;
  botId: string;
  mirror: (profile: BotDirectoryProfileV1) => Promise<BotDirectoryViewV1>;
  refreshAlarm: (storage: MirrorStoreV1) => Promise<void>;
}

/**
 * Delivers the pending mirror outside the settings transaction.
 *
 * Failure leaves the record and moves its deadline forward. Success clears it
 * only when the queued revision is still the one that was sent, so a rename
 * committed during the call is not dropped. A directory that no longer lists
 * the Bot clears the mirror too: delivery must not keep retrying a deletion.
 */
export async function deliverProfileMirrorV1(
  input: DeliverProfileMirrorV1,
): Promise<"idle" | "delivered" | "retry"> {
  const pending = decodePending(await input.storage.get(PROFILE_MIRROR_KEY_V1));
  if (!pending || pending.dueAt > input.now) return "idle";
  const profile = directoryProfileFromPending(pending);
  let directory: BotDirectoryViewV1;
  try {
    directory = await input.mirror(profile);
  } catch {
    await reschedule(input, pending.sourceRevision, input.now);
    return "retry";
  }
  await input.storage.transaction(async (storage) => {
    const current = decodePending(await storage.get(PROFILE_MIRROR_KEY_V1));
    if (!current || current.sourceRevision !== pending.sourceRevision) return;
    const entry = directory.bots.find((bot) => bot.botId === input.botId);
    const applied = entry?.currentProfile?.sourceRevision;
    if (!entry || (applied ?? -1) >= pending.sourceRevision) {
      await storage.delete(PROFILE_MIRROR_KEY_V1);
    } else {
      await storage.put(PROFILE_MIRROR_KEY_V1, {
        ...current,
        dueAt: input.now + PROFILE_MIRROR_RETRY_MS_V1,
      } satisfies PendingProfileMirrorV1);
    }
    await input.refreshAlarm(storage);
  });
  return "delivered";
}

async function reschedule(
  input: DeliverProfileMirrorV1,
  sourceRevision: number,
  now: number,
): Promise<void> {
  await input.storage.transaction(async (storage) => {
    const current = decodePending(await storage.get(PROFILE_MIRROR_KEY_V1));
    if (!current || current.sourceRevision !== sourceRevision) return;
    await storage.put(PROFILE_MIRROR_KEY_V1, {
      ...current,
      dueAt: now + PROFILE_MIRROR_RETRY_MS_V1,
    } satisfies PendingProfileMirrorV1);
    await input.refreshAlarm(storage);
  });
}
