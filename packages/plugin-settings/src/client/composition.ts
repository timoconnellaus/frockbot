// Hosted-client policy over the redacted Composition views. The Bot Durable
// Object stays the authority: everything here is a projection of records it
// returned, or an optimistic echo of a command it has not yet answered.
import type {
  CompositionCommandReceiptV1,
  CompositionDiffV1,
  CompositionGenerationViewV1,
  CompositionMemberDiffV1,
  CompositionMemberViewV1,
  CompositionOriginViewV1,
  CompositionProvenanceViewV1,
} from "@frockbot/configuration-core";

/** Marks a generation the client drew before the authority answered. */
export const OPTIMISTIC_GENERATION_PREFIX = "pending-revert:";

export function isOptimisticGenerationV1(
  generation: CompositionGenerationViewV1,
): boolean {
  return generation.generationId.startsWith(OPTIMISTIC_GENERATION_PREFIX);
}

function memberVersion(member: CompositionMemberViewV1) {
  return {
    version: member.version,
    ...(member.contentHash === undefined
      ? {}
      : { contentHash: member.contentHash }),
  };
}

/**
 * Member-by-member diff between two generations, sorted by Package id. A
 * Package present in both is `changed` when its version or its artifact content
 * hash moved, and `unchanged` otherwise.
 */
export function compositionGenerationDiffV1(
  from: CompositionGenerationViewV1,
  to: CompositionGenerationViewV1,
): CompositionDiffV1 {
  const before = new Map(
    from.members.map((member) => [member.packageId, member] as const),
  );
  const after = new Map(
    to.members.map((member) => [member.packageId, member] as const),
  );
  const packageIds = [...new Set([...before.keys(), ...after.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  const members: CompositionMemberDiffV1[] = packageIds.map((packageId) => {
    const left = before.get(packageId);
    const right = after.get(packageId);
    if (left && !right) {
      return { packageId, change: "removed", from: memberVersion(left) };
    }
    if (!left && right) {
      return { packageId, change: "added", to: memberVersion(right) };
    }
    const fromVersion = memberVersion(left!);
    const toVersion = memberVersion(right!);
    return {
      packageId,
      change:
        fromVersion.version === toVersion.version &&
        fromVersion.contentHash === toVersion.contentHash
          ? "unchanged"
          : "changed",
      from: fromVersion,
      to: toVersion,
    };
  });
  return {
    fromGenerationId: from.generationId,
    toGenerationId: to.generationId,
    members,
  };
}

/** Who authored this member: first-party, the User, or the Bot itself. */
export function describeCompositionProvenanceV1(
  provenance: CompositionProvenanceViewV1,
): string {
  if (provenance.kind === "first-party") return "First-party";
  if (provenance.kind === "user") return `User ${provenance.userId}`;
  return `Bot ${provenance.botId} · session ${provenance.sessionId} · turn ${provenance.turnId}`;
}

/** Why this generation exists. */
export function describeCompositionOriginV1(
  origin: CompositionOriginViewV1,
): string {
  if (origin.kind === "bootstrap") return "First-party bootstrap";
  if (origin.kind === "user-install") return `Installed by ${origin.userId}`;
  if (origin.kind === "revert") {
    return `Reverted to ${origin.revertsTo} by ${origin.userId}`;
  }
  return `Authored by the Bot · session ${origin.sessionId} · turn ${origin.turnId}`;
}

export interface OptimisticRevertInput {
  generations: readonly CompositionGenerationViewV1[];
  botId: string;
  toGenerationId: string;
  commandId: string;
  createdAt: string;
  userId: string;
}

/**
 * The pending generation a revert will create, drawn before the authority
 * answers. It carries the target's members because that is exactly what
 * `CompositionStore.revert` records.
 */
export function optimisticRevertGenerationsV1(
  input: OptimisticRevertInput,
): CompositionGenerationViewV1[] {
  const target = input.generations.find(
    (generation) => generation.generationId === input.toGenerationId,
  );
  if (!target) throw new Error("The selected generation is no longer listed");
  const current = input.generations.find((generation) => generation.isCurrent);
  const optimistic: CompositionGenerationViewV1 = {
    schemaVersion: 1,
    botId: input.botId,
    generationId: `${OPTIMISTIC_GENERATION_PREFIX}${input.commandId}`,
    createdAt: input.createdAt,
    status: "pending",
    isCurrent: false,
    origin: {
      kind: "revert",
      revertsTo: input.toGenerationId,
      userId: input.userId,
    },
    members: target.members.map((member) => ({ ...member })),
    ...(current ? { parentGenerationId: current.generationId } : {}),
  };
  return [optimistic, ...input.generations];
}

export interface ReconciledRevert {
  generations: CompositionGenerationViewV1[];
  failure?: string;
}

/**
 * Reconciles the optimistic entry with the receipt the authority returned: the
 * durable generation id replaces the optimistic one, or the entry is dropped
 * and the rejection surfaced.
 */
export function reconcileCompositionRevertV1(input: {
  generations: readonly CompositionGenerationViewV1[];
  commandId: string;
  receipt: CompositionCommandReceiptV1;
}): ReconciledRevert {
  const optimisticId = `${OPTIMISTIC_GENERATION_PREFIX}${input.commandId}`;
  if (input.receipt.status === "rejected") {
    return {
      generations: input.generations.filter(
        (generation) => generation.generationId !== optimisticId,
      ),
      failure: input.receipt.failure,
    };
  }
  const generationId = input.receipt.generationId;
  return {
    generations: input.generations.map((generation) =>
      generation.generationId === optimisticId
        ? { ...generation, generationId }
        : generation,
    ),
  };
}
