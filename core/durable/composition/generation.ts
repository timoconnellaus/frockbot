// A Composition generation is the durable, versioned set of Plugins a Bot
// mounts. First-party code ships with the deploy and is never a member —
// there is nothing about it a generation could pin that the deployment does
// not already decide.
//
// This module declares the record and its exact v1 codec. The Durable Object
// owns the storage (`../composition-store.ts`) and the Package that mounts it
// owns the host.

import {
  canonicalJson,
  decodePluginDescriptorV1,
  PLUGIN_PAGE_PATH_V1,
  sha256,
  type PluginDescriptorV1,
  type PluginModuleArtifactV1,
  type PluginPageArtifactV1,
} from "@frockbot/core/contracts";

export type PackageProvenanceV1 =
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
    }
  | {
      /**
       * A Plugin the account installed with its own package command (ADR
       * 0032). It is not seeded — the deployment ships it, the User installs
       * it — and reconciliation leaves it exactly where the User put it.
       */
      kind: "installed";
      packageId: string;
      version: string;
      userId: string;
      installedAt: string;
    };

export interface ArtifactRefV1 {
  /** sha-256 hex of the bundled module bytes. */
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

/** One untrusted Package in a Bot's pinned Composition. */
export interface CompositionMemberV1 {
  packageId: string;
  version: string;
  provenance: PackageProvenanceV1;
  /** The immutable module bytes the isolate loads. */
  artifact: ArtifactRefV1;
  /** What the plugin declares it reaches; the isolate's health must match. */
  descriptor: PluginDescriptorV1;
  /**
   * The pages its `conversation.panel` views name, stored beside the module
   * and covered by the generation's hash, so a revert restores them with it.
   * Present exactly when a view names a page.
   */
  pages?: PluginPageArtifactV1[];
  /**
   * The device modules its descriptor declares (ADR 0037), stored beside the
   * module and covered by the generation's hash like its pages. Present
   * exactly when the descriptor declares a module.
   */
  modules?: PluginModuleArtifactV1[];
}

export type CompositionOriginV1 =
  | { kind: "bootstrap" }
  | { kind: "bot-authored"; runId: string; sessionId: string; turnId: string }
  | { kind: "revert"; revertsTo: string; userId: string }
  | {
      kind: "revert";
      revertsTo: string;
      botId: string;
      runId: string;
      turnId: string;
    };

export type CompositionGenerationStatusV1 =
  "pending" | "active" | "superseded" | "failed" | "quarantined";

export interface CompositionGenerationV1 {
  schemaVersion: 1;
  /** Lexicographically sortable, monotonic per Bot. */
  generationId: string;
  /** sha-256 over the canonical member list — the loader identity. */
  artifactSetHash: string;
  parentGenerationId?: string;
  /** Bot-written one-line audit copy for a setup change. */
  summary?: string;
  createdAt: string;
  origin: CompositionOriginV1;
  members: CompositionMemberV1[];
  status: CompositionGenerationStatusV1;
}

/**
 * A pinning proposal lost the race for `composition:current`.
 *
 * Two writers derive a generation from the pointer and then yield — a seeded
 * reconcile, a Turn bundling the Plugin it just authored. Whichever writes
 * second would otherwise replace the pointer with a generation derived from a
 * set that no longer exists, dropping every member the other one added.
 * Compare-and-swap turns that into this error, and the caller re-reads and
 * re-derives instead of overwriting.
 */
export class CompositionPinConflictError extends Error {
  readonly expectedGenerationId: string;
  readonly currentGenerationId: string | undefined;
  constructor(expected: string, current: string | undefined) {
    super(
      `composition pointer moved to "${current ?? "nothing"}" while a generation derived from "${expected}" was being proposed`,
    );
    this.name = "CompositionPinConflictError";
    this.expectedGenerationId = expected;
    this.currentGenerationId = current;
  }
}

/** How many times a losing pin re-reads and re-derives before it gives up. */
export const COMPOSITION_PIN_ATTEMPTS_V1 = 4;

/**
 * Runs a derive-and-pin attempt until it wins the compare-and-swap.
 *
 * Every attempt re-reads the pointer, so the merge is the derivation itself.
 * Bounded, because a Bot that cannot pin is better off leaving the generation
 * it has resident than spinning inside an admission path.
 */
export async function pinCompositionWithRetryV1<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? COMPOSITION_PIN_ATTEMPTS_V1;
  let conflict: CompositionPinConflictError | undefined;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof CompositionPinConflictError)) throw error;
      conflict = error;
    }
  }
  throw conflict ?? new Error("composition pin was never attempted");
}

/** The Durable Object implements this; the record only declares it. */
export interface CompositionStore {
  current(): Promise<CompositionGenerationV1>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  /**
   * Records a new generation. `pin` advances `composition:current` to it, so
   * the next admitted Turn pins the proposal; the generation stays `pending`
   * until it mounts and is committed.
   *
   * `expectedCurrentGenerationId` makes the pin a compare-and-swap against the
   * generation this one was derived from: a pointer that moved meanwhile
   * refuses with `CompositionPinConflictError` and writes nothing.
   */
  propose(
    generation: CompositionGenerationV1,
    options?: { pin?: boolean; expectedCurrentGenerationId?: string },
  ): Promise<void>;
  commit(generationId: string): Promise<void>;
  /** Records a revert as a new pending generation; never mutates the target. */
  revert(
    toGenerationId: string,
    origin: Extract<CompositionOriginV1, { kind: "revert" }>,
    options?: { createdAt?: string },
  ): Promise<CompositionGenerationV1>;
  list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }>;
}

export interface MountedComposition {
  readonly generation: CompositionGenerationV1;
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
const GENERATION_OPTIONAL_KEYS = ["parentGenerationId", "summary"] as const;
const MEMBER_KEYS = [
  "packageId",
  "version",
  "provenance",
  "artifact",
  "descriptor",
] as const;
const ARTIFACT_KEYS = [
  "contentHash",
  "size",
  "mediaType",
  "bundlerVersion",
] as const;
/**
 * Untrusted members only, so the bound is what one Bot could plausibly author
 * or install rather than the old ceiling that had to cover every first-party
 * Package as well.
 */
export const MAX_COMPOSITION_MEMBERS_V1 = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const MAX_COMPOSITION_SUMMARY_V1 = 160;

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
  if (kind === "user") {
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
  } else if (kind === "installed") {
    exactKeys(value, [...common, "userId", "installedAt"], [], label);
    identity();
    boundedString(value.userId, `${label}.userId`, 256);
    timestamp(value.installedAt, `${label}.installedAt`);
  } else {
    throw new Error(`${label}.kind is invalid`);
  }
  // SAFETY: the exhaustive variant switch validated every provenance field.
  return value as unknown as PackageProvenanceV1;
}

export function decodeArtifactRefV1(
  input: unknown,
  label: string,
): ArtifactRefV1 {
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

export function decodeCompositionMemberV1(
  input: unknown,
  label: string,
): CompositionMemberV1 {
  const value = record(input, label);
  exactKeys(value, MEMBER_KEYS, ["pages", "modules"], label);
  const packageId = boundedString(value.packageId, `${label}.packageId`, 128);
  const version = boundedString(value.version, `${label}.version`, 64);
  const provenance = decodePackageProvenanceV1(
    value.provenance,
    `${label}.provenance`,
  );
  if (provenance.packageId !== packageId || provenance.version !== version) {
    throw new Error(`${label}.provenance does not match its member`);
  }
  const descriptor = decodePluginDescriptorV1(
    value.descriptor,
    `${label}.descriptor`,
  );
  if (descriptor.id !== packageId || descriptor.version !== version) {
    throw new Error(`${label}.descriptor does not match its member`);
  }
  const pages = decodeMemberPagesV1(value.pages, descriptor, `${label}.pages`);
  const modules = decodeMemberModulesV1(
    value.modules,
    descriptor,
    `${label}.modules`,
  );
  return {
    packageId,
    version,
    provenance,
    artifact: decodeArtifactRefV1(value.artifact, `${label}.artifact`),
    descriptor,
    ...(pages === undefined ? {} : { pages }),
    ...(modules === undefined ? {} : { modules }),
  };
}

/** Exactly one stored module for every module the descriptor declares. */
function decodeMemberModulesV1(
  input: unknown,
  descriptor: PluginDescriptorV1,
  label: string,
): PluginModuleArtifactV1[] | undefined {
  const declared = new Set(
    (descriptor.device?.modules ?? []).map((module) => module.id),
  );
  if (input === undefined) {
    if (declared.size > 0) throw new Error(`${label} is missing`);
    return undefined;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const modules = input.map((entry, index) => {
    const value = record(entry, `${label}[${index}]`);
    exactKeys(value, ["id", "contentHash", "size"], [], `${label}[${index}]`);
    if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
      throw new Error(`${label}[${index}].size must be a non-negative integer`);
    }
    return {
      id: boundedString(value.id, `${label}[${index}].id`, 32),
      contentHash: hashString(
        value.contentHash,
        `${label}[${index}].contentHash`,
      ),
      size: value.size as number,
    };
  });
  const ids = new Set(modules.map((module) => module.id));
  if (
    ids.size !== modules.length ||
    ids.size !== declared.size ||
    ![...declared].every((id) => ids.has(id))
  ) {
    throw new Error(
      `${label} must name each module the descriptor declares, once`,
    );
  }
  return modules;
}

/** Exactly one stored page for every page a view names, and no other. */
function decodeMemberPagesV1(
  input: unknown,
  descriptor: PluginDescriptorV1,
  label: string,
): PluginPageArtifactV1[] | undefined {
  const named = new Set(
    (descriptor.views ?? []).flatMap((view) =>
      view.page === undefined ? [] : [view.page],
    ),
  );
  if (input === undefined) {
    if (named.size > 0) throw new Error(`${label} is missing`);
    return undefined;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const pages = input.map((entry, index) => {
    const value = record(entry, `${label}[${index}]`);
    exactKeys(value, ["path", "contentHash", "size"], [], `${label}[${index}]`);
    const path = boundedString(value.path, `${label}[${index}].path`, 140);
    if (!PLUGIN_PAGE_PATH_V1.test(path)) {
      throw new Error(`${label}[${index}].path is invalid`);
    }
    if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
      throw new Error(`${label}[${index}].size must be a non-negative integer`);
    }
    return {
      path,
      contentHash: hashString(
        value.contentHash,
        `${label}[${index}].contentHash`,
      ),
      size: value.size as number,
    };
  });
  const paths = new Set(pages.map((page) => page.path));
  if (
    paths.size !== pages.length ||
    paths.size !== named.size ||
    ![...named].every((path) => paths.has(path))
  ) {
    throw new Error(`${label} must name each page the views name, once`);
  }
  return pages;
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
  } else if (kind === "revert") {
    boundedString(value.revertsTo, `${label}.revertsTo`, 256);
    if (Object.hasOwn(value, "userId")) {
      exactKeys(value, ["kind", "revertsTo", "userId"], [], label);
      boundedString(value.userId, `${label}.userId`, 256);
    } else {
      exactKeys(
        value,
        ["kind", "revertsTo", "botId", "runId", "turnId"],
        [],
        label,
      );
      boundedString(value.botId, `${label}.botId`, 256);
      boundedString(value.runId, `${label}.runId`, 128);
      boundedString(value.turnId, `${label}.turnId`, 128);
    }
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
  if (value.members.length > MAX_COMPOSITION_MEMBERS_V1) {
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
  if (value.summary !== undefined) {
    const summary = boundedString(
      value.summary,
      `${label}.summary`,
      MAX_COMPOSITION_SUMMARY_V1,
    );
    if (summary.trim() !== summary || /[\r\n]/u.test(summary)) {
      throw new Error(`${label}.summary must be one trimmed line`);
    }
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
    ...(value.summary === undefined
      ? {}
      : { summary: value.summary as string }),
  };
}

/** The loader identity: sha-256 over the canonical, package-ordered member list. */
export function compositionArtifactSetHashV1(
  members: readonly CompositionMemberV1[],
): Promise<string> {
  const orderedMembers = [...members].sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  return sha256(canonicalJson(orderedMembers));
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

/**
 * The generation a Bot starts on: no plugins at all.
 *
 * The whole product surface is first-party code that ships with the deploy, so
 * a Bot that has installed nothing and authored nothing has an empty
 * Composition. That is the truth rather than a placeholder, and it is why a
 * release no longer has to rewrite every Bot's generation to follow it.
 */
export async function bootstrapGeneration(options: {
  createdAt: string;
}): Promise<CompositionGenerationV1> {
  const artifactSetHash = await compositionArtifactSetHashV1([]);
  const createdAt = timestamp(options.createdAt, "bootstrap createdAt");
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    createdAt,
    origin: { kind: "bootstrap" },
    members: [],
    status: "pending",
  });
}
