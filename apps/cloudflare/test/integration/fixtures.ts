// Shared setup for the `SELF.fetch` integration suite.
//
// Everything here exists to make a request look exactly like a browser's:
// the real artifact in the real bucket, the real dev-auth header the gateway
// reads, and the product's own provisioning path. Nothing here reaches past
// the gateway on a test's behalf.
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect } from "vitest";
import {
  OLLAMA_BAD_API_KEY,
  OLLAMA_GOOD_API_KEY,
} from "../harness/miniflare.ts";

export { OLLAMA_BAD_API_KEY, OLLAMA_GOOD_API_KEY };
export { OLLAMA_REVOKED_API_KEY } from "../harness/miniflare.ts";
/**
 * The prompt that makes the stubbed model call exact tools — one entry per
 * call it should make in one response. The stub owns the wire shape; a test
 * only has to name the tools and their input.
 */
export { toolCallTriggerPrompt } from "../harness/miniflare.ts";

/** Matches `DEFAULT_APPLICATION_HASH` in the integration config. */
export const APPLICATION_HASH = "foundation-v1";

/** Any origin works; this one matches the deployed route. */
export const ORIGIN = "https://bot.frockbot.com";

export const PROVISIONED_MODEL = {
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  providerModelId: "glm-5.3-flash:cloud",
} as const;

let seeded: Promise<void> | undefined;

/**
 * Seed the artifact once per Worker. The bytes arrive as a binding the config
 * read off disk with `node:fs`, not as a Vite `?raw` import: a `?raw` import of
 * a relative path is invisible to `tsc` (TypeScript resolves relative
 * specifiers on disk and never against an ambient wildcard module), so it would
 * cost the repository a type error or a suppression. Reading in the config also
 * fails the run outright when `artifact:build` has not run, which is what
 * `test:integration` exists to guarantee. The gateway reads
 * `applications/<hash>.mjs` out of `APPLICATION_ARTIFACTS` and hands the bytes
 * to the Worker Loader, so this is the only fixture the loader path needs.
 */
function seedApplicationArtifact(): Promise<void> {
  seeded ??= (async () => {
    await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
    await env.APPLICATION_ARTIFACTS.put(
      `applications/${APPLICATION_HASH}.mjs`,
      env.FOUNDATION_ARTIFACT,
      { httpMetadata: { contentType: "application/javascript" } },
    );
  })();
  return seeded;
}

export function useApplicationArtifact(): void {
  beforeAll(seedApplicationArtifact);
}

/**
 * A user id no other test shares, so no two tests meet in one User Durable
 * Object and nothing has to be torn down between them.
 */
export function freshUserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * A request as the gateway's development identity sees it — the same
 * `x-frockbot-user-id` header `wrangler dev --var ALLOW_DEVELOPMENT_AUTH:true`
 * honours, and the same one the Electron shell uses.
 */
export function asUser(
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-frockbot-user-id", userId);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

export function postAsUser(
  userId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return asUser(userId, path, { method: "POST", body: JSON.stringify(body) });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `expected JSON from ${response.status}, got: ${text.slice(0, 200)}`,
      { cause: error },
    );
  }
}

export async function expectJson(response: Response): Promise<unknown> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return readJson(response);
}

export async function expectOkJson(response: Response): Promise<unknown> {
  const value = await readJson(response);
  expect({ status: response.status, value }).toMatchObject({ status: 200 });
  return value;
}

/**
 * Provision a User and a Bot through the product's own HTTP surface: install
 * the provider Package, create the Connection, choose the model new Bots start
 * on, then create the Bot. Every step is a request the client makes, so this
 * fixture proves the routes it uses as a side effect of using them.
 */
export async function provisionThroughGateway(options: {
  userId: string;
  botId: string;
  apiKey?: string;
}): Promise<{ connectionId: string }> {
  const { userId, botId } = options;
  const apiKey = options.apiKey ?? OLLAMA_GOOD_API_KEY;

  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-${botId}`,
      expectedRevision: 0,
      packageId: PROVISIONED_MODEL.packageId,
      version: "0.0.1",
    }),
  );

  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `connect-${botId}`,
      packageId: PROVISIONED_MODEL.packageId,
      connectionTypeId: PROVISIONED_MODEL.connectionTypeId,
      label: "Integration",
      apiKey,
    }),
  )) as { status: string; connectionId: string };

  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/set-new-bot-model",
      commandId: `model-${botId}`,
      expectedRevision: settings.revision,
      model: {
        connectionId: receipt.connectionId,
        providerModelId: PROVISIONED_MODEL.providerModelId,
      },
    }),
  );

  // The Flock's own route, and its own revision — a new User's is zero.
  const created = await postAsUser(userId, "/api/bots", {
    schemaVersion: 1,
    type: "bot/create",
    commandId: `create-${botId}`,
    expectedRevision: 0,
    botId,
    name: "Integration Bot",
  });
  expect({
    status: created.status,
    value: await readJson(created),
  }).toMatchObject({ status: 201 });

  return { connectionId: receipt.connectionId };
}
