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
  DurableCompositionFailureLog,
  DurableCompositionStore,
  decodeCompositionGenerationV1,
  type CompositionFailureInputV1,
  type CompositionFailureOutcomeV1,
  type CompositionFailureV1,
  type CompositionGenerationV1,
  type CompositionOriginV1,
  type CompositionQuarantineV1,
} from "@frockbot/core/durable";

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

/** The pin and the fallback, read together so a Bot adopts a consistent pair. */
export async function readUserCompositionV1(
  state: UserCompositionStateV1,
): Promise<UserCompositionSnapshotV1> {
  const store = userCompositionStoreV1(state);
  const current = await store.current();
  const lastKnownGood = await store.lastKnownGood();
  return {
    current: decodeCompositionGenerationV1(current),
    lastKnownGood: decodeCompositionGenerationV1(lastKnownGood),
  };
}
