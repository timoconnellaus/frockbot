// The web-tools slice end to end: `web_search` (Ollama Cloud, Connection
// backed) and `web_fetch` (generic, SSRF-safe), driven the way production
// drives them.
//
// Nothing here calls a tool directly. The stubbed model answers with a
// `tool_calls` stream when a Turn's user message carries
// {@link TOOL_CALL_TRIGGER}, so the Agent loop inside the Bot Durable Object
// prepares, admits, journals and executes each call exactly as it would for a
// real model, and every assertion is on the durable `tool/result` a browser
// reads back.
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface ClientTurn {
  runId: string;
  events: Array<
    | { type: "tool/call"; call: { id: string; name: string } }
    | { type: "tool/result"; callId: string; content: string; isError: boolean }
    | { type: string }
  >;
}

interface ToolOutcome {
  content: string;
  isError: boolean;
}

async function turnCalling(
  userId: string,
  botId: string,
  commandId: string,
  name: string,
  input: unknown,
): Promise<ClientTurn> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: `${TOOL_CALL_TRIGGER}${name}:${JSON.stringify(input)}`,
    }),
  )) as ClientTurn;
}

/** The durable result of the named call, error or not. */
function toolOutcome(turn: ClientTurn, name: string): ToolOutcome {
  const call = turn.events.find(
    (event) =>
      event.type === "tool/call" &&
      (event as { call: { name: string } }).call.name === name,
  );
  expect(call, `the Turn made no ${name} call`).toBeDefined();
  const callId = (call as { call: { id: string } }).call.id;
  const result = turn.events.find(
    (event) =>
      event.type === "tool/result" &&
      (event as { callId: string }).callId === callId,
  ) as ToolOutcome | undefined;
  expect(result, `the ${name} call produced no result`).toBeDefined();
  return result!;
}

/**
 * Provision the two capabilities this slice needs through the product's own
 * surfaces: connect Ollama Cloud and install the Web Package. The Bot receives
 * both on its next admitted Turn without a second grant.
 */
async function prepareWebTools(userId: string, botId: string): Promise<void> {
  await provisionThroughGateway({ userId, botId });

  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-web-${botId}`,
      expectedRevision: settings.revision,
      packageId: "web",
      version: "0.0.1",
    }),
  );
}

async function uninstallPackage(
  userId: string,
  packageId: string,
): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/uninstall-package",
      commandId: `uninstall-${packageId}`,
      expectedRevision: settings.revision,
      packageId,
    }),
  );
}

describe("web_search through the gateway, the artifact and the Bot", () => {
  it("records the provider's results as durable JSON on the Turn", async () => {
    const userId = freshUserId("web-search");
    const botId = "searching-bot";
    await prepareWebTools(userId, botId);

    const turn = await turnCalling(
      userId,
      botId,
      "web-search-1",
      "web_search",
      { query: "frockbot parity", max_results: 2 },
    );
    const outcome = toolOutcome(turn, "web_search");
    expect(outcome.isError, outcome.content).toBe(false);

    const body = JSON.parse(outcome.content) as {
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(body.query).toBe("frockbot parity");
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.url).toContain("https://example.test/result-");
    expect(body.results[0]?.snippet).toContain("frockbot parity");
    // The Connection's key crossed the wire and never the event log.
    expect(outcome.content).not.toContain("workerd-test-key");
  });
});

describe("web_fetch through the gateway, the artifact and the Bot", () => {
  it("reads a public page and records the durable fetch shape", async () => {
    const userId = freshUserId("web-fetch");
    const botId = "fetching-bot";
    await prepareWebTools(userId, botId);

    const turn = await turnCalling(userId, botId, "web-fetch-1", "web_fetch", {
      url: "https://example.test/page",
      format: "markdown",
    });
    const outcome = toolOutcome(turn, "web_fetch");
    expect(outcome.isError, outcome.content).toBe(false);

    const body = JSON.parse(outcome.content) as {
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      bytes: number;
      truncated: boolean;
      text: string;
    };
    expect(body.url).toBe("https://example.test/page");
    expect(body.finalUrl).toBe("https://example.test/page");
    expect(body.status).toBe(200);
    expect(body.contentType).toBe("text/html");
    expect(body.truncated).toBe(false);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.text).toContain("# Stub page");
    expect(body.text).toContain("quick brown fox & friends");
    // Script and style content never reaches the model or the event log.
    expect(body.text).not.toContain("never-extracted");
    expect(body.text).not.toContain("color:red");
  });

  it("refuses the cloud metadata address without making the request", async () => {
    const userId = freshUserId("web-fetch-ssrf");
    const botId = "guarded-bot";
    await prepareWebTools(userId, botId);

    const blocked = await turnCalling(
      userId,
      botId,
      "web-fetch-ssrf-1",
      "web_fetch",
      { url: "http://169.254.169.254/latest/meta-data" },
    );
    const outcome = toolOutcome(blocked, "web_fetch");
    expect(outcome.isError).toBe(true);
    const refusal = JSON.parse(outcome.content) as {
      error: string;
      message: string;
    };
    // `http:` is refused first, so the reason names the scheme; the same URL
    // over https names the address rule. Both are stable codes, and neither
    // names what the host resolved to.
    expect(refusal.error).toBe("ssrf-blocked-scheme");

    const overHttps = await turnCalling(
      userId,
      botId,
      "web-fetch-ssrf-2",
      "web_fetch",
      { url: "https://169.254.169.254/latest/meta-data" },
    );
    const httpsOutcome = toolOutcome(overHttps, "web_fetch");
    expect(httpsOutcome.isError).toBe(true);
    const httpsRefusal = JSON.parse(httpsOutcome.content) as {
      error: string;
      message: string;
    };
    expect(httpsRefusal.error).toBe("ssrf-blocked-private-address");
    expect(httpsRefusal.message).not.toContain("169.254");

    // And the outbound seam never saw either request. The counter lives in the
    // stub because this assertion cannot be made from inside workerd: only the
    // thing that would have answered can say it was never asked.
    const counters = await turnCalling(
      userId,
      botId,
      "web-fetch-counters",
      "web_fetch",
      { url: "https://example.test/counters" },
    );
    const countersOutcome = toolOutcome(counters, "web_fetch");
    expect(countersOutcome.isError, countersOutcome.content).toBe(false);
    const reported = JSON.parse(countersOutcome.content) as { text: string };
    expect(JSON.parse(reported.text)).toEqual({ metadata: 0 });
  });

  it("refuses a media type it cannot read", async () => {
    const userId = freshUserId("web-fetch-type");
    const botId = "typed-bot";
    await prepareWebTools(userId, botId);

    const turn = await turnCalling(
      userId,
      botId,
      "web-fetch-pdf",
      "web_fetch",
      {
        url: "https://example.test/binary.pdf",
      },
    );
    const outcome = toolOutcome(turn, "web_fetch");
    expect(outcome.isError).toBe(true);
    expect((JSON.parse(outcome.content) as { error: string }).error).toBe(
      "web-fetch-blocked-content-type",
    );
  });
});

describe("Package enablement versus Connection authority", () => {
  it("removes web_fetch on uninstall while connected web_search remains", async () => {
    const userId = freshUserId("web-uninstalled");
    const botId = "bare-bot";
    await prepareWebTools(userId, botId);
    await uninstallPackage(userId, "web");

    const turn = await turnCalling(
      userId,
      botId,
      "web-uninstalled-1",
      "web_fetch",
      { url: "https://example.test/page" },
    );
    const outcome = toolOutcome(turn, "web_fetch");
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Unknown tool");

    const searched = await turnCalling(
      userId,
      botId,
      "web-still-connected-2",
      "web_search",
      { query: "anything" },
    );
    const searchOutcome = toolOutcome(searched, "web_search");
    expect(searchOutcome.isError, searchOutcome.content).toBe(false);
  });
});
