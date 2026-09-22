import { describe, expect, test } from "bun:test";
import type { WorkspaceGenerationV1 } from "@frockbot/core/contracts";
import { sha256HexBytesV1 } from "@frockbot/core/crypto";
import { skillCatalogFromIndexV1 } from "./catalog.js";
import {
  beginSkillIndexPublicationV1,
  commitSkillDeletionV1,
  commitSkillDocumentV1,
  decodeSkillMetadataIndexV1,
  emptySkillMetadataIndexV1,
  skillBodyKeyV1,
  tombstoneSkillIndexV1,
} from "./metadata-index.js";
import {
  holdSkillIndexRevisionsV1,
  releaseSkillIndexHoldV1,
  releaseUnreferencedSkillSnapshotsV1,
  type SkillBodyStoreV1,
  type SkillIndexStorageV1,
} from "./index-store.js";
import {
  skillIndexCurrentKeyV1,
  skillIndexSnapshotKeyV1,
} from "@frockbot/core/durable";
import { workspaceRootKeyV1 } from "@frockbot/core/contracts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const ROOT = {
  kind: "bot-instructions" as const,
  userId: "user-1",
  botId: "bot-1",
};
const WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "session",
  turnId: "turn",
  runId: "run",
};

function generation(
  id: string,
  bytes: Uint8Array,
  hash: string,
): WorkspaceGenerationV1 {
  return {
    schemaVersion: 1,
    generationId: id,
    contentHash: hash,
    size: bytes.byteLength,
    writer: WRITER,
    writtenAt: "2026-09-22T00:00:00.000Z",
  };
}

const TEXT = (body: string) =>
  new TextEncoder().encode(
    `---\nname: Roster\ndescription: Use this when rostering.\n---\n\n${body}\n`,
  );

describe("skill index publication", () => {
  test("a failed generation record drops the previous entry", async () => {
    const firstBytes = TEXT("first");
    const firstHash = await sha256HexBytesV1(firstBytes);
    let index = emptySkillMetadataIndexV1();
    index = await beginSkillIndexPublicationV1(
      index,
      "skills/roster/SKILL.md",
      "g1",
      false,
    );
    index = await commitSkillDocumentV1(
      index,
      ROOT,
      "skills/roster/SKILL.md",
      generation("g1", firstBytes, firstHash),
      firstBytes,
    );
    expect(index.entries).toHaveLength(1);
    const trusted = index.revision;

    index = await beginSkillIndexPublicationV1(
      index,
      "skills/roster/SKILL.md",
      "g2",
      true,
    );
    expect(index.entries).toHaveLength(0);
    expect(index.pending.map((item) => item.reason)).toEqual(["ledger-failed"]);
    expect(index.revision).not.toBe(trusted);
    expect(index.status).toBe("rebuilding");
  });

  test("startup metadata does not include the body, and a later edit does not replace a pin", async () => {
    const firstBytes = TEXT("first instructions");
    const secondBytes = TEXT("second instructions");
    const firstHash = await sha256HexBytesV1(firstBytes);
    const secondHash = await sha256HexBytesV1(secondBytes);
    let admitted = emptySkillMetadataIndexV1();
    admitted = await beginSkillIndexPublicationV1(
      admitted,
      "skills/roster/SKILL.md",
      "g1",
      false,
    );
    admitted = await commitSkillDocumentV1(
      admitted,
      ROOT,
      "skills/roster/SKILL.md",
      generation("g1", firstBytes, firstHash),
      firstBytes,
    );
    let live = await beginSkillIndexPublicationV1(
      admitted,
      "skills/roster/SKILL.md",
      "g2",
      false,
    );
    live = await commitSkillDocumentV1(
      live,
      ROOT,
      "skills/roster/SKILL.md",
      generation("g2", secondBytes, secondHash),
      secondBytes,
    );
    const catalog = skillCatalogFromIndexV1(admitted, live, OWNER, "bot");
    expect(catalog.skills[0]?.body).toBe("");
    expect(catalog.skills[0]?.contentHash).toBe(firstHash);
    expect(catalog.skills[0]?.bodyKey).toBe(skillBodyKeyV1(firstHash));
    expect(catalog.refusals).toEqual([]);
  });

  test("removal and root deletion override a pin, and a malformed sibling does not", async () => {
    const good = TEXT("good");
    const bad = new TextEncoder().encode("not a skill");
    const goodHash = await sha256HexBytesV1(good);
    const badHash = await sha256HexBytesV1(bad);
    let index = emptySkillMetadataIndexV1();
    index = await commitSkillDocumentV1(
      await beginSkillIndexPublicationV1(
        index,
        "skills/roster/SKILL.md",
        "g1",
        false,
      ),
      ROOT,
      "skills/roster/SKILL.md",
      generation("g1", good, goodHash),
      good,
    );
    index = await commitSkillDocumentV1(
      await beginSkillIndexPublicationV1(
        index,
        "skills/broken/SKILL.md",
        "g2",
        false,
      ),
      ROOT,
      "skills/broken/SKILL.md",
      generation("g2", bad, badHash),
      bad,
    );
    const both = skillCatalogFromIndexV1(index, index, OWNER, "bot");
    expect(both.skills.map((skill) => skill.path)).toEqual([
      "skills/roster/SKILL.md",
    ]);
    expect(both.refusals.map((refusal) => refusal.kind)).toEqual(["malformed"]);

    const removed = await commitSkillDeletionV1(
      index,
      "skills/roster/SKILL.md",
    );
    const afterRemoval = skillCatalogFromIndexV1(index, removed, OWNER, "bot");
    expect(afterRemoval.skills).toEqual([]);
    expect(
      afterRemoval.refusals.some((refusal) =>
        refusal.reason.includes("removed"),
      ),
    ).toBe(true);

    const deleted = tombstoneSkillIndexV1(removed);
    const afterDelete = skillCatalogFromIndexV1(index, deleted, OWNER, "bot");
    expect(afterDelete.skills).toEqual([]);
    expect(afterDelete.refusals[0]?.reason).toContain("deleted");
  });

  test("releases snapshots nothing admitted still names", async () => {
    const bytes = TEXT("kept");
    const hash = await sha256HexBytesV1(bytes);
    const values = new Map<string, unknown>();
    const storage: SkillIndexStorageV1 = {
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
      list: async (options) => {
        const entries = [...values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        );
        return new Map(entries.slice(0, options.limit));
      },
    };
    const objects = new Map<string, Uint8Array>();
    const bodies: SkillBodyStoreV1 = {
      put: async (key, body) => {
        objects.set(key, body);
      },
      get: async (key) => objects.get(key),
      delete: async (key) => {
        objects.delete(key);
      },
    };
    const { beginDurableSkillPublicationV1, commitDurableSkillPublicationV1 } =
      await import("./index-store.js");
    await beginDurableSkillPublicationV1(
      storage,
      ROOT,
      "skills/roster/SKILL.md",
      "g1",
      false,
    );
    await commitDurableSkillPublicationV1(
      storage,
      bodies,
      ROOT,
      "skills/roster/SKILL.md",
      generation("g1", bytes, hash),
      bytes,
      false,
    );
    const current = decodeSkillMetadataIndexV1(
      await storage.get(skillIndexCurrentKeyV1(workspaceRootKeyV1(ROOT))),
    );
    await holdSkillIndexRevisionsV1(storage, "run-1", {
      botRevision: current.revision,
      userRevision: "",
    });
    const nextBytes = TEXT("next");
    const nextHash = await sha256HexBytesV1(nextBytes);
    await beginDurableSkillPublicationV1(
      storage,
      ROOT,
      "skills/roster/SKILL.md",
      "g2",
      false,
    );
    await commitDurableSkillPublicationV1(
      storage,
      bodies,
      ROOT,
      "skills/roster/SKILL.md",
      generation("g2", nextBytes, nextHash),
      nextBytes,
      false,
    );
    expect(
      await storage.get(
        skillIndexSnapshotKeyV1(workspaceRootKeyV1(ROOT), current.revision),
      ),
    ).toBeDefined();
    await releaseSkillIndexHoldV1(storage, "run-1");
    const dropped = await releaseUnreferencedSkillSnapshotsV1(
      storage,
      bodies,
      ROOT,
      new Set(),
    );
    expect(dropped).toContain(current.revision);
    expect(objects.has(skillBodyKeyV1(hash))).toBe(false);
    expect(objects.has(skillBodyKeyV1(nextHash))).toBe(true);
  });
});
