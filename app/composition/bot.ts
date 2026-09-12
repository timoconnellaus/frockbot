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
  type CompositionActivationStore,
  type CompositionFailureLog,
  type CompositionGenerationV1,
} from "@frockbot/core/durable";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type {
  UserCompositionRpcV1,
  UserCompositionSnapshotV1,
} from "./user.js";

/**
 * The User object's Composition RPCs, addressed by this Bot's User, or
 * `undefined` where no User object serves them — a host without the namespace,
 * or a test harness whose User stub knows only settings. The Bot's own store
 * is then the authority, exactly as before the store moved.
 */
export function userCompositionRpcV1(
  state: ShellBotStateV1,
  userId: string,
): UserCompositionRpcV1 | undefined {
  const namespace = state.env.USER_CONFIGURATIONS as
    ShellBotStateV1["env"]["USER_CONFIGURATIONS"] | undefined;
  if (!namespace) return undefined;
  const stub = namespace.get(
    namespace.idFromName(userId),
  ) as unknown as Partial<UserCompositionRpcV1>;
  return typeof stub.readComposition === "function"
    ? (stub as UserCompositionRpcV1)
    : undefined;
}

function requireUserCompositionRpcV1(
  state: ShellBotStateV1,
  userId: string,
): UserCompositionRpcV1 {
  const rpc = userCompositionRpcV1(state, userId);
  if (!rpc) throw new Error("the User object serves no Composition here");
  return rpc;
}

/** Reads the User's Composition and takes it as this Bot's mirror. */
export async function adoptUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<UserCompositionSnapshotV1> {
  const snapshot = await requireUserCompositionRpcV1(
    state,
    identity.userId,
  ).readComposition({ schemaVersion: 1, userId: identity.userId });
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
  if (!userCompositionRpcV1(state, identity.userId)) return;
  try {
    await adoptUserCompositionV1(state, identity);
  } catch {
    // Visible on the User's generation records; never a wedged Turn.
  }
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
  if (!rpc) {
    const local = state.authority.composition;
    return {
      read: (generationId) => local.read(generationId),
      lastKnownGood: () => local.lastKnownGood(),
      commit: (generationId) => local.commit(generationId),
      fail: (generationId, options) => local.fail(generationId, options),
    };
  }
  const refresh = async () => {
    try {
      await adoptUserCompositionV1(state, identity);
    } catch {
      // The next admission adopts it.
    }
  };
  return {
    read: async (generationId) => {
      const mirrored = await state.authority.composition.read(generationId);
      if (mirrored) return mirrored;
      return rpc.readCompositionGeneration({
        schemaVersion: 1,
        userId: identity.userId,
        generationId,
      });
    },
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

/** The User's failure log, reached from the Bot. */
export function compositionFailureLogV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): CompositionFailureLog {
  const rpc = userCompositionRpcV1(state, identity.userId);
  if (!rpc) return state.authority.compositionFailures;
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
  const rpc = userCompositionRpcV1(state, identity.userId);
  if (!rpc) return state.authority.composition.current();
  return (
    await rpc.readComposition({
      schemaVersion: 1,
      userId: identity.userId,
    })
  ).current;
}

/** Proposes a generation on the User, or on the Bot's own store where no User serves one. */
export async function proposeUserCompositionV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: {
    generation: CompositionGenerationV1;
    pin?: boolean;
    expectedCurrentGenerationId?: string;
  },
): Promise<void> {
  const rpc = userCompositionRpcV1(state, identity.userId);
  const options = {
    ...(input.pin === undefined ? {} : { pin: input.pin }),
    ...(input.expectedCurrentGenerationId === undefined
      ? {}
      : { expectedCurrentGenerationId: input.expectedCurrentGenerationId }),
  };
  if (!rpc) {
    await state.authority.composition.propose(input.generation, options);
    return;
  }
  await rpc.proposeComposition({
    schemaVersion: 1,
    userId: identity.userId,
    generation: input.generation,
    ...options,
  });
}

export async function readUserCompositionGenerationV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  generationId: string,
): Promise<CompositionGenerationV1 | undefined> {
  const rpc = userCompositionRpcV1(state, identity.userId);
  if (!rpc) return state.authority.composition.read(generationId);
  return rpc.readCompositionGeneration({
    schemaVersion: 1,
    userId: identity.userId,
    generationId,
  });
}

export async function listUserCompositionGenerationsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  query: { limit: number; cursor?: string },
): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }> {
  const rpc = userCompositionRpcV1(state, identity.userId);
  if (!rpc) return state.authority.composition.list(query);
  return rpc.listCompositionGenerations({
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
  const origin = {
    kind: "revert" as const,
    revertsTo: toGenerationId,
    userId: identity.userId,
  };
  const rpc = userCompositionRpcV1(state, identity.userId);
  if (!rpc) return state.authority.composition.revert(toGenerationId, origin);
  return rpc.revertComposition({
    schemaVersion: 1,
    userId: identity.userId,
    toGenerationId,
    origin,
  });
}
