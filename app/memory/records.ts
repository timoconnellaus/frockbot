// Canonical Memory records and the six frozen operations.
//
// Prepared core, recall, expand, browse, write and forget are the engine's
// public surface. Retrieval, projections and Vectorize live on top of these
// rows; they are not a second source of truth. The live Markdown file store
// remains until M3 cutover; this module is the tested foundation.

import { MEMORY_MAX_FACT_LENGTH } from "./store.js";
import { memoryFactKeyV1 } from "./facts.js";
import { isMemoryProjectIdV1 } from "./roots.js";

/** Product-facing scope names. `project` maps to engine `groupChat`. */
export type MemoryProductScopeV1 = "bot" | "user" | "project";

/** Engine scope kinds. `groupChat` is the typed shared scope. */
export type MemoryEngineScopeKindV1 = "bot" | "user" | "groupChat";

export type MemoryItemKindV1 = "fact" | "experience" | "observation";
export type MemoryItemStatusV1 = "active" | "inactive" | "superseded";
export type MemoryRelationV1 =
  "supersedes" | "supports" | "contradicts" | "about" | "promotedFrom";

export type MemoryCompletenessV1 =
  "complete" | "partial" | "empty" | "unavailable" | "refused";

export const MEMORY_MAX_TEXT_CHARS_V1 = MEMORY_MAX_FACT_LENGTH;
export const MEMORY_MAX_SOURCE_EXCERPT_V1 = 700;
export const MEMORY_MAX_SOURCES_V1 = 32;
export const MEMORY_MAX_LEAF_MANIFEST_V1 = 32;
export const MEMORY_BROWSE_SECTIONS_V1 = 2;
export const MEMORY_RECALL_PAGE_V1 = 20;
export const MEMORY_MAX_EXPAND_REFS_V1 = 16;
export const MEMORY_MAX_BROWSE_PAGE_V1 = 32;
export const MEMORY_JOB_WAKEUP_MS_V1 = 1_000;

export type MemorySourceKindV1 = "chat" | "voice" | "explicit";

export interface MemoryChatLocatorV1 {
  kind: "chat";
  botId: string;
  sessionId: string;
  runId: string;
  eventSeq: number;
  revision: string;
}

export interface MemoryVoiceLocatorV1 {
  kind: "voice";
  callId: string;
  spokenTurnSeq: number;
  revision: string;
}

export interface MemoryExplicitLocatorV1 {
  kind: "explicit";
  revision: string;
}

export type MemorySourceLocatorV1 =
  MemoryChatLocatorV1 | MemoryVoiceLocatorV1 | MemoryExplicitLocatorV1;

export interface MemorySourceInputV1 {
  sourceId: string;
  sourceRevision: string;
  kind: MemorySourceKindV1;
  locator: MemorySourceLocatorV1;
  safeExcerpt?: string;
}

export interface MemoryScopeRefV1 {
  kind: MemoryEngineScopeKindV1;
  userId: string;
  botId?: string;
  groupChatId?: string;
}

export interface MemoryAuthorityV1 {
  userId: string;
  botId: string;
  /** `user` is the authenticated User command path; `bot` is a Bot Turn. */
  actor: "bot" | "user";
  /** Current Project membership, filled by the owner — never trusted from a caller. */
  joinedGroupChatIds: readonly string[];
  membershipRevision: string;
}

export interface MemoryItemRecordV1 {
  id: string;
  generation: number;
  kind: MemoryItemKindV1;
  status: MemoryItemStatusV1;
  canonicalKey: string;
  text: string;
  subjectKey?: string;
  predicateKey?: string;
  occurredAt?: string;
  recordedAt: string;
  validFrom?: string;
  validTo?: string;
  createdBy: string;
  confidence?: number;
  scope: MemoryScopeRefV1;
}

export interface MemoryHitV1 {
  item: MemoryItemRecordV1;
  score?: number;
  sourceRefs: Array<{ sourceId: string; sourceRevision: string }>;
}

export interface MemoryEngineOmissionV1 {
  reason: string;
  scope?: MemoryScopeRefV1;
  ref?: string;
}

export interface MemoryLeafManifestV1 {
  itemId: string;
  generation: number;
}

export interface MemoryCoreBlockV1 {
  scope: MemoryScopeRefV1;
  text: string;
  manifest: MemoryLeafManifestV1[];
  generation: number;
  policyVersion: number;
}

export interface MemoryBrowseSectionV1 {
  sectionId: string;
  generation: number;
  title: string;
  summary: string;
  items: MemoryItemRecordV1[];
  manifest: MemoryLeafManifestV1[];
}

export interface MemoryEvidenceV1 {
  itemId: string;
  sourceId: string;
  sourceRevision: string;
  kind: MemorySourceKindV1;
  locator: MemorySourceLocatorV1;
  excerpt?: string;
  unavailable?: string;
}

export interface MemoryWriteReceiptV1 {
  operationKey: string;
  itemId: string;
  generation: number;
  scope: MemoryScopeRefV1;
  duplicate: boolean;
  suppressedOverride: boolean;
}

export interface MemoryForgetReceiptV1 {
  operationKey: string;
  itemId?: string;
  exactKey: string;
  forgotten: boolean;
  duplicate: boolean;
  scope: MemoryScopeRefV1;
}

export type MemoryWriteResultV1 =
  | { status: "ok"; receipt: MemoryWriteReceiptV1 }
  | { status: "refused"; reason: string }
  | { status: "unavailable"; reason: string };

export type MemoryForgetResultV1 =
  | { status: "ok"; receipt: MemoryForgetReceiptV1 }
  | { status: "refused"; reason: string }
  | { status: "unavailable"; reason: string };

export interface MemoryRecallResultV1 {
  hits: MemoryHitV1[];
  status: MemoryCompletenessV1;
  cursor?: string;
  omissions: MemoryEngineOmissionV1[];
  membershipRevision: string;
}

export interface MemoryExpandResultV1 {
  evidence: MemoryEvidenceV1[];
  omissions: MemoryEngineOmissionV1[];
  status: MemoryCompletenessV1;
}

export interface MemoryBrowseResultV1 {
  sections: MemoryBrowseSectionV1[];
  status: MemoryCompletenessV1;
  cursor?: string;
  omissions: MemoryEngineOmissionV1[];
}

export interface MemoryPreparedCoreResultV1 {
  blocks: MemoryCoreBlockV1[];
  manifest: MemoryLeafManifestV1[];
  omissions: MemoryEngineOmissionV1[];
  status: MemoryCompletenessV1;
}

export interface MemoryWriteRequestV1 {
  authority: MemoryAuthorityV1;
  scope: MemoryScopeRefV1;
  content: string;
  sources?: readonly MemorySourceInputV1[];
  operationKey: string;
  replaces?: string;
  promotedFrom?: { scopeKey: string; itemId: string };
  kind?: MemoryItemKindV1;
  subjectKey?: string;
  occurredAt?: string;
  createdBy?: string;
}

export interface MemoryForgetRequestV1 {
  authority: MemoryAuthorityV1;
  scope: MemoryScopeRefV1;
  operationKey: string;
  itemId?: string;
  exactKey?: string;
}

export interface MemoryRecallRequestV1 {
  authority: MemoryAuthorityV1;
  query: string;
  scopes: readonly MemoryScopeRefV1[];
  filters?: { kind?: MemoryItemKindV1; subjectKey?: string };
  budget?: number;
  cursor?: string;
}

export interface MemoryExpandRequestV1 {
  authority: MemoryAuthorityV1;
  sourceRefs: ReadonlyArray<{
    scope: MemoryScopeRefV1;
    itemId?: string;
    sourceId?: string;
    sourceRevision?: string;
  }>;
  budget?: number;
}

export interface MemoryBrowseRequestV1 {
  authority: MemoryAuthorityV1;
  scope: MemoryScopeRefV1;
  topic?: string;
  cursor?: string;
  budget?: number;
}

export interface MemoryPreparedCoreRequestV1 {
  authority: MemoryAuthorityV1;
  scopes: readonly MemoryScopeRefV1[];
  budget?: number;
}

/**
 * The six frozen operations. Hosts implement this over owner-local SQLite;
 * the Bot facade fans User/shared work to one User RPC.
 */
export interface MemoryOperationsV1 {
  preparedCore(
    request: MemoryPreparedCoreRequestV1,
  ): MemoryPreparedCoreResultV1;
  recall(request: MemoryRecallRequestV1): MemoryRecallResultV1;
  expand(request: MemoryExpandRequestV1): MemoryExpandResultV1;
  browse(request: MemoryBrowseRequestV1): MemoryBrowseResultV1;
  write(request: MemoryWriteRequestV1): MemoryWriteResultV1;
  forget(request: MemoryForgetRequestV1): MemoryForgetResultV1;
}

export function memoryCanonicalKeyV1(text: string): string {
  return memoryFactKeyV1(text);
}

export function memoryScopeKeyV1(scope: MemoryScopeRefV1): string {
  if (scope.kind === "bot") {
    if (!scope.botId) throw new Error("bot scope requires a Bot id");
    return `bot:${scope.userId}:${scope.botId}`;
  }
  if (scope.kind === "user") return `user:${scope.userId}`;
  if (!scope.groupChatId) {
    throw new Error("groupChat scope requires a Group Chat id");
  }
  return `groupChat:${scope.userId}:${scope.groupChatId}`;
}

export function decodeMemoryScopeKeyV1(scopeKey: string): MemoryScopeRefV1 {
  if (scopeKey.startsWith("bot:")) {
    const rest = scopeKey.slice("bot:".length);
    const split = rest.indexOf(":");
    if (split <= 0 || split === rest.length - 1) {
      throw new Error(`Memory scope key "${scopeKey}" is invalid`);
    }
    return {
      kind: "bot",
      userId: rest.slice(0, split),
      botId: rest.slice(split + 1),
    };
  }
  if (scopeKey.startsWith("groupChat:")) {
    const rest = scopeKey.slice("groupChat:".length);
    const split = rest.indexOf(":");
    if (split <= 0 || split === rest.length - 1) {
      throw new Error(`Memory scope key "${scopeKey}" is invalid`);
    }
    return {
      kind: "groupChat",
      userId: rest.slice(0, split),
      groupChatId: rest.slice(split + 1),
    };
  }
  if (scopeKey.startsWith("user:")) {
    const userId = scopeKey.slice("user:".length);
    if (!userId) throw new Error(`Memory scope key "${scopeKey}" is invalid`);
    return { kind: "user", userId };
  }
  throw new Error(`Memory scope key "${scopeKey}" is invalid`);
}

/**
 * Maps the still-exposed Project membership id onto the engine's `groupChat`
 * scope. One adapter, so membership records stay where they are until the
 * separately assigned rename.
 */
export function groupChatScopeFromProjectV1(
  userId: string,
  projectId: string,
): MemoryScopeRefV1 {
  if (!isMemoryProjectIdV1(projectId)) {
    throw new Error(`Project slug "${projectId}" is invalid`);
  }
  return { kind: "groupChat", userId, groupChatId: projectId };
}

export function productScopeToEngineV1(
  scope: MemoryProductScopeV1,
  owner: { userId: string; botId: string },
  projectId?: string,
): MemoryScopeRefV1 {
  if (scope === "bot") {
    return { kind: "bot", userId: owner.userId, botId: owner.botId };
  }
  if (scope === "user") return { kind: "user", userId: owner.userId };
  if (!projectId) throw new Error("the project scope requires a Project slug");
  return groupChatScopeFromProjectV1(owner.userId, projectId);
}

export function engineScopeToProductV1(
  scope: MemoryScopeRefV1,
): MemoryProductScopeV1 {
  if (scope.kind === "bot") return "bot";
  if (scope.kind === "user") return "user";
  return "project";
}

export function createdByPrincipalV1(authority: MemoryAuthorityV1): string {
  return authority.actor === "user"
    ? `user:${authority.userId}`
    : `bot:${authority.botId}`;
}

/**
 * Whether this authority may read or write the named scope. Membership is
 * the current joined set the owner loaded; a caller-supplied scope id alone
 * is never enough.
 */
export function authorizeMemoryScopeV1(
  authority: MemoryAuthorityV1,
  scope: MemoryScopeRefV1,
): string | undefined {
  if (scope.userId !== authority.userId) {
    return "this User is not the owner of that Memory scope";
  }
  if (scope.kind === "bot") {
    if (scope.botId !== authority.botId) {
      return "a Bot may only read and write its own Bot Memory";
    }
    return undefined;
  }
  if (scope.kind === "user") return undefined;
  const groupChatId = scope.groupChatId;
  if (!groupChatId) return "groupChat scope requires a Group Chat id";
  if (!authority.joinedGroupChatIds.includes(groupChatId)) {
    return `you have not joined Project "${groupChatId}"; join it before changing its memory`;
  }
  return undefined;
}

export function toolKindFromTierV1(
  tier: "profile" | "log" | "note",
): MemoryItemKindV1 {
  if (tier === "profile") return "fact";
  if (tier === "note") return "observation";
  return "experience";
}
