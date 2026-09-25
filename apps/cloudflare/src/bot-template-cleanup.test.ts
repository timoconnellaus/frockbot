import { expect, test } from "bun:test";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  cleanRetiredBotTemplatesV1,
  withoutBotTemplatePackageV1,
} from "./bot-template-cleanup.js";

const HASH = "a".repeat(64);
const RECEIPT = "maintenance:bot-template-removal:2026-09-25";

const settings = (packages: unknown[]) => ({
  schemaVersion: 1,
  revision: 3,
  profile: { name: "Tim" },
  packages,
  connections: [],
});

test("drops only the retired Package row", () => {
  expect(
    withoutBotTemplatePackageV1(
      settings([
        { packageId: "flock", version: "0.0.1", state: "installed" },
        { packageId: "bot-template", version: "0.0.1", state: "installed" },
      ]),
    ),
  ).toEqual(
    settings([{ packageId: "flock", version: "0.0.1", state: "installed" }]),
  );
  expect(
    withoutBotTemplatePackageV1(
      settings([{ packageId: "flock", version: "0.0.1", state: "installed" }]),
    ),
  ).toBeUndefined();
});

test("deletes every share blob, every template key and the row, once", async () => {
  const storage = new MemoryStorage();
  await storage.put("bot-template:share:u1.s1", { hash: HASH });
  await storage.put("bot-template:share-index", ["u1.s1"]);
  await storage.put("bot-template:import:i1", { status: "applied" });
  await storage.put("bot-template:import-recovery-at", 0);
  await storage.put("bot-template:receipt:c1", {});
  await storage.put("routine:kept", { kept: true });
  await storage.put(
    "user-configuration",
    settings([
      { packageId: "flock", version: "0.0.1", state: "installed" },
      { packageId: "bot-template", version: "0.0.1", state: "installed" },
    ]),
  );
  const deleted: string[] = [];
  const bucket = {
    delete: async (key: string) => {
      deleted.push(key);
    },
  };

  await cleanRetiredBotTemplatesV1(storage, bucket);

  expect(deleted).toEqual([`templates/${HASH}.json`]);
  expect([
    ...(await storage.list({ prefix: "bot-template:", limit: 50 })).keys(),
  ]).toEqual([]);
  expect(await storage.get<unknown>("routine:kept")).toEqual({ kept: true });
  expect(await storage.get<unknown>("user-configuration")).toEqual(
    settings([{ packageId: "flock", version: "0.0.1", state: "installed" }]),
  );
  expect(await storage.get<unknown>(RECEIPT)).toMatchObject({
    keys: 5,
    blobs: 1,
    packageRow: true,
  });

  await storage.put("bot-template:share:u1.s2", { hash: HASH });
  await cleanRetiredBotTemplatesV1(storage, bucket);
  expect(deleted).toHaveLength(1);
});
