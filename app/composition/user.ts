// The User's Composition: the installed Plugin set, its generations, the last
// known good and the quarantine. The User Durable Object owns them (ADR 0026);
// a Bot mirrors the pin before every admission and holds only its own enable
// map beside it.
//
// This module is the User half: the store over the User object's storage and
// the RPC surface a Bot reaches it through. Nothing here knows a Bot's
// identity beyond the User it belongs to.
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  CompositionPinConflictError,
  DurableCompositionFailureLog,
  DurableCompositionStore,
  decodeCompositionGenerationV1,
  type CompositionFailureInputV1,
  type CompositionFailureOutcomeV1,
  type CompositionFailureV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
  type CompositionOriginV1,
  type CompositionQuarantineV1,
  type CompositionStore,
} from "@frockbot/core/durable";
import {
  seededMemberV1,
  seededPluginsForAccountV1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";

/** What a Bot reads before admission: the pin and the fallback, whole. */
export interface UserCompositionSnapshotV1 {
  current: CompositionGenerationV1;
  lastKnownGood: CompositionGenerationV1;
}

/** The RPC surface the User Durable Object exposes for its Composition. */
export interface UserCompositionRpcV1 {
  readComposition(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<UserCompositionSnapshotV1>;
  readCompositionGeneration(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
  }): Promise<CompositionGenerationV1 | undefined>;
  proposeComposition(request: {
    schemaVersion: 1;
    userId: string;
    generation: CompositionGenerationV1;
    pin?: boolean;
    expectedCurrentGenerationId?: string;
  }): Promise<void>;
  commitComposition(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
  }): Promise<void>;
  failComposition(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
    quarantined: boolean;
  }): Promise<void>;
  revertComposition(request: {
    schemaVersion: 1;
    userId: string;
    toGenerationId: string;
    origin: Extract<CompositionOriginV1, { kind: "revert" }>;
  }): Promise<CompositionGenerationV1>;
  listCompositionGenerations(request: {
    schemaVersion: 1;
    userId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }>;
  recordCompositionFailure(request: {
    schemaVersion: 1;
    userId: string;
    failure: CompositionFailureInputV1;
  }): Promise<CompositionFailureOutcomeV1>;
  listCompositionFailures(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
  }): Promise<CompositionFailureV1[]>;
  readCompositionQuarantine(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
  }): Promise<CompositionQuarantineV1 | undefined>;
  clearCompositionFailures(request: {
    schemaVersion: 1;
    userId: string;
    generationId: string;
  }): Promise<void>;
}

export interface UserCompositionStateV1 {
  ctx: DurableObjectState;
}

/** The User object's store; one instance per object, built on first use. */
export function userCompositionStoreV1(
  state: UserCompositionStateV1,
): DurableCompositionStore {
  return new DurableCompositionStore({
    state: state.ctx,
    bootstrap: () =>
      bootstrapGeneration({ createdAt: new Date().toISOString() }),
  });
}

export function userCompositionFailuresV1(
  state: UserCompositionStateV1,
): DurableCompositionFailureLog {
  return new DurableCompositionFailureLog({ state: state.ctx });
}

/**
 * The pin and the fallback, read together so a Bot adopts a consistent pair.
 * The deployment's catalog is reconciled first, so a seeded Plugin the
 * account does not carry yet — or one an admin just opened — is in the
 * generation the next admitted Turn on any of this User's Bots pins.
 */
export async function readUserCompositionV1(
  state: UserCompositionStateV1,
  input: {
    userId: string;
    catalog: readonly SeededPluginV1[];
    adminOpened: readonly string[];
  },
): Promise<UserCompositionSnapshotV1> {
  const store = userCompositionStoreV1(state);
  await reconcileSeededCompositionV1({
    store,
    userId: input.userId,
    seeded: seededPluginsForAccountV1(input.catalog, input.adminOpened),
  });
  const current = await store.current();
  const lastKnownGood = await store.lastKnownGood();
  return {
    current: decodeCompositionGenerationV1(current),
    lastKnownGood: decodeCompositionGenerationV1(lastKnownGood),
  };
}

/** What a seeded member is compared by: the artifact the catalog ships now. */
function seededDiffersV1(
  current: readonly CompositionMemberV1[],
  seeded: readonly SeededPluginV1[],
): boolean {
  const carried = current.filter((member) => member.provenance.kind === "user");
  if (carried.length !== seeded.length) return true;
  return seeded.some((plugin) => {
    const member = carried.find(
      (candidate) => candidate.packageId === plugin.pluginId,
    );
    return (
      !member ||
      member.artifact.contentHash !== plugin.artifact.contentHash ||
      member.version !== plugin.descriptor.version
    );
  });
}

/**
 * Proposes a generation carrying exactly the seeded Plugins this account
 * should hold beside whatever its Bots wrote, when the current one does not.
 * Pinned for the next Turn; a lost race re-reads and tries once more, and a
 * second loss leaves the winner's generation, which the next read reconciles
 * again. Returns the generation proposed, or `undefined` when none was needed.
 */
export async function reconcileSeededCompositionV1(input: {
  store: Pick<CompositionStore, "current" | "propose">;
  userId: string;
  seeded: readonly SeededPluginV1[];
  now?: Date;
}): Promise<CompositionGenerationV1 | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await input.store.current();
    if (!seededDiffersV1(current.members, input.seeded)) return undefined;
    const createdAt = (input.now ?? new Date()).toISOString();
    const authored = current.members.filter(
      (member) => member.provenance.kind !== "user",
    );
    const members = [
      ...authored,
      ...input.seeded.map((plugin) =>
        seededMemberV1(plugin, input.userId, createdAt),
      ),
    ].toSorted((left, right) => left.packageId.localeCompare(right.packageId));
    const artifactSetHash = await compositionArtifactSetHashV1(
      members,
      current.applets ?? [],
    );
    const generation = decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
      artifactSetHash,
      parentGenerationId: current.generationId,
      createdAt,
      origin: { kind: "bootstrap" },
      members,
      ...(current.applets && current.applets.length > 0
        ? { applets: current.applets }
        : {}),
      status: "pending",
    });
    try {
      await input.store.propose(generation, {
        pin: true,
        expectedCurrentGenerationId: current.generationId,
      });
      return generation;
    } catch (error) {
      if (!(error instanceof CompositionPinConflictError)) throw error;
    }
  }
  return undefined;
}
