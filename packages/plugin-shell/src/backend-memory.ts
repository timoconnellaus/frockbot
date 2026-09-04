// The Bot Durable Object's half of the Memory seam.
//
// The Memory Package reads and writes Memory roots through a `MemoryStore`
// over `WorkspaceFilesV1`. This module decides, for one admitted Turn, whether
// such a surface exists, what provenance a write records, and where Project
// membership is kept. It implements none of those.
//
// HIBERNATION. "The Agent loop, Memory, Skills, Package composition, and
// Routines function correctly while the Computer is hibernated and do not wake
// it." Nothing here reaches the Computer registry, a Computer provider, or a
// Sprite. The surface handed to the Memory Package is a binding on the Durable
// Object's environment, backed by object storage under ADR 0013; whether a
// Computer host happens to be running changes nothing above this line.
//
// SEAM. `MEMORY_WORKSPACE_FILES` is bound in production by
// `apps/cloudflare/src/bot-state.ts`: `WorkspaceFilesV1` with `surface:
// "memory"`, so it serves Memory roots and refuses every other, with shared
// roots' generations recorded in the *User* Durable Object and the Bot's own
// root in the Bot's. A host that binds nothing gets `undefined` and the Memory
// Package is then not mounted at all: a Turn with no readable Memory root
// injects no Memory, visibly, rather than inventing a second store.
import type { WorkspaceFilesV1 } from "@frockbot/kernel-contracts";
import type {
  MemoryProjectsV1,
  MemoryRuntimeHostV1,
} from "@frockbot/plugin-memory/agent";
import { MemoryStore } from "@frockbot/plugin-memory/store";
import type { MemoryChunkIndexWriterV1 } from "@frockbot/plugin-memory/chunk-index";

/** The Bot and User whose Memory a Turn may read and write. */
export interface BotMemoryIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a Memory write records as its provenance. */
export interface BotMemoryTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * The narrow slice of the Durable Object environment this module reads. Named
 * as its own type so each binding's absence is a typed state, not a cast.
 */
export interface BotMemoryEnv {
  /** `WorkspaceFilesV1` with the Memory surface. Absent in a host with no bucket. */
  MEMORY_WORKSPACE_FILES?: WorkspaceFilesV1;
  /** The durable Project authority, in the User Durable Object. */
  MEMORY_PROJECTS?: MemoryProjectsV1;
  /** Display names per Bot id, for the `[via …]` tag on a shared fact. */
  MEMORY_BOT_NAMES?: Readonly<Record<string, string>>;
  /** Bot-scoped vector-id ledger supplied by the Durable Object host. */
  MEMORY_CHUNK_INDEX?: MemoryChunkIndexWriterV1;
}

/**
 * The Memory seam one admitted Turn runs under, or `undefined` when the Bot's
 * Memory surface is unavailable.
 */
export function createBotMemoryHost(
  identity: BotMemoryIdentity,
  turn: BotMemoryTurn,
  env: object,
): MemoryRuntimeHostV1 | undefined {
  // SAFETY: the Memory file surface is constructed onto the Durable Object
  // environment rather than declared in the generated `Env`, because it is not
  // a Worker binding. Absence is a supported state, not an error.
  const bindings = env as BotMemoryEnv;
  const files = bindings.MEMORY_WORKSPACE_FILES;
  if (!files) return undefined;
  const owner = { userId: identity.userId, botId: identity.botId };
  return {
    owner,
    store: new MemoryStore({
      files,
      owner,
      ...(bindings.MEMORY_BOT_NAMES
        ? { botNames: bindings.MEMORY_BOT_NAMES }
        : {}),
    }),
    // A Bot changes Memory only inside a Turn whose run, Turn and Session its
    // provenance names — the same rule Skills and Package authoring follow.
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    ...(bindings.MEMORY_PROJECTS ? { projects: bindings.MEMORY_PROJECTS } : {}),
    ...(bindings.MEMORY_CHUNK_INDEX
      ? { chunkIndex: bindings.MEMORY_CHUNK_INDEX }
      : {}),
  };
}
