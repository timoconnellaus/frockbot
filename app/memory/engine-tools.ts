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
  engineScopeToProductV1,
  productScopeToEngineV1,
  toolKindFromTierV1,
  type MemoryAuthorityV1,
  type MemoryProductScopeV1,
  type MemoryScopeRefV1,
} from "./records.js";
import { explicitDatesInQueryV1 } from "./hybrid.js";
import { isMemoryProjectIdV1, type MemoryOwnerV1 } from "./roots.js";
import type { MemoryProjectsV1 } from "./projects.js";
import { MEMORY_MAX_FACT_LENGTH } from "./store.js";

export interface MemoryRecordsHostV1 {
  owner: MemoryOwnerV1;
  records: MemoryRecordsV1;
  writer?: { sessionId: string; turnId: string; runId: string };
  projects?: MemoryProjectsV1;
}

export async function authorityOf(
  host: MemoryRecordsHostV1,
): Promise<MemoryAuthorityV1> {
  let joinedGroupChatIds: string[] = [];
  let membershipRevision = "0";
  if (host.projects) {
    try {
      const joined = await host.projects.joined();
      joinedGroupChatIds = joined.map((project) => project.projectId);
      membershipRevision = joined
        .map((project) => project.projectId)
        .sort()
        .join(",");
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

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

export async function executeRecordsWriteV1(
  host: MemoryRecordsHostV1,
  input: {
    scope: MemoryScopeNameV1;
    project?: string;
    tier: "profile" | "log" | "note";
    fact: string;
  },
  operationKey: string,
): Promise<ToolExecutionResult> {
  const authority = await authorityOf(host);
  let scope: MemoryScopeRefV1;
  try {
    scope = productScopeToEngineV1(input.scope, host.owner, input.project);
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
  const outcome = await host.records.write({
    authority,
    scope,
    content: input.fact,
    operationKey,
    kind: toolKindFromTierV1(input.tier),
    sources,
  });
  if (outcome.status !== "ok") {
    return refusal(`memory_write was ${outcome.status}: ${outcome.reason}`);
  }
  return {
    content: outcome.receipt.duplicate
      ? `Already remembered; nothing changed.`
      : `Remembered.`,
    isError: false,
  };
}

export async function executeRecordsForgetV1(
  host: MemoryRecordsHostV1,
  input: {
    scope: MemoryScopeNameV1;
    project?: string;
    fact: string;
  },
  operationKey: string,
): Promise<ToolExecutionResult> {
  const authority = await authorityOf(host);
  let scope: MemoryScopeRefV1;
  try {
    scope = productScopeToEngineV1(input.scope, host.owner, input.project);
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
  const scopes: MemoryScopeRefV1[] = input.scope
    ? input.scope === "project"
      ? authority.joinedGroupChatIds.map((id) =>
          productScopeToEngineV1("project", host.owner, id),
        )
      : [productScopeToEngineV1(input.scope, host.owner)]
    : [
        productScopeToEngineV1("bot", host.owner),
        productScopeToEngineV1("user", host.owner),
        ...authority.joinedGroupChatIds.map((id) =>
          productScopeToEngineV1("project", host.owner, id),
        ),
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
        const project =
          hit.item.scope.kind === "groupChat"
            ? `/${hit.item.scope.groupChatId}`
            : "";
        const scopeKey =
          hit.item.scope.kind === "bot"
            ? `bot:${hit.item.scope.userId}:${hit.item.scope.botId}`
            : hit.item.scope.kind === "user"
              ? `user:${hit.item.scope.userId}`
              : `groupChat:${hit.item.scope.userId}:${hit.item.scope.groupChatId}`;
        return `[${index + 1}] ${where}${project}:${hit.item.id}\nmemory-item ${scopeKey} ${hit.item.id} ${hit.item.generation}\n${hit.item.text}`;
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
      enum: ["bot", "user", "project"],
    },
    project: { type: "string" },
  },
  additionalProperties: false,
} as const;

const BROWSE_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["bot", "user", "project"],
      description: "Which Memory to page through. Defaults to bot.",
    },
    project: { type: "string" },
    topic: {
      type: "string",
      description: "Optional subject to filter the page.",
    },
    cursor: { type: "string" },
  },
  additionalProperties: false,
} as const;

function decodeExpandInputV1(input: unknown): {
  itemId?: string;
  sourceId?: string;
  scope: MemoryProductScopeV1;
  project?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["itemId", "sourceId", "scope", "project"].includes(key),
    )
  ) {
    throw new Error("input has unknown fields");
  }
  if (value.itemId === undefined && value.sourceId === undefined) {
    throw new Error("itemId or sourceId is required");
  }
  const scope = (value.scope ?? "bot") as MemoryProductScopeV1;
  if (!["bot", "user", "project"].includes(scope)) {
    throw new Error("scope is invalid");
  }
  const decoded: {
    itemId?: string;
    sourceId?: string;
    scope: MemoryProductScopeV1;
    project?: string;
  } = { scope };
  if (typeof value.itemId === "string") decoded.itemId = value.itemId;
  if (typeof value.sourceId === "string") decoded.sourceId = value.sourceId;
  if (scope === "project") {
    if (!isMemoryProjectIdV1(value.project)) {
      throw new Error("the project scope requires a valid Project slug");
    }
    decoded.project = value.project;
  } else if (value.project !== undefined) {
    throw new Error("project is only valid with the project scope");
  }
  return decoded;
}

function decodeBrowseInputV1(input: unknown): {
  scope: MemoryProductScopeV1;
  project?: string;
  topic?: string;
  cursor?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["scope", "project", "topic", "cursor"].includes(key),
    )
  ) {
    throw new Error("input has unknown fields");
  }
  const scope = (value.scope ?? "bot") as MemoryProductScopeV1;
  if (!["bot", "user", "project"].includes(scope)) {
    throw new Error("scope is invalid");
  }
  const decoded: {
    scope: MemoryProductScopeV1;
    project?: string;
    topic?: string;
    cursor?: string;
  } = { scope };
  if (scope === "project") {
    if (!isMemoryProjectIdV1(value.project)) {
      throw new Error("the project scope requires a valid Project slug");
    }
    decoded.project = value.project;
  } else if (value.project !== undefined) {
    throw new Error("project is only valid with the project scope");
  }
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
        decodeExpandInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let decoded: ReturnType<typeof decodeExpandInputV1>;
      try {
        decoded = decodeExpandInputV1(input);
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
          decoded.project,
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
        decodeBrowseInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let decoded: ReturnType<typeof decodeBrowseInputV1>;
      try {
        decoded = decodeBrowseInputV1(input);
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
          decoded.project,
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
