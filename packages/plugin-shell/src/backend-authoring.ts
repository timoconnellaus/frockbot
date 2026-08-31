// The Bot Durable Object half of Package authoring.
//
// The Authoring Package holds no authority: it decodes the model's input and
// records the session events. Everything durable happens here, in the Package
// that owns the Bot object's state, and in this order (constitution, Durable
// effects — intent before effect):
//
//   reserve a per-User quota unit → write `authorship:intent:<effectId>` →
//   call `PACKAGE_BUNDLER` → write `artifact:<contentHash>` and put the module
//   to the Package artifact store → build the `provenance.kind: "bot"` member →
//   propose the new Composition generation, pinned for the *next* Turn.
//
// The authoring Turn keeps running on the generation it was admitted under.
// Nothing here mutates a recorded generation or a recorded artifact: a
// re-authored Package appends a version and supersedes its predecessor inside
// a new generation.
import {
  decodePackageBundleResultV1,
  type PackageBundleRequestV1,
  type PackageBundlerBinding,
} from "@frockbot/kernel-contracts";
import { canonicalJson, sha256 } from "@frockbot/kernel-composition/compiler";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import {
  artifactKey,
  artifactR2KeyV1,
  authoredManifestV1,
  authoredSpecifierV1,
  authoredVersionV1,
  authoringEffectIdV1,
  authoringQuotaDayV1,
  authorshipArtifactKey,
  authorshipFailureKey,
  authorshipIntentKey,
  authorshipPackageKey,
  classifyAuthoringEffectV1,
  type AuthoredArtifactRecordV1,
  type AuthoredPackageRecordV1,
  type AuthoringEffectOutcomeV1,
  type AuthoringFailureRecordV1,
  type AuthoringQuotaBinding,
  type AuthorPackageOutcomeV1,
  type AuthorPackageRequestV1,
  type AuthorshipIntentV1,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring";

/** The narrow Bot Durable Object storage surface authoring needs. */
export interface AuthoringStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

/** The Composition surface authoring needs; `DurableCompositionStore` satisfies it. */
export interface AuthoringCompositionStore {
  current(): Promise<CompositionGenerationV1>;
  read(generationId: string): Promise<CompositionGenerationV1 | undefined>;
  propose(
    generation: CompositionGenerationV1,
    options?: { pin?: boolean },
  ): Promise<void>;
  retainedCount(): Promise<number>;
}

/** Immutable content, written once and addressed by hash. */
export interface AuthoringArtifactStore {
  putPackageArtifact(contentHash: string, module: string): Promise<void>;
  headPackageArtifact(
    contentHash: string,
  ): Promise<{ contentHash: string; size: number } | undefined>;
}

export interface PackageAuthoringHostOptions {
  storage: AuthoringStorage;
  composition: AuthoringCompositionStore;
  /** Absent when this host has no bundler; authoring then refuses visibly. */
  bundler?: PackageBundlerBinding;
  /** Absent when this host has no artifact store; authoring then refuses visibly. */
  artifacts?: AuthoringArtifactStore;
  quota: AuthoringQuotaBinding;
  userId: string;
  botId: string;
  runId: string;
  turnId: string;
  compatibilityDate: string;
  now?(): Date;
  newId?(): string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the authoring seam one admitted Turn runs under. Constructed per
 * Turn because provenance names the run and turn that produced the artifact.
 */
export function createPackageAuthoringHost(
  options: PackageAuthoringHostOptions,
): PackageAuthoringHost {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  async function recordFailure(input: {
    effectId: string;
    packageId: string;
    phase: AuthoringFailureRecordV1["phase"];
    reason: string;
    diagnostics?: string[];
  }): Promise<AuthoringFailureRecordV1> {
    const failureId = `authoring-failure-${newId()}`;
    const record: AuthoringFailureRecordV1 = {
      schemaVersion: 1,
      failureId,
      effectId: input.effectId,
      botId: options.botId,
      packageId: input.packageId,
      runId: options.runId,
      phase: input.phase,
      reason: input.reason,
      diagnostics: input.diagnostics ?? [],
      recordedAt: now().toISOString(),
    };
    await options.storage.put({ [authorshipFailureKey(failureId)]: record });
    return record;
  }

  function refused(
    record: AuthoringFailureRecordV1,
  ): Extract<AuthorPackageOutcomeV1, { status: "refused" }> {
    return {
      status: "refused",
      reason: record.reason,
      failureId: record.failureId,
    };
  }

  /**
   * The member set of the next generation: every member of the pinned-forward
   * current generation except the one this Package supersedes, plus the new
   * one. A recorded generation is never edited.
   */
  async function nextGeneration(input: {
    member: CompositionMemberV1;
    createdAt: string;
    sessionId: string;
  }): Promise<{
    generation: CompositionGenerationV1;
    supersededVersion?: string;
  }> {
    const parent = await options.composition.current();
    const superseded = parent.members.find(
      (member) => member.packageId === input.member.packageId,
    );
    const members = [
      ...parent.members.filter(
        (member) => member.packageId !== input.member.packageId,
      ),
      input.member,
    ].sort((left, right) => left.packageId.localeCompare(right.packageId));
    const artifactSetHash = await compositionArtifactSetHashV1(members);
    const generation = decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(input.createdAt, artifactSetHash),
      artifactSetHash,
      parentGenerationId: parent.generationId,
      createdAt: input.createdAt,
      origin: {
        kind: "bot-authored",
        runId: options.runId,
        sessionId: input.sessionId,
        turnId: options.turnId,
      },
      members,
      status: "pending",
    });
    return {
      generation,
      ...(superseded ? { supersededVersion: superseded.version } : {}),
    };
  }

  async function compose(input: {
    request: AuthorPackageRequestV1;
    outcome: Extract<AuthoringEffectOutcomeV1, { status: "bundled" }>;
    artifact: AuthoredArtifactRecordV1;
  }): Promise<AuthorPackageOutcomeV1> {
    const { request, outcome, artifact } = input;
    if (outcome.generationId) {
      const recorded = await options.composition.read(outcome.generationId);
      if (recorded) {
        return {
          status: "authored",
          packageId: request.input.packageId,
          version: outcome.version,
          contentHash: outcome.contentHash,
          generationId: recorded.generationId,
        };
      }
    }
    const manifest = authoredManifestV1({
      packageId: request.input.packageId,
      displayName: request.input.displayName,
      version: outcome.version,
      tool: request.input.tool,
      ...(request.input.model ? { model: request.input.model } : {}),
    });
    const member: CompositionMemberV1 = {
      packageId: request.input.packageId,
      specifier: authoredSpecifierV1(request.input.packageId),
      version: outcome.version,
      manifestHash: await sha256(canonicalJson(manifest)),
      provenance: artifact.provenance,
      artifact: {
        contentHash: artifact.contentHash,
        size: artifact.size,
        mediaType: artifact.mediaType,
        bundlerVersion: artifact.bundlerVersion,
      },
    };
    const { generation, supersededVersion } = await nextGeneration({
      member,
      createdAt: artifact.provenance.authoredAt,
      sessionId: request.sessionId,
    });
    if (!(await options.composition.read(generation.generationId))) {
      await options.composition.propose(generation, { pin: true });
    }
    await options.storage.put({
      [authorshipArtifactKey(request.effectId)]: {
        ...outcome,
        generationId: generation.generationId,
      } satisfies AuthoringEffectOutcomeV1,
    });
    return {
      status: "authored",
      packageId: request.input.packageId,
      version: outcome.version,
      contentHash: outcome.contentHash,
      generationId: generation.generationId,
      ...(supersededVersion ? { supersededVersion } : {}),
    };
  }

  return {
    effectIdFor: (input) =>
      authoringEffectIdV1({
        runId: options.runId,
        packageId: input.packageId,
        sourceHash: input.sourceHash,
      }),

    async author(
      request: AuthorPackageRequestV1,
    ): Promise<AuthorPackageOutcomeV1> {
      const { effectId } = request;
      const packageId = request.input.packageId;
      const intent = await options.storage.get<AuthorshipIntentV1>(
        authorshipIntentKey(effectId),
      );
      const recordedOutcome =
        await options.storage.get<AuthoringEffectOutcomeV1>(
          authorshipArtifactKey(effectId),
        );
      const classification = classifyAuthoringEffectV1({
        intent,
        outcome: recordedOutcome,
      });

      if (classification.kind === "unknown") {
        // The bundler may have run. Nothing durable says so, and a blind
        // re-bundle would duplicate the effect, so it is reported instead.
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "recovery",
            reason: classification.reason,
          }),
        );
      }
      if (classification.kind === "failed") {
        return {
          status: "refused",
          reason: classification.reason,
          failureId: classification.failureId,
        };
      }
      if (classification.kind === "settled") {
        const artifact = await options.storage.get<AuthoredArtifactRecordV1>(
          artifactKey(classification.outcome.contentHash),
        );
        if (!artifact) {
          return refused(
            await recordFailure({
              effectId,
              packageId,
              phase: "recovery",
              reason: `authoring effect "${effectId}" names artifact "${classification.outcome.contentHash}", which has no durable record`,
            }),
          );
        }
        return await compose({
          request,
          outcome: classification.outcome,
          artifact,
        });
      }

      if (!options.bundler || !options.artifacts) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "compose",
            reason:
              "this host cannot author Packages: it has no Package bundler or artifact store",
          }),
        );
      }

      const previous = await options.storage.get<AuthoredPackageRecordV1>(
        authorshipPackageKey(packageId),
      );
      const ordinal = (previous?.ordinal ?? 0) + 1;
      const version = authoredVersionV1(ordinal);
      const sourceBytes = new TextEncoder().encode(
        request.input.source,
      ).byteLength;
      const recordedAt = now().toISOString();

      // The User Durable Object is the authority for User-scoped quotas, and
      // it is asked before any durable intent is written here.
      const receipt = await options.quota.reserve({
        schemaVersion: 1,
        userId: options.userId,
        botId: options.botId,
        effectId,
        day: authoringQuotaDayV1(new Date(recordedAt)),
        sourceBytes,
        retainedGenerations: await options.composition.retainedCount(),
      });
      if (receipt.status === "refused") {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "quota",
            reason: `a durable per-User quota refused this Package: ${receipt.reason}`,
            diagnostics: [
              `limit=${receipt.limitName}`,
              `used=${receipt.used}`,
              `allowed=${receipt.limit}`,
            ],
          }),
        );
      }

      const recordedIntent: AuthorshipIntentV1 = {
        schemaVersion: 1,
        effectId,
        botId: options.botId,
        sessionId: request.sessionId,
        runId: options.runId,
        turnId: options.turnId,
        packageId,
        version,
        sourceHash: request.sourceHash,
        sourceBytes,
        recordedAt,
        status: "recorded",
      };
      await options.storage.put({
        [authorshipIntentKey(effectId)]: recordedIntent,
      });

      const bundleRequest: PackageBundleRequestV1 = {
        schemaVersion: 1,
        effectId,
        target: "bot-isolate",
        compatibilityDate: options.compatibilityDate,
        entry: "package.ts",
        sources: [{ path: "package.ts", text: request.input.source }],
      };
      let bundled;
      try {
        // Never inside a storage transaction: bundler CPU is the bundler's.
        bundled = decodePackageBundleResultV1(
          await options.bundler.bundle(bundleRequest),
        );
      } catch (error) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "bundle",
            reason: `the Package bundler could not be reached: ${errorMessage(error)}`,
          }),
        );
      }
      if (bundled.status === "failed") {
        const failure = await recordFailure({
          effectId,
          packageId,
          phase: "bundle",
          reason: `the Package bundler rejected this source: ${bundled.failure}`,
          diagnostics: bundled.diagnostics,
        });
        // A deterministic refusal is itself the effect's outcome: a replay
        // must reproduce it rather than classify the effect unknown.
        await options.storage.put({
          [authorshipArtifactKey(effectId)]: {
            schemaVersion: 1,
            status: "failed",
            effectId,
            failureId: failure.failureId,
            reason: failure.reason,
          } satisfies AuthoringEffectOutcomeV1,
        });
        return refused(failure);
      }

      const { artifact } = bundled;
      // Content-addressed and immutable: writing the same hash twice is a
      // no-op, so the object write is safe to repeat and the record is not.
      await options.artifacts.putPackageArtifact(
        artifact.contentHash,
        bundled.module,
      );
      const artifactRecord: AuthoredArtifactRecordV1 = {
        schemaVersion: 1,
        contentHash: artifact.contentHash,
        size: artifact.size,
        mediaType: artifact.mediaType,
        bundlerVersion: artifact.bundlerVersion,
        effectId,
        r2Key: artifactR2KeyV1(artifact.contentHash),
        provenance: {
          kind: "bot",
          packageId,
          version,
          botId: options.botId,
          sessionId: request.sessionId,
          turnId: options.turnId,
          runId: options.runId,
          authoredAt: recordedAt,
        },
        createdAt: recordedAt,
      };
      const outcome: Extract<AuthoringEffectOutcomeV1, { status: "bundled" }> =
        {
          schemaVersion: 1,
          status: "bundled",
          effectId,
          contentHash: artifact.contentHash,
          version,
        };
      await options.storage.put({
        [artifactKey(artifact.contentHash)]: artifactRecord,
        [authorshipArtifactKey(effectId)]: outcome,
        [authorshipPackageKey(packageId)]: {
          schemaVersion: 1,
          packageId,
          ordinal,
          version,
          contentHash: artifact.contentHash,
          updatedAt: recordedAt,
        } satisfies AuthoredPackageRecordV1,
      });
      return await compose({ request, outcome, artifact: artifactRecord });
    },
  };
}

/**
 * The Package artifact store over the `APPLICATION_ARTIFACTS` bucket. Writes
 * are content-addressed, so repeating one is a no-op rather than a mutation.
 */
export function createR2AuthoringArtifactStore(
  bucket: R2Bucket,
): AuthoringArtifactStore {
  return {
    async putPackageArtifact(contentHash: string, module: string) {
      await bucket.put(artifactR2KeyV1(contentHash), module, {
        httpMetadata: { contentType: "application/javascript" },
      });
    },
    async headPackageArtifact(contentHash: string) {
      const object = await bucket.head(artifactR2KeyV1(contentHash));
      return object ? { contentHash, size: object.size } : undefined;
    },
  };
}
