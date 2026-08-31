// In-memory doubles for the two seams the store consumes.
//
// They exist so the store's behaviour can be proven without workerd — and so
// the Memory Package and the Computer-side sync can test against the same
// semantics the deployed R2 and Durable Object give them. They are fixtures,
// not a second implementation: the conditional-write rules and the generation
// ledger they model are the ones the store depends on, so a divergence here
// would be a bug in the double, not a difference in policy.
import {
  workspaceRootKeyV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import type {
  ObjectBodyV1,
  ObjectBucketV1,
  ObjectHeadV1,
  ObjectListPageV1,
  ObjectListRequestV1,
  ObjectPutOptionsV1,
} from "./bucket.js";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface InMemoryObjectBucketV1 extends ObjectBucketV1 {
  /** Every key currently held, in sorted order. */
  keys(): string[];
}

/**
 * An object store with R2's conditional-write semantics: `etagMatches` is
 * `If-Match`, and `etagDoesNotMatch: "*"` is `If-None-Match: *`. A failed
 * precondition answers `null` rather than throwing, exactly as R2 does.
 */
export function createInMemoryObjectBucketV1(
  clock: () => Date = () => new Date(),
): InMemoryObjectBucketV1 {
  const objects = new Map<string, StoredObject>();
  let etagCounter = 0;

  const head = (key: string): ObjectHeadV1 | null => {
    const stored = objects.get(key);
    if (!stored) return null;
    return {
      key,
      etag: stored.etag,
      size: stored.bytes.byteLength,
      uploaded: stored.uploaded,
      ...(stored.customMetadata
        ? { customMetadata: stored.customMetadata }
        : {}),
    };
  };

  return {
    keys: () => [...objects.keys()].sort(),
    head: (key) => Promise.resolve(head(key)),
    get: (key) => {
      const stored = objects.get(key);
      const meta = head(key);
      if (!stored || !meta) return Promise.resolve(null);
      const body: ObjectBodyV1 = {
        ...meta,
        bytes: () => Promise.resolve(stored.bytes),
      };
      return Promise.resolve(body);
    },
    put: (key: string, bytes: Uint8Array, options?: ObjectPutOptionsV1) => {
      const existing = objects.get(key);
      const onlyIf = options?.onlyIf;
      if (onlyIf?.etagDoesNotMatch === "*" && existing) {
        return Promise.resolve(null);
      }
      if (
        onlyIf?.etagDoesNotMatch !== undefined &&
        onlyIf.etagDoesNotMatch !== "*" &&
        existing?.etag === onlyIf.etagDoesNotMatch
      ) {
        return Promise.resolve(null);
      }
      if (
        onlyIf?.etagMatches !== undefined &&
        existing?.etag !== onlyIf.etagMatches
      ) {
        return Promise.resolve(null);
      }
      etagCounter += 1;
      const stored: StoredObject = {
        bytes: new Uint8Array(bytes),
        etag: `etag-${etagCounter}`,
        uploaded: clock(),
        ...(options?.customMetadata
          ? { customMetadata: { ...options.customMetadata } }
          : {}),
      };
      objects.set(key, stored);
      return Promise.resolve(head(key));
    },
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    list: (request: ObjectListRequestV1) => {
      const prefix = request.prefix ?? "";
      const matching = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = request.cursor ? Number(request.cursor) : 0;
      const limit = request.limit ?? 1000;
      const window = matching.slice(start, start + limit);
      const truncated = start + window.length < matching.length;
      const page: ObjectListPageV1 = {
        objects: window.flatMap((key) => {
          const meta = head(key);
          return meta ? [meta] : [];
        }),
        truncated,
        ...(truncated ? { cursor: String(start + window.length) } : {}),
      };
      return Promise.resolve(page);
    },
  };
}

export interface InMemoryWorkspaceGenerationsV1 extends WorkspaceGenerationsV1 {
  /** Every tombstone recorded, for asserting that a delete left evidence. */
  tombstones(): WorkspaceGenerationRecordV1[];
}

/** The generation ledger a Durable Object keeps, modelled in memory. */
export function createInMemoryWorkspaceGenerationsV1(
  clock: () => Date = () => new Date(),
): InMemoryWorkspaceGenerationsV1 {
  const current = new Map<string, WorkspaceGenerationRecordV1>();
  const conflicts = new Map<string, WorkspaceGenerationRecordV1[]>();
  let counter = 0;
  let last = "";

  const key = (root: WorkspaceRootV1, path: string): string =>
    `${workspaceRootKeyV1(root)}:${path}`;

  return {
    mint: (at: Date) => {
      counter += 1;
      let minted = `${at.getTime().toString().padStart(15, "0")}-${counter
        .toString()
        .padStart(6, "0")}`;
      // Sortable *and* monotonic: a clock that does not advance still yields
      // an increasing id, because generation order is what ordering means.
      if (minted <= last)
        minted = `${last}-${counter.toString().padStart(6, "0")}`;
      last = minted;
      return Promise.resolve(minted);
    },
    current: (root, path) => Promise.resolve(current.get(key(root, path))),
    record: (entry) => {
      current.set(key(entry.root, entry.path), entry);
      return Promise.resolve();
    },
    tombstone: (entry) => {
      current.set(key(entry.root, entry.path), { ...entry, deleted: true });
      return Promise.resolve();
    },
    conflict: (entry) => {
      const at = key(entry.root, entry.path);
      conflicts.set(at, [...(conflicts.get(at) ?? []), entry]);
      return Promise.resolve();
    },
    conflicts: (root, path) =>
      Promise.resolve([...(conflicts.get(key(root, path)) ?? [])]),
    tombstones: () =>
      [...current.values()].filter((entry) => entry.deleted === true),
  };
}
