import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { PUBLICATION_CURSOR_KEY } from "@frockbot/core/durable";
import { cleanRetiredPublicationStateV1 } from "./publication-state-cleanup.js";

describe("retired publication cleanup", () => {
  test("drops the invalidation log and S3 pending stubs, keeps live pending", async () => {
    const storage = new MemoryStorage();
    await storage.put("bot-state-channel:meta:v1", {
      schemaVersion: 1,
      first: 1,
      last: 2,
    });
    await storage.put("bot-state-channel:event:v1:0000000000000001", {
      schemaVersion: 1,
      cursor: "1",
      topic: "runs",
    });
    await storage.put(PUBLICATION_CURSOR_KEY, 4);
    await storage.put("publication-pending:0000000000000003", {
      schemaVersion: 1,
      cursor: 3,
    });
    await storage.put("publication-pending:0000000000000004", {
      schemaVersion: 1,
      epoch: 1,
      cursor: 4,
      entityId: "run:run-1",
      kind: "run-status",
      revision: 1,
    });

    await cleanRetiredPublicationStateV1(storage);

    expect(storage.values.has("bot-state-channel:meta:v1")).toBe(false);
    expect(
      storage.values.has("bot-state-channel:event:v1:0000000000000001"),
    ).toBe(false);
    expect(storage.values.has(PUBLICATION_CURSOR_KEY)).toBe(false);
    expect(storage.values.has("publication-pending:0000000000000003")).toBe(
      false,
    );
    expect(storage.values.get("publication-pending:0000000000000004")).toEqual({
      schemaVersion: 1,
      epoch: 1,
      cursor: 4,
      entityId: "run:run-1",
      kind: "run-status",
      revision: 1,
    });
    await cleanRetiredPublicationStateV1(storage);
    expect(storage.values.has("publication-pending:0000000000000004")).toBe(
      true,
    );
  });
});
