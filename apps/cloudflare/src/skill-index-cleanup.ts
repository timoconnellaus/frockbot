// Drops Skill index records this process cannot decode.
//
// There is no legacy shape. A record that fails the current decoder is
// disposable test state, not something a Turn should try to interpret. The
// receipt makes the walk once per object. Reseeding the index from object
// bytes is separate and also receipted: startup never scans Skill files.

import { SKILL_INDEX_PREFIX } from "@frockbot/core/durable";
import { decodeSkillMetadataIndexV1 } from "@frockbot/app/skills/metadata-index";

const RECEIPT = "maintenance:skill-index-decode:2026-09-22";
const PAGE = 50;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

export async function cleanUndecodableSkillIndexesV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix: SKILL_INDEX_PREFIX,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    if (listed.size === 0) break;
    let last = "";
    for (const [key, value] of listed) {
      last = key;
      if (start !== undefined && key === start) continue;
      if (!key.includes(":current:") && !key.includes(":rev:")) continue;
      if (key.includes(":rev:")) continue;
      try {
        decodeSkillMetadataIndexV1(value);
      } catch {
        await storage.delete(key);
      }
    }
    if (listed.size < PAGE) break;
    start = `${last}\0`;
  }
  await storage.put(RECEIPT, { schemaVersion: 1 });
}
