/// <reference types="@cloudflare/workers-types" />
// Bot Durable Object authority for Catalog tools. The external User settings
// mutation is fenced by a Bot-owned intent and an idempotent command id; the
// pending Composition generation is then appended and pinned for the next Turn.
import {
  MAX_CATALOG_DOCUMENT_BYTES_V1,
  assertCatalogEntryMatchesIndexV1,
  assertCatalogPackageBundleV1,
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  catalogPackageArtifactKeyV1,
  catalogPackageSourceKeyV1,
  catalogPackageUiArtifactKeyV1,
  decodeCatalogIndexDocumentV1,
  parseCatalogEntryDocumentV1,
  type CatalogEntryV1,
  type CatalogIndexV1,
} from "@frockbot/catalog-core";
import {
  type OperationReceiptV1,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { isClientIframeContribution } from "@frockbot/kernel-composition";
import { canonicalJson } from "@frockbot/kernel-composition/compiler";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import {
  authorshipFailureKey,
  authorshipUndoOutcomeKey,
  authorshipManifestKey,
  type AuthoringFailureRecordV1,
  type AuthoredManifestRecordV1,
  type PackageUndoRecordV1,
} from "@frockbot/plugin-authoring/records";
import type { PackageUndoRequestV1 } from "@frockbot/plugin-authoring/agent";
import type { PackageUndoOutcomeV1 } from "@frockbot/plugin-authoring/shared";
import type {
  PackageCatalogChangeInputV1,
  PackageCatalogChangeRequestV1,
  PackageCatalogHost,
} from "@frockbot/plugin-package-catalog/agent";
import {
  PACKAGE_CATALOG_RESULT_MAX_V1,
  packageCatalogEffectIdV1,
  type PackageCatalogChangeOutcomeV1,
  type PackageCatalogInspectOutcomeV1,
} from "@frockbot/plugin-package-catalog/shared";
import {
  packageCatalogChangeIntentKey,
  packageCatalogChangeOutcomeKey,
  packageCatalogUndoIntentKey,
  type PackageCatalogChangeIntentV1,
  type PackageCatalogChangeOutcomeRecordV1,
  type PackageCatalogUndoIntentV1,
} from "@frockbot/plugin-package-catalog/records";

export interface PackageCatalogStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface PackageCatalogCompositionStore {
  current(): Promise<CompositionGenerationV1>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  read(generationId: string): Promise<CompositionGenerationV1 | undefined>;
  propose(
    generation: CompositionGenerationV1,
    options?: { pin?: boolean },
  ): Promise<void>;
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

export interface PackageCatalogUserAuthority {
  read(): Promise<UserSettingsViewV1>;
  execute(command: UserConfigurationCommandV1): Promise<OperationReceiptV1>;
}

export interface BotPackageCatalogReader {
  readIndex(generation: string, expectedHash: string): Promise<CatalogIndexV1>;
  readEntry(input: {
    generation: string;
    index: CatalogIndexV1;
    catalogId: string;
  }): Promise<CatalogEntryV1 | undefined>;
  readSource(sourceHash: string): Promise<string | undefined>;
  headArtifact(contentHash: string): Promise<{ size: number } | undefined>;
  headUiArtifact(contentHash: string): Promise<{ size: number } | undefined>;
}

export interface PackageCatalogHostOptions {
  storage: PackageCatalogStorage;
  composition: PackageCatalogCompositionStore;
  catalog: BotPackageCatalogReader;
  user: PackageCatalogUserAuthority;
  userId: string;
  botId: string;
  runId: string;
  turnId: string;
  now?(): Date;
}

export interface CatalogAwarePackageCatalogHost extends PackageCatalogHost {
  /** `undefined` delegates a non-Catalog undo to the authoring host. */
  undoCatalogChange(
    request: PackageUndoRequestV1,
  ): Promise<PackageUndoOutcomeV1 | undefined>;
}

function summary(
  action: "install" | "update" | "remove",
  name: string,
): string {
  const verb =
    action === "install"
      ? "Added"
      : action === "update"
        ? "Updated"
        : "Removed";
  return `${verb} ${name}`.slice(0, 160);
}

function requiredCatalogPin(user: UserSettingsViewV1): {
  generation: string;
  indexHash: string;
} {
  if (!user.catalogGeneration || !user.catalogIndexHash) {
    // A User is pinned on the first configuration read that finds a published
    // Catalog, so an absent pin means the deployment has none to find. Say
    // that, rather than an internal sentence about pinning the Bot then
    // relays to the person who asked.
    throw new Error(
      "No Package Catalog is published for this deployment, so there is nothing to search or install",
    );
  }
  return {
    generation: user.catalogGeneration,
    indexHash: user.catalogIndexHash,
  };
}

function connectionState(
  entry: CatalogEntryV1,
  user: UserSettingsViewV1,
): PackageCatalogInspectOutcomeV1["connectionTypes"] {
  return (entry.bundle?.manifest.configuration?.connectionTypes ?? []).map(
    (definition) => ({
      id: definition.id,
      displayName: definition.displayName,
      connected: user.connections.some(
        (connection) =>
          connection.packageId === entry.packageId &&
          connection.connectionTypeId === definition.id &&
          connection.state === "ready",
      ),
    }),
  );
}

function recordedOutcome(
  record: PackageCatalogChangeOutcomeRecordV1,
): PackageCatalogChangeOutcomeV1 {
  return record.status === "refused"
    ? {
        status: "refused",
        action: record.action,
        effectId: record.effectId,
        reason: record.reason,
      }
    : {
        status: "recorded",
        action: record.action,
        effectId: record.effectId,
        packageId: record.packageId,
        displayName: record.displayName,
        ...(record.version ? { version: record.version } : {}),
        ...(record.contentHash ? { contentHash: record.contentHash } : {}),
        generationId: record.generationId,
        missingConnectionTypes: record.missingConnectionTypes,
      };
}

/** One admitted Turn's authority-bearing Catalog host. */
export function createPackageCatalogHost(
  options: PackageCatalogHostOptions,
): CatalogAwarePackageCatalogHost {
  const now = options.now ?? (() => new Date());

  async function pinnedEntry(catalogId: string): Promise<{
    user: UserSettingsViewV1;
    entry: CatalogEntryV1;
    generation: string;
  }> {
    const user = await options.user.read();
    const pin = requiredCatalogPin(user);
    const index = await options.catalog.readIndex(
      pin.generation,
      pin.indexHash,
    );
    const entry = await options.catalog.readEntry({
      generation: pin.generation,
      index,
      catalogId,
    });
    if (!entry) {
      throw new Error(
        `Catalog entry "${catalogId}" is not in pinned generation "${pin.generation}"`,
      );
    }
    return { user, entry, generation: pin.generation };
  }

  async function refuse(
    action: PackageCatalogChangeInputV1["action"],
    effectId: string,
    reason: string,
  ): Promise<PackageCatalogChangeOutcomeV1> {
    const record: PackageCatalogChangeOutcomeRecordV1 = {
      schemaVersion: 1,
      status: "refused",
      effectId,
      action,
      reason,
      recordedAt: now().toISOString(),
    };
    await options.storage.put({
      [packageCatalogChangeOutcomeKey(effectId)]: record,
    });
    return recordedOutcome(record);
  }

  async function verifyArtifact(entry: CatalogEntryV1): Promise<void> {
    if (!entry.bundle) {
      throw new Error(
        `Catalog entry "${entry.catalogId}" names reviewed first-party code and has no Bot-isolate bundle`,
      );
    }
    const artifact = await options.catalog.headArtifact(
      entry.bundle.contentHash,
    );
    if (!artifact || artifact.size !== entry.bundle.size) {
      throw new Error(
        `Catalog bundle "${entry.bundle.contentHash}" is absent or has the wrong size`,
      );
    }
    const client = entry.bundle.manifest.contributions.client;
    if (client && isClientIframeContribution(client)) {
      for (const page of client.pages) {
        const uiArtifact = await options.catalog.headUiArtifact(
          page.artifact.contentHash,
        );
        if (!uiArtifact || uiArtifact.size !== page.artifact.size) {
          throw new Error(
            `Catalog iframe artifact "${page.artifact.contentHash}" is absent or has the wrong size`,
          );
        }
      }
    }
  }

  async function undoRefused(
    request: PackageUndoRequestV1,
    reason: string,
  ): Promise<PackageUndoOutcomeV1> {
    const recordedAt = now().toISOString();
    const failureId = `authoring-failure-${crypto.randomUUID()}`;
    const failure: AuthoringFailureRecordV1 = {
      schemaVersion: 1,
      failureId,
      effectId: request.effectId,
      botId: options.botId,
      packageId: "composition",
      runId: options.runId,
      phase: "compose",
      reason,
      diagnostics: [],
      recordedAt,
    };
    const outcome: PackageUndoRecordV1 = {
      schemaVersion: 1,
      status: "refused",
      effectId: request.effectId,
      failureId,
      reason,
      recordedAt,
    };
    await options.storage.put({
      [authorshipFailureKey(failureId)]: failure,
      [authorshipUndoOutcomeKey(request.effectId)]: outcome,
    });
    return { status: "refused", reason, failureId };
  }

  return {
    effectIdFor: (change) =>
      packageCatalogEffectIdV1({
        runId: options.runId,
        action: change.action,
        identifier:
          change.action === "remove"
            ? change.input.packageId
            : change.input.catalogId,
        ...(change.action === "remove" || change.input.contentHash === undefined
          ? {}
          : { contentHash: change.input.contentHash }),
      }),

    async search(input) {
      const user = await options.user.read();
      const pin = requiredCatalogPin(user);
      const index = await options.catalog.readIndex(
        pin.generation,
        pin.indexHash,
      );
      const query = input.query.trim().toLocaleLowerCase();
      const entries = index.entries
        .filter((entry) => {
          const haystack = [
            entry.packageId,
            entry.displayName,
            entry.description,
            ...(entry.tags ?? []),
          ]
            .join("\n")
            .toLocaleLowerCase();
          return query.length === 0 || haystack.includes(query);
        })
        .slice(0, PACKAGE_CATALOG_RESULT_MAX_V1);
      return { generation: pin.generation, entries };
    },

    async inspect(input) {
      const { user, entry, generation } = await pinnedEntry(input.catalogId);
      const connections = connectionState(entry, user);
      const missingConnectionTypes = connections
        .filter((connection) => !connection.connected)
        .map((connection) => connection.id);
      const source = entry.bundle?.sourceHash
        ? await options.catalog.readSource(entry.bundle.sourceHash)
        : undefined;
      return {
        generation,
        entry,
        declaredTools: (entry.bundle?.manifest.tools ?? []).map(
          (tool) => tool.name,
        ),
        connectionTypes: connections,
        missingConnectionTypes,
        inert: missingConnectionTypes.length > 0,
        ...(source === undefined ? {} : { source }),
      };
    },

    async undoCatalogChange(request) {
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

      const current = await options.composition.current();
      const history = (await options.composition.list({ limit: 100 }))
        .generations;
      const latestCatalog = history.find(
        (generation) => generation.origin.kind === "bot-catalog",
      );
      if (!request.input.generationId && !latestCatalog) return undefined;
      const targetId =
        request.input.generationId ?? latestCatalog?.parentGenerationId;
      if (!targetId) {
        return undoRefused(
          request,
          "There is no earlier Catalog Package setup generation to undo",
        );
      }
      const target = await options.composition.read(targetId);
      if (!target) {
        return undoRefused(
          request,
          `Composition generation "${targetId}" is unavailable`,
        );
      }
      if (target.status !== "active" && target.status !== "superseded") {
        return undoRefused(
          request,
          `Composition generation "${targetId}" was never successfully mounted and cannot be an undo target`,
        );
      }
      if (target.generationId === current.generationId) {
        return undoRefused(
          request,
          `Package setup already matches Composition generation "${targetId}"`,
        );
      }
      const protectedMembers = (generation: CompositionGenerationV1) =>
        generation.members
          .filter(
            (member) =>
              member.provenance.kind !== "bot" &&
              member.provenance.kind !== "catalog",
          )
          .sort((left, right) => left.packageId.localeCompare(right.packageId));
      if (
        canonicalJson(protectedMembers(current)) !==
        canonicalJson(protectedMembers(target))
      ) {
        return undoRefused(
          request,
          "That generation changes required first-party or User Package setup",
        );
      }
      const catalogIds = new Set(
        [...current.members, ...target.members]
          .filter((member) => member.provenance.kind === "catalog")
          .map((member) => member.packageId),
      );
      const changed = [...catalogIds].filter((packageId) => {
        const from = current.members.find(
          (member) => member.packageId === packageId,
        );
        const to = target.members.find(
          (member) => member.packageId === packageId,
        );
        return canonicalJson(from ?? null) !== canonicalJson(to ?? null);
      });
      if (changed.length === 0) return undefined;
      if (changed.length > 1) {
        return undoRefused(
          request,
          "One package_undo may reconcile only one Catalog Package change",
        );
      }
      const packageId = changed[0]!;
      const targetMember = target.members.find(
        (member) => member.packageId === packageId,
      );
      const targetCatalogMember =
        targetMember?.provenance.kind === "catalog" ? targetMember : undefined;
      if (targetMember && !targetCatalogMember) {
        return undoRefused(
          request,
          `Undo would replace Catalog Package "${packageId}" with non-Catalog provenance`,
        );
      }

      const user = await options.user.read();
      let intent = await options.storage.get<PackageCatalogUndoIntentV1>(
        packageCatalogUndoIntentKey(request.effectId),
      );
      if (!intent) {
        intent = {
          schemaVersion: 1,
          effectId: request.effectId,
          targetGenerationId: target.generationId,
          packageId,
          expectedUserRevision: user.revision,
          action: targetCatalogMember ? "install" : "uninstall",
          recordedAt: now().toISOString(),
          status: "recorded",
        };
        // Durable Bot intent before changing User installation state.
        await options.storage.put({
          [packageCatalogUndoIntentKey(request.effectId)]: intent,
        });
      }

      let command: UserConfigurationCommandV1;
      if (!targetCatalogMember) {
        command = {
          schemaVersion: 1,
          type: "user/uninstall-package",
          commandId: `${request.effectId}-catalog-user`,
          expectedRevision: intent.expectedUserRevision,
          packageId,
        };
      } else {
        const provenance = targetCatalogMember.provenance;
        if (provenance.kind !== "catalog") {
          throw new Error("Catalog undo target lost its decoded provenance");
        }
        const pin = requiredCatalogPin(user);
        const index = await options.catalog.readIndex(
          provenance.catalogGeneration,
          pin.indexHash,
        );
        const targetEntry = await options.catalog.readEntry({
          generation: provenance.catalogGeneration,
          index,
          catalogId: provenance.catalogId,
        });
        // A first-party member pins no bundle, so "the entry still offers
        // what the target generation recorded" is the two hashes agreeing,
        // both present or both absent.
        if (
          !targetEntry ||
          targetEntry.bundle?.contentHash !== provenance.contentHash
        ) {
          return undoRefused(
            request,
            `Catalog entry for "${packageId}" is unavailable for undo`,
          );
        }
        command = {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: `${request.effectId}-catalog-user`,
          expectedRevision: intent.expectedUserRevision,
          packageId,
          version: targetCatalogMember.version,
          catalogId: provenance.catalogId,
          catalogGeneration: provenance.catalogGeneration,
          ...(provenance.contentHash === undefined
            ? {}
            : { contentHash: provenance.contentHash }),
        };
      }
      const receipt = await options.user.execute(command);
      if (receipt.status === "rejected") {
        return undoRefused(request, receipt.failure);
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
        status: "recorded",
        effectId: request.effectId,
        generationId: generation.generationId,
        targetGenerationId: target.generationId,
        recordedAt: intent.recordedAt,
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

    async change(request: PackageCatalogChangeRequestV1) {
      const replay =
        await options.storage.get<PackageCatalogChangeOutcomeRecordV1>(
          packageCatalogChangeOutcomeKey(request.effectId),
        );
      if (replay) return recordedOutcome(replay);

      const { action } = request.change;
      let existingIntent =
        await options.storage.get<PackageCatalogChangeIntentV1>(
          packageCatalogChangeIntentKey(request.effectId),
        );
      let entry: CatalogEntryV1;
      let user: UserSettingsViewV1;
      let base: CompositionGenerationV1;
      let intent: PackageCatalogChangeIntentV1;
      try {
        user = await options.user.read();
        base = await options.composition.lastKnownGood();
        if (existingIntent) {
          const pin = requiredCatalogPin(user);
          const index = await options.catalog.readIndex(
            existingIntent.catalogGeneration,
            pin.indexHash,
          );
          const resumed = await options.catalog.readEntry({
            generation: existingIntent.catalogGeneration,
            index,
            catalogId: existingIntent.catalogId,
          });
          if (!resumed)
            throw new Error(
              "the intent's immutable Catalog entry is unavailable",
            );
          entry = resumed;
          intent = existingIntent;
        } else if (action === "remove") {
          const packageId = request.change.input.packageId;
          const member = base.members.find(
            (candidate) => candidate.packageId === packageId,
          );
          if (!member)
            throw new Error(`Package "${packageId}" is not installed`);
          if (member.provenance.kind !== "catalog") {
            throw new Error(
              `Package "${packageId}" is a required or non-Catalog member and cannot be removed by package_remove`,
            );
          }
          const pin = requiredCatalogPin(user);
          const index = await options.catalog.readIndex(
            member.provenance.catalogGeneration,
            pin.indexHash,
          );
          const found = await options.catalog.readEntry({
            generation: member.provenance.catalogGeneration,
            index,
            catalogId: member.provenance.catalogId,
          });
          if (!found?.bundle) {
            throw new Error(
              `Installed Catalog Package "${packageId}" has no immutable entry`,
            );
          }
          const bundle = found.bundle;
          entry = found;
          const recordedAt = now().toISOString();
          intent = {
            schemaVersion: 1,
            effectId: request.effectId,
            action,
            userId: options.userId,
            botId: options.botId,
            sessionId: request.sessionId,
            runId: options.runId,
            turnId: options.turnId,
            packageId: entry.packageId,
            displayName: entry.displayName,
            version: entry.version,
            catalogId: entry.catalogId,
            catalogGeneration: member.provenance.catalogGeneration,
            contentHash: bundle.contentHash,
            manifestHash: entry.manifestHash,
            summary:
              request.change.input.summary ??
              summary(action, entry.displayName),
            missingConnectionTypes: [],
            baseGenerationId: base.generationId,
            expectedUserRevision: user.revision,
            previousInstallation: user.packages.find(
              (candidate) => candidate.packageId === packageId,
            ),
            recordedAt,
            status: "recorded",
          };
        } else {
          const resolved = await pinnedEntry(request.change.input.catalogId);
          user = resolved.user;
          entry = resolved.entry;
          // A first-party entry names reviewed compiled-in code and publishes
          // no bundle: there is no artifact to verify and no hash to pin. The
          // Plugins page has always installed such an entry; refusing it here
          // is what made `package_install` by chat disagree with the UI (F4).
          if (entry.bundle) {
            if (entry.bundle.contentHash !== request.change.input.contentHash) {
              throw new Error(
                `Catalog entry "${entry.catalogId}" has content hash "${entry.bundle.contentHash}", not "${request.change.input.contentHash}"`,
              );
            }
            await verifyArtifact(entry);
          } else if (request.change.input.contentHash !== undefined) {
            throw new Error(
              `Catalog entry "${entry.catalogId}" does not carry a Package bundle`,
            );
          }
          const member = base.members.find(
            (candidate) => candidate.packageId === entry.packageId,
          );
          if (action === "install" && member) {
            throw new Error(
              `Package "${entry.packageId}" is already in this Bot's Composition`,
            );
          }
          if (
            action === "update" &&
            (!member || member.provenance.kind !== "catalog")
          ) {
            throw new Error(
              `Package "${entry.packageId}" is not an installed Catalog Package`,
            );
          }
          const connections = connectionState(entry, user);
          const recordedAt = now().toISOString();
          intent = {
            schemaVersion: 1,
            effectId: request.effectId,
            action,
            userId: options.userId,
            botId: options.botId,
            sessionId: request.sessionId,
            runId: options.runId,
            turnId: options.turnId,
            packageId: entry.packageId,
            displayName: entry.displayName,
            version: entry.version,
            catalogId: entry.catalogId,
            catalogGeneration: resolved.generation,
            ...(entry.bundle ? { contentHash: entry.bundle.contentHash } : {}),
            manifestHash: entry.manifestHash,
            summary:
              request.change.input.summary ??
              summary(action, entry.displayName),
            missingConnectionTypes: connections
              .filter((connection) => !connection.connected)
              .map((connection) => connection.id),
            baseGenerationId: base.generationId,
            expectedUserRevision: user.revision,
            previousInstallation: user.packages.find(
              (candidate) => candidate.packageId === entry.packageId,
            ),
            recordedAt,
            status: "recorded",
          };
        }
      } catch (error) {
        return refuse(
          action,
          request.effectId,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Intent and manifest before the User settings effect. The manifest key
      // is the existing isolate loader seam used by authored Packages.
      if (!existingIntent) {
        const bundle = entry.bundle;
        await options.storage.put({
          [packageCatalogChangeIntentKey(request.effectId)]: intent,
          // A bundle-less entry has no manifest document to store; the mount
          // resolves it from the compiled-in application instead, still
          // against the `manifestHash` the generation records.
          ...(bundle
            ? {
                [authorshipManifestKey(intent.manifestHash)]: {
                  schemaVersion: 1,
                  manifestHash: intent.manifestHash,
                  packageId: intent.packageId,
                  version: intent.version,
                  manifest: bundle.manifest,
                  createdAt: intent.recordedAt,
                } satisfies AuthoredManifestRecordV1,
              }
            : {}),
        });
        existingIntent = intent;
      }

      const command: UserConfigurationCommandV1 =
        action === "remove"
          ? {
              schemaVersion: 1,
              type: "user/uninstall-package",
              commandId: `${request.effectId}-user`,
              expectedRevision: intent.expectedUserRevision,
              packageId: intent.packageId,
            }
          : {
              schemaVersion: 1,
              type: "user/install-package",
              commandId: `${request.effectId}-user`,
              expectedRevision: intent.expectedUserRevision,
              packageId: intent.packageId,
              version: intent.version,
              catalogId: intent.catalogId,
              catalogGeneration: intent.catalogGeneration,
              ...(intent.contentHash === undefined
                ? {}
                : { contentHash: intent.contentHash }),
            };
      const receipt = await options.user.execute(command);
      if (receipt.status === "rejected") {
        return refuse(action, request.effectId, receipt.failure);
      }

      const parent =
        (await options.composition.read(intent.baseGenerationId)) ?? base;
      const members = parent.members.filter(
        (member) => member.packageId !== intent.packageId,
      );
      if (action !== "remove") {
        const bundle = entry.bundle;
        const member: CompositionMemberV1 = {
          packageId: entry.packageId,
          specifier: `catalog:${entry.catalogId}`,
          version: entry.version,
          manifestHash: entry.manifestHash,
          provenance: {
            kind: "catalog",
            packageId: entry.packageId,
            version: entry.version,
            catalogId: entry.catalogId,
            catalogGeneration: intent.catalogGeneration,
            ...(bundle ? { contentHash: bundle.contentHash } : {}),
          },
          // No artifact ⇒ the member mounts in the kernel isolate from the
          // compiled-in Package, exactly as the UI install records it.
          ...(bundle
            ? {
                artifact: {
                  contentHash: bundle.contentHash,
                  size: bundle.size,
                  mediaType: bundle.mediaType,
                  bundlerVersion: bundle.bundlerVersion,
                },
              }
            : {}),
        };
        members.push(member);
      }
      members.sort((left, right) =>
        left.packageId.localeCompare(right.packageId),
      );
      const artifactSetHash = await compositionArtifactSetHashV1(members);
      const generation = decodeCompositionGenerationV1({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(
          intent.recordedAt,
          artifactSetHash,
        ),
        artifactSetHash,
        parentGenerationId: parent.generationId,
        createdAt: intent.recordedAt,
        origin: {
          kind: "bot-catalog",
          action,
          packageId: intent.packageId,
          catalogId: intent.catalogId,
          botId: options.botId,
          runId: options.runId,
          sessionId: request.sessionId,
          turnId: options.turnId,
        },
        summary: intent.summary,
        members,
        status: "pending",
      });
      if (!(await options.composition.read(generation.generationId))) {
        await options.composition.propose(generation, { pin: true });
      }
      const outcome: PackageCatalogChangeOutcomeRecordV1 = {
        schemaVersion: 1,
        status: "recorded",
        effectId: request.effectId,
        action,
        packageId: intent.packageId,
        displayName: intent.displayName,
        ...(action === "remove" ? {} : { version: intent.version }),
        ...(action === "remove" || intent.contentHash === undefined
          ? {}
          : { contentHash: intent.contentHash }),
        generationId: generation.generationId,
        missingConnectionTypes: intent.missingConnectionTypes,
        recordedAt: intent.recordedAt,
      };
      await options.storage.put({
        [packageCatalogChangeOutcomeKey(request.effectId)]: outcome,
      });
      return recordedOutcome(outcome);
    },
  };
}

/** Hash-verifying R2 reader over the Catalog and Package artifact stores. */
export function createR2BotPackageCatalogReader(
  catalog: R2Bucket,
  artifacts: R2Bucket,
): BotPackageCatalogReader {
  async function document(
    bucket: R2Bucket,
    key: string,
  ): Promise<string | undefined> {
    const object = await bucket.get(key);
    if (!object) return undefined;
    if (object.size > MAX_CATALOG_DOCUMENT_BYTES_V1) {
      throw new Error(`Catalog object "${key}" exceeds its size bound`);
    }
    return object.text();
  }
  return {
    async readIndex(generation, expectedHash) {
      const value = await document(catalog, catalogIndexKeyV1(generation));
      if (value === undefined)
        throw new Error(`Catalog generation "${generation}" has no index`);
      return decodeCatalogIndexDocumentV1(value, expectedHash);
    },
    async readEntry({ generation, index, catalogId }) {
      const row = index.entries.find(
        (candidate) => candidate.catalogId === catalogId,
      );
      if (!row) return undefined;
      const value = await document(
        catalog,
        catalogEntryKeyV1(generation, catalogId),
      );
      if (value === undefined)
        throw new Error(`Catalog entry "${catalogId}" is absent`);
      const entry = parseCatalogEntryDocumentV1(value);
      assertCatalogEntryMatchesIndexV1(entry, row);
      await assertCatalogPackageBundleV1(entry);
      return entry;
    },
    async readSource(sourceHash) {
      const value = await document(
        artifacts,
        catalogPackageSourceKeyV1(sourceHash),
      );
      if (value === undefined) return undefined;
      if ((await catalogContentHashV1(value)) !== sourceHash) {
        throw new Error(
          `Catalog Package source "${sourceHash}" failed hash verification`,
        );
      }
      return value;
    },
    async headArtifact(contentHash) {
      const object = await artifacts.head(
        catalogPackageArtifactKeyV1(contentHash),
      );
      return object ? { size: object.size } : undefined;
    },
    async headUiArtifact(contentHash) {
      const object = await artifacts.head(
        catalogPackageUiArtifactKeyV1(contentHash),
      );
      return object ? { size: object.size } : undefined;
    },
  };
}
