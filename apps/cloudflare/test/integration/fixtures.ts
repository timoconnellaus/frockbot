// Shared setup for the `SELF.fetch` integration suite.
//
// Everything here exists to make a request look exactly like a browser's:
// the real artifact in the real bucket, the real dev-auth header the gateway
// reads, and the product's own provisioning path. Nothing here reaches past
// the gateway on a test's behalf.
import {
  applyD1Migrations,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { beforeAll, expect, vi } from "vitest";
import {
  OLLAMA_BAD_API_KEY,
  OLLAMA_GOOD_API_KEY,
} from "../harness/miniflare.ts";
import { hydrateStoredRunEventsV1 } from "../session-log-probe.ts";

export {
  hydrateStoredRunEventsV1,
  hydratedStoredRunsV1,
  rewindStoredRunEventsV1,
} from "../session-log-probe.ts";

export { OLLAMA_BAD_API_KEY, OLLAMA_GOOD_API_KEY };
export {
  OLLAMA_FLAKY_API_KEY,
  OLLAMA_REVOKED_API_KEY,
} from "../harness/miniflare.ts";
/**
 * The prompt that makes the stubbed model call exact tools — one entry per
 * call it should make in one response. The stub owns the wire shape; a test
 * only has to name the tools and their input.
 */
export {
  repeatedToolCallPrompt,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";

/**
 * The `dueAt` a one-minute cron Routine holds when its occurrence has arrived,
 * seeded so the firing it triggers is the only one the test can see.
 *
 * Two things matter and both are about the scheduler's recompute. It advances
 * the clock to the next occurrence strictly after `dueAt` — so a fabricated
 * `dueAt` a second before "now" puts the next occurrence anywhere in the
 * following minute, and when the test happens to run in the last second of a
 * wall-clock minute that occurrence is already due. The object then re-arms its
 * alarm on a moment in the present, fires the Routine a second time, and a test
 * asserting one firing sees two.
 *
 * So this waits until there is a whole minute of headroom, and seeds a real
 * minute boundary rather than an off-grid instant. The recompute then lands a
 * full period away, which is what a one-minute cron actually does, and the
 * assertion is about the product rather than about the clock the suite
 * happened to start on.
 */
export async function dueAtWithFiringHeadroomV1(
  headroomMs = 15_000,
): Promise<number> {
  for (;;) {
    const now = Date.now();
    const boundary = Math.floor(now / 60_000) * 60_000;
    if (boundary + 60_000 - now > headroomMs) return boundary;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The Bot Durable Object stub one User's Bot is held in. */
export function botStateStubV1(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

type ExactStoredRunV1<Run> = Omit<Run, "events"> & { events: SessionEvent[] };

/** Exact run journal for an integration assertion, hydrated from its range. */
export async function readStoredRunWithEventsV1<Run extends object>(
  userId: string,
  botId: string,
  runId: string,
): Promise<ExactStoredRunV1<Run> | undefined> {
  return runInDurableObject(
    botStateStubV1(userId, botId),
    async (_instance, state) => {
      const stored = await state.storage.get<
        Run & {
          sessionId: string;
          events?: unknown[];
          eventRange?: { startSeq: number; endSeq: number };
        }
      >(`run:${runId}`);
      if (!stored) return undefined;
      return (await hydrateStoredRunEventsV1(
        state.storage,
        stored,
      )) as ExactStoredRunV1<Run>;
    },
  );
}

/** Exact journals for integration assertions that inspect the raw run index. */
export async function listStoredRunsWithEventsV1<Run extends object>(
  userId: string,
  botId: string,
): Promise<Array<ExactStoredRunV1<Run>>> {
  return runInDurableObject(
    botStateStubV1(userId, botId),
    async (_instance, state) => {
      const stored = await state.storage.list<
        Run & {
          sessionId: string;
          events?: unknown[];
          eventRange?: { startSeq: number; endSeq: number };
        }
      >({ prefix: "run:" });
      return Promise.all(
        [...stored.values()].map(
          async (run) =>
            (await hydrateStoredRunEventsV1(
              state.storage,
              run,
            )) as ExactStoredRunV1<Run>,
        ),
      );
    },
  );
}

/** The shape every caller needs of a durable run to recognise a firing. */
interface RoutineFiringProbeV1 {
  runId: string;
  status: string;
  admission?: { origin?: { routineId?: string } };
}

/**
 * Wait for a Routine's firing to settle, and answer with its durable run.
 *
 * `runDurableObjectAlarm` resolves when the alarm handler it drove returns, and
 * that is not the same moment the firing settles. The alarm defers whenever a
 * Turn is already executing in the object, so a second alarm delivery racing
 * the driven one returns straight away while the first is still running the
 * Turn — and the run record is written at admission, carrying its Session and
 * its origin, long before `status` becomes `completed`. Reading the runs the
 * instant the alarm returns can therefore catch the firing mid-flight.
 *
 * So this polls to a bounded deadline for the whole firing, not just the run:
 * the run is terminal *and* the scheduler's unsettled-firing lock is gone,
 * which is the write that also rewrites the run-log entry and moves the
 * Routine's `lastRunAt`. Everything a test asserts after this call is settled.
 *
 * Driving the alarm on each pass is deliberate and idempotent: a settled
 * occurrence has already moved past its `dueAt`, and an alarm arriving while a
 * firing is in flight only defers — so the poll doubles as the drain for a
 * firing that was minted but has not been run yet.
 *
 * The drive is a nudge and its answer means nothing: `false` only says this
 * call found no alarm pending, which is what a slow runner produces when the
 * object's own scheduled delivery arrived first and already ran the firing. No
 * test should assert on it. Durable state is the single source of truth for
 * whether a Routine fired, and this is the only thing that reads it.
 */
export async function settledRoutineFiringV1<
  Run extends RoutineFiringProbeV1 = RoutineFiringProbeV1,
>(
  userId: string,
  botId: string,
  routineId = "brief",
  timeout = 5_000,
): Promise<Run> {
  const stub = botStateStubV1(userId, botId);
  let settled: Run | undefined;
  await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(stub);
      const probe = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          runs: await Promise.all(
            [
              ...(
                await state.storage.list<
                  Run & {
                    sessionId: string;
                    events?: unknown[];
                    eventRange?: { startSeq: number; endSeq: number };
                  }
                >({ prefix: "run:" })
              ).values(),
            ].map((run) => hydrateStoredRunEventsV1(state.storage, run)),
          ),
          unsettled:
            (await state.storage.get<unknown>(`routine-fire:${routineId}`)) !==
            undefined,
        }),
      );
      const fired = probe.runs.filter(
        (run) => run.admission?.origin?.routineId === routineId,
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("completed");
      expect(probe.unsettled).toBe(false);
      settled = fired[0] as Run;
    },
    { timeout, interval: 50 },
  );
  return settled!;
}

/** Matches `DEFAULT_APPLICATION_HASH` in the integration config. */
export const APPLICATION_HASH = "foundation-v1";

/** Any origin works; this one matches the deployed route. */
export const ORIGIN = "https://bot.frockbot.com";
const STRIPE_WEBHOOK_SECRET =
  "whsec_workerd-stripe-webhook-secret-0123456789abcdef";

export const PROVISIONED_MODEL = {
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  providerModelId: "glm-5.3-flash:cloud",
} as const;

export const CUSTOM_MODELS_PACKAGE_ID = "custom-models";

/** Deliver the paid-Checkout event through the same signed public route Stripe uses. */
export async function creditWithFakeCheckout(
  userId: string,
  amountCents: number,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const suffix = crypto.randomUUID();
  const body = JSON.stringify({
    id: `evt_${suffix}`,
    type: "checkout.session.completed",
    created: timestamp,
    data: {
      object: {
        id: `cs_${suffix}`,
        mode: "payment",
        payment_status: "paid",
        payment_intent: `pi_${suffix}`,
        amount_total: amountCents,
        customer: `cus_${suffix.replaceAll("-", "")}`,
        metadata: {
          frockbot_user_id: userId,
          frockbot_kind: "credit",
        },
      },
    },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${String(timestamp)}.${body}`),
    ),
  );
  const signature = Array.from(signed, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await SELF.fetch(`${ORIGIN}/api/billing/stripe/webhook`, {
    method: "POST",
    headers: { "stripe-signature": `t=${String(timestamp)},v1=${signature}` },
    body,
  });
  expect(response.status).toBe(200);
}

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
 * Custom models and the provider Package, create the Connection, choose the
 * account model, then create the Bot. Every step is a request the client makes, so this
 * fixture proves the routes it uses as a side effect of using them.
 */
/**
 * Switch Custom models on for a User and return the revision that follows.
 * The Package is seeded disabled on a User's first read, so the product path
 * is enablement at whatever revision the seed left, never a fresh install at
 * zero.
 */
export async function enableCustomModels(
  userId: string,
  commandId: string,
): Promise<number> {
  const seeded = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: `enable-${commandId}`,
      expectedRevision: seeded.revision,
      packageId: CUSTOM_MODELS_PACKAGE_ID,
      enabled: true,
    }),
  );
  return seeded.revision + 1;
}

export async function provisionThroughGateway(options: {
  userId: string;
  botId: string;
  apiKey?: string;
  /** Most integration scenarios start funded; billing tests may opt out. */
  funded?: boolean;
}): Promise<{ connectionId: string }> {
  const { userId, botId } = options;
  const apiKey = options.apiKey ?? OLLAMA_GOOD_API_KEY;

  const enabled = await enableCustomModels(userId, `custom-models-${botId}`);
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-${botId}`,
      expectedRevision: enabled,
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
      type: "user/set-package-settings",
      commandId: `model-${botId}`,
      expectedRevision: settings.revision,
      packageId: CUSTOM_MODELS_PACKAGE_ID,
      values: {
        "account-model": {
          connectionId: receipt.connectionId,
          providerModelId: PROVISIONED_MODEL.providerModelId,
        },
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

  if (options.funded !== false) {
    await creditWithFakeCheckout(userId, 100_000);
  }

  return { connectionId: receipt.connectionId };
}
