// The Memory seam, bound in production.
//
// Two things live here, and both exist because of one sentence in `AGENTS.md`
// § Authorities: "The User's Durable Object is the authority for everything
// User-scoped: ... and the generation records of User and Project Memory
// roots."
//
//  1. `createRoutedWorkspaceGenerationsV1` sends a *shared* Memory root's
//     generations — `user-memory` and `project-memory` — to the User Durable
//     Object over RPC, and everything else to the Bot's own ledger. Two Bots
//     writing one shared root therefore record into one ledger, which is what
//     makes "newest fact wins on conflict" answerable at all: the minted
//     generation ids come from a single authority, so they order.
//  2. `createUserMemoryProjectsV1` is the Project membership authority, also
//     the User object, also over RPC.
//
// Both are decoded at the seam. "Cross-runtime communication uses narrow,
// versioned DTOs, and every inbound value is decoded at its seam" — an answer
// from another Durable Object is inbound, so it is decoded here rather than
// trusted because of where it came from.
import {
  decodeWorkspaceGenerationRecordV1,
  isWorkspaceSharedMemoryRootV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import type {
  MemoryProjectsOutcomeV1,
  MemoryProjectsV1,
  MemoryProjectV1,
} from "@frockbot/plugin-memory/agent";

/** The User Durable Object's Memory RPC surface, as the Bot object calls it. */
export interface UserMemoryRpc {
  mintWorkspaceGeneration(input: unknown): Promise<string>;
  currentWorkspaceGeneration(input: unknown): Promise<unknown>;
  recordWorkspaceGeneration(input: unknown): Promise<void>;
  tombstoneWorkspaceGeneration(input: unknown): Promise<void>;
  conflictWorkspaceGeneration(input: unknown): Promise<void>;
  listWorkspaceConflicts(input: unknown): Promise<unknown>;
  listMemoryProjects(input: unknown): Promise<unknown>;
  changeMemoryProjects(input: unknown): Promise<unknown>;
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
  return {
    mint: (at, root) =>
      rpc.mintWorkspaceGeneration(envelope({ at: at.toISOString(), root })),
    current: async (root, path) =>
      decodeRecord(
        await rpc.currentWorkspaceGeneration(envelope({ root, path })),
      ),
    record: (entry) => rpc.recordWorkspaceGeneration(envelope({ entry })),
    tombstone: (entry) => rpc.tombstoneWorkspaceGeneration(envelope({ entry })),
    conflict: (entry) => rpc.conflictWorkspaceGeneration(envelope({ entry })),
    conflicts: async (root, path) => {
      const answer = await rpc.listWorkspaceConflicts(envelope({ root, path }));
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

function decodeProject(value: unknown): MemoryProjectV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project record is invalid");
  }
  const record = value as Record<string, unknown>;
  const text = (key: string, maximum: number, required: boolean): string => {
    const candidate = record[key];
    if (candidate === undefined && !required) return "";
    if (typeof candidate !== "string" || candidate.length > maximum) {
      throw new Error(`Project record.${key} is invalid`);
    }
    return candidate;
  };
  return {
    projectId: text("projectId", 128, true),
    name: text("name", 128, true),
    description: text("description", 512, false),
  };
}

function decodeProjectsOutcome(value: unknown): MemoryProjectsOutcomeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project membership answer is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.status === "refused") {
    return {
      status: "refused",
      reason:
        typeof record.reason === "string"
          ? record.reason.slice(0, 512)
          : "the Project change was refused",
    };
  }
  if (record.status !== "ok" || !Array.isArray(record.joined)) {
    throw new Error("Project membership answer is invalid");
  }
  return { status: "ok", joined: record.joined.map(decodeProject) };
}

/** Project membership over the User Durable Object, per Bot. */
export function createUserMemoryProjectsV1(
  rpc: UserMemoryRpc,
  identity: { userId: string; botId: string },
): MemoryProjectsV1 {
  const envelope = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    userId: identity.userId,
    botId: identity.botId,
    ...extra,
  });
  const change = async (
    action: "create" | "join" | "leave",
    projectId: string,
    project?: MemoryProjectV1,
  ): Promise<MemoryProjectsOutcomeV1> =>
    decodeProjectsOutcome(
      await rpc.changeMemoryProjects(
        envelope({
          action,
          projectId,
          ...(project ? { project } : {}),
        }),
      ),
    );
  return {
    joined: async () => {
      const answer = await rpc.listMemoryProjects(envelope({}));
      if (!Array.isArray(answer)) return [];
      return answer.map(decodeProject);
    },
    create: (project) => change("create", project.projectId, project),
    join: (projectId) => change("join", projectId),
    leave: (projectId) => change("leave", projectId),
  };
}
