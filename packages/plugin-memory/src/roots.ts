// Where a Memory fact lives: which durable root, which shard, which file.
//
// "Memory is Markdown files under durable roots of the Workspace in three
// tiers: a Bot Memory root per Bot, a User Memory root shared by the User's
// Bots, and a Project Memory root per Project that a Bot has joined."
//
// Sharding is not decided here. `memoryShardPathV1` in
// `@frockbot/kernel-contracts` owns `by-agent/<botId>/`, and this module calls
// it; a second spelling of the shard prefix is exactly the bug the contract
// exists to prevent. What this module owns is GrokBot's file layout inside a
// shard — `profile.md` beside `log/YYYY-MM.md` — and the mapping from a
// scope name to a root.
import {
  memoryShardPathV1,
  memoryShardPrefixV1,
  type MemoryScopeNameV1,
  type WorkspaceMemoryRootV1,
  type WorkspacePathV1,
} from "@frockbot/kernel-contracts";

/** The Bot whose Memory is being read or written, and its User. */
export interface MemoryOwnerV1 {
  userId: string;
  botId: string;
}

/**
 * The three write tiers within a scope (`docs/research/grokbot-computer.md`
 * §2.2): `profile` is foundational and kept in mind every Turn, `log` is dated
 * history and the default, `note` "fades fast". A note is not a separate file:
 * GrokBot stores it as a `[note] ` prefix on the fact text in the same monthly
 * log, and so does this Package.
 */
export type MemoryTierV1 = "profile" | "log" | "note";

/** The file a `profile`-tier fact is written to, inside a shard. */
export const MEMORY_PROFILE_FILE = "profile.md";
/** The directory dated facts live in, inside a shard. */
export const MEMORY_LOG_DIRECTORY = "log";

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** True for a Project slug the `project-memory` root will accept. */
export function isMemoryProjectIdV1(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID.test(value);
}

export function botMemoryRootV1(owner: MemoryOwnerV1): WorkspaceMemoryRootV1 {
  return { kind: "bot-memory", userId: owner.userId, botId: owner.botId };
}

export function userMemoryRootV1(owner: MemoryOwnerV1): WorkspaceMemoryRootV1 {
  return { kind: "user-memory", userId: owner.userId };
}

export function projectMemoryRootV1(
  owner: MemoryOwnerV1,
  projectId: string,
): WorkspaceMemoryRootV1 {
  if (!isMemoryProjectIdV1(projectId)) {
    throw new Error(`Project slug "${projectId}" is invalid`);
  }
  return { kind: "project-memory", userId: owner.userId, projectId };
}

/** The root one scope names, with a Project slug required for `project`. */
export function memoryScopeRootV1(
  scope: MemoryScopeNameV1,
  owner: MemoryOwnerV1,
  projectId?: string,
): WorkspaceMemoryRootV1 {
  if (scope === "bot") return botMemoryRootV1(owner);
  if (scope === "user") return userMemoryRootV1(owner);
  if (projectId === undefined) {
    throw new Error("the project scope requires a Project slug");
  }
  return projectMemoryRootV1(owner, projectId);
}

/** The scope name a root belongs to. */
export function memoryScopeOfRootV1(
  root: WorkspaceMemoryRootV1,
): MemoryScopeNameV1 {
  if (root.kind === "bot-memory") return "bot";
  if (root.kind === "user-memory") return "user";
  return "project";
}

/** The Project slug a root names, or `""` for the two unprojected tiers. */
export function memoryProjectIdOfRootV1(root: WorkspaceMemoryRootV1): string {
  return root.kind === "project-memory" ? root.projectId : "";
}

/** `log/YYYY-MM.md`, the monthly file a dated fact is appended to. */
export function memoryLogRelativeV1(at: Date): string {
  const year = at.getUTCFullYear().toString().padStart(4, "0");
  const month = (at.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${MEMORY_LOG_DIRECTORY}/${year}-${month}.md`;
}

/** The relative path, inside a shard, one tier writes to. */
export function memoryTierRelativeV1(tier: MemoryTierV1, at: Date): string {
  return tier === "profile" ? MEMORY_PROFILE_FILE : memoryLogRelativeV1(at);
}

/**
 * The full path a Bot's fact is written to. Shared roots place it under the
 * writing Bot's own shard; the Bot Memory root is already single-writer, so
 * its shard is the root.
 */
export function memoryFilePathV1(
  root: WorkspaceMemoryRootV1,
  botId: string,
  tier: MemoryTierV1,
  at: Date,
): WorkspacePathV1 {
  return memoryShardPathV1(root, botId, memoryTierRelativeV1(tier, at));
}

/** The prefix a Bot's own files sit under; `""` for the Bot Memory root. */
export function memoryShardOfV1(
  root: WorkspaceMemoryRootV1,
  botId: string,
): string {
  return memoryShardPrefixV1(root, botId);
}

/**
 * Classifies one relative path inside a root as a Memory file, or not.
 *
 * A Memory root holds only `profile.md` and `log/*.md` per shard; anything
 * else — a stray file, a derived index, a directory marker — is data the
 * renderer ignores rather than parses. The shard prefix is stripped first, so
 * the same predicate answers for all three tiers.
 */
export function memoryFileKindV1(
  root: WorkspaceMemoryRootV1,
  relative: string,
): { kind: "profile" | "log"; shard: string } | undefined {
  let shard = "";
  let tail = relative;
  if (root.kind !== "bot-memory") {
    const segments = relative.split("/");
    if (segments.length < 3 || segments[0] !== "by-agent") return undefined;
    try {
      shard = decodeURIComponent(segments[1] ?? "");
    } catch {
      return undefined;
    }
    if (!shard) return undefined;
    tail = segments.slice(2).join("/");
  } else {
    shard = root.botId;
  }
  if (tail === MEMORY_PROFILE_FILE) return { kind: "profile", shard };
  if (/^log\/\d{4}-\d{2}\.md$/.test(tail)) return { kind: "log", shard };
  return undefined;
}
