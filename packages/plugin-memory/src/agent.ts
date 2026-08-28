import type {
  NormalizedModelRequest,
  ToolDefinition,
} from "@frockbot/agent-core";
import type { Context, Plugin } from "cordis";
import { createMemoryEmbedder } from "./embeddings.js";
import { indexDocument, removeDocument } from "./indexer.js";
import { createMemoryScopes } from "./scopes.js";
import {
  formatMemoryResults,
  scopesForTier,
  searchMemory,
} from "./searcher.js";
import { type MemoryDocumentStore, MemoryStorage } from "./storage.js";
import type {
  EmbedMemory,
  MemoryAiBinding,
  MemoryBucket,
  MemoryScope,
  MemoryTier,
  MemoryVectorIndex,
} from "./types.js";

const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_PATH_LENGTH = 200;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_QUERY_LENGTH = 500;
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_AUTO_RECALL_RESULTS = 4;

export interface MemoryPluginConfig {
  ownerId: string;
  botId?: string;
  /** Legacy configuration alias; new compositions use botId. */
  agentId?: string;
  bucket?: MemoryBucket;
  documents?: MemoryDocumentStore;
  createDocuments?: (
    ctx: Context,
  ) => MemoryDocumentStore | Promise<MemoryDocumentStore>;
  vectorize: MemoryVectorIndex;
  ai?: MemoryAiBinding;
  embed?: EmbedMemory;
  embeddingModel?: string;
  autoRecallResults?: number;
}

interface MemoryRuntime {
  scopes: Record<MemoryTier, MemoryScope>;
  storage: MemoryDocumentStore;
  vectorize: MemoryVectorIndex;
  embed: EmbedMemory;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validTier(value: unknown): value is MemoryTier {
  return value === "agent" || value === "global";
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    PATH_PATTERN.test(value) &&
    !value.startsWith("/") &&
    !value.includes("..")
  );
}

function validSearchInput(value: unknown): boolean {
  const input = record(value);
  if (!input || typeof input.query !== "string") return false;
  if (!input.query.trim() || input.query.length > MAX_QUERY_LENGTH)
    return false;
  if (input.tier !== undefined && !validTier(input.tier)) return false;
  return (
    input.maxResults === undefined ||
    (Number.isInteger(input.maxResults) &&
      Number(input.maxResults) >= 1 &&
      Number(input.maxResults) <= 20)
  );
}

function validGetInput(value: unknown): boolean {
  const input = record(value);
  return Boolean(
    input &&
      validPath(input.path) &&
      (input.tier === undefined || validTier(input.tier)),
  );
}

function validWriteInput(value: unknown): boolean {
  const input = record(value);
  return Boolean(
    input &&
      validPath(input.path) &&
      (input.tier === undefined || validTier(input.tier)) &&
      typeof input.content === "string" &&
      input.content.trim() &&
      input.content.length <= MAX_CONTENT_LENGTH,
  );
}

function validDeleteInput(value: unknown): boolean {
  const input = record(value);
  return Boolean(
    input &&
      validPath(input.path) &&
      (input.tier === undefined || validTier(input.tier)),
  );
}

function jsonResult(value: unknown, isError = false) {
  return { content: JSON.stringify(value), isError };
}

function latestUserText(request: NormalizedModelRequest): string | undefined {
  const message = request.messages.findLast(
    (candidate) => candidate.role === "user" && candidate.content.trim(),
  );
  return message?.role === "user" ? message.content.trim() : undefined;
}

async function writeMemory(
  runtime: MemoryRuntime,
  scope: MemoryScope,
  path: string,
  content: string,
) {
  await runtime.storage.writeContent(scope, path, content);
  try {
    let candidate = content;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await indexDocument(
        scope,
        path,
        candidate,
        runtime.embed,
        runtime.vectorize,
        runtime.storage,
      );
      const canonical = await runtime.storage.readContent(scope, path);
      if (canonical === candidate) {
        return { ok: true, indexed: true, path, tier: scope.tier, ...result };
      }
      if (canonical === null) {
        await removeDocument(scope, path, runtime.vectorize, runtime.storage);
        return {
          ok: true,
          indexed: false,
          path,
          tier: scope.tier,
          warning: "memory was concurrently deleted while indexing",
        };
      }
      candidate = canonical;
    }
    throw new Error("memory changed repeatedly while indexing");
  } catch (error) {
    // R2 is canonical. Remove any old derived index state when possible so
    // retrieval falls back to the newly persisted R2 content instead of stale vectors.
    try {
      await removeDocument(scope, path, runtime.vectorize, runtime.storage);
    } catch (cleanupError) {
      console.error("[memory] failed to clear stale index state", cleanupError);
    }
    return {
      ok: true,
      indexed: false,
      path,
      tier: scope.tier,
      warning:
        error instanceof Error ? error.message : "memory indexing failed",
    };
  }
}

function createTools(runtime: MemoryRuntime): ToolDefinition[] {
  return [
    {
      name: "memory_search",
      description:
        "Search durable memory. Searches agent and global tiers by default; agent memory wins when the same path exists in both tiers.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
          tier: { type: "string", enum: ["agent", "global"] },
          maxResults: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      idempotent: true,
      validate: validSearchInput,
      execute: async (value) => {
        const input = value as {
          query: string;
          tier?: MemoryTier;
          maxResults?: number;
        };
        const results = await searchMemory({
          scopes: scopesForTier(runtime.scopes, input.tier),
          query: input.query,
          maxResults: input.maxResults ?? DEFAULT_SEARCH_RESULTS,
          embed: runtime.embed,
          vectorize: runtime.vectorize,
          storage: runtime.storage,
        });
        return jsonResult({
          count: results.length,
          results,
          formatted: formatMemoryResults(results),
        });
      },
    },
    {
      name: "memory_get",
      description:
        "Read a complete memory file. Without a tier, checks agent memory first and then global memory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
          tier: { type: "string", enum: ["agent", "global"] },
        },
        required: ["path"],
        additionalProperties: false,
      },
      idempotent: true,
      validate: validGetInput,
      execute: async (value) => {
        const input = value as { path: string; tier?: MemoryTier };
        for (const scope of scopesForTier(runtime.scopes, input.tier)) {
          const content = await runtime.storage.readContent(scope, input.path);
          if (content !== null) {
            return jsonResult({
              found: true,
              path: input.path,
              tier: scope.tier,
              content,
            });
          }
        }
        return jsonResult({ found: false, path: input.path });
      },
    },
    {
      name: "memory_write",
      description:
        "Create or replace durable memory. Defaults to agent memory; use global only for facts that should apply to every agent owned by this user.",
      inputSchema: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["agent", "global"] },
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
          content: {
            type: "string",
            minLength: 1,
            maxLength: MAX_CONTENT_LENGTH,
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      validate: validWriteInput,
      execute: async (value) => {
        const input = value as {
          tier?: MemoryTier;
          path: string;
          content: string;
        };
        const tier = input.tier ?? "agent";
        return jsonResult(
          await writeMemory(
            runtime,
            runtime.scopes[tier],
            input.path,
            input.content,
          ),
        );
      },
    },
    {
      name: "memory_delete",
      description:
        "Delete a durable memory file. Defaults to the agent tier to avoid accidentally deleting shared global memory.",
      inputSchema: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["agent", "global"] },
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
        },
        required: ["path"],
        additionalProperties: false,
      },
      validate: validDeleteInput,
      execute: async (value) => {
        const input = value as { tier?: MemoryTier; path: string };
        const tier = input.tier ?? "agent";
        const scope = runtime.scopes[tier];
        const vectorsRemoved = await removeDocument(
          scope,
          input.path,
          runtime.vectorize,
          runtime.storage,
        );
        await runtime.storage.deleteContent(scope, input.path);
        return jsonResult({
          ok: true,
          path: input.path,
          tier,
          vectorsRemoved,
        });
      },
    },
  ];
}

export function createMemoryPlugin(
  config: MemoryPluginConfig,
): Plugin.Function {
  if (!config.embed && !config.ai) {
    throw new Error(
      "memory plugin requires an embed function or Workers AI binding",
    );
  }
  const botId = config.botId?.trim() || config.agentId?.trim();
  if (!botId) throw new Error("memory plugin requires a persistent botId");
  if (!config.bucket && !config.documents && !config.createDocuments) {
    throw new Error(
      "memory plugin requires a bucket, documents, or createDocuments",
    );
  }
  const autoRecallResults =
    config.autoRecallResults ?? DEFAULT_AUTO_RECALL_RESULTS;
  if (
    !Number.isInteger(autoRecallResults) ||
    autoRecallResults < 0 ||
    autoRecallResults > 20
  ) {
    throw new Error(
      "memory auto-recall result count must be an integer from 0 to 20",
    );
  }

  const plugin: Plugin.Function = async (ctx) => {
    const storage: MemoryDocumentStore =
      config.documents ??
      (config.createDocuments
        ? await config.createDocuments(ctx)
        : new MemoryStorage(config.bucket as MemoryBucket));
    const runtime: MemoryRuntime = {
      scopes: createMemoryScopes(config.ownerId, botId),
      storage,
      vectorize: config.vectorize,
      embed:
        config.embed ??
        createMemoryEmbedder(
          config.ai as MemoryAiBinding,
          config.embeddingModel,
        ),
    };
    const disposers = createTools(runtime).map((tool) =>
      ctx.tools.register(tool),
    );
    disposers.push(
      ctx.systemPrompt.register({
        id: "memory",
        order: 100,
        render: () =>
          [
            "## Durable memory",
            "You have Bot memory (specific to this Bot) and global memory (shared by this User's Bots).",
            "When memories conflict at the same path, Bot memory is authoritative.",
            "Use memory_search for deeper recall. Write only when the user asks to remember or persist something; memory_write defaults to agent memory.",
          ].join("\n"),
      }),
    );
    if (autoRecallResults > 0) {
      disposers.push(
        ctx.on("agent/request", async (_agent, _request, _signal, next) => {
          const resolved = await next();
          const query = latestUserText(resolved);
          if (!query) return resolved;
          try {
            const results = await searchMemory({
              scopes: [runtime.scopes.agent, runtime.scopes.global],
              query,
              maxResults: autoRecallResults,
              embed: runtime.embed,
              vectorize: runtime.vectorize,
              storage: runtime.storage,
            });
            if (results.length === 0) return resolved;
            const memoryBlock = [
              "## Possibly relevant durable memory",
              "Agent-tier entries override global-tier entries at the same path. Use only relevant facts.",
              formatMemoryResults(results),
            ].join("\n\n");
            return {
              ...resolved,
              system: [resolved.system.trim(), memoryBlock]
                .filter(Boolean)
                .join("\n\n"),
            };
          } catch (error) {
            console.error("[memory] automatic recall failed", error);
            return resolved;
          }
        }),
      );
    }
    return async () => {
      for (const dispose of disposers.toReversed()) dispose();
      await storage.dispose?.();
    };
  };
  plugin.inject = ["tools", "systemPrompt"];
  return plugin;
}

export default createMemoryPlugin;
