// Tool adapters for the canonical Memory operations.
//
// `memory_write`, `memory_forget` and `memory_search` call these when the
// host supplies a records facade. `memory_expand` and `memory_browse` exist
// only on that path — progressive disclosure has no Markdown equivalent.

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  MemoryScopeNameV1,
} from "@frockbot/core/contracts";
import type { MemoryRecordsV1 } from "./owner.js";
import {
  MEMORY_MAX_TEXT_CHARS_V1,
  createdByPrincipalV1,
  engineScopeToProductV1,
  productScopeToEngineV1,
  toolKindFromTierV1,
  type MemoryAuthorityV1,
  type MemoryProductScopeV1,
  type MemoryScopeRefV1,
} from "./records.js";
import { explicitDatesInQueryV1 } from "./hybrid.js";
import { isGroupIdV1 } from "@frockbot/app/groups/shared";
import type { MemoryOwnerV1 } from "./roots.js";
import type { MemoryGroupsV1 } from "./groups.js";
import { MEMORY_MAX_FACT_LENGTH } from "./store.js";
import { refuseMemorySecretV1 } from "./secrets.js";

/** A fact about to be remembered, and what is kept near it. */
export interface MemoryWriteEvidenceV1 {
  readonly fact: string;
  readonly tier: "profile" | "log" | "note";
  /** What is already kept in the same scope that recall found near it. */
  readonly candidates: readonly {
    readonly id: string;
    readonly text: string;
  }[];
}

/** What a write becomes once judged. */
export type MemoryWriteVerdictV1 =
  | { readonly action: "refuse-secret" }
  | { readonly action: "already-kept"; readonly id: string }
  | {
      readonly action: "write";
      readonly tier: "profile" | "log" | "note";
      readonly replaces?: { readonly id: string; readonly text: string };
    };

/** How many kept facts are recalled to judge a write against. */
export const MEMORY_WRITE_RECALL_V1 = 5;

export interface MemoryRecordsHostV1 {
  owner: MemoryOwnerV1;
  records: MemoryRecordsV1;
  /**
   * Judges a fact against what is kept before it is written. Absent, or
   * when it cannot say, the fact is written as asked.
   */
  judgeWrite?(
    evidence: MemoryWriteEvidenceV1,
  ): Promise<MemoryWriteVerdictV1 | undefined>;
  writer?: { sessionId: string; turnId: string; runId: string };
  groups?: MemoryGroupsV1;
  /** The Group Chat this Turn speaks in, the default `group_id`. */
  group?: string;
}

/**
 * The authority one call carries. Group Chat membership is read for it; one
 * that cannot be read opens no group, and says so in its revision.
 */
export async function authorityOf(
  host: Pick<MemoryRecordsHostV1, "owner" | "groups">,
): Promise<MemoryAuthorityV1> {
  let joinedGroupChatIds: string[] = [];
  let membershipRevision = "0";
  if (host.groups) {
    try {
      joinedGroupChatIds = await host.groups.memberOf();
      membershipRevision = memoryMembershipRevisionV1(joinedGroupChatIds);
    } catch {
      membershipRevision = "unavailable";
    }
  }
  return {
    userId: host.owner.userId,
    botId: host.owner.botId,
    actor: "bot",
    joinedGroupChatIds,
    membershipRevision: membershipRevision || "0",
  };
}

/** A membership's revision is the set itself, so both owners agree on it. */
export function memoryMembershipRevisionV1(
  groupIds: readonly string[],
): string {
  return [...groupIds].sort().join(",") || "0";
}

/** The `group_id` a group-scope call names, defaulting to this Turn's group. */
function decodeGroupIdFieldV1(
  scope: MemoryProductScopeV1,
  value: unknown,
  group: string | undefined,
): string | undefined {
  if (scope !== "group") {
    if (value !== undefined) {
      throw new Error("group_id is only valid with the group scope");
    }
    return undefined;
  }
  const groupId = value ?? group;
  if (!isGroupIdV1(groupId)) {
    throw new Error("the group scope requires the group chat's group_id");
  }
  return groupId;
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

export async function executeRecordsWriteV1(
  host: MemoryRecordsHostV1,
  input: {
    scope: MemoryScopeNameV1;
    groupId?: string;
    tier: "profile" | "log" | "note";
    fact: string;
  },
  operationKey: string,
): Promise<ToolExecutionResult> {
  const authority = await authorityOf(host);
  let scope: MemoryScopeRefV1;
  try {
    scope = productScopeToEngineV1(input.scope, host.owner, input.groupId);
  } catch (error) {
    return refusal(
      `memory_write was refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sources = host.writer
    ? [
        {
          sourceId: `${host.writer.sessionId}:${host.writer.turnId}`,
          sourceRevision: host.writer.runId,
          kind: "explicit" as const,
          locator: {
            kind: "explicit" as const,
            revision: host.writer.runId,
          },
        },
      ]
    : [];
  const verdict = await judgedWriteV1(host, authority, scope, input);
  if (verdict?.action === "refuse-secret") {
    return refusal(
      "memory_write was refused: it holds a secret, such as a password, key or account number. Never keep a secret in Memory.",
    );
  }
  if (verdict?.action === "already-kept") {
    return { content: "Already remembered; nothing changed.", isError: false };
  }
  const tier = verdict?.tier ?? input.tier;
  const outcome = await host.records.write({
    authority,
    scope,
    content: input.fact,
    operationKey,
    kind: toolKindFromTierV1(tier),
    sources,
    ...(verdict?.replaces ? { replaces: verdict.replaces.id } : {}),
  });
  if (outcome.status !== "ok") {
    return refusal(`memory_write was ${outcome.status}: ${outcome.reason}`);
  }
  if (outcome.receipt.duplicate) {
    return { content: "Already remembered; nothing changed.", isError: false };
  }
  const notes = [
    ...(verdict?.replaces
      ? [`It replaces what was kept before: "${verdict.replaces.text}".`]
      : []),
    ...(tier !== input.tier
      ? [`It is kept as a ${tier} entry, since it will not stay true.`]
      : []),
  ];
  return {
    content: ["Remembered.", ...notes].join(" "),
    isError: false,
  };
}

/** What the judge makes of a write, against what recall finds kept near it. */
async function judgedWriteV1(
  host: MemoryRecordsHostV1,
  authority: MemoryAuthorityV1,
  scope: MemoryScopeRefV1,
  input: { tier: "profile" | "log" | "note"; fact: string },
): Promise<MemoryWriteVerdictV1 | undefined> {
  if (!host.judgeWrite) return undefined;
  const text = input.fact.trim();
  if (
    !text ||
    text.length > MEMORY_MAX_TEXT_CHARS_V1 ||
    refuseMemorySecretV1(text)
  ) {
    return undefined;
  }
  let candidates: { id: string; text: string; createdBy: string }[] = [];
  try {
    const recalled = await host.records.recall({
      authority,
      query: input.fact,
      scopes: [scope],
      budget: MEMORY_WRITE_RECALL_V1,
      effort: "automatic",
    });
    candidates = recalled.hits
      .filter((hit) => hit.item.status === "active")
      .slice(0, MEMORY_WRITE_RECALL_V1)
      .map((hit) => ({
        id: hit.item.id,
        text: hit.item.text,
        createdBy: hit.item.createdBy,
      }));
  } catch {
    // Nothing recalled to compare with; the secret and lasting questions stand.
  }
  const verdict = await host.judgeWrite({
    fact: input.fact,
    tier: input.tier,
    candidates: candidates.map(({ id, text }) => ({ id, text })),
  });
  if (verdict?.action !== "write" || !verdict.replaces) return verdict;
  const replaced = candidates.find((kept) => kept.id === verdict.replaces?.id);
  if (replaced?.createdBy === createdByPrincipalV1(authority)) return verdict;
  return { action: "write", tier: verdict.tier };
}

export async function executeRecordsForgetV1(
  host: MemoryRecordsHostV1,
  input: {
    scope: MemoryScopeNameV1;
    groupId?: string;
    fact: string;
  },
  operationKey: string,
): Promise<ToolExecutionResult> {
  const authority = await authorityOf(host);
  let scope: MemoryScopeRefV1;
  try {
    scope = productScopeToEngineV1(input.scope, host.owner, input.groupId);
  } catch (error) {
    return refusal(
      `memory_forget was refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const outcome = await host.records.forget({
    authority,
    scope,
    operationKey,
    exactKey: input.fact,
  });
  if (outcome.status !== "ok") {
    return refusal(`memory_forget was ${outcome.status}: ${outcome.reason}`);
  }
  return { content: `Forgotten.`, isError: false };
}

export async function executeRecordsSearchV1(
  host: MemoryRecordsHostV1,
  input: { query: string; scope?: MemoryScopeNameV1; maxResults?: number },
): Promise<ToolExecutionResult> {
  const authority = await authorityOf(host);
  const groups = authority.joinedGroupChatIds.map((id) =>
    productScopeToEngineV1("group", host.owner, id),
  );
  // In a group's Turn, "group" means that group; elsewhere, every group the
  // Bot is in.
  const scopes: MemoryScopeRefV1[] = input.scope
    ? input.scope === "group"
      ? host.group && authority.joinedGroupChatIds.includes(host.group)
        ? [productScopeToEngineV1("group", host.owner, host.group)]
        : groups
      : [productScopeToEngineV1(input.scope, host.owner)]
    : [
        productScopeToEngineV1("bot", host.owner),
        productScopeToEngineV1("user", host.owner),
        ...groups,
      ];
  const dates = explicitDatesInQueryV1(input.query);
  const recalled = await host.records.recall({
    authority,
    query: input.query,
    scopes,
    budget: input.maxResults ?? 5,
    effort: "explicit",
    ...(dates.occurredFrom ? { filters: dates } : {}),
    ...(scopes[0] && input.scope ? { focusScope: scopes[0] } : {}),
  });
  if (recalled.status === "refused" || recalled.status === "unavailable") {
    const reason =
      recalled.omissions[0]?.reason ?? `memory_search was ${recalled.status}`;
    return refusal(`memory_search was ${recalled.status}: ${reason}`);
  }
  if (recalled.hits.length === 0)
    return { content: "No memory matches.", isError: false };
  const header = `status=${recalled.status} tokensEstimated=${recalled.tokensEstimated ?? 0}`;
  return {
    content: [
      header,
      ...recalled.hits.map((hit, index) => {
        const where = engineScopeToProductV1(hit.item.scope);
        const group =
          hit.item.scope.kind === "groupChat"
            ? `/${hit.item.scope.groupChatId}`
            : "";
        const scopeKey =
          hit.item.scope.kind === "bot"
            ? `bot:${hit.item.scope.userId}:${hit.item.scope.botId}`
            : hit.item.scope.kind === "user"
              ? `user:${hit.item.scope.userId}`
              : `groupChat:${hit.item.scope.userId}:${hit.item.scope.groupChatId}`;
        return `[${index + 1}] ${where}${group}:${hit.item.id}\nmemory-item ${scopeKey} ${hit.item.id} ${hit.item.generation}\n${hit.item.text}`;
      }),
    ].join("\n\n---\n\n"),
    isError: false,
  };
}

const EXPAND_SCHEMA = {
  type: "object",
  properties: {
    itemId: {
      type: "string",
      description: "The Memory item whose supporting evidence to expand.",
    },
    sourceId: {
      type: "string",
      description: "A source id previously returned with a hit.",
    },
    scope: {
      type: "string",
      enum: ["bot", "user", "group"],
    },
    group_id: { type: "string" },
  },
  additionalProperties: false,
} as const;

const BROWSE_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["bot", "user", "group"],
      description: "Which Memory to page through. Defaults to bot.",
    },
    group_id: { type: "string" },
    topic: {
      type: "string",
      description: "Optional subject to filter the page.",
    },
    cursor: { type: "string" },
  },
  additionalProperties: false,
} as const;

function decodeExpandInputV1(
  input: unknown,
  group?: string,
): {
  itemId?: string;
  sourceId?: string;
  scope: MemoryProductScopeV1;
  groupId?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["itemId", "sourceId", "scope", "group_id"].includes(key),
    )
  ) {
    throw new Error("input has unknown fields");
  }
  if (value.itemId === undefined && value.sourceId === undefined) {
    throw new Error("itemId or sourceId is required");
  }
  const scope = (value.scope ?? "bot") as MemoryProductScopeV1;
  if (!["bot", "user", "group"].includes(scope)) {
    throw new Error("scope is invalid");
  }
  const decoded: {
    itemId?: string;
    sourceId?: string;
    scope: MemoryProductScopeV1;
    groupId?: string;
  } = { scope };
  if (typeof value.itemId === "string") decoded.itemId = value.itemId;
  if (typeof value.sourceId === "string") decoded.sourceId = value.sourceId;
  const groupId = decodeGroupIdFieldV1(scope, value.group_id, group);
  if (groupId) decoded.groupId = groupId;
  return decoded;
}

function decodeBrowseInputV1(
  input: unknown,
  group?: string,
): {
  scope: MemoryProductScopeV1;
  groupId?: string;
  topic?: string;
  cursor?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["scope", "group_id", "topic", "cursor"].includes(key),
    )
  ) {
    throw new Error("input has unknown fields");
  }
  const scope = (value.scope ?? "bot") as MemoryProductScopeV1;
  if (!["bot", "user", "group"].includes(scope)) {
    throw new Error("scope is invalid");
  }
  const decoded: {
    scope: MemoryProductScopeV1;
    groupId?: string;
    topic?: string;
    cursor?: string;
  } = { scope };
  const groupId = decodeGroupIdFieldV1(scope, value.group_id, group);
  if (groupId) decoded.groupId = groupId;
  if (value.topic !== undefined) {
    if (
      typeof value.topic !== "string" ||
      value.topic.length > MEMORY_MAX_FACT_LENGTH
    ) {
      throw new Error("topic must be a bounded string");
    }
    decoded.topic = value.topic;
  }
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== "string" || value.cursor.length > 256) {
      throw new Error("cursor is invalid");
    }
    decoded.cursor = value.cursor;
  }
  return decoded;
}

export function createMemoryExpandTool(
  host: MemoryRecordsHostV1,
): ToolDefinition {
  return {
    name: "memory_expand",
    namespace: "frockbot",
    admission: { subagentRoles: ["executor"] },
    description:
      "Open the supporting evidence for one Memory item or source. Use this after memory_search when you need the exact excerpt.",
    inputSchema: EXPAND_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    validate: (input) => {
      try {
        decodeExpandInputV1(input, host.group);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let decoded: ReturnType<typeof decodeExpandInputV1>;
      try {
        decoded = decodeExpandInputV1(input, host.group);
      } catch (error) {
        return refusal(
          `memory_expand was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const authority = await authorityOf(host);
      let scope: MemoryScopeRefV1;
      try {
        scope = productScopeToEngineV1(
          decoded.scope,
          host.owner,
          decoded.groupId,
        );
      } catch (error) {
        return refusal(
          `memory_expand was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const expanded = await host.records.expand({
        authority,
        sourceRefs: [
          {
            scope,
            ...(decoded.itemId ? { itemId: decoded.itemId } : {}),
            ...(decoded.sourceId ? { sourceId: decoded.sourceId } : {}),
          },
        ],
      });
      if (expanded.status === "refused" || expanded.status === "unavailable") {
        return refusal(
          `memory_expand was ${expanded.status}: ${expanded.omissions[0]?.reason ?? expanded.status}`,
        );
      }
      if (expanded.evidence.length === 0) {
        return {
          content:
            expanded.omissions[0]?.reason ??
            "No supporting evidence is available.",
          isError: false,
        };
      }
      return {
        content: expanded.evidence
          .map((entry) => {
            const quote = entry.excerpt ?? "(no durable excerpt)";
            return `${entry.sourceId}@${entry.sourceRevision}\n${quote}`;
          })
          .join("\n\n---\n\n"),
        isError: false,
      };
    },
  };
}

export function createMemoryBrowseTool(
  host: MemoryRecordsHostV1,
): ToolDefinition {
  return {
    name: "memory_browse",
    namespace: "frockbot",
    admission: { subagentRoles: ["executor"] },
    description:
      "Page through Memory by time or topic. Returns at most two sections; use the cursor for the next page.",
    inputSchema: BROWSE_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    validate: (input) => {
      try {
        decodeBrowseInputV1(input, host.group);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let decoded: ReturnType<typeof decodeBrowseInputV1>;
      try {
        decoded = decodeBrowseInputV1(input, host.group);
      } catch (error) {
        return refusal(
          `memory_browse was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const authority = await authorityOf(host);
      let scope: MemoryScopeRefV1;
      try {
        scope = productScopeToEngineV1(
          decoded.scope,
          host.owner,
          decoded.groupId,
        );
      } catch (error) {
        return refusal(
          `memory_browse was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const page = await host.records.browse({
        authority,
        scope,
        ...(decoded.topic ? { topic: decoded.topic } : {}),
        ...(decoded.cursor ? { cursor: decoded.cursor } : {}),
      });
      if (page.status === "refused" || page.status === "unavailable") {
        return refusal(
          `memory_browse was ${page.status}: ${page.omissions[0]?.reason ?? page.status}`,
        );
      }
      if (page.sections.length === 0) {
        return { content: "No Memory in this page.", isError: false };
      }
      const body = page.sections
        .map((section) => {
          const items = section.items
            .map((item) => `- ${item.text}`)
            .join("\n");
          return `## ${section.title}\n${section.summary}\n${items}`;
        })
        .join("\n\n");
      const cursor = page.cursor ? `\n\ncursor: ${page.cursor}` : "";
      return { content: `${body}${cursor}`, isError: false };
    },
  };
}

export { authorityOf as memoryRecordsAuthorityV1 };
