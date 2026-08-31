// The Bot Durable Object's half of the Routines seam.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, Assignments." The Routines Package holds the
// records, the codecs, and the command semantics; this module supplies the one
// thing the Package cannot own — the Durable Object's storage — and the writer
// identity a Turn writes under.
//
// HIBERNATION. Nothing here reaches a Computer. "The Agent loop, Memory,
// Skills, Package composition, and Routines function correctly while the
// Computer is hibernated and do not wake it": a Routine is Durable Object
// storage and nothing else.
import {
  RoutineStore,
  type RoutineStorageV1,
} from "@frockbot/plugin-routines/store";
import type { RoutinesRuntimeHostV1 } from "@frockbot/plugin-routines/agent";

/** The Bot and User whose Routines a caller may reach. */
export interface BotRoutinesIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a Bot-authored Routine records as its writer. */
export interface BotRoutinesTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * The Routines authority for one Bot Durable Object.
 *
 * `DurableObjectState.storage` already satisfies `RoutineStorageV1`; naming the
 * narrow seam here is what keeps the Package testable without a Durable Object.
 */
export function createBotRoutineStore(storage: RoutineStorageV1): RoutineStore {
  return new RoutineStore(storage);
}

/**
 * The Routines seam one admitted Turn runs under. A Turn is required: a Bot
 * writes a Routine only inside a Turn whose Session and Turn its provenance can
 * name, exactly as it writes a Skill or authors a Package.
 */
export function createBotRoutinesHost(
  identity: BotRoutinesIdentity,
  turn: BotRoutinesTurn,
  store: RoutineStore,
): RoutinesRuntimeHostV1 {
  return {
    botId: identity.botId,
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    list: () => store.list(identity.botId),
    execute: (command, writer) => store.execute(command, writer),
  };
}
