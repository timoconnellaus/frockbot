import { describe, expect, test } from "bun:test";
import { Context, Service } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools/agent";
import type { ToolExecutionContext } from "@frockbot/kernel-contracts";
import type { CredentialLeaseV1 } from "@frockbot/connection-core";
import {
  createConfiguredOllamaWebSearchRuntimeContribution,
  ollamaWebSearchUrl,
  OllamaCloudWebSearchClient,
} from "./web-search.ts";

const CONNECTION_ID = "connection-1";
const GENERATION = "generation-1";
const API_KEY = "ollama-test-key";

const ASSIGNMENT = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-web-search",
  connectionId: CONNECTION_ID,
  state: "enabled",
} as const;

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function lease(effectId: string): CredentialLeaseV1 {
  return {
    schemaVersion: 1,
    leaseId: `lease-${effectId}`,
    connectionId: CONNECTION_ID,
    effectId,
    credentialGeneration: GENERATION,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    // The lease carries the sealed credential; only the Credential Store may
    // open it, and this test's opener never looks inside.
    envelope: {
      schemaVersion: 1,
      algorithm: "AES-GCM",
      keyId: "primary",
      credentialGeneration: GENERATION,
      nonce: "bm9uY2U",
      ciphertext: "Y2lwaGVy",
      createdAt: new Date(0).toISOString(),
    },
  };
}

/** The credential-store service the Bot Durable Object mounts for real. */
class FakeCredentialLease extends Service {
  opened: string[] = [];
  constructor(ctx: Context) {
    super(ctx, "credentialLease");
  }
  open(input: {
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
    this.opened.push(input.packageId);
    return Promise.resolve(API_KEY);
  }
}

function toolContext(effectId = "effect-1"): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "bot",
    sessionId: "session",
    compositionGenerationId: "generation",
    effectId,
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

async function mount(options: {
  respond: (recorded: Recorded) => Response;
  apiBaseUrl?: string;
  maxResults?: number;
}) {
  const recorded: Recorded[] = [];
  const leased: string[] = [];
  const settled: string[] = [];
  const root = new Context();
  await root.plugin(ToolRegistry);
  await root.plugin(FakeCredentialLease);
  const plugin = createConfiguredOllamaWebSearchRuntimeContribution({
    assignment: ASSIGNMENT,
    accountId: "user-1",
    connectionId: CONNECTION_ID,
    connectionGeneration: GENERATION,
    ...(options.apiBaseUrl === undefined
      ? {}
      : { apiBaseUrl: options.apiBaseUrl }),
    ...(options.maxResults === undefined
      ? {}
      : { maxResults: options.maxResults }),
    leaseCredential: (effectId) => {
      leased.push(effectId);
      return Promise.resolve(lease(effectId));
    },
    settleCredential: (effectId) => {
      settled.push(effectId);
      return Promise.resolve();
    },
    fetch: (input, init) => {
      const entry = { url: String(input), init };
      recorded.push(entry);
      return Promise.resolve(options.respond(entry));
    },
  });
  expect(plugin).toBeDefined();
  await root.plugin(plugin!);
  return { root, recorded, leased, settled };
}

describe("the Ollama Cloud web_search Capability", () => {
  test("composes the endpoint from the Connection's own base URL", () => {
    expect(ollamaWebSearchUrl()).toBe("https://ollama.com/api/web_search");
    expect(ollamaWebSearchUrl("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434/api/web_search",
    );
    expect(ollamaWebSearchUrl("https://proxy.example/")).toBe(
      "https://proxy.example/api/web_search",
    );
  });

  test("posts the bounded request shape with the leased key", async () => {
    const { root, recorded, leased, settled } = await mount({
      respond: () =>
        Response.json({
          results: [
            {
              title: "A result",
              url: "https://example.test/a",
              content: "  a  snippet\n over lines ",
            },
            { title: "no url", content: "dropped" },
          ],
        }),
    });

    const prepared = await root.tools.prepare(
      { id: "call-1", name: "web_search", input: { query: "frockbot" } },
      toolContext(),
    );
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    const result = await root.tools.executePrepared(prepared, toolContext());

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      query: "frockbot",
      results: [
        {
          title: "A result",
          url: "https://example.test/a",
          snippet: "a snippet over lines",
        },
      ],
    });
    const call = recorded[0]!;
    expect(call.url).toBe("https://ollama.com/api/web_search");
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(JSON.parse(String(call.init?.body))).toEqual({
      query: "frockbot",
      max_results: 5,
    });
    // The credential is leased per durable effect and settled afterwards, so
    // no key outlives the tool call that opened it.
    expect(leased).toEqual(["effect-1"]);
    expect(settled).toEqual(["effect-1"]);
    // And it never reaches the durable result.
    expect(result.content).not.toContain(API_KEY);
    await root.fiber.dispose();
  });

  test("carries max_results through and trims the answer to it", async () => {
    const { root, recorded } = await mount({
      respond: () =>
        Response.json({
          results: Array.from({ length: 8 }, (_value, index) => ({
            title: `r${index}`,
            url: `https://example.test/${index}`,
            content: "x",
          })),
        }),
    });
    const call = {
      id: "c",
      name: "web_search",
      input: { query: "q", max_results: 2 },
    };
    const prepared = await root.tools.prepare(call, toolContext());
    if (prepared.kind !== "ready") throw new Error("not ready");
    const result = await root.tools.executePrepared(prepared, toolContext());
    expect(JSON.parse(String(recorded[0]?.init?.body)).max_results).toBe(2);
    expect(
      (JSON.parse(result.content) as { results: unknown[] }).results.length,
    ).toBe(2);
    await root.fiber.dispose();
  });

  test("caps the request at the Package-level setting the User chose", async () => {
    const { root, recorded } = await mount({
      maxResults: 2,
      respond: () =>
        Response.json({
          results: Array.from({ length: 8 }, (_value, index) => ({
            title: `r${index}`,
            url: `https://example.test/${index}`,
            content: "x",
          })),
        }),
    });
    const prepared = await root.tools.prepare(
      {
        id: "c",
        name: "web_search",
        // The model asks for the contract's maximum; the User's ceiling wins.
        input: { query: "q", max_results: 10 },
      },
      toolContext(),
    );
    if (prepared.kind !== "ready") throw new Error("not ready");
    const result = await root.tools.executePrepared(prepared, toolContext());
    // The ceiling is applied before the provider is asked, so the extra
    // results are never fetched, let alone recorded on the Turn.
    expect(JSON.parse(String(recorded[0]?.init?.body)).max_results).toBe(2);
    expect(
      (JSON.parse(result.content) as { results: unknown[] }).results.length,
    ).toBe(2);
    await root.fiber.dispose();
  });

  test("leaves a request already under the ceiling alone", async () => {
    const { root, recorded } = await mount({
      maxResults: 8,
      respond: () => Response.json({ results: [] }),
    });
    const prepared = await root.tools.prepare(
      { id: "c", name: "web_search", input: { query: "q", max_results: 3 } },
      toolContext(),
    );
    if (prepared.kind !== "ready") throw new Error("not ready");
    await root.tools.executePrepared(prepared, toolContext());
    expect(JSON.parse(String(recorded[0]?.init?.body)).max_results).toBe(3);
    await root.fiber.dispose();
  });

  test("refuses arguments outside the contract's bounds", async () => {
    const { root } = await mount({
      respond: () => Response.json({ results: [] }),
    });
    for (const input of [
      {},
      { query: "" },
      { query: "q", max_results: 0 },
      { query: "q", max_results: 11 },
      { query: "q", max_results: 1.5 },
      { query: "x".repeat(401) },
    ]) {
      const prepared = await root.tools.prepare(
        { id: "c", name: "web_search", input },
        toolContext(),
      );
      expect({ input, kind: prepared.kind }).toEqual({ input, kind: "denied" });
    }
    await root.fiber.dispose();
  });

  test("reports a revoked key as a visible tool error", async () => {
    const { root, settled } = await mount({
      respond: () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const prepared = await root.tools.prepare(
      { id: "c", name: "web_search", input: { query: "q" } },
      toolContext(),
    );
    if (prepared.kind !== "ready") throw new Error("not ready");
    const result = await root.tools.executePrepared(prepared, toolContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("web-search-failed");
    expect(body.message).toContain("401");
    // The lease is settled even when the call fails.
    expect(settled).toEqual(["effect-1"]);
    await root.fiber.dispose();
  });

  test("refuses a provider answer larger than the response bound", async () => {
    const { root } = await mount({
      respond: () =>
        Response.json({
          results: [
            {
              title: "big",
              url: "https://example.test/big",
              content: "x".repeat(300 * 1024),
            },
          ],
        }),
    });
    const prepared = await root.tools.prepare(
      { id: "c", name: "web_search", input: { query: "q" } },
      toolContext(),
    );
    if (prepared.kind !== "ready") throw new Error("not ready");
    const result = await root.tools.executePrepared(prepared, toolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
    await root.fiber.dispose();
  });

  test("is offered on every turn type the manifest admits", async () => {
    const { root } = await mount({
      respond: () => Response.json({ results: [] }),
    });
    for (const turnType of ["chat", "automation", "subagent"] as const) {
      expect({
        turnType,
        names: root.tools.schemas({ turnType }).map((schema) => schema.name),
      }).toEqual({ turnType, names: ["web_search"] });
    }
    await root.fiber.dispose();
  });

  test("mounts nothing without an enabled Assignment bound to the Connection", () => {
    const base = {
      accountId: "user-1",
      connectionId: CONNECTION_ID,
      connectionGeneration: GENERATION,
      leaseCredential: () => Promise.resolve(lease("e")),
      settleCredential: () => Promise.resolve(),
    };
    expect(
      createConfiguredOllamaWebSearchRuntimeContribution({
        ...base,
        assignment: { ...ASSIGNMENT, state: "disabled" },
      }),
    ).toBeUndefined();
    expect(
      createConfiguredOllamaWebSearchRuntimeContribution({
        ...base,
        assignment: { ...ASSIGNMENT, capabilityId: "ollama-cloud-models" },
      }),
    ).toBeUndefined();
    expect(
      createConfiguredOllamaWebSearchRuntimeContribution({
        ...base,
        assignment: { ...ASSIGNMENT, connectionId: "other" },
      }),
    ).toBeUndefined();
  });

  test("bounds the provider response before it is parsed", async () => {
    const client = new OllamaCloudWebSearchClient({
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(512 * 1024),
            },
          }),
        ),
    });
    await expect(
      client.search(API_KEY, { query: "q", maxResults: 5 }),
    ).rejects.toThrow("too large");
  });
});
