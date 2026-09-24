import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "./index.js";
import { resetAccessKeyCacheV1 } from "./access.js";
import { accessTeamFixtureV1 } from "./access-fixture.js";
import {
  defaultUserFeaturesV1,
  type AdminUserListViewV1,
  type DeploymentPolicyV1,
} from "@frockbot/app/admin/shared";
import {
  seedHostedModelRatesV1,
  type HostedModelRatesViewV1,
} from "@frockbot/app/billing/rates";

const team = await accessTeamFixtureV1();
const serveKeys = team.serveKeys();
const realFetch = globalThis.fetch;
// The Worker verifies against the team's published keys over the network; this
// serves that one document and nothing else.
globalThis.fetch = ((input: RequestInfo | URL) =>
  serveKeys(typeof input === "string" ? input : String(input))) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetAccessKeyCacheV1();
});

const ORIGIN = "https://admin.frockbot.com";
const ADMIN = "owner@example.com";

function policy(revision = 3): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision,
    admission: { mode: "invite-only" },
    updatedAt: "2026-09-14T10:00:00.000Z",
    updatedBy: ADMIN,
  };
}

function accounts(): AdminUserListViewV1 {
  return {
    schemaVersion: 1,
    gatedPlugins: [{ pluginId: "weather", displayName: "Weather" }],
    users: [
      {
        userId: "user-1",
        email: "person@example.com",
        name: "Person One",
        features: {
          ...defaultUserFeaturesV1(),
          plugins: ["weather"],
        },
        billing: {
          includedMicros: 0,
          purchasedMicros: 0,
          complimentaryMicros: 2_500_000,
          reservedMicros: 0,
          subscribed: false,
          canSpend: true,
          suspended: false,
        },
        access: {
          schemaVersion: 1,
          userId: "user-1",
          access: {
            schemaVersion: 1,
            userId: "user-1",
            state: "active",
            revision: 7,
            updatedAt: "2026-09-14T11:00:00.000Z",
            updatedBy: ADMIN,
          },
        },
      },
      {
        userId: "user-2",
        features: { unavailable: true },
        billing: { unavailable: true },
        access: { unavailable: true },
      },
    ],
  };
}

function ratesView(): HostedModelRatesViewV1 {
  const first = seedHostedModelRatesV1("2026-09-24T00:00:00.000Z");
  const current = {
    ...first,
    version: 2,
    createdAt: "2026-09-25T00:00:00.000Z",
    createdBy: ADMIN,
  };
  return {
    schemaVersion: 1,
    current,
    history: [current, first],
    unpriced: [
      {
        schemaVersion: 1,
        servedModel: "custom-together/new-model",
        route: "@frock/auto",
        version: 2,
        firstSeenAt: "2026-09-25T01:00:00.000Z",
        lastSeenAt: "2026-09-25T02:00:00.000Z",
      },
    ],
  };
}

interface Recorded {
  calls: Array<{ method: string; input?: unknown }>;
}

function app(
  overrides: Partial<Record<string, (input: unknown) => unknown>> = {},
): { binding: Env["APP"]; recorded: Recorded } {
  const recorded: Recorded = { calls: [] };
  const record = (method: string, answer: (input: unknown) => unknown) => {
    return (input?: unknown) => {
      recorded.calls.push({ method, input });
      return Promise.resolve(overrides[method]?.(input) ?? answer(input));
    };
  };
  return {
    recorded,
    binding: {
      readPolicy: record("readPolicy", () => policy()),
      listAccounts: record("listAccounts", () => accounts()),
      setAdmissionMode: record("setAdmissionMode", () => ({
        status: "applied",
        value: policy(4),
      })),
      readAccountAccess: record("readAccountAccess", () => ({
        schemaVersion: 1,
        userId: "user-1",
        access: null,
      })),
      setAccountAccess: record("setAccountAccess", () => ({
        status: "applied",
        value: {
          schemaVersion: 1,
          userId: "user-1",
          state: "paused",
          revision: 8,
          updatedAt: "2026-09-15T00:00:00.000Z",
          updatedBy: ADMIN,
        },
      })),
      inviteEmail: record("inviteEmail", () => ({
        schemaVersion: 1,
        email: "friend@example.com",
        invitedAt: "2026-09-15T00:00:00.000Z",
        invitedBy: ADMIN,
      })),
      setAccountFeatures: record("setAccountFeatures", () => ({
        ...defaultUserFeaturesV1(),
        updatedBy: ADMIN,
      })),
      grantCredit: record("grantCredit", () => ({
        includedMicros: 0,
        purchasedMicros: 0,
        complimentaryMicros: 5_000_000,
        reservedMicros: 0,
        subscribed: false,
        canSpend: true,
        suspended: false,
      })),
      readModelRates: record("readModelRates", () => ratesView()),
      saveModelRates: record("saveModelRates", () => ({
        status: "applied",
        value: { ...ratesView().current, version: 3 },
      })),
    } as Env["APP"],
  };
}

function environment(overrides: Partial<Env> = {}): Env {
  return {
    APP: app().binding,
    ACCESS_TEAM_DOMAIN: team.teamDomain,
    ACCESS_AUD: team.audience,
    FROCKBOT_ADMIN_EMAILS: `${ADMIN},second@example.com`,
    ...overrides,
  };
}

async function signedIn(claims: Record<string, unknown> = {}) {
  return { "cf-access-jwt-assertion": await team.sign(claims) };
}

async function get(env: Env, path = "/") {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: await signedIn() }),
    env,
  );
}

async function post(
  env: Env,
  fields: Record<string, string | string[]>,
  init: { origin?: string | null } = {},
) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      body.append(name, entry);
    }
  }
  const headers = new Headers({
    ...(await signedIn()),
    "content-type": "application/x-www-form-urlencoded",
  });
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  return worker.fetch(
    new Request(`${ORIGIN}/`, { method: "POST", headers, body }),
    env,
  );
}

describe("the door", () => {
  test("says so when the Access application is not configured", async () => {
    const response = await get(
      environment({ ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("ACCESS_TEAM_DOMAIN");
  });

  test("refuses a request that carries no assertion", async () => {
    const response = await worker.fetch(new Request(ORIGIN), environment());

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("no Cloudflare Access assertion");
  });

  test("refuses an assertion for another application", async () => {
    const response = await worker.fetch(
      new Request(ORIGIN, {
        headers: await signedIn({ aud: ["b".repeat(64)] }),
      }),
      environment(),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("another application");
  });

  test("refuses a verified identity the admin list does not name", async () => {
    const binding = app();
    const response = await worker.fetch(
      new Request(ORIGIN, {
        headers: await signedIn({ email: "stranger@example.com" }),
      }),
      environment({ APP: binding.binding }),
    );

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("Not an administrator");
    expect(body).toContain("stranger@example.com");
    // Nothing about the deployment was read on that person's behalf.
    expect(binding.recorded.calls).toEqual([]);
  });

  test("answers one path only", async () => {
    const response = await get(environment(), "/accounts");

    expect(response.status).toBe(404);
  });

  test("carries security headers, a nonce that matches its stylesheet, and no store", async () => {
    const response = await get(environment());
    const body = await response.text();

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    const policyHeader = response.headers.get("content-security-policy") ?? "";
    expect(policyHeader).toContain("default-src 'none'");
    expect(policyHeader).toContain("frame-ancestors 'none'");
    const nonce = /style-src 'nonce-([^']+)'/.exec(policyHeader)?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<style nonce="${nonce}">`);
    // No script at all, so nothing to allow.
    expect(policyHeader).not.toContain("script-src '");
    expect(body).not.toContain("<script");
  });
});

describe("the page", () => {
  test("shows the admission mode, the accounts and what each holds", async () => {
    const response = await get(environment());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Signed in as owner@example.com");
    // The deployment's mode is marked current and offers no button; the others
    // carry the revision it was read at.
    expect(body).toContain('<div class="row row-current">');
    expect(body).toContain('<input type="hidden" name="mode" value="closed">');
    expect(body).toContain('<input type="hidden" name="revision" value="3">');
    expect(body).toContain("Person One");
    expect(body).toContain("person@example.com");
    // Access, with the record's own revision on the form that changes it.
    expect(body).toContain(">Active</span>");
    expect(body).toContain('<input type="hidden" name="revision" value="7">');
    // Features, checked from the record rather than from a default.
    expect(body).toContain('value="weather" checked');
    expect(body).toContain("US$2.50 complimentary");
    // The unreadable account is present and honest about being unreadable.
    expect(body).toContain("user-2");
    expect(body).toContain("could not be reached");
    expect(body).toContain("could not be read");
  });

  test("escapes what an account carries", async () => {
    const hostile = accounts();
    hostile.users[0]!.name = '<script>alert("x")</script>';
    const response = await get(
      environment({
        APP: app({ listAccounts: () => hostile }).binding,
      }),
    );
    const body = await response.text();

    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)");
  });

  test("shows the rate table, its history and a model that answered unpriced", async () => {
    const body = await (await get(environment())).text();

    expect(body).toContain("Hosted model rates");
    expect(body).toContain("Version 2, saved by owner@example.com");
    expect(body).toContain(
      "Input US$0.30 · cached input US$0.006 · output US$1.20",
    );
    expect(body).toContain("up to 400,000 tokens in, 16,384 out");
    expect(body).toContain("custom-together/deepseek-ai/DeepSeek-V4.1-Flash");
    expect(body).toContain("custom-together/new-model");
    expect(body).toContain("Unpriced");
    expect(body).toContain('<input type="hidden" name="revision" value="2">');
    expect(body).toContain("Save as version 3");
    expect(body).toContain("<h3>Version 1</h3>");
    expect(body).toContain("&quot;@frock/auto&quot;");
  });

  test("a rate table that cannot be read leaves the rest of the page", async () => {
    const response = await get(
      environment({
        APP: app({
          readModelRates: () => {
            throw new Error("authority unreachable");
          },
        }).binding,
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("The rate table could not be read");
    expect(body).toContain("Person One");
  });

  test("shows the notice a finished write redirected to", async () => {
    const response = await get(environment(), "/?notice=invited");

    expect(await response.text()).toContain("The invitation is recorded");
  });
});

describe("a write", () => {
  test("carries the revision the page read and redirects when it lands", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "admission-mode",
      mode: "open",
      revision: "3",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?notice=mode");
    expect(
      binding.recorded.calls.find((call) => call.method === "setAdmissionMode")
        ?.input,
    ).toEqual({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/set-admission-mode",
        mode: "open",
        revision: 3,
      },
      updatedBy: ADMIN,
    });
  });

  test("renders the current state when the mode changed underneath it", async () => {
    const response = await post(
      environment({
        APP: app({
          setAdmissionMode: () => ({ status: "conflict", currentRevision: 9 }),
        }).binding,
      }),
      { action: "admission-mode", mode: "open", revision: "3" },
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("changed underneath you");
    expect(body).toContain("New accounts");
  });

  test("renders the current state when an account's access changed underneath it", async () => {
    const response = await post(
      environment({
        APP: app({
          setAccountAccess: () => ({ status: "conflict", currentRevision: 8 }),
        }).binding,
      }),
      {
        action: "account-access",
        userId: "user-1",
        state: "paused",
        revision: "7",
      },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("changed underneath you");
  });

  test("sets an account's access under its revision", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "account-access",
      userId: "user-1",
      state: "blocked",
      revision: "7",
    });

    expect(response.headers.get("location")).toBe("/?notice=access");
    expect(
      binding.recorded.calls.find((call) => call.method === "setAccountAccess")
        ?.input,
    ).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "account/set-access",
        state: "blocked",
        revision: 7,
      },
      updatedBy: ADMIN,
    });
  });

  test("invites an address", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "invite-email",
      email: " Friend@Example.com ",
    });

    expect(response.headers.get("location")).toBe("/?notice=invited");
    expect(
      binding.recorded.calls.find((call) => call.method === "inviteEmail")
        ?.input,
    ).toMatchObject({
      command: { type: "access/invite-email", email: "Friend@Example.com" },
      invitedBy: ADMIN,
    });
  });

  test("writes the whole features record, so an unchecked box is off", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "account-features",
      userId: "user-1",
      pluginAuthoring: "on",
      plugin: ["weather"],
    });

    expect(response.headers.get("location")).toBe("/?notice=features");
    expect(
      binding.recorded.calls.find(
        (call) => call.method === "setAccountFeatures",
      )?.input,
    ).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-features",
        pluginAuthoring: true,
        plugins: ["weather"],
      },
      updatedBy: ADMIN,
    });
  });

  test("grants credit in cents under the page's own idempotency key", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "grant-credit",
      userId: "user-1",
      grantId: "grant-abc",
      dollars: "25.50",
      reason: "Beta thanks",
    });

    expect(response.headers.get("location")).toBe("/?notice=credit");
    expect(
      binding.recorded.calls.find((call) => call.method === "grantCredit")
        ?.input,
    ).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/grant-credit",
        id: "grant-abc",
        cents: 2_550,
        reason: "Beta thanks",
      },
      grantedBy: ADMIN,
    });
  });

  test("refuses an amount past the cap without reaching the ledger", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "grant-credit",
      userId: "user-1",
      grantId: "grant-abc",
      dollars: "1000.01",
      reason: "Slipped digit",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("capped at US$1000.00");
    expect(
      binding.recorded.calls.some((call) => call.method === "grantCredit"),
    ).toBe(false);
  });

  test("says what was refused when the app refuses the write", async () => {
    const response = await post(
      environment({
        APP: app({
          setAccountFeatures: () => {
            throw new Error("user features request.userId is invalid");
          },
        }).binding,
      }),
      { action: "account-features", userId: "user-1" },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Nothing was written");
  });

  test("refuses a form submitted from another site", async () => {
    const binding = app();
    const response = await post(
      environment({ APP: binding.binding }),
      { action: "admission-mode", mode: "open", revision: "3" },
      { origin: "https://elsewhere.example" },
    );

    expect(response.status).toBe(403);
    expect(
      binding.recorded.calls.some((call) => call.method === "setAdmissionMode"),
    ).toBe(false);
  });

  test("saves a rate version over the one the page read", async () => {
    const binding = app();
    const table = {
      routes: ratesView().current.routes,
      served: ratesView().current.served,
    };
    const response = await post(environment({ APP: binding.binding }), {
      action: "model-rates",
      revision: "2",
      rates: JSON.stringify(table),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?notice=rates");
    expect(
      binding.recorded.calls.find((call) => call.method === "saveModelRates")
        ?.input,
    ).toEqual({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/save-model-rates",
        baseVersion: 2,
        ...table,
      },
      createdBy: ADMIN,
    });
  });

  test("a rate table that does not parse is refused and comes back as typed", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "model-rates",
      revision: "2",
      rates: '{"routes": {"@frock/auto": <oops>}',
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("The rate table is not valid JSON.");
    expect(body).toContain(
      "{&quot;routes&quot;: {&quot;@frock/auto&quot;: &lt;oops&gt;}",
    );
    expect(
      binding.recorded.calls.some((call) => call.method === "saveModelRates"),
    ).toBe(false);
  });

  test("a rate table that leaves Auto unpriced never reaches the app", async () => {
    const binding = app();
    const response = await post(environment({ APP: binding.binding }), {
      action: "model-rates",
      revision: "2",
      rates: JSON.stringify({
        routes: {
          "@frock/deepseek-ai/deepseek-v4-flash-0731":
            ratesView().current.routes["@frock/auto"],
        },
        served: {},
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("routes must price");
    expect(
      binding.recorded.calls.some((call) => call.method === "saveModelRates"),
    ).toBe(false);
  });

  test("a rate save that lost the race keeps the edit over the current version", async () => {
    const response = await post(
      environment({
        APP: app({
          saveModelRates: () => ({ status: "conflict", currentRevision: 3 }),
        }).binding,
      }),
      {
        action: "model-rates",
        revision: "2",
        rates: JSON.stringify({
          routes: ratesView().current.routes,
          served: {
            "custom-together/kept-edit": {
              inputMicrosPerToken: 1,
              cachedInputMicrosPerToken: 0.5,
              outputMicrosPerToken: 2,
            },
          },
        }),
      },
    );
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(body).toContain("gained a version underneath you");
    expect(body).toContain("custom-together/kept-edit");
  });

  test("refuses a form this page does not offer", async () => {
    const response = await post(environment(), { action: "delete-everything" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not one this page offers");
  });
});
