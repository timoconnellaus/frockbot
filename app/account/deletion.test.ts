import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_DELETION_KEY_V1,
  ACCOUNT_DELETION_STEPS_V1,
  accountDeletionRetryDelayMsV1,
  advanceAccountDeletionV1,
  beginAccountDeletionV1,
  decodeAccountDeletionRecordV1,
  readAccountDeletionV1,
  type AccountDeletionHostV1,
  type AccountDeletionStepOutcomeV1,
  type AccountDeletionStepV1,
  type AccountDeletionTombstoneV1,
} from "./deletion.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

const NOW = new Date("2026-09-24T00:00:00.000Z");

function host(
  storage: MemoryStorage,
  run: (
    step: AccountDeletionStepV1,
    cursor: string | undefined,
  ) => AccountDeletionStepOutcomeV1 | Promise<AccountDeletionStepOutcomeV1>,
) {
  const ran: string[] = [];
  const erased: AccountDeletionTombstoneV1[] = [];
  const saga: AccountDeletionHostV1 = {
    storage,
    now: () => NOW,
    run: async (step, record) => {
      ran.push(record.cursor ? `${step}@${record.cursor}` : step);
      return run(step, record.cursor);
    },
    erase: async (tombstone) => {
      storage.values.clear();
      erased.push(tombstone);
    },
  };
  return { saga, ran, erased };
}

describe("account deletion", () => {
  test("a repeated request joins the deletion already under way", async () => {
    const storage = new MemoryStorage();
    const first = await beginAccountDeletionV1(
      storage,
      { userId: "user-1", commandId: "command-1", email: "a@example.com" },
      NOW,
    );
    expect(first.begun).toBe(true);
    expect(first.record).toMatchObject({
      step: "access",
      attempts: 0,
      email: "a@example.com",
      requestedAt: NOW.toISOString(),
    });
    const second = await beginAccountDeletionV1(storage, {
      userId: "user-1",
      commandId: "command-2",
    });
    expect(second).toEqual({ record: first.record, begun: false });
    await expect(
      beginAccountDeletionV1(storage, { userId: "user-2", commandId: "c" }),
    ).rejects.toThrow(/another User/);
  });

  test("runs every step in order and erases last, in one pass when nothing waits", async () => {
    const storage = new MemoryStorage();
    await beginAccountDeletionV1(
      storage,
      { userId: "user-1", commandId: "command-1" },
      NOW,
    );
    const { saga, ran, erased } = host(storage, () => ({
      status: "complete",
    }));
    expect(await advanceAccountDeletionV1(saga)).toEqual({ status: "erased" });
    expect(ran).toEqual([...ACCOUNT_DELETION_STEPS_V1]);
    expect(erased).toEqual([
      {
        schemaVersion: 1,
        userId: "user-1",
        requestedAt: NOW.toISOString(),
        deletedAt: NOW.toISOString(),
      },
    ]);
    // Nothing left to drive.
    expect(await advanceAccountDeletionV1(saga)).toEqual({ status: "idle" });
  });

  test("a pending step keeps its cursor, and a later pass resumes from it", async () => {
    const storage = new MemoryStorage();
    await beginAccountDeletionV1(storage, {
      userId: "user-1",
      commandId: "command-1",
    });
    let pages = 0;
    const { saga, ran } = host(storage, (step, cursor) => {
      if (step !== "files") return { status: "complete" };
      pages += 1;
      return pages < 3
        ? { status: "pending", cursor: `page-${pages}` }
        : { status: "complete" };
    });
    expect(await advanceAccountDeletionV1(saga)).toEqual({
      status: "pending",
      step: "files",
    });
    expect((await readAccountDeletionV1(storage))?.cursor).toBe("page-1");
    expect(await advanceAccountDeletionV1(saga)).toEqual({
      status: "pending",
      step: "files",
    });
    expect(await advanceAccountDeletionV1(saga)).toEqual({ status: "erased" });
    // Steps before the page never ran again: each was recorded as done.
    expect(ran.filter((step) => step === "access")).toEqual(["access"]);
    expect(ran.filter((step) => step.startsWith("files"))).toEqual([
      "files",
      "files@page-1",
      "files@page-2",
    ]);
  });

  test("a failing step is recorded where it failed and retried from there, backing off", async () => {
    const storage = new MemoryStorage();
    await beginAccountDeletionV1(storage, {
      userId: "user-1",
      commandId: "command-1",
    });
    let fail = true;
    const { saga, ran } = host(storage, (step) => {
      if (step === "payments" && fail) throw new Error("provider down");
      return { status: "complete" };
    });
    const first = await advanceAccountDeletionV1(saga);
    expect(first).toEqual({ status: "failed", step: "payments", attempts: 1 });
    expect(accountDeletionRetryDelayMsV1(first)).toBe(2_000);
    const second = await advanceAccountDeletionV1(saga);
    expect(second).toMatchObject({ attempts: 2 });
    expect(accountDeletionRetryDelayMsV1(second)).toBe(4_000);
    expect(await readAccountDeletionV1(storage)).toMatchObject({
      step: "payments",
      attempts: 2,
      lastFailure: "provider down",
    });
    // A long outage never stops the saga; it only slows it.
    expect(
      accountDeletionRetryDelayMsV1({
        status: "failed",
        step: "payments",
        attempts: 40,
      }),
    ).toBe(300_000);
    fail = false;
    expect(await advanceAccountDeletionV1(saga)).toEqual({ status: "erased" });
    expect(ran.filter((step) => step === "connected-apps")).toEqual([
      "connected-apps",
    ]);
  });

  test("an erase that throws leaves the record to be erased again", async () => {
    const storage = new MemoryStorage();
    await beginAccountDeletionV1(storage, {
      userId: "user-1",
      commandId: "command-1",
    });
    let erases = 0;
    const saga: AccountDeletionHostV1 = {
      storage,
      run: async () => ({ status: "complete" }),
      erase: async () => {
        erases += 1;
        if (erases === 1) throw new Error("evicted");
        storage.values.clear();
      },
    };
    await expect(advanceAccountDeletionV1(saga)).rejects.toThrow("evicted");
    // The record survived at its last step, so the next pass re-runs it and
    // erases, rather than the account being left half deleted.
    expect(await readAccountDeletionV1(storage)).toMatchObject({
      step: "admission",
    });
    expect(await advanceAccountDeletionV1(saga)).toEqual({ status: "erased" });
  });

  test("a stored record that does not decode is refused, not guessed at", () => {
    expect(() =>
      decodeAccountDeletionRecordV1({
        schemaVersion: 1,
        userId: "user-1",
        commandId: "c",
        requestedAt: NOW.toISOString(),
        step: "everything",
        attempts: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeAccountDeletionRecordV1({
        schemaVersion: 1,
        userId: "user-1",
        commandId: "c",
        requestedAt: NOW.toISOString(),
        step: "access",
        attempts: 0,
        extra: true,
      }),
    ).toThrow();
    expect(ACCOUNT_DELETION_KEY_V1).toBe("account:deletion:v1");
  });
});
