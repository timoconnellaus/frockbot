import { describe, expect, test } from "bun:test";
import type { AuthPackageV1 } from "@frockbot/core/contracts";
import type { GatewayDependencies } from "./contracts.js";
import { createGateway } from "./gateway.js";
import { SETUP_PAGE_CSP_V1 } from "./setup-page.js";
import {
  createSetupReader,
  isSetupDocumentPathV1,
  SETUP_READER_LIFETIME_MS_V1,
  setupReaderPathV1,
} from "./setup-reader.js";

const unreached = (member: string) => (): never => {
  throw new Error(`Setup must not reach ${member}`);
};

function gatewayFor(options: {
  signedIn?: boolean;
  now?: () => number;
  admitted?: boolean;
  development?: boolean;
  userConfigurationFor?: GatewayDependencies["userConfigurationFor"];
}) {
  const auth: AuthPackageV1 = {
    handler: unreached("auth.handler"),
    signOut: unreached("auth.signOut"),
    startSignIn: unreached("auth.startSignIn"),
    getSession: () =>
      Promise.resolve(options.signedIn ? { user: { id: "member" } } : null),
  };
  const setupReader = createSetupReader({
    secret: "test-secret",
    admit: async () =>
      options.admitted === false
        ? { schemaVersion: 1, admitted: false, reason: "account-paused" }
        : { schemaVersion: 1, admitted: true, basis: "active" },
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    setupReader,
    gateway: createGateway({
      whatsNew: true,
      loader: { get: unreached("loader") } as never,
      artifacts: { load: unreached("artifacts") },
      auth,
      admitAccount: () =>
        Promise.resolve({ schemaVersion: 1, admitted: true, basis: "active" }),
      applicationHashFor: unreached("applicationHashFor"),
      botStateFor: unreached("botStateFor"),
      userConfigurationFor:
        options.userConfigurationFor ?? unreached("userConfigurationFor"),
      botConfigurationFor: unreached("botConfigurationFor"),
      setupReader,
      ...(options.development ? { allowDevelopmentIdentity: true } : {}),
    }),
  };
}

const settingsOwner = (answer: unknown) =>
  (() => ({
    readConfiguration: async () => answer,
  })) as unknown as GatewayDependencies["userConfigurationFor"];

describe("the Setup document", () => {
  test("is served to anyone, names no account, and is framed only here", async () => {
    const { gateway } = gatewayFor({});
    for (const path of ["/setup", "/setup/ai", "/setup/accounts"]) {
      const response = await gateway(
        new Request(`https://frockbot.test${path}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(
        SETUP_PAGE_CSP_V1,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain('src="/_setup/setup.js"');
      expect(html).not.toContain("member");
    }
    expect(SETUP_PAGE_CSP_V1).toContain("frame-ancestors 'self'");
    expect(SETUP_PAGE_CSP_V1).not.toContain("unsafe-inline");
  });

  test("names only its own pages", () => {
    expect(isSetupDocumentPathV1("/setup")).toBe(true);
    expect(isSetupDocumentPathV1("/setup/plan")).toBe(true);
    expect(isSetupDocumentPathV1("/setup/")).toBe(false);
    expect(isSetupDocumentPathV1("/setup/elsewhere")).toBe(false);
    expect(isSetupDocumentPathV1("/setupx")).toBe(false);
  });
});

describe("the reader credential", () => {
  test("only a signed-in app mints one, in the fragment", async () => {
    const { gateway } = gatewayFor({ signedIn: true });
    const response = await gateway(
      new Request("https://frockbot.test/api/setup/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: "ai" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toMatch(
      /^https:\/\/frockbot\.test\/setup\/ai#reader=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );

    const signedOut = gatewayFor({}).gateway;
    expect(
      (
        await signedOut(
          new Request("https://frockbot.test/api/setup/frame", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("refuses a page it does not draw", async () => {
    const { gateway } = gatewayFor({ signedIn: true });
    const response = await gateway(
      new Request("https://frockbot.test/api/setup/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: "bots" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("reads the account it names, on the account routes only", async () => {
    const { gateway, setupReader } = gatewayFor({
      userConfigurationFor: settingsOwner({
        schemaVersion: 1,
        revision: 3,
        profile: { name: "Member" },
        packages: [],
        connections: [],
      }),
    });
    const { token } = await setupReader.mint({
      userId: "member",
      development: false,
    });
    const headers = { authorization: `Bearer frockbot-setup.${token}` };
    const settings = await gateway(
      new Request("https://frockbot.test/api/settings?view=2", { headers }),
    );
    expect(settings.status).toBe(200);
    for (const path of [
      "/api/bots/bot-1/settings",
      "/api/secrets",
      "/api/account/delete",
    ]) {
      const refused = await gateway(
        new Request(`https://frockbot.test${path}`, { headers }),
      );
      expect(refused.status).toBe(403);
    }
    const mint = await gateway(
      new Request("https://frockbot.test/api/setup/frame", {
        method: "POST",
        headers,
      }),
    );
    expect(mint.status).toBe(403);
  });

  test("expires, and says so in a way the page can ask for another", async () => {
    let now = 1_000;
    const { gateway, setupReader } = gatewayFor({ now: () => now });
    const { token } = await setupReader.mint({
      userId: "member",
      development: false,
    });
    now += SETUP_READER_LIFETIME_MS_V1 + 1;
    const response = await gateway(
      new Request("https://frockbot.test/api/identity", {
        headers: { authorization: `Bearer frockbot-setup.${token}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "setup-reader-expired",
    });
  });

  test("a forged or foreign credential names nobody", async () => {
    const { setupReader } = gatewayFor({});
    const other = createSetupReader({
      secret: "another-secret",
      admit: unreached("admit"),
    });
    const { token } = await other.mint({
      userId: "member",
      development: false,
    });
    expect(await setupReader.verify(token)).toBeUndefined();
    const [payload] = token.split(".");
    expect(await setupReader.verify(`${payload}.AAAA`)).toBeUndefined();
    expect(await setupReader.verify("nonsense")).toBeUndefined();
  });

  test("a paused account is refused as a cookie is", async () => {
    const { gateway, setupReader } = gatewayFor({ admitted: false });
    const { token } = await setupReader.mint({
      userId: "member",
      development: false,
    });
    const response = await gateway(
      new Request("https://frockbot.test/api/identity", {
        headers: { authorization: `Bearer frockbot-setup.${token}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  test("one minted for a development identity is honoured only where those are", async () => {
    for (const development of [true, false]) {
      const { gateway, setupReader } = gatewayFor({
        admitted: false,
        development,
      });
      const { token } = await setupReader.mint({
        userId: "local-person",
        development: true,
      });
      const response = await gateway(
        new Request("https://frockbot.test/api/identity", {
          headers: { authorization: `Bearer frockbot-setup.${token}` },
        }),
      );
      expect(response.status).toBe(development ? 200 : 403);
    }
  });

  test("opens the account's settings, Connections and billing", () => {
    for (const path of [
      "/api/identity",
      "/api/settings",
      "/api/settings/connections",
      "/api/connections",
      "/api/connection-commands",
      "/api/billing",
      "/api/billing/spending",
      "/api/web-search",
      "/api/machines",
      "/api/billing/provider/checkout",
      "/api/plugins/connect/connections",
      "/api/plugins/mcp/connections/conn-1/authorize",
      "/api/plugins/mcp/connections/conn-1/revoke",
    ])
      expect(setupReaderPathV1(path)).toBe(true);
    for (const path of [
      "/api/setup/frame",
      "/api/secrets",
      "/api/bots/bot-1/settings",
      "/api/billing/reconcile",
      "/api/plugins/other/connections",
      "/api/settings/application",
      "/api/machines/pair",
      "/api/machines/mac-1/revoke",
    ])
      expect(setupReaderPathV1(path)).toBe(false);
  });
});
