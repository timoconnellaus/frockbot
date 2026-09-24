// A secret a person types on a Bot's secret-request card, against real
// Durable Objects.
//
// The claim is about bytes: the value is sealed in the User's credential
// store and appears nowhere else. So after a Bot asks, a person saves, and
// the delivery Turn that save opens has run — model request, tool results
// and all — this reads every key-value record and every SQL row both objects
// hold and looks for the value in them. It is found in none, and the sealed
// generation opens back to it only through the deployment keyring.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import { SECRETS_PACKAGE_ID_V1 } from "@frockbot/app/secrets/shared";
import { decodeCredentialLeaseV1 } from "@frockbot/core/connection";
import { provisionBot } from "./provision-bot.ts";
import {
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "./computer-host-fake.ts";

/** What the person types. Distinctive, so a match anywhere is this value. */
const VALUE = "hunter2-correct-horse-9f3a1c7e";

const COMPUTER_HOST = "http://computer-host.internal";

/** Teaches the shared fake Computer host how to answer one exec. */
async function script(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${COMPUTER_HOST}/__fake/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

/** Every call the fake Computer host answered. */
async function computerCalls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${COMPUTER_HOST}/__fake/calls`),
  );
  return ((await response.json()) as { calls: FakeComputerHostCall[] }).calls;
}

interface SecretBotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  listCards(input: unknown): Promise<{
    cards: Array<{
      surfaceId: string;
      components: Array<Record<string, unknown>>;
    }>;
  }>;
  submitSecret(input: unknown): Promise<{
    status: string;
    card?: { components: Array<Record<string, unknown>> };
  }>;
}

interface SecretUserRpc {
  listSecrets(input: unknown): Promise<{
    secrets: Array<{
      secretId: string;
      label: string;
      payment: boolean;
      origin?: string;
    }>;
  }>;
  describeSecret(input: unknown): Promise<{ secret: unknown }>;
  leaseSecret(input: unknown): Promise<unknown>;
  settleSecret(input: unknown): Promise<void>;
  deleteSecret(input: unknown): Promise<{ removed: boolean }>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  admission?: { origin?: { kind: string } };
}

function bot(identity: { userId: string; botId: string }) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

function botRpc(identity: { userId: string; botId: string }): SecretBotRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the methods this file calls.
  return bot(identity) as unknown as SecretBotRpc;
}

function userRpc(userId: string): SecretUserRpc {
  // SAFETY: as above, for the User Durable Object's secret RPCs.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as SecretUserRpc;
}

/** Every key-value record and every SQL row an object holds, as text. */
async function everythingStored(
  stub: DurableObjectStub,
): Promise<{ kv: string; sql: string }> {
  return runInDurableObject(stub, async (_instance, state) => {
    const kv = JSON.stringify([...(await state.storage.list()).entries()]);
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    const rows: unknown[] = [];
    for (const { name } of tables) {
      try {
        rows.push(
          name,
          state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray(),
        );
      } catch {
        // A virtual table's shadow may refuse a plain read; its content is in
        // the table it shadows.
      }
    }
    return { kv, sql: JSON.stringify(rows) };
  });
}

async function storedRuns(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe[]> {
  return runInDurableObject(bot(identity), (_instance, state) =>
    hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
}

/** The Turn the save opened, once it has settled. */
async function deliveryTurn(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = (await storedRuns(identity)).find(
      (run) => run.admission?.origin?.kind === "input-delivery",
    );
    if (found && found.status !== "running") return found;
    await runInDurableObject(bot(identity), (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(bot(identity), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error("the save never opened a Turn");
}

async function identityFor(prefix: string) {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `${prefix}-${suffix}`,
    botId: `${prefix}-bot-${suffix}`,
  };
  await provisionBot(identity);
  return identity;
}

/** One chat Turn whose scripted call asks the person for a secret. */
async function askForSecret(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<{ requestId: string; surfaceId: string }> {
  await botRpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "send_to_user",
        {
          disposition: "finish",
          payload: {
            type: "secret-request",
            prompt: "Your shop password, so I can sign in and reorder.",
            secretName: "Shop login",
            origin: "https://shop.example/account/login",
            payment: false,
          },
        },
      ]),
    },
  });
  const { cards } = await botRpc(identity).listCards({
    schemaVersion: 1,
    ...identity,
  });
  for (const card of cards) {
    const field = card.components.find(
      (component) => component.component === "SecretField",
    );
    if (field) {
      return {
        requestId: field.requestId as string,
        surfaceId: card.surfaceId,
      };
    }
  }
  throw new Error("the secret request drew no field");
}

describe("a secret typed on a Bot's card", () => {
  test("is sealed in the User's store and in no other record either object keeps", async () => {
    const identity = await identityFor("secret");
    const { requestId } = await askForSecret(identity, "ask-secret");
    expect(requestId).toMatch(/^secret-request-[0-9a-f]{32}$/);

    const receipt = await botRpc(identity).submitSecret({
      schemaVersion: 1,
      ...identity,
      requestId,
      command: { schemaVersion: 1, commandId: "save-1", value: VALUE },
    });
    expect(receipt.status).toBe("saved");
    // The field settles on the card itself, and carries nothing typed.
    const field = receipt.card?.components.find(
      (component) => component.component === "SecretField",
    );
    expect(field).toMatchObject({ requestId, state: "saved" });
    expect(JSON.stringify(receipt)).not.toContain(VALUE);

    // The Bot is told, on a Turn of its own, and that Turn's model request
    // and every tool result are on the Bot's durable log.
    const delivered = await deliveryTurn(identity);
    expect(delivered.status).toBe("completed");

    const { secrets } = await userRpc(identity.userId).listSecrets({
      schemaVersion: 1,
      userId: identity.userId,
    });
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      label: "Shop login",
      payment: false,
      origin: "https://shop.example",
    });
    const secretId = secrets[0]!.secretId;

    // The Bot learned the reference, never the value.
    const botStored = await everythingStored(bot(identity));
    expect(botStored.kv).toContain(secretId);
    expect(botStored.kv).not.toContain(VALUE);
    expect(botStored.sql).not.toContain(VALUE);

    // The User object holds it sealed, and in nothing it can read back —
    // settings, audit rows, the transcript index.
    const userStored = await everythingStored(
      env.USER_CONFIGURATIONS.getByName(identity.userId),
    );
    expect(userStored.kv).toContain(secretId);
    expect(userStored.kv).not.toContain(VALUE);
    expect(userStored.sql).not.toContain(VALUE);
    expect(
      JSON.stringify(
        await userRpc(identity.userId).describeSecret({
          schemaVersion: 1,
          userId: identity.userId,
          secretId,
        }),
      ),
    ).not.toContain(VALUE);

    // And it is really there: a lease opens to it with the keyring alone.
    const lease = decodeCredentialLeaseV1(
      await userRpc(identity.userId).leaseSecret({
        schemaVersion: 1,
        userId: identity.userId,
        secretId,
        effectId: "secret-fill:workerd",
      }),
    );
    expect(JSON.stringify(lease)).not.toContain(VALUE);
    const opened = await new CredentialLeaseRuntime({
      readSecret: () => env.CREDENTIAL_KEYRING,
    }).open({
      accountId: identity.userId,
      connectionId: secretId,
      packageId: SECRETS_PACKAGE_ID_V1,
      lease,
    });
    expect(opened).toBe(VALUE);
    await userRpc(identity.userId).settleSecret({
      schemaVersion: 1,
      userId: identity.userId,
      secretId,
      effectId: "secret-fill:workerd",
    });

    // The Bot fills it into the page by reference. Its site is the one the
    // secret was saved for, so nothing is asked: the value is leased, handed
    // to the Computer for the one action, and the lease settled.
    const action = Buffer.from(
      JSON.stringify({
        action: "fill-secret",
        label: "Password",
        origin: "https://shop.example",
      }),
    ).toString("base64url");
    await script({
      match: action,
      stdout: JSON.stringify({
        filled: true,
        url: "https://shop.example/account/login",
        title: "Sign in",
        snapshot: "",
      }),
    });
    await botRpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: "fill-secret",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("computer_browser", {
          action: "fill",
          label: "Password",
          secret: secretId,
        }),
      },
    });
    const filled = (await storedRuns(identity)).find(
      (run) => run.runId === "fill-secret",
    );
    expect(filled?.status).toBe("completed");
    // The Computer is the one place the value goes, and it arrives in the
    // command's environment rather than its script.
    const exec = (await computerCalls()).find((call) =>
      call.script?.includes(action),
    );
    expect(exec?.env).toEqual({ FROCKBOT_FILL_SECRET: VALUE });
    expect(exec?.script).not.toContain(VALUE);

    // The Turn's tool call, its result, the model request after it, and the
    // audit row of the call are all durable now — and none carries it.
    const afterFill = await everythingStored(bot(identity));
    expect(afterFill.kv).toContain('Filled \\"Password\\"');
    expect(afterFill.kv).not.toContain(VALUE);
    expect(afterFill.sql).not.toContain(VALUE);
    const audited = await everythingStored(
      env.USER_CONFIGURATIONS.getByName(identity.userId),
    );
    expect(audited.sql).toContain(`fill Password ${secretId}`);
    expect(audited.sql).not.toContain(VALUE);
    expect(audited.kv).not.toContain(VALUE);
    // And the lease it took is settled.
    expect(audited.kv).not.toContain("secret-fill:computer-");
  });

  test("a second save of an answered request changes nothing, and delete removes it", async () => {
    const identity = await identityFor("secret-once");
    const { requestId } = await askForSecret(identity, "ask-once");
    const save = (commandId: string, value: string) =>
      botRpc(identity).submitSecret({
        schemaVersion: 1,
        ...identity,
        requestId,
        command: { schemaVersion: 1, commandId, value },
      });
    expect((await save("save-1", VALUE)).status).toBe("saved");
    expect((await save("save-2", `${VALUE}-again`)).status).toBe("replayed");

    const rpc = userRpc(identity.userId);
    const listed = await rpc.listSecrets({
      schemaVersion: 1,
      userId: identity.userId,
    });
    expect(listed.secrets).toHaveLength(1);
    const userStored = await everythingStored(
      env.USER_CONFIGURATIONS.getByName(identity.userId),
    );
    expect(userStored.kv).not.toContain(`${VALUE}-again`);

    expect(
      await rpc.deleteSecret({
        schemaVersion: 1,
        userId: identity.userId,
        secretId: listed.secrets[0]!.secretId,
      }),
    ).toMatchObject({ removed: true });
    expect(
      (await rpc.listSecrets({ schemaVersion: 1, userId: identity.userId }))
        .secrets,
    ).toHaveLength(0);
    // Awaited inside a function of its own, so the refusal is one native
    // promise rather than a pipelined RPC promise with a second, unobserved
    // rejection beside it.
    const leaseDeleted = async () =>
      rpc.leaseSecret({
        schemaVersion: 1,
        userId: identity.userId,
        secretId: listed.secrets[0]!.secretId,
        effectId: "secret-fill:deleted",
      });
    await expect(leaseDeleted()).rejects.toThrow(/not found/);
  });

  test("a request this Bot never recorded is not found", async () => {
    const identity = await identityFor("secret-unknown");
    const submitUnknown = async () =>
      botRpc(identity).submitSecret({
        schemaVersion: 1,
        ...identity,
        requestId: `secret-request-${"0".repeat(32)}`,
        command: { schemaVersion: 1, commandId: "save-1", value: VALUE },
      });
    await expect(submitUnknown()).rejects.toThrow(/not found/);
  });
});
