import { describe, expect, test } from "bun:test";
import { createPackagePublisherUserContribution } from "./user.js";
import type { PackagePublisherTransaction } from "./user.js";

class MemoryStorage implements PackagePublisherTransaction {
  readonly values = new Map<string, unknown>();
  readonly alarmTransactions: boolean[] = [];
  private transactionActive = false;

  constructor(
    private readonly onAlarm?: (scheduledTime: number | Date) => void,
  ) {}

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }

  put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  async transaction<T>(
    callback: (storage: PackagePublisherTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionActive = true;
    try {
      return await callback(this);
    } finally {
      this.transactionActive = false;
    }
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTransactions.push(this.transactionActive);
    this.onAlarm?.(scheduledTime);
    return Promise.resolve();
  }
}

const candidate = {
  source: "source archive",
  applicationArtifact: "export default { fetch() {} }",
  checks: [{ name: "test", status: "passed" as const }],
};

describe("Package Publisher User contribution", () => {
  test("publishes a verified immutable revision and replays the command", async () => {
    const effects: string[] = [];
    const storage = new MemoryStorage((scheduledTime) => {
      effects.push(`scheduled:${new Date(scheduledTime).toISOString()}`);
    });
    const contribution = createPackagePublisherUserContribution({
      storage,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      hash: () => Promise.resolve("sha256:artifact-one"),
      storeAndVerify: async ({ applicationHash }) => {
        effects.push(applicationHash);
      },
    });

    const command = {
      schemaVersion: 1 as const,
      commandId: "publish-1",
      expectedRevision: 0,
      candidate,
    };
    const first = await contribution.publish("user-1", command);
    const replay = await contribution.publish("user-1", command);

    expect(first).toEqual({
      schemaVersion: 1,
      commandId: "publish-1",
      status: "active",
      revision: 1,
      packageRevision: 1,
      applicationHash: "sha256:artifact-one",
    });
    expect(replay).toEqual(first);
    expect(effects).toEqual([
      "scheduled:2026-09-01T00:01:00.000Z",
      "sha256:artifact-one",
    ]);
    expect(storage.alarmTransactions).toEqual([true]);
    expect(await contribution.read()).toEqual({
      schemaVersion: 1,
      revision: 1,
      activePackageRevision: 1,
      revisions: [
        {
          packageRevision: 1,
          applicationHash: "sha256:artifact-one",
          publishedAt: "2026-09-01T00:00:00.000Z",
          checks: [{ name: "test", status: "passed" }],
        },
      ],
    });
  });

  test("resumes a durably pending publication after its host is reconstructed", async () => {
    const storage = new MemoryStorage();
    const order: string[] = [];
    await storage.put("package-publisher:state:v1", {
      schemaVersion: 1,
      revision: 0,
      revisions: [],
      pending: {
        userId: "user-1",
        commandId: "publish-1",
        fingerprint: "fingerprint",
        packageRevision: 1,
        applicationHash: "sha256:artifact-one",
        publishedAt: "2026-09-01T00:00:00.000Z",
        candidate,
      },
    });
    const contribution = createPackagePublisherUserContribution({
      storage,
      hash: () => Promise.resolve("sha256:artifact-one"),
      storeAndVerify: () => {
        order.push("verified");
        return Promise.resolve();
      },
    });

    const receipt = await contribution.recover();

    expect(order).toEqual(["verified"]);
    expect(receipt).toMatchObject({ status: "active", packageRevision: 1 });
    expect((await contribution.read()).activePackageRevision).toBe(1);
    expect(await contribution.recover()).toBeUndefined();
  });

  test("deduplicates concurrent delivery of a pending publication effect", async () => {
    const storage = new MemoryStorage();
    let releaseVerification: (() => void) | undefined;
    const verificationStarted = Promise.withResolvers<void>();
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let effects = 0;
    const contribution = createPackagePublisherUserContribution({
      storage,
      hash: () => Promise.resolve("sha256:artifact-one"),
      storeAndVerify: async () => {
        effects += 1;
        verificationStarted.resolve();
        await verificationReleased;
      },
    });
    const command = {
      schemaVersion: 1 as const,
      commandId: "publish-concurrent",
      expectedRevision: 0,
      candidate,
    };

    const publication = contribution.publish("user-1", command);
    await verificationStarted.promise;
    const recovery = contribution.recover();
    releaseVerification?.();
    const [published, recovered] = await Promise.all([publication, recovery]);

    expect(recovered).toEqual(published);
    expect(effects).toBe(1);
  });

  test("rejects malformed publication state at the durable storage seam", async () => {
    const storage = new MemoryStorage();
    await storage.put("package-publisher:state:v1", {
      schemaVersion: 1,
      revision: 0,
      revisions: [],
      unknown: true,
    });
    const contribution = createPackagePublisherUserContribution({
      storage,
      hash: () => Promise.resolve("sha256:unused"),
      storeAndVerify: () => Promise.resolve(),
    });

    let failure: unknown;
    try {
      await contribution.read();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unknown or missing fields");
  });

  test("records verification failure without replacing the active revision", async () => {
    const storage = new MemoryStorage();
    let shouldFail = false;
    const contribution = createPackagePublisherUserContribution({
      storage,
      hash: ({ applicationArtifact }) =>
        Promise.resolve(`sha256:${applicationArtifact.length}`),
      storeAndVerify: () =>
        shouldFail
          ? Promise.reject(new Error("candidate did not become healthy"))
          : Promise.resolve(),
    });

    await contribution.publish("user-1", {
      schemaVersion: 1,
      commandId: "publish-1",
      expectedRevision: 0,
      candidate,
    });
    shouldFail = true;
    const failed = await contribution.publish("user-1", {
      schemaVersion: 1,
      commandId: "publish-2",
      expectedRevision: 1,
      candidate: {
        ...candidate,
        applicationArtifact: "broken application",
      },
    });

    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("candidate did not become healthy");
    expect((await contribution.read()).activePackageRevision).toBe(1);
  });

  test("blocks failed checks and rolls every Bot back by changing the shared active revision", async () => {
    const contribution = createPackagePublisherUserContribution({
      storage: new MemoryStorage(),
      hash: ({ applicationArtifact }) =>
        Promise.resolve(`sha256:${applicationArtifact.length}`),
      storeAndVerify: () => Promise.resolve(),
    });

    let checkFailure: unknown;
    try {
      await contribution.publish("user-1", {
        schemaVersion: 1,
        commandId: "publish-failed-tests",
        expectedRevision: 0,
        candidate: {
          ...candidate,
          checks: [{ name: "test", status: "failed" }],
        },
      });
    } catch (error) {
      checkFailure = error;
    }
    expect(checkFailure).toBeInstanceOf(Error);
    expect((checkFailure as Error).message).toContain(
      "all required checks must pass",
    );

    const first = await contribution.publish("user-1", {
      schemaVersion: 1,
      commandId: "publish-1",
      expectedRevision: 0,
      candidate,
    });
    await contribution.publish("user-1", {
      schemaVersion: 1,
      commandId: "publish-2",
      expectedRevision: first.revision,
      candidate: {
        ...candidate,
        applicationArtifact: "second artifact",
      },
    });
    const rollback = await contribution.rollback({
      schemaVersion: 1,
      commandId: "rollback-1",
      expectedRevision: 2,
      packageRevision: 1,
    });

    expect(rollback).toEqual({
      schemaVersion: 1,
      commandId: "rollback-1",
      status: "active",
      revision: 3,
      packageRevision: 1,
      applicationHash: first.applicationHash,
    });
    expect((await contribution.read()).activePackageRevision).toBe(1);
  });
});
