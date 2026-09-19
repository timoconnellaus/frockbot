import { describe, expect, test } from "bun:test";
import { readBotLifecycleReceiptV1, readFlockReceiptV1 } from "./receipts.js";

const flockStored = {
  fingerprint: "fingerprint-1",
  receipt: {
    schemaVersion: 1 as const,
    commandId: "command-1",
    status: "applied" as const,
    revision: 2,
  },
};

const lifecycleStored = {
  fingerprint: "fingerprint-1",
  receipt: {
    schemaVersion: 1 as const,
    commandId: "command-1",
    botId: "alpha",
    status: "applied" as const,
    lifecycle: {
      schemaVersion: 1 as const,
      botId: "alpha",
      status: "active" as const,
      revision: 2,
    },
  },
};

describe("Flock receipt reads", () => {
  test("returns a clone and leaves an absent receipt absent", () => {
    const first = readFlockReceiptV1(
      flockStored,
      "fingerprint-1",
      "command-1",
    )!;
    first.revision = 9;
    expect(
      readFlockReceiptV1(flockStored, "fingerprint-1", "command-1"),
    ).toEqual(flockStored.receipt);
    expect(
      readFlockReceiptV1(undefined, "fingerprint-1", "command-1"),
    ).toBeUndefined();
  });

  test("keeps the exact collision error for User receipts", () => {
    expect(() =>
      readFlockReceiptV1(flockStored, "fingerprint-2", "command-1"),
    ).toThrow("command ID collision: command-1");
  });

  test("uses the lifecycle decoder and clones lifecycle receipts", () => {
    const first = readBotLifecycleReceiptV1(
      lifecycleStored,
      "fingerprint-1",
      "command-1",
    )!;
    first.lifecycle.status = "deleted";
    expect(
      readBotLifecycleReceiptV1(lifecycleStored, "fingerprint-1", "command-1"),
    ).toEqual(lifecycleStored.receipt);
    expect(() =>
      readBotLifecycleReceiptV1(lifecycleStored, "fingerprint-2", "command-1"),
    ).toThrow("command ID collision: command-1");
  });
});
