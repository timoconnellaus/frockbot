// A Composition generation is the durable, versioned set of Package generations
// a Bot mounts. The kernel declares the record, its exact v1 codec, and the
// bootstrap generation; the Durable Object authority owns the storage and the
// Package that mounts it owns the host.
import type { Context } from "cordis";
import { canonicalJson, sha256 } from "./compiler.ts";

export type PackageProvenanceV1 =
  | { kind: "first-party"; packageId: string; version: string }
  | {
      kind: "user";
      packageId: string;
      version: string;
      userId: string;
      authoredAt: string;
    }
  | {
      kind: "bot";
      packageId: string;
      version: string;
      botId: string;
      sessionId: string;
      turnId: string;
      runId: string;
      authoredAt: string;
    };

export interface ArtifactRefV1 {
  /** sha-256 hex of the bundled module bytes. */
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

export interface CompositionMemberV1 {
  packageId: string;
  specifier: string;
  version: string;
  manifestHash: string;
  provenance: PackageProvenanceV1;
  /** Absent ⇒ first-party, runs in the kernel isolate. */
  artifact?: ArtifactRefV1;
}

export type CompositionOriginV1 =
  | { kind: "bootstrap" }
  | { kind: "bot-authored"; runId: string; sessionId: string; turnId: string }
  | { kind: "user-install"; userId: string }
  | { kind: "revert"; revertsTo: string; userId: string };

export type CompositionGenerationStatusV1 =
  "pending" | "active" | "superseded" | "failed" | "quarantined";

export interface CompositionGenerationV1 {
  schemaVersion: 1;
  /** Lexicographically sortable, monotonic per Bot. */
  generationId: string;
  /** sha-256 over the canonical member list — the loader identity. */
  artifactSetHash: string;
  parentGenerationId?: string;
  createdAt: string;
  origin: CompositionOriginV1;
  members: CompositionMemberV1[];
  status: CompositionGenerationStatusV1;
}

/** The Durable Object implements this; the kernel only declares it. */
export interface CompositionStore {
  current(): Promise<CompositionGenerationV1>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  /**
   * Records a new generation. `pin` advances `composition:current` to it, so
   * the next admitted Turn pins the proposal; the generation stays `pending`
   * until it mounts and is committed.
   */
  propose(
    generation: CompositionGenerationV1,
    options?: { pin?: boolean },
  ): Promise<void>;
  commit(generationId: string): Promise<void>;
  list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }>;
}

export interface MountedComposition {
  readonly generation: CompositionGenerationV1;
  readonly root: Context;
  verify(signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export interface CompositionHost {
  mount(
    generation: CompositionGenerationV1,
    signal: AbortSignal,
  ): Promise<MountedComposition>;
}

const COMPOSITION_GENERATION_STATUSES: readonly CompositionGenerationStatusV1[] =
  ["pending", "active", "superseded", "failed", "quarantined"];
const GENERATION_REQUIRED_KEYS = [
  "schemaVersion",
  "generationId",
  "artifactSetHash",
  "createdAt",
  "origin",
  "members",
  "status",
] as const;
const GENERATION_OPTIONAL_KEYS = ["parentGenerationId"] as const;
const MEMBER_REQUIRED_KEYS = [
  "packageId",
  "specifier",
  "version",
  "manifestHash",
  "provenance",
] as const;
const MEMBER_OPTIONAL_KEYS = ["artifact"] as const;
const ARTIFACT_KEYS = [
  "contentHash",
  "size",
  "mediaType",
  "bundlerVersion",
] as const;
const MAX_COMPOSITION_MEMBERS = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function hashString(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be a sha-256 hex digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(candidate))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return candidate;
}

function decodePackageProvenanceV1(
  input: unknown,
  label: string,
): PackageProvenanceV1 {
  const value = record(input, label);
  const kind = boundedString(value.kind, `${label}.kind`, 32);
  const common = ["kind", "packageId", "version"] as const;
  const identity = () => {
    boundedString(value.packageId, `${label}.packageId`, 128);
    boundedString(value.version, `${label}.version`, 64);
  };
  if (kind === "first-party") {
    exactKeys(value, common, [], label);
    identity();
  } else if (kind === "user") {
    exactKeys(value, [...common, "userId", "authoredAt"], [], label);
    identity();
    boundedString(value.userId, `${label}.userId`, 256);
    timestamp(value.authoredAt, `${label}.authoredAt`);
  } else if (kind === "bot") {
    exactKeys(
      value,
      [...common, "botId", "sessionId", "turnId", "runId", "authoredAt"],
      [],
      label,
    );
    identity();
    boundedString(value.botId, `${label}.botId`, 256);
    boundedString(value.sessionId, `${label}.sessionId`, 257);
    boundedString(value.turnId, `${label}.turnId`, 128);
    boundedString(value.runId, `${label}.runId`, 128);
    timestamp(value.authoredAt, `${label}.authoredAt`);
  } else {
    throw new Error(`${label}.kind is invalid`);
  }
  // SAFETY: the exhaustive variant switch validated every provenance field.
  return value as unknown as PackageProvenanceV1;
}

function decodeArtifactRefV1(input: unknown, label: string): ArtifactRefV1 {
  const value = record(input, label);
  exactKeys(value, ARTIFACT_KEYS, [], label);
  hashString(value.contentHash, `${label}.contentHash`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new Error(`${label}.size must be a non-negative integer`);
  }
  if (value.mediaType !== "application/javascript") {
    throw new Error(`${label}.mediaType is invalid`);
  }
  boundedString(value.bundlerVersion, `${label}.bundlerVersion`, 128);
  return value as unknown as ArtifactRefV1;
}

function decodeCompositionMemberV1(
  input: unknown,
  label: string,
): CompositionMemberV1 {
  const value = record(input, label);
  exactKeys(value, MEMBER_REQUIRED_KEYS, MEMBER_OPTIONAL_KEYS, label);
  const packageId = boundedString(value.packageId, `${label}.packageId`, 128);
  const specifier = boundedString(value.specifier, `${label}.specifier`, 256);
  const version = boundedString(value.version, `${label}.version`, 64);
  const manifestHash = hashString(value.manifestHash, `${label}.manifestHash`);
  const provenance = decodePackageProvenanceV1(
    value.provenance,
    `${label}.provenance`,
  );
  if (provenance.packageId !== packageId || provenance.version !== version) {
    throw new Error(`${label}.provenance does not match its member`);
  }
  return {
    packageId,
    specifier,
    version,
    manifestHash,
    provenance,
    ...(value.artifact === undefined
      ? {}
      : { artifact: decodeArtifactRefV1(value.artifact, `${label}.artifact`) }),
  };
}

function decodeCompositionOriginV1(
  input: unknown,
  label: string,
): CompositionOriginV1 {
  const value = record(input, label);
  const kind = boundedString(value.kind, `${label}.kind`, 32);
  if (kind === "bootstrap") {
    exactKeys(value, ["kind"], [], label);
  } else if (kind === "bot-authored") {
    exactKeys(value, ["kind", "runId", "sessionId", "turnId"], [], label);
    boundedString(value.runId, `${label}.runId`, 128);
    boundedString(value.sessionId, `${label}.sessionId`, 257);
    boundedString(value.turnId, `${label}.turnId`, 128);
  } else if (kind === "user-install") {
    exactKeys(value, ["kind", "userId"], [], label);
    boundedString(value.userId, `${label}.userId`, 256);
  } else if (kind === "revert") {
    exactKeys(value, ["kind", "revertsTo", "userId"], [], label);
    boundedString(value.revertsTo, `${label}.revertsTo`, 256);
    boundedString(value.userId, `${label}.userId`, 256);
  } else {
    throw new Error(`${label}.kind is invalid`);
  }
  // SAFETY: the exhaustive variant switch validated every origin field.
  return value as unknown as CompositionOriginV1;
}

/** The exact v1 decoder for a durable Composition generation record. */
export function decodeCompositionGenerationV1(
  input: unknown,
): CompositionGenerationV1 {
  const label = "composition generation";
  const value = record(input, label);
  exactKeys(value, GENERATION_REQUIRED_KEYS, GENERATION_OPTIONAL_KEYS, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const generationId = boundedString(
    value.generationId,
    `${label}.generationId`,
    256,
  );
  const artifactSetHash = hashString(
    value.artifactSetHash,
    `${label}.artifactSetHash`,
  );
  const createdAt = timestamp(value.createdAt, `${label}.createdAt`);
  const origin = decodeCompositionOriginV1(value.origin, `${label}.origin`);
  if (!Array.isArray(value.members)) {
    throw new Error(`${label}.members must be an array`);
  }
  if (value.members.length > MAX_COMPOSITION_MEMBERS) {
    throw new Error(`${label}.members exceeds its bound`);
  }
  const members = value.members.map((member, index) =>
    decodeCompositionMemberV1(member, `${label}.members[${index}]`),
  );
  const packageIds = new Set(members.map((member) => member.packageId));
  if (packageIds.size !== members.length) {
    throw new Error(`${label}.members contains duplicate packages`);
  }
  const status = COMPOSITION_GENERATION_STATUSES.find(
    (candidate) => candidate === value.status,
  );
  if (!status) throw new Error(`${label}.status is invalid`);
  if (value.parentGenerationId !== undefined) {
    boundedString(value.parentGenerationId, `${label}.parentGenerationId`, 256);
  }
  return {
    schemaVersion: 1,
    generationId,
    artifactSetHash,
    createdAt,
    origin,
    members,
    status,
    ...(value.parentGenerationId === undefined
      ? {}
      : { parentGenerationId: value.parentGenerationId as string }),
  };
}

/** The loader identity: sha-256 over the canonical, package-ordered member list. */
export function compositionArtifactSetHashV1(
  members: readonly CompositionMemberV1[],
): Promise<string> {
  return sha256(
    canonicalJson(
      [...members].sort((left, right) =>
        left.packageId.localeCompare(right.packageId),
      ),
    ),
  );
}

/** Rejects a generation whose recorded hash does not match its member list. */
export async function assertCompositionArtifactSetHashV1(
  generation: CompositionGenerationV1,
): Promise<void> {
  const expected = await compositionArtifactSetHashV1(generation.members);
  if (expected !== generation.artifactSetHash) {
    throw new Error(
      `composition generation "${generation.generationId}" has a mismatched artifact set hash`,
    );
  }
}

/** Sortable and stable: the same members created at the same instant reuse the id. */
export function compositionGenerationIdV1(
  createdAt: string,
  artifactSetHash: string,
): string {
  return `${createdAt}:${artifactSetHash.slice(0, 16)}`;
}

export interface BootstrapCompositionMemberV1 {
  packageId: string;
  specifier: string;
  version: string;
  manifest: unknown;
}

/**
 * The single first-party generation a Bot starts on: every Contribution the
 * compiled application declares, running in the kernel isolate.
 */
export async function bootstrapGeneration(
  members: readonly BootstrapCompositionMemberV1[],
  options: { createdAt: string },
): Promise<CompositionGenerationV1> {
  const composed = await Promise.all(
    members.map(async (member) => ({
      packageId: member.packageId,
      specifier: member.specifier,
      version: member.version,
      manifestHash: await sha256(canonicalJson(member.manifest)),
      provenance: {
        kind: "first-party" as const,
        packageId: member.packageId,
        version: member.version,
      },
    })),
  );
  const ordered = composed.sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  const artifactSetHash = await compositionArtifactSetHashV1(ordered);
  const createdAt = timestamp(options.createdAt, "bootstrap createdAt");
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    createdAt,
    origin: { kind: "bootstrap" },
    members: ordered,
    status: "pending",
  });
}
