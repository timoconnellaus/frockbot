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
import type { PackageIframeCompositionV1 } from "@frockbot/kernel-contracts";
import {
  isClientIframeContribution,
  type FrockBotManifest,
} from "@frockbot/kernel-composition";
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

/** One decoded manifest lookup shared by isolate mount and hosted UI views. */
export type CompositionMemberManifestReaderV1 = (
  member: CompositionMemberV1,
) => Promise<FrockBotManifest | undefined>;

/** What the shell attributes an iframe page to, by where its code came from. */
function iframeProvenanceV1(
  member: CompositionMemberV1,
): PackageIframeCompositionV1["contributions"][number]["provenance"] {
  if (member.provenance.kind === "bot") return "Bot-authored";
  if (member.provenance.kind === "first-party") return "FrockBot";
  return "User-installed";
}

/**
 * Project iframe Contributions from every artifact-backed member.
 *
 * The test is the artifact, not the provenance. "Every Contribution kind is
 * resolved from the manifest and an artifact, never from a switch over Package
 * identity" — a first-party Package that ships as an artifact-backed member
 * (ADR 0022 decision 8) has a manifest the Bot object holds and pages the
 * anonymous origin can serve, so there is nothing left for a provenance test
 * to decide. A first-party member with no artifact is in-process code whose
 * client Contribution is a compiled module, and it has no iframe page to show.
 */
export async function projectPackageIframeCompositionV1(input: {
  botId: string;
  generation: CompositionGenerationV1;
  readMemberManifest: CompositionMemberManifestReaderV1;
}): Promise<PackageIframeCompositionV1> {
  const contributions: PackageIframeCompositionV1["contributions"] = [];
  for (const member of input.generation.members) {
    if (member.artifact === undefined) continue;
    const manifest = await input.readMemberManifest(member);
    if (!manifest) continue;
    const client = manifest.contributions.client;
    if (!client || !isClientIframeContribution(client)) continue;
    contributions.push({
      packageId: member.packageId,
      displayName: manifest.displayName,
      provenance: iframeProvenanceV1(member),
      pages: client.pages.map((page) => ({
        id: page.id,
        artifact: { ...page.artifact },
        mounts: page.mounts.map((mount) => ({ ...mount })),
      })),
      entries: (client.entries ?? []).map((entry) => ({
        ...entry,
        opens: { ...entry.opens },
      })),
      declaredTools: (manifest.tools ?? []).map((tool) => tool.name),
    });
  }
  contributions.sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  return {
    schemaVersion: 1,
    botId: input.botId,
    generationId: input.generation.generationId,
    contributions,
  };
}

function provenanceView(
  member: CompositionMemberV1,
): CompositionProvenanceViewV1 {
  const provenance = member.provenance;
  if (provenance.kind === "first-party") return { kind: "first-party" };
  if (provenance.kind === "catalog") {
    return {
      kind: "catalog",
      catalogId: provenance.catalogId,
      catalogGeneration: provenance.catalogGeneration,
    };
  }
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
    ...(input.generation.summary === undefined
      ? {}
      : { summary: input.generation.summary }),
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
