// The Bot's half of the User-owned Composition (ADR 0026).
//
// The User Durable Object holds the installed set, its generations, the last
// known good and the quarantine. A Bot admits a Turn inside its own storage
// transaction, which cannot make a cross-object call, so before every
// admission the Bot reads the User's pin and fallback and adopts them into its
// own `composition:` records — a mirror, never a second truth. Activation
// commits and fails against the User and refreshes the mirror after; the
// views the settings page reads come from the User directly.
import {
  type BotTurnCompletion,
  type CompositionActivationStore,
  type CompositionFailureLog,
  type CompositionGenerationV1,
  type OwnedBotTurnCommand,
} from "@frockbot/core/durable";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type {
  UserCompositionRpcV1,
  UserCompositionSnapshotV1,
} from "./user.js";

/**
 * The User object's Composition RPCs, addressed by this Bot's User. The User
 * owns the Composition outright: there is no second authority to fall back
 * to, so everything here goes through this one stub.
 */
export function userCompositionRpcV1(
  state: ShellBotStateV1,
  userId: string,
): UserCompositionRpcV1 {
  const namespace = state.env.USER_CONFIGURATIONS;
  // SAFETY: this namespace is bound to UserConfiguration; generated Worker
  // types do not expose its Composition RPC surface.
  return namespace.get(
    namespace.idFromName(userId),
  ) as unknown as UserCompositionRpcV1;
}

/** The User's pin and fallback, read together and written nowhere. */
export function readUserCompositionSnapshotV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<UserCompositionSnapshotV1> {
  return userCompositionRpcV1(state, identity.userId).readComposition({
    schemaVersion: 1,
    userId: identity.userId,
  });
}

/** Reads the User's Composition and takes it as this Bot's mirror. */
export async function adoptUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<UserCompositionSnapshotV1> {
  const snapshot = await readUserCompositionSnapshotV1(state, identity);
  await state.authority.composition.adopt(snapshot);
  return snapshot;
}

/**
 * Before admission, outside its transaction. A User object that cannot be
 * read leaves the Bot on the pin it mirrored last: a Composition change is
 * never a reason a Turn cannot start, and the next Turn reads again.
 */
export async function syncCompositionFromUser(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<void> {
  try {
    await adoptUserCompositionV1(state, identity);
  } catch {
    // Visible on the User's generation records; never a wedged Turn.
  }
}

/**
 * Admission. Every Turn enters the kernel through here — a chat Turn, a
 * Routine firing, a Package-UI tool, a Subagent task — so the pin the
 * admission transaction takes inside the Bot is always the User's current
 * generation mirrored a moment earlier, never one this Bot minted alone.
 */
export async function admitTurnV1(
  state: ShellBotStateV1,
  command: OwnedBotTurnCommand,
): Promise<BotTurnCompletion> {
  await syncCompositionFromUser(state, {
    userId: command.userId,
    botId: command.botId,
  });
  return state.authority.run(command);
}

/**
 * The narrow store activation drives. Reads come from the mirror the
 * admission already pinned; a commit or a failure is recorded on the User,
 * where the generation lives, and the mirror is refreshed so the next
 * admission sees the outcome.
 */
export function compositionActivationStoreV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): CompositionActivationStore {
  const rpc = userCompositionRpcV1(state, identity.userId);
  const refresh = async () => {
    try {
      await adoptUserCompositionV1(state, identity);
    } catch {
      // The next admission adopts it.
    }
  };
  return {
    read: (generationId) =>
      readPinnedCompositionGenerationV1(state, identity, generationId),
    lastKnownGood: () => state.authority.composition.lastKnownGood(),
    commit: async (generationId) => {
      await rpc.commitComposition({
        schemaVersion: 1,
        userId: identity.userId,
        generationId,
      });
      await refresh();
    },
    fail: async (generationId, options) => {
      await rpc.failComposition({
        schemaVersion: 1,
        userId: identity.userId,
        generationId,
        quarantined: options.quarantined,
      });
      await refresh();
    },
  };
}

/**
 * A generation a Turn already pinned: the mirror first, the User second. An
 * in-flight Turn keeps the pin it was admitted under even once a later
 * admission has adopted a newer one over the mirror.
 */
export async function readPinnedCompositionGenerationV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  generationId: string,
): Promise<CompositionGenerationV1 | undefined> {
  const mirrored = await state.authority.composition.read(generationId);
  if (mirrored) return mirrored;
  return readUserCompositionGenerationV1(state, identity, generationId);
}

/** The User's failure log, reached from the Bot. */
export function compositionFailureLogV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): CompositionFailureLog {
  const rpc = userCompositionRpcV1(state, identity.userId);
  const userId = identity.userId;
  return {
    record: (failure) =>
      rpc.recordCompositionFailure({ schemaVersion: 1, userId, failure }),
    list: (generationId) =>
      rpc.listCompositionFailures({ schemaVersion: 1, userId, generationId }),
    quarantine: (generationId) =>
      rpc.readCompositionQuarantine({ schemaVersion: 1, userId, generationId }),
    clear: (generationId) =>
      rpc.clearCompositionFailures({ schemaVersion: 1, userId, generationId }),
  };
}

/** The User's current generation, read fresh: what a proposal derives from. */
export async function currentUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<CompositionGenerationV1> {
  return (await readUserCompositionSnapshotV1(state, identity)).current;
}

/** Proposes a generation on the User, where the installed set lives. */
export async function proposeUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: {
    generation: CompositionGenerationV1;
    pin?: boolean;
    expectedCurrentGenerationId?: string;
  },
): Promise<void> {
  await userCompositionRpcV1(state, identity.userId).proposeComposition({
    schemaVersion: 1,
    userId: identity.userId,
    generation: input.generation,
    ...(input.pin === undefined ? {} : { pin: input.pin }),
    ...(input.expectedCurrentGenerationId === undefined
      ? {}
      : { expectedCurrentGenerationId: input.expectedCurrentGenerationId }),
  });
}

export async function readUserCompositionGenerationV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  generationId: string,
): Promise<CompositionGenerationV1 | undefined> {
  return userCompositionRpcV1(state, identity.userId).readCompositionGeneration(
    {
      schemaVersion: 1,
      userId: identity.userId,
      generationId,
    },
  );
}

export async function listUserCompositionGenerationsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  query: { limit: number; cursor?: string },
): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }> {
  return userCompositionRpcV1(
    state,
    identity.userId,
  ).listCompositionGenerations({
    schemaVersion: 1,
    userId: identity.userId,
    ...query,
  });
}

export async function revertUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  toGenerationId: string,
): Promise<CompositionGenerationV1> {
  return userCompositionRpcV1(state, identity.userId).revertComposition({
    schemaVersion: 1,
    userId: identity.userId,
    toGenerationId,
    origin: {
      kind: "revert",
      revertsTo: toGenerationId,
      userId: identity.userId,
    },
  });
}
