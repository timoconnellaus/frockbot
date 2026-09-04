import type { PackageInstallationView } from "@frockbot/configuration-core";
import type { PackageCatalogChangeActionV1 } from "./shared.js";

export const PACKAGE_CATALOG_CHANGE_INTENT_PREFIX =
  "package-catalog:change-intent:";
export const PACKAGE_CATALOG_CHANGE_OUTCOME_PREFIX =
  "package-catalog:change-outcome:";
export const PACKAGE_CATALOG_UNDO_INTENT_PREFIX =
  "package-catalog:undo-intent:";

export function packageCatalogChangeIntentKey(effectId: string): string {
  return `${PACKAGE_CATALOG_CHANGE_INTENT_PREFIX}${effectId}`;
}

export function packageCatalogChangeOutcomeKey(effectId: string): string {
  return `${PACKAGE_CATALOG_CHANGE_OUTCOME_PREFIX}${effectId}`;
}

export function packageCatalogUndoIntentKey(effectId: string): string {
  return `${PACKAGE_CATALOG_UNDO_INTENT_PREFIX}${effectId}`;
}

export interface PackageCatalogChangeIntentV1 {
  schemaVersion: 1;
  effectId: string;
  action: PackageCatalogChangeActionV1;
  userId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  packageId: string;
  displayName: string;
  version: string;
  catalogId: string;
  catalogGeneration: string;
  /** Absent for a first-party entry, which publishes no bundle to pin. */
  contentHash?: string;
  manifestHash: string;
  summary: string;
  missingConnectionTypes: string[];
  baseGenerationId: string;
  expectedUserRevision: number;
  previousInstallation?: PackageInstallationView;
  recordedAt: string;
  status: "recorded";
}

export type PackageCatalogChangeOutcomeRecordV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      action: PackageCatalogChangeActionV1;
      packageId: string;
      displayName: string;
      version?: string;
      contentHash?: string;
      generationId: string;
      missingConnectionTypes: string[];
      recordedAt: string;
      status: "recorded";
    }
  | {
      schemaVersion: 1;
      effectId: string;
      action: PackageCatalogChangeActionV1;
      reason: string;
      recordedAt: string;
      status: "refused";
    };

export interface PackageCatalogUndoIntentV1 {
  schemaVersion: 1;
  effectId: string;
  targetGenerationId: string;
  packageId: string;
  expectedUserRevision: number;
  action: "install" | "uninstall";
  recordedAt: string;
  status: "recorded";
}
