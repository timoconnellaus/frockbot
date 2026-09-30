import { describe, expect, test } from "bun:test";
import {
  createAgentRuntimeHarness,
  frockbotToolCall,
} from "@frockbot/app/testkit";
import { createCredentialUserBackendContribution } from "@frockbot/app/credentials/user";
import type { SearchMeterV1 } from "@frockbot/app/billing/search";
import type { ToolExecutionContext } from "@frockbot/core/contracts";
import {
  MemorySecretStorage,
  TEST_SECRETS_KEYRING,
} from "@frockbot/app/secrets/testing";
import {
  EXA_SEARCH_ENDPOINT_V1,
  TAVILY_SEARCH_ENDPOINT_V1,
} from "./account-providers.ts";
import { BRAVE_WEB_SEARCH_ENDPOINT_V1 } from "./brave.ts";
import { webSearchEffectIdV1 } from "./contract.ts";
import {
  createAccountWebSearchV1,
  createConfiguredWebSearchRuntimeContribution,
} from "./search.ts";
import {
  decodeWebSearchChoiceInputV1,
  type WebSearchChoiceInputV1,
} from "./search-choice.ts";
import { createWebSearchChoiceStoreV1 } from "./search-choice-user.ts";

const ACCOUNT = "user-1";
const PLATFORM_KEY = "platform-brave-key";
const CAPABILITY = { packageId: "web", capabilityId: "web-search" } as const;
const NOW = Date.parse("2026-09-30T00:00:00.000Z");

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

/** The User Durable Object's half, over in-memory storage. */
function account(now = () => NOW) {
  const storage = new MemorySecretStorage();
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: TEST_SECRETS_KEYRING,
    now,
  });
  const store = createWebSearchChoiceStoreV1({ storage, credentials, now });
  const leases: string[] = [];
  return {
    storage,
    store,
    leases,
    /** The Bot Durable Object's half, as a Turn mounts it. */
    async mountAccount() {
      return createAccountWebSearchV1({
        accountId: ACCOUNT,
        choice: await store.read(),
        lease: (effectId, generation) => {
          leases.push(`lease ${effectId}`);
          return store.lease({ accountId: ACCOUNT, effectId, generation });
        },
        settle: (effectId) => {
          leases.push(`settle ${effectId}`);
          return store.settle({ accountId: ACCOUNT, effectId });
        },
        readSecret: () => TEST_SECRETS_KEYRING,
      });
    },
  };
}

function refusingMeter(): { meter: SearchMeterV1; reserved: string[] } {
  const reserved: string[] = [];
  return {
    reserved,
    meter: {
      reserve: (search) => {
        reserved.push(search.effectId);
        return Promise.resolve({
          charge: () => Promise.resolve(),
          release: () => Promise.resolve(),
        });
      },
    },
  };
}

async function mount(options: {
  choice?: WebSearchChoiceInputV1;
  platformKey?: string;
  respond: (recorded: Recorded) => Response | Promise<Response>;
}) {
  const held = account();
  if (options.choice) {
    await held.store.set(ACCOUNT, decodeWebSearchChoiceInputV1(options.choice));
  }
  const { meter, reserved } = refusingMeter();
  const recorded: Recorded[] = [];
  const feature = await createConfiguredWebSearchRuntimeContribution({
    capability: CAPABILITY,
    apiKey: options.platformKey,
    meter,
    account: () => held.mountAccount(),
    fetch: (input, init) => {
      const entry = { url: new URL(input), init };
      recorded.push(entry);
      return Promise.resolve(options.respond(entry));
    },
  });
  const root = createAgentRuntimeHarness();
  if (feature) await root.mount(feature);
  return { root, recorded, reserved, feature, held };
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

function rows(count: number, snippetKey: string) {
  return Array.from({ length: count }, (_value, index) => ({
    title: `r${index}`,
    url: `https://example.test/${index}`,
    [snippetKey]: "  a  snippet\n over lines ",
    score: 0.9,
  }));
}

const EXPECTED = {
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
};

describe("web_search on the person's own provider", () => {
  test("Brave on their own key", async () => {
    const { root, recorded, reserved } = await mount({
      choice: { provider: "brave", apiKey: "own-brave-key" },
      platformKey: PLATFORM_KEY,
      respond: () =>
        Response.json({ web: { results: rows(3, "description") } }),
    });
    const result = await search(root, { query: "frockbot", max_results: 2 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(EXPECTED);
    const call = recorded[0]!;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(
      BRAVE_WEB_SEARCH_ENDPOINT_V1,
    );
    expect(new Headers(call.init?.headers).get("x-subscription-token")).toBe(
      "own-brave-key",
    );
    expect(reserved).toEqual([]);
    await root.dispose();
  });

  test("Exa on their own key", async () => {
    const { root, recorded, reserved } = await mount({
      choice: { provider: "exa", apiKey: "exa-key" },
      respond: () => Response.json({ results: rows(3, "text") }),
    });
    const result = await search(root, { query: "frockbot", max_results: 2 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(EXPECTED);
    const call = recorded[0]!;
    expect(call.url.toString()).toBe(EXA_SEARCH_ENDPOINT_V1);
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("x-api-key")).toBe("exa-key");
    expect(JSON.parse(call.init?.body as string)).toMatchObject({
      query: "frockbot",
      numResults: 2,
    });
    expect(result.content).not.toContain("exa-key");
    expect(reserved).toEqual([]);
    await root.dispose();
  });

  test("Tavily on their own key", async () => {
    const { root, recorded, reserved } = await mount({
      choice: { provider: "tavily", apiKey: "tvly-key" },
      respond: () =>
        Response.json({ query: "frockbot", results: rows(2, "content") }),
    });
    const result = await search(root, { query: "frockbot", max_results: 2 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(EXPECTED);
    const call = recorded[0]!;
    expect(call.url.toString()).toBe(TAVILY_SEARCH_ENDPOINT_V1);
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      "Bearer tvly-key",
    );
    expect(JSON.parse(call.init?.body as string)).toMatchObject({
      query: "frockbot",
      max_results: 2,
    });
    expect(reserved).toEqual([]);
    await root.dispose();
  });

  test("SearXNG at their own address, through its JSON API", async () => {
    const { root, recorded, reserved } = await mount({
      choice: { provider: "searxng", url: "https://search.example:8443/searx" },
      respond: () =>
        Response.json({ query: "frockbot", results: rows(6, "content") }),
    });
    const result = await search(root, { query: "frockbot", max_results: 2 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(EXPECTED);
    const call = recorded[0]!;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(
      "https://search.example:8443/searx/search",
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      q: "frockbot",
      format: "json",
    });
    expect(call.init?.redirect).toBe("manual");
    expect(reserved).toEqual([]);
    await root.dispose();
  });

  test("says how to fix a SearXNG instance with JSON switched off", async () => {
    const { root } = await mount({
      choice: { provider: "searxng", url: "https://search.example" },
      respond: () => new Response("Forbidden", { status: 403 }),
    });
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("search.formats");
    await root.dispose();
  });

  test("mounts on their own provider when the deployment has no key", async () => {
    const { feature } = await mount({
      choice: { provider: "exa", apiKey: "exa-key" },
      respond: () => Response.json({ results: [] }),
    });
    expect(feature).toBeDefined();
  });

  test("never falls back to FrockBot's search when theirs fails", async () => {
    for (const status of [401, 402, 429, 432, 500]) {
      const { root, recorded, reserved } = await mount({
        choice: { provider: "tavily", apiKey: "tvly-key" },
        platformKey: PLATFORM_KEY,
        respond: () => new Response("{}", { status }),
      });
      const result = await search(root, { query: "q" });
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content) as {
        error: string;
        message: string;
      };
      expect(body.error).toBe("web-search-failed");
      expect(body.message).toContain("Your Tavily search");
      expect(body.message).toContain(String(status));
      expect(recorded.map((call) => call.url.origin)).toEqual([
        "https://api.tavily.com",
      ]);
      expect(reserved).toEqual([]);
      await root.dispose();
    }
  });

  test("leases the secret for each search and settles it after", async () => {
    const { root, held } = await mount({
      choice: { provider: "exa", apiKey: "exa-key" },
      respond: () => Response.json({ results: [] }),
    });
    await search(root, { query: "q" });
    const effectId = await webSearchEffectIdV1(toolContext());
    // The first settle clears whatever an earlier attempt left behind.
    expect(held.leases).toEqual([`lease ${effectId}`, `settle ${effectId}`]);
    expect(held.storage.dump()).not.toContain("exa-key");
    await root.dispose();
  });

  test("re-runs a search under the same effect, as recovery does", async () => {
    let answered = 0;
    const { root } = await mount({
      choice: { provider: "exa", apiKey: "exa-key" },
      respond: () => {
        answered += 1;
        return Response.json({ results: rows(1, "text") });
      },
    });
    for (let run = 0; run < 3; run += 1) {
      const result = await search(root, { query: "q" });
      expect(result.isError).toBe(false);
    }
    expect(answered).toBe(3);
    await root.dispose();
  });

  test("re-leases after an evicted attempt's lease expired unsettled", async () => {
    let now = NOW;
    const held = account(() => now);
    const choice = await held.store.set(ACCOUNT, {
      provider: "exa",
      apiKey: "exa-key",
    });
    if (choice.provider === "frockbot") throw new Error("unexpected");
    const input = {
      accountId: ACCOUNT,
      effectId: "web-search-abc",
      generation: choice.generation,
    };
    // The first attempt leased and was evicted before it could settle.
    await held.store.lease(input);
    now += 5 * 60_000;
    const again = await held.store.lease(input);
    expect(again.effectId).toBe("web-search:web-search-abc");
    await held.store.settle(input);
  });

  test("refuses a search whose choice changed since the Turn mounted", async () => {
    const held = account();
    await held.store.set(ACCOUNT, { provider: "exa", apiKey: "exa-key" });
    const mounted = await held.mountAccount();
    await held.store.set(ACCOUNT, { provider: "tavily", apiKey: "tvly-key" });
    const recorded: string[] = [];
    const feature = await createConfiguredWebSearchRuntimeContribution({
      capability: CAPABILITY,
      apiKey: PLATFORM_KEY,
      account: () => Promise.resolve(mounted),
      fetch: (input) => {
        recorded.push(String(input));
        return Promise.resolve(Response.json({ results: [] }));
      },
    });
    const root = createAgentRuntimeHarness();
    await root.mount(feature!);
    const result = await search(root, { query: "q" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Your Exa search could not be used");
    expect(result.content).not.toContain("tvly-key");
    expect(recorded).toEqual([]);
    await root.dispose();
  });
});

describe("FrockBot's search", () => {
  test("is the default, on the platform key, and billed", async () => {
    const { root, recorded, reserved } = await mount({
      platformKey: PLATFORM_KEY,
      respond: () =>
        Response.json({ web: { results: rows(2, "description") } }),
    });
    const result = await search(root, { query: "frockbot", max_results: 2 });
    expect(JSON.parse(result.content)).toEqual(EXPECTED);
    expect(
      new Headers(recorded[0]!.init?.headers).get("x-subscription-token"),
    ).toBe(PLATFORM_KEY);
    expect(reserved).toEqual([await webSearchEffectIdV1(toolContext())]);
    await root.dispose();
  });

  test("is chosen again by switching back, which drops the saved key", async () => {
    const held = account();
    await held.store.set(ACCOUNT, { provider: "exa", apiKey: "exa-key" });
    await held.store.set(ACCOUNT, { provider: "frockbot" });
    expect(await held.store.read()).toEqual({
      schemaVersion: 1,
      provider: "frockbot",
    });
    expect(held.storage.dump()).not.toContain("credential-active:");
  });

  test("mounts nothing without the deployment's key", async () => {
    const { feature } = await mount({
      respond: () => Response.json({}),
    });
    expect(feature).toBeUndefined();
  });
});

describe("the account's choice", () => {
  test("keeps a key only sealed, and shows which provider it is for", async () => {
    const held = account();
    const view = await held.store.set(ACCOUNT, {
      provider: "tavily",
      apiKey: "tvly-secret",
    });
    expect(view).toMatchObject({ schemaVersion: 1, provider: "tavily" });
    expect(JSON.stringify(view)).not.toContain("tvly-secret");
    expect(held.storage.dump()).not.toContain("tvly-secret");
    expect(await held.store.read()).toEqual(view);
  });

  test("decodes what a person submits", () => {
    expect(
      decodeWebSearchChoiceInputV1({
        provider: "searxng",
        url: "https://search.example/searx/search?q=x",
      }),
    ).toEqual({ provider: "searxng", url: "https://search.example/searx/" });
    expect(
      decodeWebSearchChoiceInputV1({ provider: "exa", apiKey: " key " }),
    ).toEqual({ provider: "exa", apiKey: "key" });
    for (const input of [
      { provider: "exa" },
      { provider: "exa", apiKey: "" },
      { provider: "exa", apiKey: "has space" },
      { provider: "frockbot", apiKey: "x" },
      { provider: "searxng", url: "http://search.example" },
      { provider: "searxng", url: "https://127.0.0.1:8080" },
      { provider: "searxng", url: "https://searx.internal" },
      { provider: "google", apiKey: "x" },
    ]) {
      expect(() => decodeWebSearchChoiceInputV1(input)).toThrow();
    }
  });

  test("never quotes the key in a refusal", () => {
    try {
      decodeWebSearchChoiceInputV1({ provider: "exa", apiKey: "a b c" });
    } catch (error) {
      expect((error as Error).message).not.toContain("a b c");
    }
  });
});
