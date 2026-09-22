// One bounded rebuild of a Skill index from the instruction root's objects.
//
// Ordinary startup does not call this. A release runs it once, behind a
// receipt, so disposable files that predate the index become metadata without
// a Turn walking them on every cold start. A walk that hits the page cap does
// not write the receipt: the index stays whatever the pages published, and the
// next release continues rather than claiming the root was finished.

import { decodeWorkspaceGenerationV1 } from "@frockbot/core/contracts";
import type { WorkspaceInstructionRootV1 } from "@frockbot/core/contracts";
import {
  WORKSPACE_GENERATION_METADATA_KEY,
  WORKSPACE_TOMBSTONE_METADATA_KEY,
  workspaceObjectPrefixV1,
  type ObjectBucketV1,
} from "@frockbot/core/workspace-store";
import { SKILL_MAX_LIST_PAGES, SKILL_LIST_PAGE_LIMIT } from "./catalog.js";
import {
  beginDurableSkillPublicationV1,
  commitDurableSkillPublicationV1,
  type SkillBodyStoreV1,
  type SkillIndexStorageV1,
} from "./index-store.js";
import { isSkillIndexPathV1 } from "./metadata-index.js";

function bodiesOf(bucket: ObjectBucketV1): SkillBodyStoreV1 {
  return {
    put: async (key, bytes) => {
      await bucket.put(key, bytes);
    },
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? object.bytes() : undefined;
    },
    delete: (key) => bucket.delete(key),
  };
}

export async function reseedInstructionRootV1(options: {
  storage: SkillIndexStorageV1;
  bucket: ObjectBucketV1;
  root: WorkspaceInstructionRootV1;
  receiptKey: string;
}): Promise<void> {
  if (await options.storage.get(options.receiptKey)) return;
  const bodies = bodiesOf(options.bucket);
  const prefix = `${workspaceObjectPrefixV1(options.root)}skills/`;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  for (;;) {
    pages += 1;
    if (pages > SKILL_MAX_LIST_PAGES) {
      truncated = true;
      break;
    }
    const page = await options.bucket.list({
      prefix,
      limit: SKILL_LIST_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      const relative = object.key.slice(
        workspaceObjectPrefixV1(options.root).length,
      );
      if (!isSkillIndexPathV1(relative)) continue;
      if (object.customMetadata?.[WORKSPACE_TOMBSTONE_METADATA_KEY]) continue;
      const encoded =
        object.customMetadata?.[WORKSPACE_GENERATION_METADATA_KEY];
      if (!encoded) continue;
      let generation;
      try {
        generation = decodeWorkspaceGenerationV1(JSON.parse(encoded));
      } catch {
        continue;
      }
      const body = await options.bucket.get(object.key);
      const bytes = body ? await body.bytes() : undefined;
      if (!bytes) continue;
      await beginDurableSkillPublicationV1(
        options.storage,
        options.root,
        relative,
        generation.generationId,
        false,
      );
      await commitDurableSkillPublicationV1(
        options.storage,
        bodies,
        options.root,
        relative,
        generation,
        bytes,
        false,
      );
    }
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  if (!truncated)
    await options.storage.put(options.receiptKey, { schemaVersion: 1 });
}
