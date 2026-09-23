// The Memory seam, bound in production.
//
// Two things live here, and both exist because the User's Durable Object is
// the authority for everything User-scoped:
//
//  1. `createRoutedWorkspaceGenerationsV1` sends the *shared* Memory root's
//     generations — `user-memory` — to the User Durable Object over RPC, and
//     everything else to the Bot's own ledger. Two Bots writing one shared
//     root therefore record into one ledger, which is what makes "newest fact
//     wins on conflict" answerable at all: the minted generation ids come
//     from a single authority, so they order.
//  2. `createUserMemoryGroupsV1` reads which Group Chats the Bot is in, whose
//     Memory it may use, from the User object's list of groups.
//
// Both are decoded at the seam. "Cross-runtime communication uses narrow,
// versioned DTOs, and every inbound value is decoded at its seam" — an answer
// from another Durable Object is inbound, so it is decoded here rather than
// trusted because of where it came from.
import {
  decodeWorkspaceGenerationRecordV1,
  isWorkspaceSharedMemoryRootV1,
  remoteCallV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { isGroupIdV1 } from "@frockbot/app/groups/shared";
import type { MemoryGroupsV1 } from "@frockbot/app/memory/groups";

/** The User Durable Object's Memory RPC surface, as the Bot object calls it. */
export interface UserMemoryRpc {
  mintWorkspaceGeneration(input: unknown): Promise<string>;
  currentWorkspaceGeneration(input: unknown): Promise<unknown>;
  recordWorkspaceGeneration(input: unknown): Promise<void>;
  tombstoneWorkspaceGeneration(input: unknown): Promise<void>;
  conflictWorkspaceGeneration(input: unknown): Promise<void>;
  listWorkspaceConflicts(input: unknown): Promise<unknown>;
  listMemoryGroups(input: unknown): Promise<unknown>;
  operateMemory(input: unknown): Promise<unknown>;
}

function decodeRecord(value: unknown): WorkspaceGenerationRecordV1 | undefined {
  return value === undefined || value === null
    ? undefined
    : decodeWorkspaceGenerationRecordV1(value);
}

/** `WorkspaceGenerationsV1` over the User Durable Object, for shared roots. */
export function createUserWorkspaceGenerationsV1(
  rpc: UserMemoryRpc,
  userId: string,
): WorkspaceGenerationsV1 {
  const envelope = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    userId,
    ...extra,
  });
  // Every one of these crosses a Durable Object boundary, so every one gets a
  // deadline and one retry: a User object that is mid-eviction or briefly
  // unreachable must cost a retry, never a Turn that hangs to the platform
  // limit with nothing on screen.
  const call = <T>(label: string, invoke: () => Promise<T>) =>
    remoteCallV1(label, invoke);
  return {
    mint: (at, root) =>
      call("the generation ledger", () =>
        rpc.mintWorkspaceGeneration(envelope({ at: at.toISOString(), root })),
      ),
    current: async (root, path) =>
      decodeRecord(
        await call("the generation ledger", () =>
          rpc.currentWorkspaceGeneration(envelope({ root, path })),
        ),
      ),
    record: (entry) =>
      call("the generation ledger", () =>
        rpc.recordWorkspaceGeneration(envelope({ entry })),
      ),
    tombstone: (entry) =>
      call("the generation ledger", () =>
        rpc.tombstoneWorkspaceGeneration(envelope({ entry })),
      ),
    conflict: (entry) =>
      call("the generation ledger", () =>
        rpc.conflictWorkspaceGeneration(envelope({ entry })),
      ),
    conflicts: async (root, path) => {
      const answer = await call("the generation ledger", () =>
        rpc.listWorkspaceConflicts(envelope({ root, path })),
      );
      if (!Array.isArray(answer)) return [];
      return answer.map((value) => decodeWorkspaceGenerationRecordV1(value));
    },
  };
}

/**
 * One ledger interface over two authorities, routed by the root itself.
 *
 * A shared Memory root belongs to the User; every other durable root belongs
 * to the Bot whose object holds it. The routing is a function of the root and
 * nothing else, so no caller can send a record to the wrong authority by
 * holding the wrong handle.
 */
export function createRoutedWorkspaceGenerationsV1(options: {
  bot: WorkspaceGenerationsV1;
  user: WorkspaceGenerationsV1;
}): WorkspaceGenerationsV1 {
  const owner = (root: WorkspaceRootV1): WorkspaceGenerationsV1 =>
    isWorkspaceSharedMemoryRootV1(root) ? options.user : options.bot;
  return {
    // A minted id must order against the other ids in the ledger that holds
    // it, so minting follows exactly the same routing as recording: shared
    // roots mint in the User object, the Bot's own roots in its own.
    mint: (at, root) => owner(root).mint(at, root),
    current: (root, path) => owner(root).current(root, path),
    record: (entry) => owner(entry.root).record(entry),
    tombstone: (entry) => owner(entry.root).tombstone(entry),
    conflict: (entry) => owner(entry.root).conflict(entry),
    conflicts: (root, path) => owner(root).conflicts(root, path),
  };
}

/** The Bot's Group Chat membership, over the User Durable Object. */
export function createUserMemoryGroupsV1(
  rpc: UserMemoryRpc,
  identity: { userId: string; botId: string },
): MemoryGroupsV1 {
  return {
    memberOf: async () => {
      const answer = await remoteCallV1("the Group Chat list", () =>
        rpc.listMemoryGroups({
          schemaVersion: 1,
          userId: identity.userId,
          botId: identity.botId,
        }),
      );
      const groupIds = (answer as { groupIds?: unknown } | null)?.groupIds;
      if (!Array.isArray(groupIds) || !groupIds.every(isGroupIdV1)) {
        throw new Error("Group Chat membership answer is invalid");
      }
      return groupIds;
    },
  };
}
