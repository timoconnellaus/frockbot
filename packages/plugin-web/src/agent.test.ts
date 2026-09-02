import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools/agent";
import type { ToolExecutionContext } from "@frockbot/kernel-contracts";
import {
  createConfiguredWebFetchRuntimeContribution,
  createWebFetchToolDefinitionV1,
  executeWebFetchV1,
  extractReadableTextV1,
  WEB_FETCH_MAX_BYTES_V1,
  type WebFetchFn,
  type WebFetchResultV1,
} from "./agent.ts";

const ENABLED_CAPABILITY = {
  packageId: "web",
  capabilityId: "web-fetch",
} as const;

function toolContext(): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "bot",
    sessionId: "session",
    compositionGenerationId: "generation",
    effectId: "effect-1",
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

/** A fetch that answers a script of responses and records what it was asked. */
function fakeFetch(
  answers: Array<{
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  }>,
): { fetch: WebFetchFn; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetch: WebFetchFn = (input) => {
    calls.push(input);
    const answer = answers[Math.min(index, answers.length - 1)] ?? {};
    index += 1;
    return Promise.resolve(
      new Response(answer.body ?? "", {
        status: answer.status ?? 200,
        headers: answer.headers ?? { "content-type": "text/html" },
      }),
    );
  };
  return { fetch, calls };
}

function parsed(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe("web_fetch", () => {
  test("returns the durable JSON shape for a readable page", async () => {
    const { fetch, calls } = fakeFetch([
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>t</title><style>a{}</style></head><body><h1>Title</h1><p>Body &amp; more</p><script>evil()</script></body></html>",
      },
    ]);
    const result = await executeWebFetchV1(
      { url: "https://example.test/page", maxBytes: 65536, format: "text" },
      { fetch },
    );

    expect(result.isError).toBe(false);
    const body = parsed(result.content) as unknown as WebFetchResultV1;
    expect(body.url).toBe("https://example.test/page");
    expect(body.finalUrl).toBe("https://example.test/page");
    expect(body.status).toBe(200);
    expect(body.contentType).toBe("text/html");
    expect(body.truncated).toBe(false);
    expect(body.text).toContain("Title");
    expect(body.text).toContain("Body & more");
    // Script and style content is dropped whole, never handed to the model.
    expect(body.text).not.toContain("evil()");
    expect(body.text).not.toContain("a{}");
    expect(calls).toEqual(["https://example.test/page"]);
  });

  test("sends a fixed identity and no credential of the Bot's", async () => {
    let sent: Headers | undefined;
    const fetch: WebFetchFn = (_input, init) => {
      sent = new Headers(init?.headers);
      return Promise.resolve(
        new Response("<p>ok</p>", { headers: { "content-type": "text/html" } }),
      );
    };
    await executeWebFetchV1(
      { url: "https://example.test/", maxBytes: 65536, format: "text" },
      { fetch },
    );
    expect(sent?.get("user-agent")).toContain("FrockBot");
    expect(sent?.get("authorization")).toBeNull();
    expect(sent?.get("cookie")).toBeNull();
  });

  test("truncates a body that runs past max_bytes and says so", async () => {
    const { fetch } = fakeFetch([
      {
        headers: { "content-type": "text/plain" },
        body: "x".repeat(20_000),
      },
    ]);
    const result = await executeWebFetchV1(
      { url: "https://example.test/big", maxBytes: 4096, format: "text" },
      { fetch },
    );
    const body = parsed(result.content) as unknown as WebFetchResultV1;
    expect(result.isError).toBe(false);
    expect(body.bytes).toBe(4096);
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(4096);
  });

  test("refuses a body whose declared length is already over the cap", async () => {
    const { fetch } = fakeFetch([
      {
        headers: {
          "content-type": "text/plain",
          "content-length": String(WEB_FETCH_MAX_BYTES_V1 + 1),
        },
        body: "small",
      },
    ]);
    const result = await executeWebFetchV1(
      {
        url: "https://example.test/huge",
        maxBytes: WEB_FETCH_MAX_BYTES_V1,
        format: "text",
      },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(parsed(result.content).error).toBe("web-fetch-response-too-large");
  });

  test("refuses a content type outside the allow list", async () => {
    const { fetch } = fakeFetch([
      { headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" },
    ]);
    const result = await executeWebFetchV1(
      { url: "https://example.test/doc.pdf", maxBytes: 65536, format: "text" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(parsed(result.content).error).toBe("web-fetch-blocked-content-type");
  });

  test("re-validates every redirect and refuses one into private space", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      },
    ]);
    const result = await executeWebFetchV1(
      { url: "https://example.test/go", maxBytes: 65536, format: "text" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(parsed(result.content).error).toBe("ssrf-blocked-private-address");
    // The private hop is never requested: the classifier runs before the fetch.
    expect(calls).toEqual(["https://example.test/go"]);
  });

  test("follows at most three redirects", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 302, headers: { location: "/next" } },
    ]);
    const result = await executeWebFetchV1(
      { url: "https://example.test/a", maxBytes: 65536, format: "text" },
      { fetch },
    );
    expect(parsed(result.content).error).toBe("web-fetch-too-many-redirects");
    expect(calls.length).toBe(4);
  });

  test("refuses a non-https url without making a request", async () => {
    const { fetch, calls } = fakeFetch([{}]);
    const result = await executeWebFetchV1(
      {
        url: "http://169.254.169.254/latest/meta-data",
        maxBytes: 65536,
        format: "text",
      },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(parsed(result.content).error).toBe("ssrf-blocked-scheme");
    expect(calls).toEqual([]);
  });

  test("renders markdown when the call asks for it", () => {
    const markdown = extractReadableTextV1(
      '<h2>Heading</h2><ul><li>one</li></ul><p><a href="https://example.test/x">link</a></p>',
      "text/html",
      "markdown",
    );
    expect(markdown).toContain("## Heading");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("[link](https://example.test/x)");
  });

  test("declares itself idempotent, so recovery re-runs rather than guesses", () => {
    expect(createWebFetchToolDefinitionV1().idempotent).toBe(true);
  });

  test("rejects arguments the schema does not admit", async () => {
    const definition = createWebFetchToolDefinitionV1();
    expect(definition.validate?.({ url: 42 })).toBe(false);
    expect(
      definition.validate?.({ url: "https://a.test/", format: "pdf" }),
    ).toBe(false);
    expect(definition.validate?.({ url: "https://a.test/" })).toBe(true);
    const result = await definition.execute({ url: "" }, toolContext());
    expect(result.isError).toBe(true);
  });
});

describe("the web-fetch Capability enablement", () => {
  test("mounts only for the enabled Capability", () => {
    expect(
      createConfiguredWebFetchRuntimeContribution({
        capability: { ...ENABLED_CAPABILITY, capabilityId: "something-else" },
      }),
    ).toBeUndefined();
    expect(
      createConfiguredWebFetchRuntimeContribution({
        capability: ENABLED_CAPABILITY,
      }),
    ).toBeDefined();
  });

  test("offers web_fetch on every turn type its manifest admits", async () => {
    const root = new Context();
    await root.plugin(ToolRegistry);
    const plugin = createConfiguredWebFetchRuntimeContribution({
      capability: ENABLED_CAPABILITY,
    });
    expect(plugin).toBeDefined();
    await root.plugin(plugin!);

    for (const turnType of ["chat", "automation", "subagent"] as const) {
      expect({
        turnType,
        names: root.tools.schemas({ turnType }).map((schema) => schema.name),
      }).toEqual({ turnType, names: ["web_fetch"] });
    }
    await root.fiber.dispose();
  });
});
