import { describe, expect, test } from "bun:test";
import { createCredentialUserBackendContribution } from "@frockbot/app/credentials/user";
import { CredentialLeaseRuntime } from "@frockbot/app/credentials/runtime";
import { SECRET_LIMITS_V1, SECRETS_PACKAGE_ID_V1 } from "./shared.js";
import { createSecretVaultV1 } from "./user.js";
import { MemorySecretStorage, TEST_SECRETS_KEYRING } from "./testing.js";

const ACCOUNT = "user-1";
const VALUE = "hunter2-correct-horse-9f3a1c7e";

function vault(storage = new MemorySecretStorage()) {
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: TEST_SECRETS_KEYRING,
    now: () => Date.parse("2026-09-24T00:00:00.000Z"),
  });
  return {
    storage,
    vault: createSecretVaultV1({
      storage,
      credentials,
      now: () => Date.parse("2026-09-24T00:00:00.000Z"),
    }),
  };
}

const REQUEST = {
  accountId: ACCOUNT,
  botId: "bot-1",
  requestId: `secret-request-${"a".repeat(32)}`,
  label: "Shop login",
  origin: "https://shop.example",
  payment: false,
  value: VALUE,
};

describe("the User's secret vault", () => {
  test("seals the value and keeps it nowhere readable", async () => {
    const { storage, vault: secrets } = vault();
    const saved = await secrets.store(REQUEST);

    expect(saved).toMatchObject({
      status: "saved",
      label: "Shop login",
      origin: "https://shop.example",
      payment: false,
      botId: "bot-1",
    });
    expect(saved.secretId).toMatch(/^secret-[0-9a-f]{32}$/);
    // Every byte the object would store: the value is in none of them, and
    // what it answers — the view, the listing — carries none either.
    expect(storage.dump()).not.toContain(VALUE);
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    expect(JSON.stringify(await secrets.list())).not.toContain(VALUE);
  });

  test("a lease opens back to the value with the keyring, and settles", async () => {
    const { storage, vault: secrets } = vault();
    const { secretId } = await secrets.store(REQUEST);

    const lease = await secrets.lease({
      accountId: ACCOUNT,
      secretId,
      effectId: "secret-fill:effect-1",
    });
    expect(JSON.stringify(lease)).not.toContain(VALUE);
    const opened = await new CredentialLeaseRuntime({
      readSecret: () => TEST_SECRETS_KEYRING,
    }).open({
      accountId: ACCOUNT,
      connectionId: secretId,
      packageId: SECRETS_PACKAGE_ID_V1,
      lease,
    });
    expect(opened).toBe(VALUE);
    await secrets.settle({
      accountId: ACCOUNT,
      secretId,
      effectId: "secret-fill:effect-1",
    });
    expect(storage.dump()).not.toContain("secret-fill:effect-1");
  });

  test("one request makes one secret, however often it is saved", async () => {
    const { vault: secrets } = vault();
    const first = await secrets.store(REQUEST);
    const again = await secrets.store({ ...REQUEST, value: `${VALUE}-2` });

    expect(again.status).toBe("replayed");
    expect(again.secretId).toBe(first.secretId);
    expect((await secrets.list()).secrets).toHaveLength(1);
  });

  test("a card number is a payment detail whatever the Bot asked for", async () => {
    const { vault: secrets } = vault();
    const saved = await secrets.store({
      ...REQUEST,
      label: "Card",
      value: "4242 4242 4242 4242",
    });
    expect(saved.payment).toBe(true);
  });

  test("delete removes the record and the sealed value", async () => {
    const { storage, vault: secrets } = vault();
    const { secretId } = await secrets.store(REQUEST);

    expect(await secrets.remove(secretId)).toEqual({ removed: true });
    expect(await secrets.describe(secretId)).toBeUndefined();
    expect(storage.dump()).not.toContain(secretId);
    await expect(
      secrets.lease({ accountId: ACCOUNT, secretId, effectId: "late" }),
    ).rejects.toThrow("not found");
    expect(await secrets.remove(secretId)).toEqual({ removed: false });
  });

  test("an account holds a bounded number of secrets", async () => {
    const { vault: secrets } = vault();
    for (let index = 0; index < SECRET_LIMITS_V1.perUser; index += 1) {
      await secrets.store({
        ...REQUEST,
        requestId: `secret-request-${index.toString(16).padStart(32, "0")}`,
      });
    }
    await expect(
      secrets.store({
        ...REQUEST,
        requestId: `secret-request-${"f".repeat(32)}`,
      }),
    ).rejects.toThrow(`${SECRET_LIMITS_V1.perUser} saved secrets`);
  });
});
