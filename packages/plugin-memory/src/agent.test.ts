import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type NormalizedModelRequest,
  SystemPromptRegistry,
  ToolRegistry,
} from "@frockbot/agent-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createMemoryPlugin } from "./agent.js";
import type {
  MemoryBucket,
  MemoryBucketObject,
  MemoryVector,
  MemoryVectorIndex,
} from "./types.js";

class FakeBucket implements MemoryBucket {
  readonly objects = new Map<string, string>();

  get(key: string): Promise<MemoryBucketObject | null> {
    const body = this.objects.get(key);
    return Promise.resolve(
      body === undefined
        ? null
        : {
            text: () => Promise.resolve(body),
            json: <T>() => Promise.resolve(JSON.parse(body) as T),
          },
    );
  }

  put(key: string, value: string): Promise<unknown> {
    this.objects.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<unknown> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list({ prefix }: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
  }> {
    return Promise.resolve({
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    });
  }
}

class FakeVectorize implements MemoryVectorIndex {
  readonly vectors = new Map<string, MemoryVector>();

  upsert(vectors: MemoryVector[]): Promise<unknown> {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
    return Promise.resolve();
  }

  query(
    query: number[],
    options: { topK: number; namespace: string; returnMetadata: "all" },
  ): Promise<{
    matches: Array<{
      id: string;
      score: number;
      metadata: Record<string, unknown>;
    }>;
  }> {
    return Promise.resolve({
      matches: [...this.vectors.values()]
        .filter((vector) => vector.namespace === options.namespace)
        .map((vector) => ({
          id: vector.id,
          score: cosine(query, vector.values),
          metadata: vector.metadata,
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, options.topK),
    });
  }

  deleteByIds(ids: string[]): Promise<unknown> {
    for (const id of ids) this.vectors.delete(id);
    return Promise.resolve();
  }
}

class MutatingVectorize extends FakeVectorize {
  private mutated = false;

  constructor(private readonly mutate: () => void) {
    super();
  }

  override async upsert(vectors: MemoryVector[]): Promise<unknown> {
    const result = await super.upsert(vectors);
    if (!this.mutated) {
      this.mutated = true;
      this.mutate();
    }
    return result;
  }
}

class NoAgentVectorMatches extends FakeVectorize {
  override query(
    query: number[],
    options: { topK: number; namespace: string; returnMetadata: "all" },
  ) {
    if (options.namespace.startsWith("agent:")) {
      return Promise.resolve({ matches: [] });
    }
    return super.query(query, options);
  }
}

function cosine(left: number[], right: number[]): number {
  let product = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    product += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return product / Math.sqrt(leftMagnitude * rightMagnitude);
}

function embed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vector = Array.from({ length: 32 }, () => 0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 0;
        for (const character of word) {
          hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        }
        vector[hash % vector.length] = (vector[hash % vector.length] ?? 0) + 1;
      }
      return vector;
    }),
  );
}

async function executeTool(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const call = { id: crypto.randomUUID(), name, input };
  const context = {
    botId: "alpha",
    agentId: "alpha",
    sessionId: "owner:alpha",
    signal: new AbortController().signal,
  };
  const preparation = await harness.root.tools.prepare(call, context);
  if (preparation.kind !== "ready") {
    throw new Error(preparation.result.content);
  }
  const result = await harness.root.tools.executePrepared(preparation, context);
  if (result.isError) throw new Error(result.content);
  return JSON.parse(result.content) as Record<string, unknown>;
}

function modelRequest(text: string): NormalizedModelRequest {
  return {
    requestId: "request",
    provider: "fixture",
    model: "fixture",
    system: "Base prompt",
    messages: [{ role: "user", content: text }],
    tools: [],
  };
}

function fakeAgent(): Agent {
  return {
    id: "owner:alpha",
    botId: "alpha",
    session: undefined as never,
    status: "idle",
    send: () => "message",
    cancel: () => undefined,
    whenIdle: () => Promise.resolve(),
  };
}

describe("memory plugin", () => {
  test("prefers agent memory over global memory at the same path", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );

    await executeTool(harness, "memory_write", {
      tier: "global",
      path: "preferences.md",
      content: "Use the global preference.",
    });
    await executeTool(harness, "memory_write", {
      tier: "agent",
      path: "preferences.md",
      content: "Use the alpha preference.",
    });

    expect(
      await executeTool(harness, "memory_get", { path: "preferences.md" }),
    ).toMatchObject({
      found: true,
      tier: "agent",
      content: "Use the alpha preference.",
    });
    expect(
      await executeTool(harness, "memory_get", {
        tier: "global",
        path: "preferences.md",
      }),
    ).toMatchObject({ tier: "global", content: "Use the global preference." });
    const search = await executeTool(harness, "memory_search", {
      query: "preference",
      maxResults: 10,
    });
    expect(search.results).toEqual([
      expect.objectContaining({ path: "preferences.md", tier: "agent" }),
    ]);
    await harness.dispose();
  });

  test("replaces a retrieved global clash with the authoritative agent copy", async () => {
    const bucket = new FakeBucket();
    const vectorize = new NoAgentVectorMatches();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );
    await executeTool(harness, "memory_write", {
      tier: "global",
      path: "policy.md",
      content: "The launch color is blue.",
    });
    await executeTool(harness, "memory_write", {
      path: "policy.md",
      content: "Alpha has an authoritative private launch policy.",
    });

    const search = await executeTool(harness, "memory_search", {
      query: "launch color blue",
      maxResults: 5,
    });
    expect(search.results).toEqual([
      expect.objectContaining({
        path: "policy.md",
        tier: "agent",
        snippet: "Alpha has an authoritative private launch policy.",
      }),
    ]);
    await harness.dispose();
  });

  test("shares global memory while isolating agent memory", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const alpha = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    const beta = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await alpha.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );
    await beta.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "beta",
        bucket,
        vectorize,
        embed,
      }),
    );
    await executeTool(alpha, "memory_write", {
      path: "private.md",
      content: "alpha only",
    });
    await executeTool(alpha, "memory_write", {
      tier: "global",
      path: "shared.md",
      content: "all agents",
    });

    expect(
      await executeTool(beta, "memory_get", { path: "private.md" }),
    ).toMatchObject({ found: false });
    expect(
      await executeTool(beta, "memory_get", { path: "shared.md" }),
    ).toMatchObject({ found: true, tier: "global", content: "all agents" });
    await Promise.all([alpha.dispose(), beta.dispose()]);
  });

  test("injects automatic recall into the normalized model request", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );
    await executeTool(harness, "memory_write", {
      path: "pets.md",
      content: "The user's dog is named Rex.",
    });

    const request = modelRequest("What is my dog's name?");
    const recalled = await harness.root.waterfall(
      "agent/request",
      fakeAgent(),
      request,
      new AbortController().signal,
      () => Promise.resolve(request),
    );
    expect(recalled.system).toContain("Possibly relevant durable memory");
    expect(recalled.system).toContain("dog is named Rex");
    await harness.dispose();
  });

  test("indexes oversized paragraphs as distinct bounded chunks", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );
    const content = "memory ".repeat(600);
    const result = await executeTool(harness, "memory_write", {
      path: "long.md",
      content,
    });
    if (typeof result.chunksTotal !== "number") {
      throw new Error("memory write did not return a chunk count");
    }
    expect(result.chunksTotal).toBeGreaterThan(1);
    expect(vectorize.vectors.size).toBe(result.chunksTotal);

    expect(
      await executeTool(harness, "memory_write", {
        path: "long.md",
        content,
      }),
    ).toMatchObject({ chunksEmbedded: 0 });
    const partialEdit = await executeTool(harness, "memory_write", {
      path: "long.md",
      content: `${content}changed ending`,
    });
    expect(partialEdit.chunksEmbedded).toBe(partialEdit.chunksTotal);
    await executeTool(harness, "memory_write", {
      path: "long.md",
      content: "short memory",
    });
    expect(vectorize.vectors.size).toBe(1);
    await harness.dispose();
  });

  test("finds canonical R2 content in a partially indexed tier", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const selectiveEmbed = (texts: string[]) =>
      texts.some((text) => text.includes("marker-fail"))
        ? Promise.reject(new Error("selective embedding failure"))
        : embed(texts);
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed: selectiveEmbed,
      }),
    );
    await executeTool(harness, "memory_write", {
      path: "indexed.md",
      content: "An unrelated indexed document.",
    });
    await executeTool(harness, "memory_write", {
      path: "canonical.md",
      content: "The canonical phrase survives marker-fail.",
    });

    const search = await executeTool(harness, "memory_search", {
      query: "canonical phrase",
      maxResults: 10,
    });
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "canonical.md", tier: "agent" }),
      ]),
    );
    await harness.dispose();
  });

  test("reconciles indexing when canonical R2 changes during a write", async () => {
    const bucket = new FakeBucket();
    let contentKey: string | undefined;
    const vectorize = new MutatingVectorize(() => {
      contentKey = [...bucket.objects.keys()].find((key) =>
        key.endsWith("/files/race.md"),
      );
      if (!contentKey) throw new Error("memory content was not persisted");
      bucket.objects.set(
        contentKey,
        "The concurrent canonical value is violet.",
      );
    });
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );

    expect(
      await executeTool(harness, "memory_write", {
        tier: "global",
        path: "race.md",
        content: "The initial value is amber.",
      }),
    ).toMatchObject({ ok: true, indexed: true });
    const search = await executeTool(harness, "memory_search", {
      tier: "global",
      query: "concurrent canonical value",
    });
    expect(search.results).toEqual([
      expect.objectContaining({
        path: "race.md",
        snippet: "The concurrent canonical value is violet.",
      }),
    ]);
    expect(vectorize.vectors.size).toBe(1);
    await harness.dispose();
  });

  test("rejects stale vectors when canonical R2 wins a concurrent write", async () => {
    const bucket = new FakeBucket();
    const vectorize = new FakeVectorize();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize,
        embed,
      }),
    );
    await executeTool(harness, "memory_write", {
      tier: "global",
      path: "race.md",
      content: "The stale semantic value is amber.",
    });
    const contentKey = [...bucket.objects.keys()].find((key) =>
      key.endsWith("/files/race.md"),
    );
    if (!contentKey) throw new Error("memory content was not persisted");
    bucket.objects.set(contentKey, "The canonical concurrent value is violet.");

    const stale = await executeTool(harness, "memory_search", {
      tier: "global",
      query: "stale semantic value amber",
    });
    expect(stale.results).toEqual([]);
    const current = await executeTool(harness, "memory_search", {
      tier: "global",
      query: "canonical concurrent value",
    });
    expect(current.results).toEqual([
      expect.objectContaining({ path: "race.md", tier: "global" }),
    ]);
    await harness.dispose();
  });

  test("keeps R2 content available when indexing fails", async () => {
    const bucket = new FakeBucket();
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket,
        vectorize: new FakeVectorize(),
        embed: () => Promise.reject(new Error("embedding unavailable")),
      }),
    );

    expect(
      await executeTool(harness, "memory_write", {
        path: "resilient.md",
        content: "Persist this despite indexing failure.",
      }),
    ).toMatchObject({ ok: true, indexed: false, tier: "agent" });
    expect(
      await executeTool(harness, "memory_get", { path: "resilient.md" }),
    ).toMatchObject({
      found: true,
      content: "Persist this despite indexing failure.",
    });
    await harness.dispose();
  });

  test("disposes tools and satisfies package conventions", async () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-memory",
      contributionKinds: ["runtime"],
    });
    const harness = await createPluginHarness([
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    const fiber = await harness.mount(
      createMemoryPlugin({
        ownerId: "owner",
        botId: "alpha",
        bucket: new FakeBucket(),
        vectorize: new FakeVectorize(),
        embed,
      }),
    );
    expect(harness.root.tools.schemas().map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_get",
      "memory_write",
      "memory_delete",
    ]);
    await fiber.dispose();
    expect(harness.root.tools.schemas()).toEqual([]);
    await harness.dispose();
  });
});
