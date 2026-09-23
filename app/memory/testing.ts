// Fixtures for the Memory Package's tests, and for anything that needs a
// Memory host without a Durable Object.
//
// The Workspace half is deliberately *not* faked here: the tests build a real
// `createObjectWorkspaceFilesV1` over the in-memory bucket and generation
// ledger from `@frockbot/core/workspace-store/testing`, so what they prove is the
// production store's behaviour and not a double's. What this module supplies
// is the two seams that genuinely have no implementation in this Package: Group
// Chat membership, and a deterministic clock.
import { createObjectWorkspaceFilesV1 } from "@frockbot/core/workspace-store";
import {
  createInMemoryObjectBucketV1,
  createInMemoryWorkspaceGenerationsV1,
} from "@frockbot/core/workspace-store/testing";
import type { WorkspaceFilesV1 } from "@frockbot/core/contracts";
import type { MemoryGroupsV1 } from "./groups.js";
import { MemoryStore } from "./store.js";
import type { MemoryOwnerV1 } from "./roots.js";
import type { MemoryAuthorityV1 } from "./records.js";

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

/** Group Chat membership in memory; production reads the User object's list. */
export function createInMemoryMemoryGroupsV1(
  groupIds: string[] = [],
): MemoryGroupsV1 & { set(groupIds: string[]): void } {
  let current = [...groupIds];
  return {
    memberOf: () => Promise.resolve([...current]),
    set: (next) => {
      current = [...next];
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

/** The authority one engine call carries, with membership already resolved. */
export function createTestMemoryAuthorityV1(
  overrides: Partial<MemoryAuthorityV1> = {},
): MemoryAuthorityV1 {
  return {
    userId: "user-1",
    botId: "bot-1",
    actor: "bot",
    joinedGroupChatIds: [],
    membershipRevision: "1",
    ...overrides,
  };
}
