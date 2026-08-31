// The Bot Durable Object's half of the Routines seam.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, Assignments." The Routines Package holds the
// records, the codecs, the command semantics and the scheduler; this module
// supplies the two things the Package cannot own — the Durable Object's storage,
// and the one call that admits a Turn.
//
// FIRING IS AN IN-OBJECT CALL. `authority.run` is a method on the kernel
// authority, reached from `settleScheduledWork` inside the object. No HTTP path
// and no RPC reaches it, so nothing outside the Bot can cause a Routine to run
// as an automation Turn.
//
// HIBERNATION. Nothing here reaches a Computer. "The Agent loop, Memory,
// Skills, Package composition, and Routines function correctly while the
// Computer is hibernated and do not wake it": a Routine is Durable Object
// storage, an alarm, and a Turn.
import {
  RoutineScheduler,
  type RoutineFireOutcomeV1,
} from "@frockbot/plugin-routines/scheduler";
import {
  routineSessionIdV1,
  type RoutineFireV1,
} from "@frockbot/plugin-routines/firing";
import {
  RoutineStore,
  type RoutineHookMinterV1,
  type RoutineStorageV1,
} from "@frockbot/plugin-routines/store";
import {
  mintRoutineHookTokenV1,
  routineHookDigestV1,
} from "@frockbot/plugin-routines/hook";
import { routineHookPathV1 } from "@frockbot/plugin-routines/shared";
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
 * The Routines authority for one Bot Durable Object: the record store and the
 * scheduler that fires it, built together because the command path needs the
 * scheduler (`routine/run`) and the scheduler needs the records.
 *
 * `DurableObjectState.storage` already satisfies `RoutineStorageV1`; naming the
 * narrow seam here is what keeps the Package testable without a Durable Object.
 */
export function createBotRoutines(
  storage: RoutineStorageV1,
  hookKeys?: RoutineHookMinterV1,
): {
  store: RoutineStore;
  scheduler: RoutineScheduler;
} {
  const scheduler = new RoutineScheduler(storage);
  return {
    scheduler,
    store: new RoutineStore(storage, {
      firings: scheduler,
      ...(hookKeys ? { hookKeys } : {}),
    }),
  };
}

/**
 * The webhook key minter for one Bot.
 *
 * The token is derived from the Worker secret and the Routine's identity, so it
 * is reproducible and never stored; what the Bot keeps is its digest. Without
 * the secret there is no minter at all, and a webhook Routine is refused with
 * that reason rather than given a key that cannot be verified.
 */
export function createBotRoutineHookMinter(
  identity: () => Promise<BotRoutinesIdentity | undefined>,
  secret: string | undefined,
): RoutineHookMinterV1 | undefined {
  if (!secret) return undefined;
  return {
    async mint({ routineId, keyVersion }) {
      // The Bot's durable identity, not a constructor argument: a Durable
      // Object learns who it is from its own storage, and a key that named the
      // wrong Bot would verify at the edge against an object that never holds it.
      const owner = await identity();
      if (!owner) {
        throw new Error("this Bot has no durable identity to key a webhook to");
      }
      const token = await mintRoutineHookTokenV1(secret, {
        u: owner.userId,
        b: owner.botId,
        r: routineId,
        v: keyVersion,
      });
      return {
        token,
        digest: await routineHookDigestV1(token),
        path: routineHookPathV1(owner.botId, routineId),
      };
    },
  };
}

/** Kept for callers that only want the record store. */
export function createBotRoutineStore(storage: RoutineStorageV1): RoutineStore {
  return createBotRoutines(storage).store;
}

/**
 * The Turn command one firing is admitted as.
 *
 * `turnType: "automation"` is the ceiling the firing runs under, and
 * `origin` names the Routine and the firing, so the run stays attributable
 * after the bounded run log has trimmed its index row away. The Session is the
 * Routine's own — never the User's visible conversation.
 */
export function routineTurnCommandV1(
  identity: BotRoutinesIdentity,
  fire: RoutineFireV1,
  acceptedAt: string,
) {
  return {
    userId: identity.userId,
    botId: identity.botId,
    runId: fire.fireId,
    sessionId: routineSessionIdV1(fire.routineId),
    acceptedAt,
    text: fire.cue,
    turnType: "automation" as const,
    origin: {
      kind: "routine" as const,
      routineId: fire.routineId,
      fireId: fire.fireId,
      trigger: fire.trigger,
    },
  };
}

/**
 * What the run log records for a firing, read off the durable run rather than
 * off the completion value: the run record is the authority for whether the
 * Turn succeeded, and it survives an eviction that loses the value.
 */
export function routineFireOutcomeV1(
  run: { status: string; failure?: string; responseText?: string } | undefined,
  thrown?: unknown,
): RoutineFireOutcomeV1 {
  if (thrown !== undefined) {
    return {
      status: "failed",
      summary: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  if (!run) return { status: "failed", summary: "the firing recorded no run" };
  if (run.status === "cancelled") {
    return {
      status: "cancelled",
      ...(run.failure === undefined ? {} : { summary: run.failure }),
    };
  }
  if (run.status === "completed") {
    return {
      status: "ok",
      ...(run.responseText === undefined ? {} : { summary: run.responseText }),
    };
  }
  return {
    status: "failed",
    summary: run.failure ?? `the firing's run is ${run.status}`,
  };
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
