// Disposable cleanup for what Projects left in the User Durable Object.
//
// Group Chats replaced Projects. The Project catalogue and each Bot's joined
// list go, with the generation records of the Project Memory roots and their
// files in object storage. Memory kept a Project's facts in its shared
// `groupChat` scope under the Project's slug; a Group Chat's scope is keyed
// by the group's id, so every such scope not keyed by one is a Project's and
// is purged. Object storage is paged, so a large root finishes over several
// wakes; the receipt carries the cursor until it is done.

import { isGroupIdV1 } from "@frockbot/app/groups/shared";
import {
  WORKSPACE_CONFLICT_PREFIX,
  WORKSPACE_GENERATION_PREFIX,
} from "@frockbot/core/durable";
import { WORKSPACE_OBJECT_PREFIX } from "@frockbot/core/workspace-store";
import type { MemoryEngineV1 } from "@frockbot/app/memory/engine";
import { decodeMemoryScopeKeyV1 } from "@frockbot/app/memory/records";

const RECEIPT = "maintenance:project-removal:2026-09-23";
const RETIRED_KEY = "memory:projects";
const RETIRED_ROOT = "project-memory:";
const PAGE = 50;
const OBJECT_PAGES = 4;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: {
    prefix: string;
    limit: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

interface CleanupBucket {
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: string[]; cursor?: string; truncated: boolean }>;
  delete(key: string): Promise<void>;
}

async function deletePrefix(
  storage: CleanupStorage,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const listed = await storage.list({ prefix, limit: PAGE });
    for (const key of listed.keys()) {
      await storage.delete(key);
      deleted += 1;
    }
    if (listed.size < PAGE) return deleted;
  }
}

export async function cleanRetiredProjectsV1(
  storage: CleanupStorage,
  options: {
    userId?: string;
    bucket?: CleanupBucket;
    engine?: Pick<MemoryEngineV1, "scopeKeysOfKind" | "purgeScope">;
  },
): Promise<void> {
  const stored = await storage.get(RECEIPT);
  const receipt =
    stored && typeof stored === "object"
      ? (stored as { done?: boolean; cursor?: string })
      : undefined;
  if (receipt?.done) return;
  let keys = (await storage.delete(RETIRED_KEY)) ? 1 : 0;
  keys += await deletePrefix(storage, `${RETIRED_KEY}:`);
  keys += await deletePrefix(
    storage,
    `${WORKSPACE_GENERATION_PREFIX}${RETIRED_ROOT}`,
  );
  keys += await deletePrefix(
    storage,
    `${WORKSPACE_CONFLICT_PREFIX}${RETIRED_ROOT}`,
  );
  let scopes = 0;
  for (const scopeKey of options.engine?.scopeKeysOfKind("groupChat") ?? []) {
    if (isGroupIdV1(decodeMemoryScopeKeyV1(scopeKey).groupChatId)) continue;
    options.engine!.purgeScope(scopeKey);
    scopes += 1;
  }
  let cursor = receipt?.cursor;
  let objects = 0;
  let done = true;
  if (options.userId && options.bucket) {
    const prefix = `${WORKSPACE_OBJECT_PREFIX}/${RETIRED_ROOT}${encodeURIComponent(options.userId)}:`;
    done = false;
    for (let page = 0; page < OBJECT_PAGES; page += 1) {
      const listed = await options.bucket.list({
        prefix,
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const key of listed.keys) {
        if (!key.startsWith(prefix)) continue;
        await options.bucket.delete(key);
        objects += 1;
      }
      if (!listed.truncated) {
        done = true;
        break;
      }
      cursor = listed.cursor;
    }
  }
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    done,
    ...(done || !cursor ? {} : { cursor }),
    keys,
    scopes,
    objects,
  });
}
