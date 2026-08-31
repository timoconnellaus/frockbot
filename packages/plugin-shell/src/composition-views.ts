// The redacted hosted-client projection of the Bot's durable Composition
// generations. The durable record is kernel authority; what a User may see of
// it is Shell Package policy, so the projection lives here and never lets
// artifact bytes, manifest hashes, or loader identities cross the seam.
import {
  decodeCompositionGenerationViewV1,
  MAX_COMPOSITION_FAILURE_PAGE_V1,
  type CompositionGenerationViewV1,
  type CompositionMemberViewV1,
  type CompositionProvenanceViewV1,
} from "@frockbot/configuration-core";
import type {
  CompositionFailureV1,
  CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";

/**
 * SEAM — plan Step 5 (authoring). Once the Bot object holds
 * `authorship:intent:<effectId>` / `artifact:<contentHash>` records, the Shell
 * Contribution supplies a reader that returns the recorded TypeScript source
 * for an isolate member. Until those records exist, no reader is supplied and a
 * generation view carries its member list alone.
 */
export type CompositionMemberSourceReaderV1 = (
  member: CompositionMemberV1,
) => Promise<string | undefined>;

function provenanceView(
  member: CompositionMemberV1,
): CompositionProvenanceViewV1 {
  const provenance = member.provenance;
  if (provenance.kind === "first-party") return { kind: "first-party" };
  if (provenance.kind === "user") {
    return {
      kind: "user",
      userId: provenance.userId,
      authoredAt: provenance.authoredAt,
    };
  }
  return {
    kind: "bot",
    botId: provenance.botId,
    sessionId: provenance.sessionId,
    turnId: provenance.turnId,
    runId: provenance.runId,
    authoredAt: provenance.authoredAt,
  };
}

export interface ProjectCompositionGenerationInput {
  botId: string;
  generation: CompositionGenerationV1;
  currentGenerationId: string;
  /** Omitted for the list projection: only a single generation carries source. */
  readMemberSource?: CompositionMemberSourceReaderV1;
  /** Recorded activation failures for this generation, oldest attempt first. */
  failures?: readonly CompositionFailureV1[];
  /** Present once three consecutive failures quarantined this generation. */
  quarantine?: CompositionQuarantineV1;
}

/** One durable generation as the hosted client may see it. */
export async function projectCompositionGenerationV1(
  input: ProjectCompositionGenerationInput,
): Promise<CompositionGenerationViewV1> {
  const members: CompositionMemberViewV1[] = [];
  for (const member of input.generation.members) {
    const source = member.artifact
      ? await input.readMemberSource?.(member)
      : undefined;
    members.push({
      packageId: member.packageId,
      version: member.version,
      provenance: provenanceView(member),
      ...(member.artifact ? { contentHash: member.artifact.contentHash } : {}),
      ...(source === undefined ? {} : { source }),
    });
  }
  // Diagnostics carry artifact content hashes and loader identities, so the
  // view keeps only the repairable half of a failure: when, where, and why.
  const failures = (input.failures ?? [])
    .slice(-MAX_COMPOSITION_FAILURE_PAGE_V1)
    .map((failure) => ({
      attempt: failure.attempt,
      at: failure.at,
      phase: failure.phase,
      message: failure.message,
    }));
  // Decoding the projection is the seam check: a field the view does not
  // declare cannot reach a client through this function.
  return decodeCompositionGenerationViewV1({
    schemaVersion: 1,
    botId: input.botId,
    generationId: input.generation.generationId,
    createdAt: input.generation.createdAt,
    status: input.generation.status,
    origin: input.generation.origin,
    isCurrent: input.generation.generationId === input.currentGenerationId,
    members,
    failures,
    ...(input.quarantine === undefined
      ? {}
      : {
          quarantine: {
            quarantinedAt: input.quarantine.quarantinedAt,
            reason: input.quarantine.reason,
            failures: input.quarantine.failures,
          },
        }),
    ...(input.generation.parentGenerationId === undefined
      ? {}
      : { parentGenerationId: input.generation.parentGenerationId }),
  });
}
