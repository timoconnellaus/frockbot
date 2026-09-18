// The User's Composition: the installed Plugin set, its generations, the last
// known good and the quarantine. The User Durable Object owns them (ADR 0026);
// a Bot mirrors the pin before every admission and holds only its own enable
// map beside it.
//
// This module is the User half: the store over the User object's storage and
// the RPC surface a Bot reaches it through. Nothing here knows a Bot's
// identity beyond the User it belongs to.
import { canonicalJson } from "@frockbot/core/contracts";
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
  installedMemberV1,
  seededMemberV1,
  seededPluginsForAccountV1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";
import { pluginServedProvidersForPackageV1 } from "@frockbot/providers/catalog/definition";

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
    /**
     * The account's installed Package ids, when the caller has them. This read
     * is the one a Bot makes before admitting a Turn, so it is also where a
     * Plugin installation is reconciled: a command that could not propose a
     * generation — a lost race, a transient storage failure — is repaired
     * here, and a catalog artifact the deployment updated reaches the next
     * Turn through the same path. A failure here is the caller's to see, not
     * something to read past: the Bot keeps the pin it mirrored last.
     */
    installedPackageIds?: readonly string[];
  },
): Promise<UserCompositionSnapshotV1> {
  const store = userCompositionStoreV1(state);
  await reconcileSeededCompositionV1({
    store,
    userId: input.userId,
    seeded: seededPluginsForAccountV1(input.catalog, input.adminOpened),
  });
  await reconcileInstalledProviderPluginsV1({
    store,
    userId: input.userId,
    catalog: input.catalog,
    installedPackageIds: input.installedPackageIds ?? [],
  });
  const current = await store.current();
  const lastKnownGood = await store.lastKnownGood();
  return {
    current: decodeCompositionGenerationV1(current),
    lastKnownGood: decodeCompositionGenerationV1(lastKnownGood),
  };
}

/**
 * The timestamp one proposal is stamped with.
 *
 * A generation id is derived from it together with the artifact set, and the
 * store never rewrites a generation it already holds, so a stamp must be
 * later than every stamp already in play: the clock's own reading, the
 * generation this proposal derives from, and the attempt before it. Without
 * that, an install and the uninstall that follows it in the same millisecond
 * — or two reads under a fixed test clock — would propose one id twice.
 */
function nextCreatedAtV1(
  now: Date | undefined,
  currentCreatedAt: string,
  previous: number,
): string {
  const at = Math.max(
    (now ?? new Date()).getTime(),
    Date.parse(currentCreatedAt) + 1,
    previous + 1,
  );
  return new Date(at).toISOString();
}

/**
 * Whether a member is the one a catalog entry ships: the same artifact and the
 * same descriptor, the two things a member is beside its provenance.
 *
 * The descriptor is not decoration. The runtime reads the contract version,
 * the grants and the slots off the member, and a Bot reads the Skills off it,
 * so a catalog entry that moved any of them must reach an account still
 * carrying the old descriptor — even when the module bytes are untouched, as
 * they are when only the descriptor moved.
 */
function memberShipsFromCatalogV1(
  member: CompositionMemberV1,
  plugin: SeededPluginV1,
): boolean {
  return (
    member.packageId === plugin.pluginId &&
    canonicalJson(member.artifact) === canonicalJson(plugin.artifact) &&
    canonicalJson(member.descriptor) === canonicalJson(plugin.descriptor)
  );
}

/** Whether the seeded set an account carries is the one the catalog ships. */
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
    return !member || !memberShipsFromCatalogV1(member, plugin);
  });
}

/**
 * The provider Plugins this account installed with its own package command
 * (ADR 0032), reconciled into its Composition.
 *
 * Installing the Package a provider Plugin belongs to is what installs the
 * Plugin: the artifact is the deployment's own, the decision is the User's,
 * and no operator and no default is involved. Reconciliation is idempotent
 * and touches only members with `installed` provenance, so it neither drops a
 * seeded Plugin nor disturbs one the account deliberately installed. A
 * deployment that cannot mount a Plugin installs none — the model call then
 * fails with the sentence that names the missing Plugin rather than a
 * generation nothing can run.
 */
export async function reconcileInstalledProviderPluginsV1(input: {
  store: Pick<CompositionStore, "current" | "propose">;
  userId: string;
  catalog: readonly SeededPluginV1[];
  /** The account's installed Package ids, as its settings read them. */
  installedPackageIds: readonly string[];
  now?: Date;
}): Promise<CompositionGenerationV1 | undefined> {
  const wanted = input.catalog.filter(
    (plugin) =>
      plugin.seed === "installable" &&
      input.installedPackageIds.some((packageId) =>
        pluginServedProvidersForPackageV1(packageId).some(
          (entry) => entry.pluginId === plugin.pluginId,
        ),
      ),
  );
  let lastCreatedAt = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await input.store.current();
    const carried = current.members.filter(
      (member) => member.provenance.kind === "installed",
    );
    const settled =
      carried.length === wanted.length &&
      wanted.every((plugin) =>
        carried.some((member) => memberShipsFromCatalogV1(member, plugin)),
      );
    if (settled) return undefined;
    const createdAt = nextCreatedAtV1(
      input.now,
      current.createdAt,
      lastCreatedAt,
    );
    lastCreatedAt = Date.parse(createdAt);
    const members = [
      ...current.members.filter(
        (member) => member.provenance.kind !== "installed",
      ),
      ...wanted.map((plugin) =>
        installedMemberV1(plugin, input.userId, createdAt),
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
  let lastCreatedAt = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await input.store.current();
    if (!seededDiffersV1(current.members, input.seeded)) return undefined;
    const createdAt = nextCreatedAtV1(
      input.now,
      current.createdAt,
      lastCreatedAt,
    );
    lastCreatedAt = Date.parse(createdAt);
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
