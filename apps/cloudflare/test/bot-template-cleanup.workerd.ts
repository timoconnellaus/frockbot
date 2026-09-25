// The disposable cleanup for the removed Bot templates, against the real User
// Durable Object that runs it in its constructor and the real artifact bucket.
//
// The release requires it: an account a template-era build left behind — a
// share ledger, an import record, the shared recipe's blob and the seeded
// `bot-template` Package row — must come back with all of that gone, its other
// state untouched, and its settings still readable. Only an evicted object can
// make that claim, because the cleanup runs before any request can.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

const RECEIPT = "maintenance:bot-template-removal:2026-09-25";
const HASH = "b".repeat(64);
const OTHER_HASH = "c".repeat(64);

interface Settings {
  packages: { packageId: string }[];
}

interface UserRpc {
  readConfiguration(input: unknown): Promise<Settings>;
}

test("a template-era account comes back without templates, and still reads", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `template-cleanup-user-${suffix}`,
    botId: `template-cleanup-bot-${suffix}`,
  };
  await provisionBot(identity);
  const stub = env.USER_CONFIGURATIONS.getByName(identity.userId);
  // SAFETY: names only the method this test calls on the generated stub.
  const rpc = stub as unknown as UserRpc;
  const before = await rpc.readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    view: 2,
  });

  const blob = `templates/${HASH}.json`;
  const unrelated = `templates/${OTHER_HASH}.json`;
  await env.APPLICATION_ARTIFACTS.put(blob, '{"kind":"frockbot.template"}');
  await env.APPLICATION_ARTIFACTS.put(unrelated, "{}");
  const keptKeys = await runInDurableObject(stub, async (_instance, state) => {
    const stored = (await state.storage.get<Settings>("user-configuration"))!;
    await state.storage.put("user-configuration", {
      ...stored,
      packages: [
        ...stored.packages,
        { packageId: "bot-template", version: "0.0.1", state: "installed" },
      ],
    });
    const records: Record<string, unknown> = {
      [`bot-template:share:${identity.userId}.s1`]: { hash: HASH },
      [`bot-template:share:${identity.userId}.s2`]: { hash: HASH },
      "bot-template:share-index": ["s1", "s2"],
      "bot-template:import:i1": { status: "applied" },
      "bot-template:import-recovery-at": 0,
    };
    for (let n = 0; n < 120; n++) records[`bot-template:receipt:${n}`] = {};
    for (const [key, value] of Object.entries(records))
      await state.storage.put(key, value);
    await state.storage.delete(RECEIPT);
    return [...(await state.storage.list()).keys()].filter(
      (key) => !key.startsWith("bot-template:"),
    );
  });
  await evictDurableObject(stub);

  const after = await rpc.readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    view: 2,
  });
  expect(after.packages.map((row) => row.packageId)).toEqual(
    before.packages.map((row) => row.packageId),
  );
  expect(await env.APPLICATION_ARTIFACTS.get(blob)).toBeNull();
  expect(await env.APPLICATION_ARTIFACTS.get(unrelated)).not.toBeNull();
  await runInDurableObject(stub, async (_instance, state) => {
    expect((await state.storage.list({ prefix: "bot-template:" })).size).toBe(
      0,
    );
    const stored = (await state.storage.get<Settings>("user-configuration"))!;
    expect(
      stored.packages.some((row) => row.packageId === "bot-template"),
    ).toBe(false);
    const keys = [...(await state.storage.list()).keys()];
    for (const key of keptKeys) expect(keys).toContain(key);
    expect(await state.storage.get(RECEIPT)).toMatchObject({
      keys: 125,
      blobs: 1,
      packageRow: true,
    });
    // A second wake finds the receipt and leaves new keys alone.
    await state.storage.put("bot-template:share:late", { hash: HASH });
  });
  await evictDurableObject(stub);
  await rpc.readConfiguration({ schemaVersion: 1, userId: identity.userId });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("bot-template:share:late")).toEqual({
      hash: HASH,
    });
  });
});
