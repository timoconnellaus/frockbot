// The durable records one authoring effect leaves in the Bot Durable Object,
// and the classifier that reads them after an eviction.
//
// Constitution, Durable effects: "A mutation ... records intent and an effect
// identifier ... before it runs, so recovery can read its outcome or classify
// it as unknown without repeating it." Bundling is that mutation. The intent is
// written first; the artifact record and the effect index are written together
// afterwards; recovery reads both and never re-bundles on a guess.

export const AUTHORSHIP_INTENT_PREFIX = "authorship:intent:";
export const AUTHORSHIP_ARTIFACT_PREFIX = "authorship:artifact:";
export const AUTHORSHIP_FAILURE_PREFIX = "authorship:failure:";
export const AUTHORSHIP_PACKAGE_PREFIX = "authorship:package:";
export const ARTIFACT_PREFIX = "artifact:";

export function authorshipIntentKey(effectId: string): string {
  return `${AUTHORSHIP_INTENT_PREFIX}${effectId}`;
}

/** effectId → contentHash. Written in the same transaction as `artifact:<hash>`. */
export function authorshipArtifactKey(effectId: string): string {
  return `${AUTHORSHIP_ARTIFACT_PREFIX}${effectId}`;
}

export function authorshipFailureKey(failureId: string): string {
  return `${AUTHORSHIP_FAILURE_PREFIX}${failureId}`;
}

export function authorshipPackageKey(packageId: string): string {
  return `${AUTHORSHIP_PACKAGE_PREFIX}${packageId}`;
}

export function artifactKey(contentHash: string): string {
  return `${ARTIFACT_PREFIX}${contentHash}`;
}

export interface AuthorshipIntentV1 {
  schemaVersion: 1;
  effectId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  packageId: string;
  version: string;
  /** sha-256 of the source text. The source itself is never durable state. */
  sourceHash: string;
  sourceBytes: number;
  recordedAt: string;
  status: "recorded";
}

/** The immutable content record for one Bot-authored artifact. */
export interface AuthoredArtifactRecordV1 {
  schemaVersion: 1;
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
  effectId: string;
  r2Key: string;
  provenance: {
    kind: "bot";
    packageId: string;
    version: string;
    botId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    authoredAt: string;
  };
  createdAt: string;
}

/** The latest recorded version of one authored Package identity. */
export interface AuthoredPackageRecordV1 {
  schemaVersion: 1;
  packageId: string;
  ordinal: number;
  version: string;
  contentHash: string;
  updatedAt: string;
}

/** A visible durable failure. Quota refusals and unknown effects both land here. */
export interface AuthoringFailureRecordV1 {
  schemaVersion: 1;
  failureId: string;
  effectId: string;
  botId: string;
  packageId: string;
  runId: string;
  phase: "quota" | "bundle" | "recovery" | "compose";
  reason: string;
  diagnostics: string[];
  recordedAt: string;
}

export function artifactR2KeyV1(contentHash: string): string {
  return `packages/${contentHash}.mjs`;
}

/**
 * The durable outcome of one authoring effect, written under
 * `authorship:artifact:<effectId>` in the same put as `artifact:<contentHash>`.
 * `generationId` is filled in once the generation has been recorded, so a
 * replay resolves to the same generation rather than proposing another.
 */
export type AuthoringEffectOutcomeV1 =
  | {
      schemaVersion: 1;
      status: "bundled";
      effectId: string;
      contentHash: string;
      version: string;
      generationId?: string;
    }
  | {
      schemaVersion: 1;
      status: "failed";
      effectId: string;
      failureId: string;
      reason: string;
    };

export type AuthoringEffectClassificationV1 =
  /** No intent recorded: the effect has not started and may run. */
  | { kind: "fresh" }
  /** The artifact exists and is addressed by hash: reuse it, never re-bundle. */
  | {
      kind: "settled";
      outcome: Extract<AuthoringEffectOutcomeV1, { status: "bundled" }>;
    }
  /** The bundler answered and refused. The same answer is replayed. */
  | { kind: "failed"; failureId: string; reason: string }
  /**
   * Intent exists with no recorded outcome. The bundler may or may not have
   * run; nothing durable says which. The effect is unknown and is reported,
   * not retried.
   */
  | { kind: "unknown"; reason: string };

/**
 * Reads one authoring effect's durable trail. Pure, so the eviction window it
 * exists for is testable without a Durable Object.
 */
export function classifyAuthoringEffectV1(input: {
  intent: AuthorshipIntentV1 | undefined;
  outcome: AuthoringEffectOutcomeV1 | undefined;
}): AuthoringEffectClassificationV1 {
  if (input.outcome) {
    if (!input.intent) {
      return {
        kind: "unknown",
        reason:
          "an authoring outcome is recorded for an effect with no recorded intent",
      };
    }
    return input.outcome.status === "bundled"
      ? { kind: "settled", outcome: input.outcome }
      : {
          kind: "failed",
          failureId: input.outcome.failureId,
          reason: input.outcome.reason,
        };
  }
  if (!input.intent) return { kind: "fresh" };
  return {
    kind: "unknown",
    reason: `authoring effect "${input.intent.effectId}" recorded its intent but has no durable outcome; it will not be bundled again`,
  };
}
