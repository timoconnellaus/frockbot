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
  BOT_ISOLATE_CONTEXT_DTS_V1,
  decodePackageBundleResultV1,
  PACKAGE_UI_ARTIFACT_VERSION,
  PACKAGE_IFRAME_BRIDGE_DTS_V1,
  PACKAGE_IFRAME_HELPER_JS_V1,
  type PackageBundleRequestV1,
  type PackageBundlerBinding,
} from "@frockbot/kernel-contracts";
import type {
  CompositionFailureV1,
  CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import { canonicalJson, sha256 } from "@frockbot/kernel-composition/compiler";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import {
  artifactKey,
  artifactR2KeyV1,
  authoredManifestV1,
  authoredSpecifierV1,
  authoredVersionV1,
  authoringEffectIdV1,
  packageUndoEffectIdV1,
  authoringQuotaDayV1,
  authorshipArtifactKey,
  authorshipFailureKey,
  authorshipIntentKey,
  authorshipLatestFailureKey,
  authorshipManifestKey,
  authorshipPackageKey,
  authorshipUndoIntentKey,
  authorshipUndoOutcomeKey,
  classifyAuthoringEffectV1,
  type AuthoredArtifactRecordV1,
  type AuthoredManifestRecordV1,
  type AuthoredPackageRecordV1,
  type AuthoringEffectOutcomeV1,
  type AuthoringFailureRecordV1,
  type AuthoringQuotaBinding,
  type AuthorPackageOutcomeV1,
  type AuthorPackageRequestV1,
  type AuthorshipIntentV1,
  type PackageAuthoringHost,
  type PackageInspectFailureV1,
  type PackageInspectSelfOutcomeV1,
  type PackageUndoIntentV1,
  type PackageUndoOutcomeV1,
  type PackageUndoRecordV1,
  type PackageUndoRequestV1,
  sourceR2KeyV1,
} from "@frockbot/plugin-authoring";

/** The narrow Bot Durable Object storage surface authoring needs. */
export interface AuthoringStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list?<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** The Composition surface authoring needs; `DurableCompositionStore` satisfies it. */
export interface AuthoringCompositionStore {
  current(): Promise<CompositionGenerationV1>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  read(generationId: string): Promise<CompositionGenerationV1 | undefined>;
  propose(
    generation: CompositionGenerationV1,
    options?: { pin?: boolean },
  ): Promise<void>;
  retainedCount(): Promise<number>;
  revert(
    toGenerationId: string,
    origin: {
      kind: "revert";
      revertsTo: string;
      botId: string;
      runId: string;
      turnId: string;
    },
    options?: { createdAt?: string },
  ): Promise<CompositionGenerationV1>;
  list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }>;
}

/** Immutable content, written once and addressed by hash. */
export interface AuthoringArtifactStore {
  putPackageArtifact(contentHash: string, module: string): Promise<void>;
  putPackageUiArtifact?(contentHash: string, html: string): Promise<void>;
  putPackageSource(sourceHash: string, source: string): Promise<void>;
  loadPackageSource(sourceHash: string): Promise<string | undefined>;
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
  /** The mounted root's exact catalog, read only when `author` is called. */
  currentToolNames?(): readonly string[];
  /** The generation actually mounted after fail-closed fallback. */
  mountedGeneration?(): CompositionGenerationV1 | undefined;
  activationFailures?: {
    list(generationId: string): Promise<CompositionFailureV1[]>;
    quarantine(
      generationId: string,
    ): Promise<CompositionQuarantineV1 | undefined>;
  };
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
    await options.storage.put({
      [authorshipFailureKey(failureId)]: record,
      [authorshipLatestFailureKey(input.packageId)]: record,
    });
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

  async function undoRefused(
    record: AuthoringFailureRecordV1,
  ): Promise<Extract<PackageUndoOutcomeV1, { status: "refused" }>> {
    const outcome = {
      status: "refused",
      reason: record.reason,
      failureId: record.failureId,
    } as const;
    await options.storage.put({
      [authorshipUndoOutcomeKey(record.effectId)]: {
        schemaVersion: 1,
        effectId: record.effectId,
        failureId: record.failureId,
        reason: record.reason,
        recordedAt: record.recordedAt,
        status: "refused",
      } satisfies PackageUndoRecordV1,
    });
    return outcome;
  }

  /**
   * The constitutional shadowing rule: a Bot authors only over its own
   * Packages. A member of the current Composition whose provenance is
   * first-party or User is not the Bot's to supersede, so authoring that
   * `packageId` is refused before any durable effect. Superseding the Bot's
   * own prior version is the ordinary re-authoring path and passes.
   */
  async function shadowedMember(
    packageId: string,
  ): Promise<CompositionMemberV1 | undefined> {
    const current = await options.composition.current();
    const lastKnownGood = await options.composition.lastKnownGood();
    return [current, lastKnownGood]
      .flatMap((generation) => generation.members)
      .find(
        (member) =>
          member.packageId === packageId && member.provenance.kind !== "bot",
      );
  }

  async function storedManifest(
    member: CompositionMemberV1,
  ): Promise<AuthoredManifestRecordV1 | undefined> {
    if (member.provenance.kind !== "bot") return undefined;
    const stored = await options.storage.get<AuthoredManifestRecordV1>(
      authorshipManifestKey(member.manifestHash),
    );
    if (
      !stored ||
      stored.manifestHash !== member.manifestHash ||
      stored.packageId !== member.packageId ||
      stored.version !== member.version
    ) {
      return undefined;
    }
    return stored;
  }

  async function compositionHistory(): Promise<CompositionGenerationV1[]> {
    const generations: CompositionGenerationV1[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await options.composition.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      generations.push(...page.generations);
      if (!page.cursor) return generations;
      if (page.cursor === cursor) {
        throw new Error("Composition history returned a repeated cursor");
      }
      cursor = page.cursor;
    }
    throw new Error("Composition history exceeds its durable bound");
  }

  /**
   * A declaration that would collide is refused before quota reservation.
   * Re-authoring may keep or rename tools owned by that same Package, so its
   * currently stored declarations are subtracted from the mounted catalog;
   * every first-party tool and every other authored Package remains reserved.
   *
   * The comparison is on bare names. Since ADR 0023 the mounted catalog
   * reports a progressively disclosed tool as `namespace/name`, while a Package
   * declares bare names, so comparing the two directly matches nothing and the
   * guard silently stops refusing anything. Stripping the namespace keeps the
   * rule this guard has always enforced — a Bot-authored tool name may not
   * shadow one already registered — rather than quietly relaxing it as a side
   * effect of a disclosure change.
   */
  async function collidingToolName(
    packageId: string,
    declaredNames: readonly string[],
  ): Promise<string | undefined> {
    const registered = new Set(
      (options.currentToolNames?.() ?? []).map((name) => {
        const separator = name.indexOf("/");
        return separator < 0 ? name : name.slice(separator + 1);
      }),
    );
    const mounted =
      options.mountedGeneration?.() ??
      (await options.composition.lastKnownGood());
    const own = mounted.members.find(
      (member) =>
        member.packageId === packageId && member.provenance.kind === "bot",
    );
    if (own) {
      const recorded = await storedManifest(own);
      const manifest = recorded
        ? decodeFrockBotManifest(recorded.manifest)
        : undefined;
      for (const tool of manifest?.tools ?? []) registered.delete(tool.name);
    }
    return declaredNames.find((name) => registered.has(name));
  }

  /**
   * New authoring always branches from last-known-good, replacing only the
   * Package being authored. This deliberately drops every pending, failed, or
   * quarantined proposal: a broken member can be repaired by re-authoring its
   * packageId, but it can never poison a later, unrelated generation.
   */
  async function nextGeneration(input: {
    member: CompositionMemberV1;
    createdAt: string;
    sessionId: string;
  }): Promise<{
    generation: CompositionGenerationV1;
    supersededVersion?: string;
  }> {
    const parent = await options.composition.lastKnownGood();
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
    intent: AuthorshipIntentV1;
    outcome: Extract<AuthoringEffectOutcomeV1, { status: "bundled" }>;
    artifact: AuthoredArtifactRecordV1;
  }): Promise<AuthorPackageOutcomeV1> {
    const { request, intent, outcome, artifact } = input;
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
    const manifestRecord = await options.storage.get<AuthoredManifestRecordV1>(
      authorshipManifestKey(intent.manifestHash),
    );
    if (!manifestRecord) {
      return refused(
        await recordFailure({
          effectId: request.effectId,
          packageId: request.input.packageId,
          phase: "recovery",
          reason: `authoring effect "${request.effectId}" has no stored manifest "${intent.manifestHash}"`,
        }),
      );
    }
    const manifest = decodeFrockBotManifest(manifestRecord.manifest);
    if (
      manifestRecord.manifestHash !== intent.manifestHash ||
      manifest.id !== request.input.packageId ||
      manifest.version !== outcome.version
    ) {
      return refused(
        await recordFailure({
          effectId: request.effectId,
          packageId: request.input.packageId,
          phase: "recovery",
          reason: `stored manifest "${intent.manifestHash}" does not match this authoring effect`,
        }),
      );
    }
    const member: CompositionMemberV1 = {
      packageId: request.input.packageId,
      specifier: authoredSpecifierV1(request.input.packageId),
      version: outcome.version,
      manifestHash: intent.manifestHash,
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
        ...(input.uiPageHashes === undefined
          ? {}
          : { uiPageHashes: input.uiPageHashes }),
        ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
      }),

    undoEffectIdFor: (input) =>
      packageUndoEffectIdV1({
        runId: options.runId,
        ...(input.generationId ? { generationId: input.generationId } : {}),
      }),

    async author(
      request: AuthorPackageRequestV1,
    ): Promise<AuthorPackageOutcomeV1> {
      const { effectId } = request;
      const packageId = request.input.packageId;

      // Ahead of every other path, including a settled effect being composed
      // after recovery: a shadowed Package never reaches a generation.
      const shadowed = await shadowedMember(packageId);
      if (shadowed) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "compose",
            reason: `Package "${packageId}" is already in this Bot's Composition with ${shadowed.provenance.kind} provenance, and a Bot may author only over its own Packages`,
          }),
        );
      }
      const collision = await collidingToolName(
        packageId,
        request.input.tools.map((tool) => tool.name),
      );
      if (collision) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "compose",
            reason: `Tool "${collision}" is already registered in this Bot's current Composition; choose a different tool name`,
          }),
        );
      }

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
        if (!intent) {
          throw new Error("a settled authoring effect has no durable intent");
        }
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
          intent,
          outcome: classification.outcome,
          artifact,
        });
      }

      if (
        !options.bundler ||
        !options.artifacts ||
        (request.input.ui && !options.artifacts.putPackageUiArtifact)
      ) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "compose",
            reason:
              "this host cannot author Packages: it has no required Package bundler or artifact store",
          }),
        );
      }

      const previous = await options.storage.get<AuthoredPackageRecordV1>(
        authorshipPackageKey(packageId),
      );
      const ordinal = (previous?.ordinal ?? 0) + 1;
      const version = authoredVersionV1(ordinal);
      const uiPages = request.input.ui
        ? await Promise.all(
            request.input.ui.pages.map(async (page) => ({
              id: page.id,
              html: page.html,
              mounts: page.mounts,
              artifact: {
                contentHash: await sha256(page.html),
                size: new TextEncoder().encode(page.html).byteLength,
                mediaType: "text/html" as const,
                bundlerVersion: PACKAGE_UI_ARTIFACT_VERSION,
              },
            })),
          )
        : undefined;
      const rawManifest = authoredManifestV1({
        packageId,
        displayName: request.input.displayName,
        version,
        tools: request.input.tools,
        hooks: request.input.hooks,
        ...(request.input.ui && uiPages
          ? {
              ui: {
                pages: uiPages.map((page) => ({
                  id: page.id,
                  artifact: page.artifact,
                  mounts: page.mounts,
                })),
                ...(request.input.ui.entries
                  ? { entries: request.input.ui.entries }
                  : {}),
              },
            }
          : {}),
      });
      // The generated document crosses the same strict seam as every other
      // manifest before it becomes durable or participates in a generation.
      decodeFrockBotManifest(rawManifest);
      const manifestHash = await sha256(canonicalJson(rawManifest));
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
        manifestHash,
        sourceBytes,
        recordedAt,
        status: "recorded",
      };
      await options.storage.put({
        [authorshipIntentKey(effectId)]: recordedIntent,
        [authorshipManifestKey(manifestHash)]: {
          schemaVersion: 1,
          manifestHash,
          packageId,
          version,
          manifest: rawManifest,
          createdAt: recordedAt,
        } satisfies AuthoredManifestRecordV1,
      });

      const bundleRequest: PackageBundleRequestV1 = {
        schemaVersion: 1,
        effectId,
        target: "bot-isolate",
        compatibilityDate: options.compatibilityDate,
        entry: "package.ts",
        sources: [{ path: "package.ts", text: request.input.source }],
        ...(uiPages
          ? {
              uiPages: uiPages.map((page) => ({
                id: page.id,
                html: page.html,
              })),
            }
          : {}),
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
      const returnedPages = bundled.uiArtifacts ?? [];
      const uiMismatch =
        uiPages !== undefined &&
        (returnedPages.length !== uiPages.length ||
          uiPages.some((page, index) => {
            const returned = returnedPages[index];
            return (
              !returned ||
              returned.id !== page.id ||
              returned.html !== page.html ||
              returned.artifact.contentHash !== page.artifact.contentHash ||
              returned.artifact.size !== page.artifact.size ||
              returned.artifact.mediaType !== page.artifact.mediaType ||
              returned.artifact.bundlerVersion !== page.artifact.bundlerVersion
            );
          }));
      if (uiMismatch || (uiPages === undefined && returnedPages.length > 0)) {
        return refused(
          await recordFailure({
            effectId,
            packageId,
            phase: "bundle",
            reason:
              "the Package bundler returned UI bytes that do not match the recorded manifest",
          }),
        );
      }
      // Content-addressed and immutable: writing the same hash twice is a
      // no-op, so the object write is safe to repeat and the record is not.
      await options.artifacts.putPackageArtifact(
        artifact.contentHash,
        bundled.module,
      );
      for (const page of returnedPages) {
        await options.artifacts.putPackageUiArtifact!(
          page.artifact.contentHash,
          page.html,
        );
      }
      await options.artifacts.putPackageSource(
        request.sourceHash,
        request.input.source,
      );
      const artifactRecord: AuthoredArtifactRecordV1 = {
        schemaVersion: 1,
        contentHash: artifact.contentHash,
        size: artifact.size,
        mediaType: artifact.mediaType,
        bundlerVersion: artifact.bundlerVersion,
        effectId,
        r2Key: artifactR2KeyV1(artifact.contentHash),
        sourceHash: request.sourceHash,
        sourceR2Key: sourceR2KeyV1(request.sourceHash),
        manifestHash,
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
      return await compose({
        request,
        intent: recordedIntent,
        outcome,
        artifact: artifactRecord,
      });
    },

    async undo(request: PackageUndoRequestV1): Promise<PackageUndoOutcomeV1> {
      const replay = await options.storage.get<PackageUndoRecordV1>(
        authorshipUndoOutcomeKey(request.effectId),
      );
      if (replay) {
        return replay.status === "recorded"
          ? {
              status: "recorded",
              effectId: replay.effectId,
              generationId: replay.generationId,
              targetGenerationId: replay.targetGenerationId,
            }
          : {
              status: "refused",
              reason: replay.reason,
              failureId: replay.failureId,
            };
      }

      const existingIntent = await options.storage.get<PackageUndoIntentV1>(
        authorshipUndoIntentKey(request.effectId),
      );
      const history = (await options.composition.list({ limit: 100 }))
        .generations;
      const currentGood = await options.composition.lastKnownGood();
      const current = await options.composition.current();
      let target: CompositionGenerationV1 | undefined;
      if (existingIntent) {
        target = await options.composition.read(
          existingIntent.targetGenerationId,
        );
      } else if (request.input.generationId) {
        target = await options.composition.read(request.input.generationId);
      } else {
        const latestAuthored = history.find(
          (generation) => generation.origin.kind === "bot-authored",
        );
        target = latestAuthored?.parentGenerationId
          ? await options.composition.read(latestAuthored.parentGenerationId)
          : undefined;
      }
      if (!target) {
        return undoRefused(
          await recordFailure({
            effectId: request.effectId,
            packageId: "composition",
            phase: "compose",
            reason: request.input.generationId
              ? `Composition generation "${request.input.generationId}" is unavailable`
              : "There is no earlier Bot-authored Package setup change to undo",
          }),
        );
      }
      if (target.status !== "active" && target.status !== "superseded") {
        return undoRefused(
          await recordFailure({
            effectId: request.effectId,
            packageId: "composition",
            phase: "compose",
            reason: `Composition generation "${target.generationId}" was never successfully mounted and cannot be an undo target`,
          }),
        );
      }
      if (target.generationId === current.generationId) {
        return undoRefused(
          await recordFailure({
            effectId: request.effectId,
            packageId: "composition",
            phase: "compose",
            reason: `Package setup already matches Composition generation "${target.generationId}"`,
          }),
        );
      }

      // A Bot-origin undo may change only Bot-provenance members. First-party
      // and User members must be byte-for-byte identical to the current good
      // setup, so this path cannot become an alternate authority grant/revoke.
      const nonBot = (generation: CompositionGenerationV1) =>
        generation.members
          .filter((member) => member.provenance.kind !== "bot")
          .sort((left, right) => left.packageId.localeCompare(right.packageId));
      if (
        canonicalJson(nonBot(target)) !== canonicalJson(nonBot(currentGood))
      ) {
        return undoRefused(
          await recordFailure({
            effectId: request.effectId,
            packageId: "composition",
            phase: "compose",
            reason:
              "That generation changes first-party or User Package setup; package_undo may revert only this Bot's authored Packages",
          }),
        );
      }

      const recordedAt = existingIntent?.recordedAt ?? now().toISOString();
      const intent: PackageUndoIntentV1 = existingIntent ?? {
        schemaVersion: 1,
        effectId: request.effectId,
        botId: options.botId,
        runId: options.runId,
        turnId: options.turnId,
        ...(request.input.generationId
          ? { requestedGenerationId: request.input.generationId }
          : {}),
        targetGenerationId: target.generationId,
        recordedAt,
        status: "recorded",
      };
      // Intent before effect. `createdAt` makes the new generation id stable
      // when a Durable Object resumes after `revert` but before outcome write.
      if (!existingIntent) {
        await options.storage.put({
          [authorshipUndoIntentKey(request.effectId)]: intent,
        });
      }
      const generation = await options.composition.revert(
        target.generationId,
        {
          kind: "revert",
          revertsTo: target.generationId,
          botId: options.botId,
          runId: options.runId,
          turnId: options.turnId,
        },
        { createdAt: intent.recordedAt },
      );
      const outcome: PackageUndoRecordV1 = {
        schemaVersion: 1,
        effectId: request.effectId,
        generationId: generation.generationId,
        targetGenerationId: target.generationId,
        recordedAt,
        status: "recorded",
      };
      await options.storage.put({
        [authorshipUndoOutcomeKey(request.effectId)]: outcome,
      });
      return {
        status: "recorded",
        effectId: request.effectId,
        generationId: generation.generationId,
        targetGenerationId: target.generationId,
      };
    },

    async inspectSelf(): Promise<PackageInspectSelfOutcomeV1> {
      const composition =
        options.mountedGeneration?.() ?? (await options.composition.current());
      const history = await compositionHistory();
      const members = await Promise.all(
        composition.members.map(async (member) => {
          const recorded = await storedManifest(member);
          const manifest = recorded
            ? decodeFrockBotManifest(recorded.manifest)
            : undefined;
          const source =
            member.provenance.kind === "bot" && options.artifacts
              ? await readAuthoredCompositionMemberSourceV1({
                  storage: options.storage,
                  artifacts: options.artifacts,
                  member,
                })
              : undefined;
          return {
            packageId: member.packageId,
            version: member.version,
            provenance: structuredClone(member.provenance) as unknown as Record<
              string,
              unknown
            >,
            declaredTools: (manifest?.tools ?? []).map((tool) => tool.name),
            ...(source === undefined ? {} : { source }),
          };
        }),
      );
      const packageIds = new Set(
        history.flatMap((generation) =>
          generation.members
            .filter((member) => member.provenance.kind === "bot")
            .map((member) => member.packageId),
        ),
      );
      const failures: PackageInspectFailureV1[] = [];
      for (const packageId of [...packageIds].sort()) {
        const authoring = await options.storage.get<AuthoringFailureRecordV1>(
          authorshipLatestFailureKey(packageId),
        );
        let activation: PackageInspectFailureV1["activation"] | undefined;
        if (options.activationFailures) {
          for (const generation of history) {
            if (activation || generation.origin.kind !== "bot-authored") {
              continue;
            }
            const origin = generation.origin;
            const authoredMember = generation.members.find(
              (member) =>
                member.packageId === packageId &&
                member.provenance.kind === "bot" &&
                member.provenance.runId === origin.runId,
            );
            if (!authoredMember) continue;
            const recorded = await options.activationFailures.list(
              generation.generationId,
            );
            const latest = recorded.at(-1);
            if (!latest) continue;
            activation = {
              generationId: generation.generationId,
              attempt: latest.attempt,
              phase: latest.phase,
              message: latest.message,
              diagnostics: latest.diagnostics,
              at: latest.at,
              quarantined: Boolean(
                await options.activationFailures.quarantine(
                  generation.generationId,
                ),
              ),
            };
          }
        }
        failures.push({
          packageId,
          ...(authoring
            ? {
                authoring: {
                  failureId: authoring.failureId,
                  phase: authoring.phase,
                  reason: authoring.reason,
                  diagnostics: authoring.diagnostics,
                  recordedAt: authoring.recordedAt,
                },
              }
            : {}),
          ...(activation ? { activation } : {}),
        });
      }
      return {
        contextContract: `${BOT_ISOLATE_CONTEXT_DTS_V1}\n\n${PACKAGE_IFRAME_BRIDGE_DTS_V1}\nInline ui.html helper:\n<script>${PACKAGE_IFRAME_HELPER_JS_V1}</script>`,
        composition: {
          generationId: composition.generationId,
          status: composition.status,
          members,
        },
        failures,
      };
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
    async putPackageUiArtifact(contentHash: string, html: string) {
      await bucket.put(`packages/${contentHash}.html`, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
    },
    async putPackageSource(sourceHash: string, source: string) {
      await bucket.put(sourceR2KeyV1(sourceHash), source, {
        httpMetadata: { contentType: "text/typescript; charset=utf-8" },
      });
    },
    async loadPackageSource(sourceHash: string) {
      const object = await bucket.get(sourceR2KeyV1(sourceHash));
      if (!object) return undefined;
      const source = await object.text();
      if ((await sha256(source)) !== sourceHash) {
        throw new Error(
          `Package source "${sourceHash}" failed hash verification`,
        );
      }
      return source;
    },
    async headPackageArtifact(contentHash: string) {
      const object = await bucket.head(artifactR2KeyV1(contentHash));
      return object ? { contentHash, size: object.size } : undefined;
    },
  };
}

/** Reads one Bot-authored member's retained source through its durable record. */
export async function readAuthoredCompositionMemberSourceV1(input: {
  storage: Pick<AuthoringStorage, "get">;
  artifacts: Pick<AuthoringArtifactStore, "loadPackageSource">;
  member: CompositionMemberV1;
}): Promise<string | undefined> {
  const { member } = input;
  if (member.provenance.kind !== "bot" || !member.artifact) return undefined;
  const artifact = await input.storage.get<AuthoredArtifactRecordV1>(
    artifactKey(member.artifact.contentHash),
  );
  if (
    !artifact ||
    artifact.contentHash !== member.artifact.contentHash ||
    artifact.manifestHash !== member.manifestHash
  ) {
    return undefined;
  }
  return input.artifacts.loadPackageSource(artifact.sourceHash);
}
