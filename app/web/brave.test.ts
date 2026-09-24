import { frockbotToolCall, discoverFrockbotTools } from "@frockbot/app/testkit";
import { describe, expect, test } from "bun:test";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import type { ToolExecutionContext } from "@frockbot/core/contracts";
import type { SearchMeterV1 } from "@frockbot/app/billing/search";
import {
  BRAVE_WEB_SEARCH_ENDPOINT_V1,
  createConfiguredWebSearchRuntimeContribution,
} from "./brave.ts";
import { webSearchEffectIdV1 } from "./contract.ts";

const API_KEY = "brave-test-key";
const CAPABILITY = { packageId: "web", capabilityId: "web-search" } as const;

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

interface Recorded {
  url: URL;
  init: RequestInit | undefined;
}

/** A meter that records what it was asked, in order. */
function recordingMeter(): { meter: SearchMeterV1; events: string[] } {
  const events: string[] = [];
  return {
    events,
    meter: {
      reserve: (search) => {
        events.push(
          `reserve ${search.effectId} ${search.botId} ${search.sessionId}`,
        );
        return Promise.resolve({
          charge: () => {
            events.push("charge");
            return Promise.resolve();
          },
          release: () => {
            events.push("release");
            return Promise.resolve();
          },
        });
      },
    },
  };
}

function braveAnswer(count: number): Response {
  return Response.json({
    type: "search",
    query: { original: "q" },
    web: {
      type: "search",
      results: Array.from({ length: count }, (_value, index) => ({
        title: `r${index}`,
        url: `https://example.test/${index}`,
        description: "  a  snippet\n over lines ",
        extra_snippets: ["never recorded"],
      })),
    },
  });
}

async function mount(options: {
  respond: (recorded: Recorded) => Response | Promise<Response>;
  meter?: SearchMeterV1;
}) {
  const recorded: Recorded[] = [];
  const root = createAgentRuntimeHarness();
  const feature = createConfiguredWebSearchRuntimeContribution({
    capability: CAPABILITY,
    apiKey: API_KEY,
    ...(options.meter ? { meter: options.meter } : {}),
    fetch: (input, init) => {
      const entry = { url: new URL(input), init };
      recorded.push(entry);
      return Promise.resolve(options.respond(entry));
    },
  });
  expect(feature).toBeDefined();
  await root.mount(feature!);
  return { root, recorded };
}

async function search(
  root: ReturnType<typeof createAgentRuntimeHarness>,
  input: unknown,
  context = toolContext(),
) {
  const prepared = await root.tools.prepare(
    frockbotToolCall("web_search", input, "call-1"),
    context,
  );
  if (prepared.kind !== "ready") throw new Error("not ready");
  return root.tools.executePrepared(prepared, context);
}

describe("web_search on Brave Search", () => {
  test("asks Brave for web results with the deployment's key", async () => {
    const { root, recorded } = await mount({ respond: () => braveAnswer(2) });

    const result = await search(root, { query: "frockbot", max_results: 3 });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      query: "frockbot",
      results: [
        {
          title: "r0",
          url: "https://example.test/0",
          snippet: "a snippet over lines",
        },
        {
          title: "r1",
          url: "https://example.test/1",
          snippet: "a snippet over lines",
        },
      ],
    });
    const call = recorded[0]!;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(
      BRAVE_WEB_SEARCH_ENDPOINT_V1,
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      q: "frockbot",
      count: "3",
      result_filter: "web",
      text_decorations: "false",
    });
    expect(call.init?.method).toBe("GET");
    expect(new Headers(call.init?.headers).get("x-subscription-token")).toBe(
      API_KEY,
    );
    // The key goes in the header and nowhere the Turn records.
    expect(call.url.toString()).not.toContain(API_KEY);
    expect(result.content).not.toContain(API_KEY);
    await root.dispose();
  });

  test("trims Brave's answer to what was asked for", async () => {
    const { root } = await mount({ respond: () => braveAnswer(8) });
    const result = await search(root, { query: "q", max_results: 2 });
    expect(
      (JSON.parse(result.content) as { results: unknown[] }).results.length,
    ).toBe(2);
    await root.dispose();
  });

  test("records no results when nothing matched", async () => {
    // Brave leaves the `web` section out entirely for a query with no hits.
    const { root } = await mount({
      respond: () =>
        Response.json({ type: "search", query: { original: "q" } }),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ query: "q", results: [] });
    await root.dispose();
  });

  test("refuses arguments outside the contract's bounds", async () => {
    const { root, recorded } = await mount({ respond: () => braveAnswer(1) });
    for (const input of [
      {},
      { query: "" },
      { query: "q", max_results: 0 },
      { query: "q", max_results: 11 },
      { query: "q", max_results: 1.5 },
      { query: "x".repeat(401) },
    ]) {
      const prepared = await root.tools.prepare(
        frockbotToolCall("web_search", input, "c"),
        toolContext(),
      );
      expect({ input, kind: prepared.kind }).toEqual({ input, kind: "denied" });
    }
    expect(recorded).toEqual([]);
    await root.dispose();
  });

  test("reports a refused request as a visible tool error", async () => {
    const { root } = await mount({
      respond: () =>
        Response.json(
          { type: "ErrorResponse", error: { status: 429 } },
          { status: 429 },
        ),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("web-search-failed");
    expect(body.message).toContain("429");
    await root.dispose();
  });

  test("refuses an answer larger than the response bound", async () => {
    const { root } = await mount({
      respond: () =>
        Response.json({
          web: {
            results: [
              {
                title: "big",
                url: "https://example.test/big",
                description: "x".repeat(300 * 1024),
              },
            ],
          },
        }),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
    await root.dispose();
  });

  test("is offered on every turn type the manifest admits", async () => {
    const { root } = await mount({ respond: () => braveAnswer(0) });
    for (const turnType of [
      "chat",
      "agent",
      "automation",
      "subagent",
    ] as const) {
      expect(
        (await discoverFrockbotTools(root.tools, { turnType })).map(
          (schema) => schema.name,
        ),
      ).toContain("web_search");
    }
    await root.dispose();
  });

  test("mounts only for its own Capability, and only with a key", () => {
    expect(
      createConfiguredWebSearchRuntimeContribution({
        capability: { packageId: "web", capabilityId: "web-fetch" },
        apiKey: API_KEY,
      }),
    ).toBeUndefined();
    expect(
      createConfiguredWebSearchRuntimeContribution({
        capability: CAPABILITY,
        apiKey: undefined,
      }),
    ).toBeUndefined();
    expect(
      createConfiguredWebSearchRuntimeContribution({
        capability: CAPABILITY,
        apiKey: "",
      }),
    ).toBeUndefined();
  });
});

describe("what a search costs", () => {
  test("reserves under the search's effect id before asking, and charges an answer", async () => {
    const { meter, events } = recordingMeter();
    const { root } = await mount({
      meter,
      respond: () => {
        events.push("fetch");
        return braveAnswer(1);
      },
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(false);
    const effectId = await webSearchEffectIdV1(toolContext());
    expect(events).toEqual([
      `reserve ${effectId} bot session`,
      "fetch",
      "charge",
    ]);
    await root.dispose();
  });

  test("releases a request Brave refused", async () => {
    const { meter, events } = recordingMeter();
    const { root } = await mount({
      meter,
      respond: () => new Response("{}", { status: 401 }),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(events.slice(1)).toEqual(["release"]);
    await root.dispose();
  });

  test("leaves a request with no answer reserved", async () => {
    // Whether Brave counted it is unknown, so it is neither charged nor
    // released; reconciliation decides.
    const { meter, events } = recordingMeter();
    const { root } = await mount({
      meter,
      respond: () => Promise.reject(new Error("connection reset")),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toStartWith("reserve ");
    await root.dispose();
  });

  test("never asks Brave when the account cannot pay", async () => {
    const { root, recorded } = await mount({
      meter: {
        reserve: () =>
          Promise.reject(
            new Error(
              "You have no usage credit left. Open Billing to add more.",
            ),
          ),
      },
      respond: () => braveAnswer(1),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(
      (JSON.parse(result.content) as { message: string }).message,
    ).toContain("no usage credit left");
    expect(recorded).toEqual([]);
    await root.dispose();
  });
});
