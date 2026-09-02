import { describe, expect, test } from "bun:test";
import type {
  ComputerControlLease,
  ComputerHandle,
} from "@frockbot/computer-core";
import {
  COMPUTER_CONTROL_RECORD_KEY,
  COMPUTER_INTENT_PREFIX,
  COMPUTER_PROVIDER_RECORD_KEY,
  COMPUTER_VIEWER_RECORD_KEY,
  createComputerBotBackendContribution,
  type ComputerBotStorage,
  type ComputerBotTransaction,
} from "./bot.js";
import type { ComputerCommandV1 } from "./protocol.js";

class MemoryStorage implements ComputerBotStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
    } else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, structuredClone(entry));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

function command(
  type: ComputerCommandV1["type"],
  commandId: string,
): ComputerCommandV1 {
  return { version: 1, commandId, botId: "scout", type };
}

function fakeHandle(options: {
  presence?(): Promise<{ id: string; url: string; expiresAt: string }>;
  renewViewer?(
    sessionId: string,
  ): Promise<{ id: string; url: string; expiresAt: string }>;
  acquire?(ownerId: string): Promise<ComputerControlLease>;
  renew?(lease: ComputerControlLease): Promise<ComputerControlLease>;
  release?(lease: ComputerControlLease): Promise<void>;
}): ComputerHandle {
  return {
    assignment: { providerId: "fake", generation: 1 },
    identity: { userId: "user-1" },
    tenant: { botId: "scout" },
    ...(options.presence ? { presence: { connect: options.presence } } : {}),
    ...(options.renewViewer
      ? {
          viewer: {
            open: () => Promise.reject(new Error("not used")),
            renew: options.renewViewer,
            revoke: () => Promise.resolve(),
          },
        }
      : {}),
    control: {
      acquire: (request) => options.acquire!(request?.ownerId ?? "missing"),
      renew: (lease) => options.renew!(lease),
      release: (lease) => options.release!(lease),
    },
    close: () => Promise.resolve(),
  };
}

describe("Computer Bot Durable Object Contribution", () => {
  test("commits intent before it asks the provider and replays one receipt", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () => {
              calls += 1;
              expect(
                storage.values.has(`${COMPUTER_INTENT_PREFIX}connect-1`),
              ).toBe(true);
              return Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-02T00:01:30.000Z",
              });
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const first = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-1"),
    );
    const replay = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-1"),
    );
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "viewer.invalid",
    );
  });

  test("records and replays one viewer renewal without storing its bearer URL", async () => {
    const storage = new MemoryStorage();
    let renewals = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-02T00:01:30.000Z",
              }),
            renewViewer: (sessionId) => {
              renewals += 1;
              expect(sessionId).toBe("viewer-1");
              expect(
                storage.values.has(`${COMPUTER_INTENT_PREFIX}viewer-renew-1`),
              ).toBe(true);
              return Promise.resolve({
                id: sessionId,
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-viewer"),
    );
    const first = await contribution.execute(
      "user-1",
      "scout",
      command("refreshViewer", "viewer-renew-1"),
    );
    const replay = await contribution.execute(
      "user-1",
      "scout",
      command("refreshViewer", "viewer-renew-1"),
    );

    expect(first.status).toBe("applied");
    expect(replay).toEqual(first);
    expect(renewals).toBe(1);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "viewer.invalid",
    );
  });

  test("reconstructs a live lease after eviction and renews then releases it", async () => {
    const storage = new MemoryStorage();
    let now = new Date("2026-09-02T00:00:00.000Z");
    let heldOwner = "";
    const owners: string[] = [];
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      now: () => now,
      newId: () => "owner-1",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            acquire: (ownerId) => {
              heldOwner = ownerId;
              owners.push(ownerId);
              return Promise.resolve({
                id: ownerId,
                expiresAt: "2026-09-02T00:01:30.000Z",
              });
            },
            renew: (lease) => {
              expect(lease.id).toBe(heldOwner);
              return Promise.resolve({
                id: lease.id,
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
            release: (lease) => {
              expect(lease.id).toBe(heldOwner);
              return Promise.resolve();
            },
          }),
        ),
    };
    const resident = createComputerBotBackendContribution(host);
    await resident.execute("user-1", "scout", command("takeControl", "take-1"));
    const reconstructed = createComputerBotBackendContribution(host);
    now = new Date("2026-09-02T00:00:30.000Z");
    const projected = await reconstructed.read("user-1", "scout");
    expect(projected.controlLease?.ownerId).toBe("owner-1");
    await reconstructed.execute(
      "user-1",
      "scout",
      command("refreshControl", "refresh-1"),
    );
    await reconstructed.execute(
      "user-1",
      "scout",
      command("releaseControl", "release-1"),
    );
    expect(owners).toEqual(["owner-1"]);
    expect(storage.values.has(COMPUTER_CONTROL_RECORD_KEY)).toBe(false);
  });

  test("reclaims a stale lease under a new durable owner", async () => {
    const storage = new MemoryStorage();
    let now = new Date("2026-09-02T00:00:00.000Z");
    let id = 0;
    const acquired: string[] = [];
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      now: () => now,
      newId: () => `owner-${++id}`,
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            acquire: (ownerId) => {
              acquired.push(ownerId);
              return Promise.resolve({
                id: ownerId,
                expiresAt: new Date(now.getTime() + 90_000).toISOString(),
              });
            },
          }),
        ),
    };
    await createComputerBotBackendContribution(host).execute(
      "user-1",
      "scout",
      command("takeControl", "take-1"),
    );
    now = new Date("2026-09-02T00:02:00.000Z");
    await createComputerBotBackendContribution(host).execute(
      "user-1",
      "scout",
      command("takeControl", "take-2"),
    );
    expect(acquired).toEqual(["owner-1", "owner-2"]);
  });

  test("projects reconstructed durable state without opening the Computer", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      [COMPUTER_VIEWER_RECORD_KEY]: {
        version: 1,
        id: "viewer-1",
        expiresAt: "2026-09-02T00:01:30.000Z",
      },
      [COMPUTER_CONTROL_RECORD_KEY]: {
        version: 1,
        ownerId: "owner-1",
        acquiredAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-09-02T00:01:30.000Z",
      },
      [COMPUTER_PROVIDER_RECORD_KEY]: {
        version: 1,
        phase: "ready",
        message: "Computer ready",
        recordedAt: "2026-09-02T00:00:00.000Z",
      },
    });
    let providerCalls = 0;
    const reconstructed = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => {
        providerCalls += 1;
        throw new Error("a read must not wake the Computer");
      },
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });

    const projected = await reconstructed.read("user-1", "scout");

    expect(projected).toMatchObject({
      phase: "human-control",
      controlLease: { ownerId: "owner-1" },
    });
    expect(projected.viewerSession).toBeUndefined();
    expect(providerCalls).toBe(0);
  });
});
