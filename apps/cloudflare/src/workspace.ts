// The `WORKSPACE_FILES` seam, bound in production.
//
// `packages/plugin-shell/src/backend-skills.ts` reads one property off the Bot
// Durable Object's environment: a `WorkspaceFilesV1`. Until now nothing bound
// it, so the Skills Package was never mounted and no deployed Turn could load
// a Skill. This module is the binding: `WorkspaceFilesV1` over R2, with every
// generation recorded in the Bot Durable Object that owns the root.
//
// It wakes no Computer. "The Agent loop, Memory, Skills, Package composition,
// and Routines function correctly while the Computer is hibernated and do not
// wake it" — a read here is an R2 read and a Durable Object storage read, and
// nothing on this path can reach a Computer provider.
//
// The R2 types stop here: "Electron, Cloudflare, provider SDK, and Computer
// implementation types remain inside their adapters", so `@frockbot/workspace-
// store` sees only the structural `ObjectBucketV1` this file supplies.
import type {
  WorkspaceFilesV1,
  WorkspaceGenerationsV1,
} from "@frockbot/kernel-contracts";
import {
  createObjectWorkspaceFilesV1,
  type ObjectBucketV1,
  type ObjectHeadV1,
  type WorkspaceStoreSurfaceV1,
} from "@frockbot/workspace-store";

function head(object: R2Object): ObjectHeadV1 {
  return {
    key: object.key,
    etag: object.etag,
    size: object.size,
    uploaded: object.uploaded,
    ...(object.customMetadata ? { customMetadata: object.customMetadata } : {}),
  };
}

/** The structural object store, over one R2 bucket. */
export function createR2ObjectBucketV1(bucket: R2Bucket): ObjectBucketV1 {
  return {
    get: async (key) => {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        ...head(object),
        bytes: async () => new Uint8Array(await object.arrayBuffer()),
      };
    },
    head: async (key) => {
      const object = await bucket.head(key);
      return object ? head(object) : null;
    },
    put: async (key, bytes, options) => {
      const onlyIf = options?.onlyIf;
      // `If-None-Match: *` is "create only if absent". `uploadedBefore` at the
      // epoch says the same thing in a second way, and is sent alongside so
      // the precondition holds even where a wildcard etag is compared
      // literally. A create that silently overwrote would be last-writer-wins,
      // which ADR 0013 forbids outright.
      const conditional: R2Conditional | undefined =
        onlyIf === undefined
          ? undefined
          : onlyIf.etagDoesNotMatch === "*"
            ? { etagDoesNotMatch: "*", uploadedBefore: new Date(0) }
            : onlyIf;
      const written = await bucket.put(key, bytes as ArrayBufferView, {
        ...(conditional ? { onlyIf: conditional } : {}),
        ...(options?.customMetadata
          ? { customMetadata: options.customMetadata }
          : {}),
        ...(options?.contentType
          ? { httpMetadata: { contentType: options.contentType } }
          : {}),
      });
      return written ? head(written) : null;
    },
    delete: (key) => bucket.delete(key),
    list: async (request) => {
      const page = await bucket.list({
        ...(request.prefix ? { prefix: request.prefix } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
        include: ["customMetadata"],
      });
      return {
        objects: page.objects.map(head),
        truncated: page.truncated,
        ...(page.truncated ? { cursor: page.cursor } : {}),
      };
    },
  };
}

/** The bucket binding that backs durable roots. Optional: absence is a state. */
export interface WorkspaceStoreEnv {
  MEMORY_FILES?: R2Bucket;
}

/**
 * The Workspace file surface one Durable Object serves, or `undefined` when no
 * bucket is bound — in which case the Skills Package is simply not mounted,
 * visibly, rather than reading instructions from a store it invented.
 */
export function createDurableWorkspaceFilesV1(
  env: WorkspaceStoreEnv,
  options: {
    /**
     * The generation ledger these roots record in. Required, and passed in
     * rather than constructed here: a ledger caches the minting cursor while
     * it is resident, so two instances on one Durable Object can read one
     * cursor and mint one id twice. The object that owns the roots holds
     * exactly one.
     */
    generations: WorkspaceGenerationsV1;
    surface?: WorkspaceStoreSurfaceV1;
    /**
     * The User whose durable roots this store serves. Passed as soon as the
     * Durable Object knows it — a Bot object learns its User on the RPC that
     * addresses it — so a root belonging to another User is refused at the
     * store rather than reaching object storage.
     */
    owner?: { userId: string };
  },
): WorkspaceFilesV1 | undefined {
  const bucket = env.MEMORY_FILES;
  if (!bucket) return undefined;
  return createObjectWorkspaceFilesV1({
    bucket: createR2ObjectBucketV1(bucket),
    generations: options.generations,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.surface ? { surface: options.surface } : {}),
  });
}
