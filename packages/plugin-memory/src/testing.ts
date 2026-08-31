// Fixtures for the Memory Package's tests, and for anything that needs a
// Memory host without a Durable Object.
//
// The Workspace half is deliberately *not* faked here: the tests build a real
// `createObjectWorkspaceFilesV1` over the in-memory bucket and generation
// ledger from `@frockbot/workspace-store/testing`, so what they prove is the
// production store's behaviour and not a double's. What this module supplies
// is the two seams that genuinely have no implementation in this Package: the
// durable Project authority, and a deterministic clock.
import { createObjectWorkspaceFilesV1 } from "@frockbot/workspace-store";
import {
  createInMemoryObjectBucketV1,
  createInMemoryWorkspaceGenerationsV1,
} from "@frockbot/workspace-store/testing";
import type { WorkspaceFilesV1 } from "@frockbot/kernel-contracts";
import type { MemoryProjectsOutcomeV1, MemoryProjectsV1 } from "./projects.js";
import type { MemoryProjectV1 } from "./render.js";
import { MemoryStore } from "./store.js";
import type { MemoryOwnerV1 } from "./roots.js";

/** The Memory surface, over the same store production uses. */
export function createTestMemoryFilesV1(options: {
  userId: string;
  clock?: () => Date;
}): WorkspaceFilesV1 {
  return createObjectWorkspaceFilesV1({
    bucket: createInMemoryObjectBucketV1(options.clock),
    generations: createInMemoryWorkspaceGenerationsV1(options.clock),
    owner: { userId: options.userId },
    surface: "memory",
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

/**
 * A Project authority in memory. Production's lives in the User Durable
 * Object; this one models the same contract, including create-is-join.
 */
export function createInMemoryMemoryProjectsV1(
  seed: MemoryProjectV1[] = [],
): MemoryProjectsV1 & { known(): MemoryProjectV1[] } {
  const known = new Map<string, MemoryProjectV1>(
    seed.map((project) => [project.projectId, project]),
  );
  const joined = new Set<string>(seed.map((project) => project.projectId));
  const list = (): MemoryProjectV1[] =>
    [...joined]
      .flatMap((projectId) => {
        const project = known.get(projectId);
        return project ? [project] : [];
      })
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  const ok = (): MemoryProjectsOutcomeV1 => ({ status: "ok", joined: list() });
  return {
    known: () => [...known.values()],
    joined: () => Promise.resolve(list()),
    create: (project) => {
      if (!known.has(project.projectId)) known.set(project.projectId, project);
      joined.add(project.projectId);
      return Promise.resolve(ok());
    },
    join: (projectId) => {
      if (!known.has(projectId)) {
        return Promise.resolve({
          status: "refused",
          reason: `no Project "${projectId}" exists`,
        } satisfies MemoryProjectsOutcomeV1);
      }
      joined.add(projectId);
      return Promise.resolve(ok());
    },
    leave: (projectId) => {
      joined.delete(projectId);
      return Promise.resolve(ok());
    },
  };
}

/** A `MemoryStore` over the test Workspace surface, with a frozen clock. */
export function createTestMemoryStoreV1(options: {
  owner: MemoryOwnerV1;
  botNames?: Record<string, string>;
  at?: Date;
  files?: WorkspaceFilesV1;
}): MemoryStore {
  const clock = options.at ? () => options.at as Date : undefined;
  return new MemoryStore({
    files:
      options.files ??
      createTestMemoryFilesV1({
        userId: options.owner.userId,
        ...(clock ? { clock } : {}),
      }),
    owner: options.owner,
    ...(options.botNames ? { botNames: options.botNames } : {}),
    ...(clock ? { clock } : {}),
  });
}
