// A provider Plugin must not dispatch again after its Bot was evicted with
// only durable model intent left behind. Billing is disabled here, so its
// reservation ledger cannot accidentally provide the protection under test.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  DEEPSEEK_CUT_TRIGGER,
  DEEPSEEK_TEST_API_KEY,
  WEB_STUB_ORIGIN,
} from "./harness/miniflare.ts";
import { flockRevision } from "./provision-bot.ts";
import {
  hydrateStoredRunEventsV1,
  hydratedStoredRunsV1,
  rewindStoredRunEventsV1,
} from "./session-log-probe.ts";

interface Identity {
  userId: string;
  botId: string;
}

interface UserRpc {
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<{ status: string }>;
  executeConnection(
    input: unknown,
  ): Promise<{ status: string; connectionId: string }>;
  createBot(input: unknown): Promise<unknown>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  previousEventCount: number;
  status: string;
  phase: string;
  events: SessionEvent[];
  failure?: string;
  responseText?: string;
}

function bot(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

async function provision(identity: Identity): Promise<void> {
  // SAFETY: avoid expanding the generated recursive RPC stub type; these are
  // the ordinary account commands this test exercises.
  const user = env.USER_CONFIGURATIONS.getByName(
    identity.userId,
  ) as unknown as UserRpc;
  const revision = async () =>
    (
      await user.readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      })
    ).revision;
  for (const command of [
    {
      type: "user/set-package-enabled",
      packageId: "custom-models",
      enabled: true,
    },
    {
      type: "user/install-package",
      packageId: "provider-deepseek",
      version: "0.0.1",
    },
  ]) {
    const receipt = await user.executeConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        commandId: `${command.packageId}-${identity.botId}`,
        expectedRevision: await revision(),
        ...command,
      },
    });
    expect(receipt.status).toBe("applied");
  }
  const connection = await user.executeConnection({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `connect-${identity.botId}`,
      packageId: "provider-deepseek",
      connectionTypeId: "deepseek-account",
      label: "Recovery test",
      apiKey: DEEPSEEK_TEST_API_KEY,
    },
  });
  expect(connection.status).toBe("applied");
  const selected = await user.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "user/set-account-model",
      commandId: `model-${identity.botId}`,
      expectedRevision: await revision(),
      model: {
        connectionId: connection.connectionId,
        providerModelId: "deepseek-v4-pro",
      },
    },
  });
  expect(selected.status).toBe("applied");
  await user.createBot({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${identity.botId}`,
      expectedRevision: await flockRevision(identity.userId),
      botId: identity.botId,
      name: "Recovery test Bot",
    },
  });
}

async function turn(identity: Identity, runId: string, text: string) {
  // SAFETY: the generated Bot stub has the same recursive type limitation.
  const rpc = bot(identity) as unknown as {
    run(input: unknown): Promise<unknown>;
  };
  await rpc.run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
  return storedRun(identity, runId);
}

async function storedRun(identity: Identity, runId: string) {
  const runs = await runInDurableObject(bot(identity), (_instance, state) =>
    hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  expect(run).toBeDefined();
  return run!;
}

async function callCount(): Promise<number> {
  const response = await fetch(`${WEB_STUB_ORIGIN}/deepseek-calls`);
  const body = (await response.json()) as { calls: unknown[] };
  return body.calls.length;
}

async function fireRecoveryAlarm(identity: Identity): Promise<void> {
  await runInDurableObject(bot(identity), (_instance, state) =>
    state.storage.setAlarm(Date.now() + 60_000),
  );
  // A future alarm prevents the runtime racing this awaited manual delivery.
  expect(await runDurableObjectAlarm(bot(identity))).toBe(true);
}

test("eviction after upstream acceptance cannot dispatch the durable model request again without billing", async () => {
  // Without this binding BotState does not construct its Billing wrapper.
  expect("STRIPE_SECRET_KEY" in env).toBe(false);
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `provider-recovery-${suffix}`,
    botId: `provider-recovery-bot-${suffix}`,
  };
  await provision(identity);
  await fetch(`${WEB_STUB_ORIGIN}/forget-deepseek-calls`);
  const runId = `lost-${suffix}`;
  const first = await turn(
    identity,
    runId,
    `${DEEPSEEK_CUT_TRIGGER} please reply`,
  );
  expect(await callCount()).toBe(1);
  const firstIntent = first.events.find(
    (event) => event.type === "model/request",
  );
  if (firstIntent?.type !== "model/request") {
    throw new Error("the first upstream call has no durable model intent");
  }
  const requestId = firstIntent.request.requestId;

  // The upstream accepted a real request through the Plugin. Rewind only the
  // Bot's journal to the crash boundary immediately after that acceptance,
  // before any response/usage was persisted. The remote call count survives;
  // the admission, pinned composition and Connection snapshot remain intact.
  // Eviction then discards every in-memory transport ticket and runtime.
  await runInDurableObject(bot(identity), async (_instance, state) => {
    const key = `run:${runId}`;
    const raw = await state.storage.get<StoredRunProbe>(key);
    if (!raw) throw new Error("the accepted run is missing");
    const hydrated = await hydrateStoredRunEventsV1(state.storage, raw);
    const index = hydrated.events.findIndex(
      (event) =>
        event.type === "model/request" && event.request.requestId === requestId,
    );
    if (index < 0) throw new Error("the durable request is missing");
    await rewindStoredRunEventsV1(
      state.storage,
      key,
      raw,
      hydrated.events.slice(0, index + 1),
      { status: "running", phase: "executing" },
    );
    await state.storage.put("active-run", runId);
  });
  const pending = await storedRun(identity, runId);
  expect(pending.events.at(-1)?.type).toBe("model/request");
  expect(pending.events.some((event) => event.type === "model/usage")).toBe(
    false,
  );
  await evictDurableObject(bot(identity));
  await fireRecoveryAlarm(identity);

  const recovered = await storedRun(identity, runId);
  const attempts = recovered.events.filter(
    (event) =>
      event.type === "model/request" && event.request.requestId === requestId,
  );
  // This proves recovery entered the pending model attempt; a generic mount
  // failure or an abandoned run cannot satisfy the no-second-fetch claim.
  expect(attempts).toHaveLength(2);
  expect(recovered.status).toBe("failed");
  expect(recovered.failure).toContain("not sent twice");
  const usage = recovered.events.filter(
    (event) => event.type === "model/usage" && event.requestId === requestId,
  );
  // Refusing a second dispatch cannot erase the possible cost of the first
  // accepted call, whose outcome was lost before accounting became durable.
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    type: "model/usage",
    requestId,
    estimated: true,
  });
  if (usage[0]?.type !== "model/usage") {
    throw new Error("the lost model outcome has no durable usage estimate");
  }
  expect(usage[0].inputTokens).toBeGreaterThan(0);
  expect(recovered.events.some((event) => event.type === "tool/call")).toBe(
    false,
  );
  expect(await callCount()).toBe(1);
  expect(
    await runInDurableObject(bot(identity), (_instance, state) =>
      state.storage.get("active-run"),
    ),
  ).toBeUndefined();

  await evictDurableObject(bot(identity));
  await fireRecoveryAlarm(identity);
  expect(await callCount()).toBe(1);

  const next = await turn(identity, `next-${suffix}`, "hello again");
  expect(next.status).toBe("completed");
  expect(next.failure).toBeUndefined();
  expect(next.responseText).toContain("DeepSeek says hello");
  const nextIntent = next.events.find(
    (event) => event.type === "model/request",
  );
  if (nextIntent?.type !== "model/request") {
    throw new Error("the next Turn has no model request");
  }
  expect(nextIntent.request.requestId).not.toBe(requestId);
  expect(await callCount()).toBe(2);
});

test("a replay the mount can no longer serve keeps the lost call's possible cost", async () => {
  // The same lost outcome as the test above, with the account's model switched
  // while the Bot was evicted: the request recovery re-dispatches names a
  // binding this mount no longer serves, so the Plugin is never called and
  // nothing is fetched. The earlier call may still have been accepted and
  // billed, so the effect settles with exactly one estimate — an early refusal
  // is not allowed to report it as a call that never happened.
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `provider-early-replay-${suffix}`,
    botId: `provider-early-replay-bot-${suffix}`,
  };
  await provision(identity);
  await fetch(`${WEB_STUB_ORIGIN}/forget-deepseek-calls`);
  const runId = `early-${suffix}`;
  const first = await turn(identity, runId, "please reply");
  expect(await callCount()).toBe(1);
  const firstIntent = first.events.find(
    (event) => event.type === "model/request",
  );
  if (firstIntent?.type !== "model/request") {
    throw new Error("the first upstream call has no durable model intent");
  }
  const requestId = firstIntent.request.requestId;

  await runInDurableObject(bot(identity), async (_instance, state) => {
    const key = `run:${runId}`;
    const raw = await state.storage.get<StoredRunProbe>(key);
    if (!raw) throw new Error("the accepted run is missing");
    const hydrated = await hydrateStoredRunEventsV1(state.storage, raw);
    const index = hydrated.events.findIndex(
      (event) =>
        event.type === "model/request" && event.request.requestId === requestId,
    );
    if (index < 0) throw new Error("the durable request is missing");
    await rewindStoredRunEventsV1(
      state.storage,
      key,
      raw,
      hydrated.events.slice(0, index + 1),
      { status: "running", phase: "executing" },
    );
    await state.storage.put("active-run", runId);
  });

  // The credential is rotated between the interruption and the recovery, so
  // the mount that serves the resumed run is bound to a Connection generation
  // the journaled request does not name.
  interface RotatingUserRpc {
    readConfiguration(input: unknown): Promise<{
      revision: number;
      connections: Array<{ connectionId: string; packageId: string }>;
    }>;
    executeConnection(
      input: unknown,
    ): Promise<{ status: string; connectionId: string }>;
  }
  const configuration = env.USER_CONFIGURATIONS.getByName(
    identity.userId,
  ) as unknown as RotatingUserRpc;
  const current = await configuration.readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  const deepseek = current.connections.find(
    (connection) => connection.packageId === "provider-deepseek",
  );
  if (!deepseek) throw new Error("the DeepSeek connection is missing");
  const rotated = await configuration.executeConnection({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "connection/rotate-api-key",
      commandId: `rotate-${suffix}`,
      connectionId: deepseek.connectionId,
      apiKey: DEEPSEEK_TEST_API_KEY,
    },
  });
  expect(rotated.status).toBe("applied");
  await evictDurableObject(bot(identity));
  await fireRecoveryAlarm(identity);

  const recovered = await storedRun(identity, runId);
  expect(recovered.status).toBe("failed");
  const usage = recovered.events.filter(
    (event) => event.type === "model/usage" && event.requestId === requestId,
  );
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    type: "model/usage",
    requestId,
    estimated: true,
  });
  if (usage[0]?.type !== "model/usage") {
    throw new Error("the lost model outcome has no durable usage estimate");
  }
  expect(usage[0].inputTokens).toBeGreaterThan(0);
  // Nothing was fetched for the replay: the refusal came before any dispatch.
  expect(await callCount()).toBe(1);
});
