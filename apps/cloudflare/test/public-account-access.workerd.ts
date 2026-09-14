import {
  applyD1Migrations,
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import {
  ADMISSION_REFUSAL_COPY_V1,
  type AccountAccessStateV1,
} from "@frockbot/app/admin/shared";
import type { MachinePairingOfferV1 } from "@frockbot/core/machine-protocol";
import worker from "../src/index.ts";
import { ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE } from "../src/account-admission.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../src/deployment-policy.ts";
import { seedNativeIdentity } from "./native-session-fixture.ts";
import { provisionBot } from "./provision-bot.ts";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

beforeAll(async () => {
  await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
});

async function setAccess(userId: string, state: AccountAccessStateV1) {
  const authority = env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  );
  const current = await authority.readAccountAccess({
    schemaVersion: 1,
    userId,
  });
  expect(
    await authority.setAccountAccess({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "account/set-access",
        state,
        revision: current.access?.revision ?? 0,
      },
      updatedBy: "public-access-test",
    }),
  ).toMatchObject({ status: "applied" });
}

async function fixture() {
  const userId = `public-${crypto.randomUUID()}`;
  const botId = "hook-bot";
  await seedNativeIdentity(userId);
  await setAccess(userId, "active");
  await provisionBot({ userId, botId });
  const bot = env.BOT_STATES.getByName(`${userId}:${botId}`);
  const rpc = bot as unknown as {
    executeRoutineCommand(input: unknown): Promise<{ hook: { token: string } }>;
  };
  const receipt = await rpc.executeRoutineCommand({
    schemaVersion: 1,
    userId,
    botId,
    command: {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "create-hook",
      botId,
      routineId: "brief",
      name: "Brief",
      prompt: "Summarize the payload.",
      trigger: { kind: "webhook" },
    },
  });
  const machine = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    createMachinePairing(input: unknown): Promise<MachinePairingOfferV1>;
  };
  const offer = await machine.createMachinePairing({
    schemaVersion: 1,
    userId,
  });
  const hook = (token = receipt.hook.token) =>
    new Request(
      `https://bot.frockbot.com/api/bots/${botId}/routines/brief/hook`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      },
    );
  const enroll = (code = offer.code) =>
    new Request("https://bot.frockbot.com/api/machines/enroll", {
      method: "POST",
      headers: {
        authorization: `Bearer ${code}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        code,
        label: "Test machine",
        platform: "macos",
        agentVersion: "0.0.1",
        capabilities: ["exec", "files"],
      }),
    });
  const firings = () =>
    runInDurableObject(bot, async (_instance, state) =>
      [
        ...(
          await state.storage.list<{ fireId: string }>({
            prefix: "routine-delivery:",
          })
        ).values(),
      ]
        .map((receipt) => receipt.fireId)
        .sort(),
    );
  return { userId, hook, enroll, firings };
}

function gateway(
  options: { development?: string; admin?: string; outage?: boolean } = {},
) {
  const accessed: string[] = [];
  let authorityReads = 0;
  const bindings = new Proxy(env as unknown as WorkerEnv, {
    get(target, property, receiver) {
      if (property === "ALLOW_DEVELOPMENT_AUTH") return options.development;
      if (property === "FROCKBOT_ADMIN_EMAILS") return options.admin;
      if (property === "DEPLOYMENT_POLICY") {
        authorityReads++;
        if (options.outage) throw new Error("Authority unavailable");
      }
      if (property === "BOT_STATES" || property === "USER_CONFIGURATIONS") {
        accessed.push(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    accessed,
    authorityReads: () => authorityReads,
    async fetch(request: Request) {
      const context = createExecutionContext();
      const response = await worker.fetch(request, bindings, context);
      await waitOnExecutionContext(context);
      return response;
    },
  };
}

for (const state of ["paused", "ended", "blocked"] as const) {
  test(`${state} accounts cannot use existing webhook or pairing keys`, async () => {
    const setup = await fixture();
    const app = gateway();
    expect((await app.fetch(setup.hook())).status).toBe(202);
    const admittedFirings = await setup.firings();
    expect(admittedFirings.length).toBeGreaterThan(0);
    await setAccess(setup.userId, state);
    app.accessed.length = 0;
    for (const request of [setup.hook(), setup.enroll()]) {
      const response = await app.fetch(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: ADMISSION_REFUSAL_COPY_V1[`account-${state}`].title,
      });
    }
    expect(app.accessed).toEqual([]);
    expect(await setup.firings()).toEqual(admittedFirings);
    await setAccess(setup.userId, "active");
    expect((await app.fetch(setup.hook())).status).toBe(202);
    expect((await app.fetch(setup.enroll())).status).toBe(200);
  });
}

test("authority failure refuses new public work before User or Bot access", async () => {
  const setup = await fixture();
  const app = gateway({ outage: true });
  for (const request of [setup.hook(), setup.enroll()]) {
    const response = await app.fetch(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE,
    });
  }
  expect(app.accessed).toEqual([]);
  expect(await setup.firings()).toEqual([]);
});

test("forged public credentials never query account authority", async () => {
  const setup = await fixture();
  const app = gateway({ outage: true });
  for (const request of [setup.hook("forged"), setup.enroll("forged")]) {
    expect((await app.fetch(request)).status).toBe(401);
  }
  expect(app.authorityReads()).toBe(0);
  expect(app.accessed).toEqual([]);
});

test("an administrator remains admitted while blocked and authority is unavailable", async () => {
  const setup = await fixture();
  await setAccess(setup.userId, "blocked");
  const app = gateway({ admin: `${setup.userId}@native.test`, outage: true });
  expect((await app.fetch(setup.hook())).status).toBe(202);
  expect((await app.fetch(setup.enroll())).status).toBe(200);
  expect(app.authorityReads()).toBe(0);
});

test("development keys work without stored identities only with development auth enabled", async () => {
  const setup = await fixture();
  await env.AUTH_DB.prepare('delete from "user" where "id" = ?')
    .bind(setup.userId)
    .run();
  for (const development of [undefined, "false"]) {
    const app = gateway({ development });
    expect((await app.fetch(setup.hook())).status).toBe(401);
    expect((await app.fetch(setup.enroll())).status).toBe(401);
    expect(app.accessed).toEqual([]);
  }
  const app = gateway({ development: "true", outage: true });
  expect((await app.fetch(setup.hook())).status).toBe(202);
  expect((await app.fetch(setup.enroll())).status).toBe(200);
  expect(app.authorityReads()).toBe(0);
});
