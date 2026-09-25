import { describe, expect, test } from "bun:test";
import type {
  ComputerConnectionOptionsV1,
  ComputerControlLease,
  ComputerHostCapabilitiesV1,
  ComputerHostSessionV1,
} from "@frockbot/computer/core/host";
import {
  COMPUTER_UNCONFIGURED_MESSAGE_V1,
  ComputerError,
} from "@frockbot/computer/core";
import {
  COMPUTER_CONNECT_DEFERRAL_MS,
  COMPUTER_CONNECT_START_DELAY_MS,
  COMPUTER_CONNECT_WATCHDOG_MS,
  COMPUTER_CONTROL_RECORD_KEY,
  COMPUTER_INTENT_PREFIX,
  COMPUTER_PENDING_CONNECT_KEY,
  COMPUTER_PROVIDER_RECORD_KEY,
  COMPUTER_VIEWER_RECORD_KEY,
  createComputerBotBackendContribution,
  type ComputerBotStorage,
  type ComputerBotTransaction,
} from "./bot.js";
import {
  computerCommandFingerprintV1,
  type ComputerCommandV1,
} from "./protocol.js";
import {
  createFakeComputerHostV1,
  fakeLoginNamesV1,
  fakeLoginsStateV1,
  FakeWorkspace,
} from "@frockbot/computer/fake";
import type {
  ComputerLoginsKeepOutcomeV1,
  ComputerLoginsKeptV1,
  ComputerLoginVaultV1,
} from "./upkeep.js";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { computerFrameFromCaptureV1, computerFrameSinkV1 } from "./frame.js";

/** A host that offers nothing beyond the operations under test. */
const TEST_HOST_CAPABILITIES: ComputerHostCapabilitiesV1 = {
  viewerFrameOrigins: [],
};

function png(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1280);
  view.setUint32(20, 720);
  return bytes;
}

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
  presence?(options?: ComputerConnectionOptionsV1): Promise<{
    id: string;
    url: string;
    expiresAt: string;
    message?: string;
  }>;
  openViewer?(): Promise<{ id: string; url: string; expiresAt: string }>;
  renewViewer?(
    sessionId: string,
  ): Promise<{ id: string; url: string; expiresAt: string }>;
  acquire?(ownerId: string, scope?: string): Promise<ComputerControlLease>;
  renew?(
    lease: ComputerControlLease,
    scope?: string,
  ): Promise<ComputerControlLease>;
  release?(lease: ComputerControlLease, scope?: string): Promise<void>;
  capture?(): Promise<{
    bytes: Uint8Array;
    mediaType: "image/png";
    display: string;
    capturedAt: string;
  }>;
}): ComputerHostSessionV1 {
  return {
    assignment: { providerId: "fake", generation: 1 },
    identity: { userId: "user-1" },
    tenant: { botId: "scout" },
    capabilities: TEST_HOST_CAPABILITIES,
    ...(options.presence ? { presence: { connect: options.presence } } : {}),
    ...(options.renewViewer || options.openViewer
      ? {
          viewer: {
            open:
              options.openViewer ??
              (() =>
                Promise.reject(new ComputerError("not-found", "No desktop"))),
            renew:
              options.renewViewer ??
              (() =>
                Promise.reject(new ComputerError("not-found", "No viewer"))),
            revoke: () => Promise.resolve(),
          },
        }
      : {}),
    control: {
      acquire: (request) =>
        options.acquire!(request?.ownerId ?? "missing", request?.scope),
      renew: (lease, request) => options.renew!(lease, request?.scope),
      release: (lease, request) => options.release!(lease, request?.scope),
    },
    ...(options.capture
      ? { screenshot: { capture: () => options.capture!() } }
      : {}),
    close: () => Promise.resolve(),
  };
}

describe("Computer Bot Durable Object Contribution", () => {
  test("an unconfigured host rejects every command, connect included", async () => {
    const storage = new MemoryStorage();
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: false,
      providerLabel: "Fake Computer",
      openComputer: () => {
        throw new Error("an unconfigured host must not reach a provider");
      },
    });

    for (const type of [
      "connect",
      "takeControl",
      "releaseControl",
      "runDoctor",
    ] as const) {
      const receipt = await contribution.execute("user-1", "scout", {
        version: 1,
        commandId: `command-${type}`,
        botId: "scout",
        type,
      });
      expect(receipt).toMatchObject({
        version: 1,
        type,
        status: "rejected",
        failure: COMPUTER_UNCONFIGURED_MESSAGE_V1,
      });
    }
    // Nothing was admitted, so the projection never claims work is under way.
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "unconfigured",
      message: COMPUTER_UNCONFIGURED_MESSAGE_V1,
    });
    // The refusal is written for the person reading it.
    expect(COMPUTER_UNCONFIGURED_MESSAGE_V1).not.toContain("SPRITES_TOKEN");
  });

  test("records provider progress durably and projects its ordered steps", async () => {
    const storage = new MemoryStorage();
    let contribution: ReturnType<typeof createComputerBotBackendContribution>;
    contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: async (options) => {
              expect(await contribution.read("user-1", "scout")).toMatchObject({
                phase: "provisioning",
                progress: {
                  kind: "connect",
                  steps: [{ id: "waking", status: "active" }],
                },
              });
              await options?.onProgress?.({
                version: 1,
                kind: "connect",
                step: "starting-desktop",
                label: "Starting the desktop",
                index: 3,
                total: 5,
                provisioning: {
                  version: 1,
                  kind: "provision",
                  label: "installing the browser",
                  index: 4,
                  total: 5,
                  resumed: false,
                },
              });
              expect(await contribution.read("user-1", "scout")).toMatchObject({
                phase: "provisioning",
                progress: {
                  version: 1,
                  kind: "connect",
                  provisioning: {
                    kind: "provision",
                    label: "installing the browser",
                    index: 4,
                    total: 5,
                    resumed: false,
                  },
                  steps: [
                    { id: "waking", status: "complete" },
                    { id: "attaching", status: "complete" },
                    { id: "starting-desktop", status: "active" },
                    { id: "minting-viewer", status: "pending" },
                    { id: "connecting", status: "pending" },
                  ],
                },
              });
              return {
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-03T00:01:30.000Z",
              };
            },
          }),
        ),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-progress"),
    );
    await contribution.settleScheduledWork();

    expect(
      (storage.values.get(COMPUTER_PROVIDER_RECORD_KEY) as { version: number })
        .version,
    ).toBe(2);
    expect(
      (await contribution.read("user-1", "scout")).progress,
    ).toBeUndefined();
  });

  test("migrates a V1 provider record and writes V2 on the next change", async () => {
    const storage = new MemoryStorage();
    storage.values.set(COMPUTER_PROVIDER_RECORD_KEY, {
      version: 1,
      phase: "provisioning",
      message: "An older durable wake",
      recordedAt: "2026-09-02T23:59:00.000Z",
    });
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
                expiresAt: "2026-09-03T00:01:30.000Z",
              }),
          }),
        ),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "provisioning",
      message: "An older durable wake",
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-after-v1"),
    );
    await contribution.settleScheduledWork();
    expect(storage.values.get(COMPUTER_PROVIDER_RECORD_KEY)).toMatchObject({
      version: 2,
      phase: "ready",
    });
  });

  test("reads a previous V2 progress record without provisioning detail", async () => {
    const storage = new MemoryStorage();
    storage.values.set(COMPUTER_PROVIDER_RECORD_KEY, {
      version: 2,
      phase: "provisioning",
      message: "Attaching the Bot",
      recordedAt: "2026-09-03T00:00:01.000Z",
      progress: {
        version: 1,
        kind: "connect",
        startedAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:01.000Z",
        index: 2,
        total: 5,
        steps: [
          {
            version: 1,
            id: "waking",
            label: "Waking the Computer",
            status: "complete",
          },
          {
            version: 1,
            id: "attaching",
            label: "Attaching the Bot",
            status: "active",
          },
        ],
      },
    });
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("not used")),
    });

    expect(await contribution.read("user-1", "scout")).toMatchObject({
      progress: {
        version: 1,
        kind: "connect",
        index: 2,
        total: 5,
      },
    });
    expect(
      (await contribution.read("user-1", "scout")).progress?.provisioning,
    ).toBeUndefined();
  });

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
    expect(first.status).toBe("accepted");
    await contribution.settleScheduledWork();
    const replay = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-1"),
    );
    expect(replay.status).toBe("applied");
    expect(calls).toBe(1);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "viewer.invalid",
    );
  });

  test("a connect asked for while another is pending joins it rather than being refused", async () => {
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

    await contribution.execute("user-1", "scout", command("connect", "card"));
    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("connect", "card-again"),
      ),
    ).toEqual({
      version: 2,
      commandId: "card-again",
      type: "connect",
      status: "accepted",
      admittedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(storage.values.has(`${COMPUTER_INTENT_PREFIX}card-again`)).toBe(
      false,
    );

    await contribution.settleScheduledWork();
    expect(calls).toBe(1);
    expect(storage.values.has(COMPUTER_PENDING_CONNECT_KEY)).toBe(false);
  });

  test("a refused connect shows its failure only once it is no longer pending", async () => {
    const memory = new MemoryStorage();
    const committed: Map<string, unknown>[] = [];
    let depth = 0;
    const commit = () => {
      if (depth === 0) committed.push(new Map(memory.values));
    };
    const storage: ComputerBotStorage = {
      get: <T>(key: string) => memory.get<T>(key),
      put: (async (
        keyOrEntries: string | Record<string, unknown>,
        value?: unknown,
      ) => {
        if (typeof keyOrEntries === "string") {
          await memory.put(keyOrEntries, value);
        } else {
          await memory.put(keyOrEntries);
        }
        commit();
      }) as ComputerBotStorage["put"],
      delete: async (key: string) => {
        const deleted = await memory.delete(key);
        commit();
        return deleted;
      },
      transaction: async <T>(
        callback: (transaction: ComputerBotTransaction) => Promise<T>,
      ) => {
        depth += 1;
        try {
          return await callback(memory);
        } finally {
          depth -= 1;
          commit();
        }
      },
    };
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.reject(new Error("The Computer host answered 503")),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    await contribution.execute("user-1", "scout", command("connect", "down"));
    await contribution.settleScheduledWork();

    const failed = committed.filter(
      (state) =>
        (state.get(COMPUTER_PROVIDER_RECORD_KEY) as { phase?: string })
          ?.phase === "error",
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.some((state) => state.has(COMPUTER_PENDING_CONNECT_KEY)),
    ).toBe(false);
  });

  test("contributes a future deadline for a freshly admitted connect", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-09-03T00:00:00.000Z");
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("alarm has not fired")),
      now: () => now,
    });

    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("connect", "future-connect"),
      ),
    ).toMatchObject({ version: 2, status: "accepted" });
    const [deadline] = await contribution.scheduledDeadlines(storage);

    expect(deadline).toBe(now.getTime() + COMPUTER_CONNECT_START_DELAY_MS);
  });

  test("migrates a held connect intent onto a future scheduled deadline", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-09-03T00:00:00.000Z");
    const connect = command("connect", "held-connect");
    await storage.put(`${COMPUTER_INTENT_PREFIX}${connect.commandId}`, {
      version: 1,
      fingerprint: computerCommandFingerprintV1(connect),
      command: connect,
      admittedAt: "2026-09-02T00:00:00.000Z",
    });
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("alarm has not fired")),
      now: () => now,
    });

    expect(
      await contribution.execute("user-1", "scout", connect),
    ).toMatchObject({ version: 2, status: "accepted" });
    expect(await contribution.scheduledDeadlines(storage)).toEqual([
      now.getTime() + COMPUTER_CONNECT_START_DELAY_MS,
    ]);
  });

  test("a cold contribution resumes an accepted connect from durable scheduling", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    let now = "2026-09-03T00:00:00.000Z";
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => {
        calls += 1;
        return Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-03T00:01:30.000Z",
              }),
          }),
        );
      },
      now: () => new Date(now),
    };
    const warm = createComputerBotBackendContribution(host);

    expect(
      await warm.execute(
        "user-1",
        "scout",
        command("connect", "scheduled-connect"),
      ),
    ).toMatchObject({ version: 2, status: "accepted" });
    expect(calls).toBe(0);
    expect(storage.values.has(COMPUTER_PENDING_CONNECT_KEY)).toBe(true);

    const cold = createComputerBotBackendContribution(host);
    expect(await cold.scheduledDeadlines(storage)).toEqual([
      Date.parse("2026-09-03T00:00:00.000Z") + COMPUTER_CONNECT_START_DELAY_MS,
    ]);
    now = "2026-09-03T00:00:05.000Z";
    await cold.deferScheduledWork(storage);
    expect(await cold.scheduledDeadlines(storage)).toEqual([
      Date.parse(now) + COMPUTER_CONNECT_DEFERRAL_MS,
    ]);
    await cold.settleScheduledWork();
    expect(calls).toBe(2);
    expect(storage.values.has(COMPUTER_PENDING_CONNECT_KEY)).toBe(false);
    expect(
      await cold.execute(
        "user-1",
        "scout",
        command("connect", "scheduled-connect"),
      ),
    ).toMatchObject({ version: 1, status: "applied" });
  });

  test("leaves a durable watchdog armed while connect is in flight", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-09-03T00:00:00.000Z");
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const providerFinished = new Promise<{
      id: string;
      url: string;
      expiresAt: string;
    }>((resolve) => {
      release = () =>
        resolve({
          id: "viewer-1",
          url: "https://viewer.invalid/secret",
          expiresAt: "2026-09-03T00:01:30.000Z",
        });
    });
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () => {
              entered();
              return providerFinished;
            },
          }),
        ),
      now: () => now,
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "watched-connect"),
    );
    const settlement = contribution.settleScheduledWork();
    await providerEntered;

    expect(await contribution.scheduledDeadlines(storage)).toEqual([
      now.getTime() + COMPUTER_CONNECT_WATCHDOG_MS,
    ]);
    release();
    await settlement;
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
    await contribution.settleScheduledWork();
    expect((await contribution.read("user-1", "scout")).screenshots).toEqual(
      [],
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

  test("projects update-kind provider progress as updating with its label", async () => {
    const storage = new MemoryStorage();
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
                message: "Updating the Computer: Updating the Computer runtime",
              }),
          }),
        ),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-update"),
    );
    await contribution.settleScheduledWork();

    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "updating",
      message: "Updating the Computer runtime",
      viewerSession: { id: "viewer-1" },
      progress: { kind: "update" },
    });
  });

  test("projects an updating provider error during connect", async () => {
    const storage = new MemoryStorage();
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.reject(
                new ComputerError(
                  "updating",
                  "Updating the Computer runtime",
                  true,
                ),
              ),
          }),
        ),
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });

    const accepted = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-updating"),
    );
    expect(accepted.status).toBe("accepted");
    await contribution.settleScheduledWork();
    const receipt = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-updating"),
    );

    expect(receipt.status).toBe("rejected");
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "updating",
      message: "Updating the Computer runtime",
      progress: {
        kind: "update",
        steps: [{ label: "Updating the Computer runtime", status: "active" }],
      },
    });
  });

  test("reconstructs a live lease after eviction and renews then releases it", async () => {
    const storage = new MemoryStorage();
    let now = new Date("2026-09-02T00:00:00.000Z");
    let heldOwner = "";
    const owners: string[] = [];
    const scopes: string[] = [];
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      now: () => now,
      newId: () => "owner-1",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            acquire: (ownerId, scope) => {
              heldOwner = ownerId;
              owners.push(ownerId);
              scopes.push(scope ?? "missing");
              return Promise.resolve({
                id: ownerId,
                expiresAt: "2026-09-02T00:01:30.000Z",
              });
            },
            renew: (lease, scope) => {
              scopes.push(scope ?? "missing");
              expect(lease.id).toBe(heldOwner);
              return Promise.resolve({
                id: lease.id,
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
            release: (lease, scope) => {
              scopes.push(scope ?? "missing");
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
    expect(projected.controlLease?.ownerId).toBe("human:owner-1");
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
    expect(owners).toEqual(["human:owner-1"]);
    expect(scopes).toEqual(["desktop-gui", "desktop-gui", "desktop-gui"]);
    expect(storage.values.has(COMPUTER_CONTROL_RECORD_KEY)).toBe(false);
  });

  test("a release the Computer refuses still drops the durable lease", async () => {
    const storage = new MemoryStorage();
    const now = new Date("2026-09-02T00:00:00.000Z");
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      now: () => now,
      newId: () => "owner-1",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            acquire: (ownerId) =>
              Promise.resolve({
                id: ownerId,
                expiresAt: "2026-09-02T00:01:30.000Z",
              }),
            renew: (lease) => Promise.resolve({ id: lease.id, expiresAt: "" }),
            release: () =>
              Promise.reject(new Error("The Computer is unreachable")),
          }),
        ),
    };
    const contribution = createComputerBotBackendContribution(host);
    await contribution.execute(
      "user-1",
      "scout",
      command("takeControl", "take-1"),
    );
    expect(storage.values.has(COMPUTER_CONTROL_RECORD_KEY)).toBe(true);

    const receipt = await contribution.execute(
      "user-1",
      "scout",
      command("releaseControl", "release-1"),
    );

    // The failure reaches the User rather than being swallowed...
    expect(receipt).toMatchObject({
      status: "rejected",
      failure: "The Computer is unreachable",
    });
    // ...and the User-wide fence is gone, so no heartbeat can renew it and no
    // other Bot of this User is locked out of the Computer forever.
    expect(storage.values.has(COMPUTER_CONTROL_RECORD_KEY)).toBe(false);
    const projection = await contribution.read("user-1", "scout");
    expect(projection.controlLease).toBeUndefined();
    expect(projection.phase).toBe("error");
    // A heartbeat that arrives after the failed release has nothing to renew.
    await expect(
      contribution.execute(
        "user-1",
        "scout",
        command("refreshControl", "refresh-1"),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      failure: "No control lease is active",
    });
  });

  test("names a command's host requests by its Bot as well as its id", async () => {
    // A command id is the client's own text, unique only within one Bot,
    // while the Computer and its billing account are the User's.
    const sent: string[] = [];
    const bot = () =>
      createComputerBotBackendContribution({
        storage: new MemoryStorage(),
        configured: true,
        providerLabel: "Fake Computer",
        now: () => new Date("2026-09-02T00:00:00.000Z"),
        newId: () => "owner-1",
        openComputer: (_userId, _botId, effectId) => {
          sent.push(effectId);
          const handle = fakeHandle({
            acquire: (ownerId) =>
              Promise.resolve({
                id: ownerId,
                expiresAt: "2026-09-02T00:01:30.000Z",
              }),
          });
          return Promise.resolve({
            ...handle,
            control: {
              ...handle.control!,
              acquire: (request, options) => {
                sent.push(options?.effectId ?? "missing");
                return handle.control!.acquire(request, options);
              },
            },
          });
        },
      });
    const take = (botId: string): ComputerCommandV1 => ({
      version: 1,
      commandId: "take control 1",
      botId,
      type: "takeControl",
    });

    await bot().execute("user-1", "scout", take("scout"));
    await bot().execute("user-1", "ranger", take("ranger"));
    const [scoutOpen, scoutTake, rangerOpen, rangerTake] = sent;
    expect(scoutTake).toBe(`${scoutOpen}:take-control`);
    expect(rangerTake).toBe(`${rangerOpen}:take-control`);
    expect(rangerOpen).not.toBe(scoutOpen);
    // The host accepts only identifiers, and the client's id need not be one.
    expect(scoutTake).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

    // The same command sent again derives the same id.
    await bot().execute("user-1", "scout", take("scout"));
    expect(sent.slice(4)).toEqual([scoutOpen, scoutTake]);
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
    expect(acquired).toEqual(["human:owner-1", "human:owner-2"]);
  });

  test("keeps the current desktop as the card's frame when a live viewer closes", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    let opens = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => {
        opens += 1;
        return Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-03T00:01:30.000Z",
              }),
            capture: () =>
              Promise.resolve({
                bytes: png(),
                mediaType: "image/png",
                display: ":100",
                capturedAt: "2026-09-03T00:00:10.000Z",
              }),
          }),
        );
      },
      now: () => new Date("2026-09-03T00:00:15.000Z"),
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-viewer"),
    );
    await contribution.settleScheduledWork();

    const receipt = await contribution.execute(
      "user-1",
      "scout",
      command("closeViewer", "close-viewer"),
    );
    const replay = await contribution.execute(
      "user-1",
      "scout",
      command("closeViewer", "close-viewer"),
    );

    expect(receipt.status).toBe("applied");
    expect(replay).toEqual(receipt);
    expect(opens).toBe(3);
    // The frame is Bot state, not a Workspace file.
    expect(workspace.writes).toHaveLength(0);
    const [frame] = (await contribution.read("user-1", "scout")).screenshots;
    expect(frame).toEqual({
      version: 1,
      capturedAt: "2026-09-03T00:00:10.000Z",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      url: `/api/bots/scout/computer/frame/${frame?.contentHash}`,
    });
    expect(await contribution.readFrame(frame!.contentHash)).toEqual({
      bytes: png(),
      mediaType: "image/png",
    });
    // A frame the card no longer names is gone, not served.
    expect(await contribution.readFrame("0".repeat(64))).toBeUndefined();
  });

  test("does not capture a viewer close while the User's control lease is active", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    let captures = 0;
    await storage.put(COMPUTER_CONTROL_RECORD_KEY, {
      version: 1,
      ownerId: "human:owner-1",
      acquiredAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:01:30.000Z",
    });
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-03T00:01:30.000Z",
              }),
            capture: () => {
              captures += 1;
              return Promise.reject(
                new ComputerError("human-control-active", "held by User"),
              );
            },
          }),
        ),
      now: () => new Date("2026-09-03T00:00:15.000Z"),
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-controlled-viewer"),
    );
    await contribution.settleScheduledWork();

    const receipt = await contribution.execute(
      "user-1",
      "scout",
      command("closeViewer", "close-controlled-viewer"),
    );

    expect(receipt.status).toBe("applied");
    expect(captures).toBe(0);
    expect(workspace.writes).toHaveLength(0);
  });

  test("does not wake a Computer to close a viewer after Bot DO eviction", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    let opens = 0;
    const host = {
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => {
        opens += 1;
        return Promise.resolve(
          fakeHandle({
            presence: () =>
              Promise.resolve({
                id: "viewer-1",
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-03T00:01:30.000Z",
              }),
            capture: () =>
              Promise.resolve({
                bytes: png(),
                mediaType: "image/png" as const,
                display: ":100",
                capturedAt: "2026-09-03T00:00:10.000Z",
              }),
          }),
        );
      },
      now: () => new Date("2026-09-03T00:00:15.000Z"),
    };
    const resident = createComputerBotBackendContribution(host);
    await resident.execute(
      "user-1",
      "scout",
      command("connect", "connect-before-eviction"),
    );
    await resident.settleScheduledWork();

    const reconstructed = createComputerBotBackendContribution(host);
    const receipt = await reconstructed.execute(
      "user-1",
      "scout",
      command("closeViewer", "close-after-eviction"),
    );

    expect(receipt.status).toBe("applied");
    expect(opens).toBe(2);
    expect(workspace.writes).toHaveLength(0);
  });

  test("serves repeated projection file reads from the resident cache", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("must stay wake-free")),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    await contribution.read("user-1", "scout");
    await contribution.read("user-1", "scout");

    // The frame is read from the Bot's own storage; the Workspace is never
    // listed. Only the doctor report is a file, and it is cached.
    expect(workspace.lists).toHaveLength(0);
    expect(workspace.reads).toHaveLength(1);
  });

  test("invalidates the doctor cache when a User-run report is written", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve({
          assignment: { providerId: "fake", generation: 1 },
          identity: { userId: "user-1" },
          tenant: { botId: "scout" },
          capabilities: TEST_HOST_CAPABILITIES,
          doctor: {
            run: () =>
              Promise.resolve({
                schemaVersion: 2,
                generation: 1,
                capturedAt: "2026-09-03T00:00:05.000Z",
                checks: [{ name: "disk", status: "pass", detail: "healthy" }],
                summary: "1 check, 1 passed, 0 failed",
              }),
          },
          close: () => Promise.resolve(),
        }),
      now: () => new Date("2026-09-03T00:00:10.000Z"),
    });
    await contribution.read("user-1", "scout");

    await contribution.execute(
      "user-1",
      "scout",
      command("runDoctor", "doctor-write"),
    );
    const projected = await contribution.read("user-1", "scout");

    expect(workspace.reads).toHaveLength(2);
    expect(projected.doctor?.summary).toBe("1 check, 1 passed, 0 failed");
  });

  test("expires projection file caches so out-of-band durable-root writes surface", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    let now = new Date("2026-09-03T00:00:00.000Z");
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("must stay wake-free")),
      now: () => now,
    });
    await contribution.read("user-1", "scout");
    now = new Date("2026-09-03T00:00:30.001Z");

    await contribution.read("user-1", "scout");

    expect(workspace.lists).toHaveLength(0);
    expect(workspace.reads).toHaveLength(2);
  });

  test("never shares a projection file cache across Bots or Users", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("must stay wake-free")),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    await contribution.read("user-1", "scout");
    await contribution.read("user-1", "builder");
    await contribution.read("user-2", "scout");
    await contribution.read("user-1", "scout");

    expect(workspace.lists).toHaveLength(0);
    expect(workspace.reads).toHaveLength(3);
  });

  test("a frame a subagent's Turn hands the Bot becomes the card's", async () => {
    const storage = new MemoryStorage();
    const contribution = createComputerBotBackendContribution({
      storage,
      workspace: new FakeWorkspace(),
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("must stay wake-free")),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const frame = await computerFrameFromCaptureV1({
      bytes: png(),
      mediaType: "image/png",
      display: ":100",
      capturedAt: "2026-09-03T00:00:05.000Z",
    });

    await contribution.putFrame(frame!);

    expect((await contribution.read("user-1", "scout")).screenshots).toEqual([
      expect.objectContaining({ contentHash: frame!.contentHash }),
    ]);
    expect(await contribution.readFrame(frame!.contentHash)).toEqual({
      bytes: png(),
      mediaType: "image/png",
    });
  });

  test("a cold instance projects the same frame as a warm instance", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    const frame = await computerFrameFromCaptureV1({
      bytes: png(),
      mediaType: "image/png",
      display: ":100",
      capturedAt: "2026-09-03T00:00:00.000Z",
    });
    await computerFrameSinkV1(storage).put(frame!);
    const host = {
      storage,
      workspace,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("must stay wake-free")),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    };
    const warm = createComputerBotBackendContribution(host);
    const expected = await warm.read("user-1", "scout");
    await warm.read("user-1", "scout");

    const cold = createComputerBotBackendContribution(host);
    expect(await cold.read("user-1", "scout")).toEqual(expected);
    expect(expected.screenshots).toEqual([
      {
        version: 1,
        capturedAt: "2026-09-03T00:00:00.000Z",
        contentHash: frame!.contentHash,
        url: `/api/bots/scout/computer/frame/${frame!.contentHash}`,
      },
    ]);
    expect(workspace.lists).toHaveLength(0);
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

  /**
   * The eviction case, end to end: the viewer record outlives the object that
   * minted it, and the URL beside it did not. A connect on the reconstructed
   * object has to come back through the session that is already there rather
   * than provisioning a second desktop for a Bot that already has one.
   */
  test("connect attaches to Bob's running desktop with no stored viewer", async () => {
    const storage = new MemoryStorage();
    let attaches = 0;
    let prepares = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            openViewer: async () => {
              attaches++;
              return {
                id: "bob-viewer",
                url: "https://viewer.invalid/bob",
                expiresAt: "2026-09-02T00:02:00.000Z",
              };
            },
            presence: async () => {
              prepares++;
              throw new Error("must not prepare a running desktop");
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "bob-warm"),
    );
    await contribution.settleScheduledWork();
    expect(attaches).toBe(1);
    expect(prepares).toBe(0);
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "ready",
      viewerSession: { id: "bob-viewer" },
    });
  });

  test("a transport failure during attachment is reported without repeating preparation", async () => {
    const storage = new MemoryStorage();
    let prepares = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            openViewer: async () => {
              throw new ComputerError(
                "provider-unavailable",
                "Host timed out",
                true,
              );
            },
            presence: async () => {
              prepares++;
              throw new Error("must not hide transport failures");
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });
    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "warm-timeout"),
    );
    await contribution.settleScheduledWork();
    expect(prepares).toBe(0);
    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("connect", "warm-timeout"),
      ),
    ).toMatchObject({ status: "rejected", failure: "Host timed out" });
  });

  test("a connect after eviction attaches the stored viewer without waking the host", async () => {
    const storage = new MemoryStorage();
    await storage.put(COMPUTER_VIEWER_RECORD_KEY, {
      version: 1,
      id: "viewer-1",
      expiresAt: "2026-09-02T00:01:30.000Z",
    });
    let opens = 0;
    let connects = 0;
    const renewedWith: string[] = [];
    const commandEffectId = `computer-command-${(
      await sha256HexTextV1("scout\u0000connect-after-eviction")
    ).slice(0, 32)}`;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: (_userId, _botId, effectId) => {
        opens += 1;
        // The attach is charged as this command's own effect, so a replayed
        // command settles against the reservation it already made.
        expect(effectId).toBe(commandEffectId);
        return Promise.resolve(
          fakeHandle({
            presence: () => {
              connects += 1;
              throw new Error("a warm attach must not run the cold prepare");
            },
            renewViewer: (sessionId) => {
              renewedWith.push(sessionId);
              return Promise.resolve({
                id: sessionId,
                url: "https://viewer.invalid/secret",
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
          }),
        );
      },
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });

    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-after-eviction"),
    );
    await contribution.settleScheduledWork();

    expect(connects).toBe(0);
    expect(renewedWith).toEqual(["viewer-1"]);
    // One host session for one host call: the ensure, the display allocation
    // and the five connect steps are all skipped.
    expect(opens).toBe(1);
    const projected = await contribution.read("user-1", "scout");
    expect(projected).toMatchObject({ phase: "ready" });
    expect(projected.viewerSession).toMatchObject({
      id: "viewer-1",
      url: "https://viewer.invalid/secret",
      expiresAt: "2026-09-02T00:02:00.000Z",
    });
    // The bearer URL is still the one thing that never reaches storage.
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "viewer.invalid",
    );
  });

  test("an attach the Computer refuses falls through to the cold connect", async () => {
    const storage = new MemoryStorage();
    await storage.put(COMPUTER_VIEWER_RECORD_KEY, {
      version: 1,
      id: "viewer-gone",
      expiresAt: "2026-09-02T00:01:30.000Z",
    });
    let connects = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () => {
              connects += 1;
              return Promise.resolve({
                id: "viewer-2",
                url: "https://viewer.invalid/fresh",
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
            // What the Fly host answers for a session the Computer no longer
            // holds material for: `host-client.ts` maps the host's
            // `not-found` preserves a missing resource separately from a host failure.
            renewViewer: () =>
              Promise.reject(
                new ComputerError(
                  "not-found",
                  "The Computer viewer session is not available",
                ),
              ),
          }),
        ),
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });

    const receipt = await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-attach-refused"),
    );
    await contribution.settleScheduledWork();

    // The refused attach is an optimisation that did not apply, never a
    // failure the User is told about: the connect is applied and ready.
    expect(receipt).toMatchObject({ status: "accepted" });
    expect(connects).toBe(1);
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "ready",
      viewerSession: { id: "viewer-2" },
    });
  });

  /**
   * The intent's own window: a Bot is browsing, so the shared runtime updates
   * under it, and the User taps Open while that update is in flight. The host
   * refuses the attach in its `computer-updating` vocabulary; the connect has
   * to take that as "not confirmed yet", wait the update out and join. Read
   * as a final failure, that refusal leaves the one gesture the User made
   * showing an update that never ends.
   */
  test("a connect during an in-flight update waits it out and joins", async () => {
    const storage = new MemoryStorage();
    let attaches = 0;
    let joins = 0;
    let contribution: ReturnType<typeof createComputerBotBackendContribution>;
    contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            openViewer: () => {
              attaches += 1;
              return Promise.reject(
                new ComputerError(
                  "updating",
                  "Updating the Computer runtime",
                  true,
                ),
              );
            },
            presence: async (options) => {
              joins += 1;
              await options?.onProgress?.({
                version: 1,
                kind: "update",
                step: "updating",
                label: "Updating the Computer runtime",
                index: 1,
                total: 1,
              });
              // While it waits, the card carries the host's own phase, not the
              // sentence the refused attach was told.
              expect(await contribution.read("user-1", "scout")).toMatchObject({
                phase: "updating",
                message: "Updating the Computer runtime",
                progress: {
                  kind: "update",
                  steps: [
                    {
                      label: "Updating the Computer runtime",
                      status: "active",
                    },
                  ],
                },
              });
              return {
                id: "viewer-updated",
                url: "https://viewer.invalid/updated",
                expiresAt: "2026-09-02T00:02:00.000Z",
              };
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });

    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-mid-update"),
    );
    await contribution.settleScheduledWork();

    expect(attaches).toBe(1);
    expect(joins).toBe(1);
    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("connect", "connect-mid-update"),
      ),
    ).toMatchObject({ status: "applied" });
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "ready",
      message: "Computer ready",
      viewerSession: {
        id: "viewer-updated",
        url: "https://viewer.invalid/updated",
      },
    });
  });

  test("an expired viewer record is a cold prepare, not an attach", async () => {
    const storage = new MemoryStorage();
    await storage.put(COMPUTER_VIEWER_RECORD_KEY, {
      version: 1,
      id: "viewer-stale",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    let connects = 0;
    let renews = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () =>
        Promise.resolve(
          fakeHandle({
            presence: () => {
              connects += 1;
              return Promise.resolve({
                id: "viewer-3",
                url: "https://viewer.invalid/fresh",
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
            renewViewer: (sessionId) => {
              renews += 1;
              return Promise.resolve({
                id: sessionId,
                url: "https://viewer.invalid/stale",
                expiresAt: "2026-09-02T00:02:00.000Z",
              });
            },
          }),
        ),
      now: () => new Date("2026-09-02T00:01:00.000Z"),
    });

    await contribution.execute(
      "user-1",
      "scout",
      command("connect", "connect-expired-record"),
    );
    await contribution.settleScheduledWork();

    expect(renews).toBe(0);
    expect(connects).toBe(1);
  });

  /**
   * The card polls this read every 1.5 seconds while a Computer is working,
   * and `viewer renew` is a charged host operation. Reading what the Computer
   * is doing must therefore never renew anything: recovery is a command with a
   * durable intent behind it, and this is the line between the two.
   */
  test("a projection read never renews a viewer, however often it is polled", async () => {
    const storage = new MemoryStorage();
    await storage.put(COMPUTER_VIEWER_RECORD_KEY, {
      version: 1,
      id: "viewer-1",
      expiresAt: "2026-09-02T00:01:30.000Z",
    });
    let opens = 0;
    const contribution = createComputerBotBackendContribution({
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => {
        opens += 1;
        throw new Error("a read must not reach the Computer");
      },
      now: () => new Date("2026-09-02T00:00:30.000Z"),
    });

    for (let poll = 0; poll < 5; poll += 1) {
      const projected = await contribution.read("user-1", "scout");
      // A session it cannot speak for is not one it offers: the record alone
      // makes the Computer reconnectable, not ready.
      expect(projected.viewerSession).toBeUndefined();
      expect(projected.phase).toBe("idle");
      expect(projected.message).toBe("Reconnect to pick up where you left off");
    }
    expect(opens).toBe(0);
  });
});

/**
 * The host application's vault, in memory: the same refusals the User's
 * Durable Object makes, and the sign-ins in the clear because nothing here
 * is a secret.
 */
class MemoryLoginVault implements ComputerLoginVaultV1 {
  held?: ComputerLoginsKeptV1;
  owedSince?: string;
  deletedAt?: string;
  readonly keeps: ComputerLoginsKeepOutcomeV1[] = [];

  /** "Delete my Computer", as the User's object records it. */
  forget(at: string): void {
    this.held = undefined;
    this.owedSince = undefined;
    this.deletedAt = at;
  }

  deletedSince(at: string): Promise<boolean> {
    return Promise.resolve(
      this.deletedAt !== undefined && this.deletedAt >= at,
    );
  }

  owed(): Promise<string | undefined> {
    return Promise.resolve(this.owedSince);
  }

  kept(): Promise<ComputerLoginsKeptV1 | undefined> {
    return Promise.resolve(this.held);
  }

  keep(capture: ComputerLoginsKeptV1): Promise<ComputerLoginsKeepOutcomeV1> {
    const outcome: ComputerLoginsKeepOutcomeV1 = this.owedSince
      ? "owed"
      : (this.deletedAt !== undefined &&
            this.deletedAt >= capture.capturedAt) ||
          (this.held && this.held.capturedAt >= capture.capturedAt)
        ? "stale"
        : "kept";
    if (outcome === "kept") this.held = capture;
    this.keeps.push(outcome);
    return Promise.resolve(outcome);
  }

  owe(at: string): Promise<"owed" | "deleted"> {
    if (this.deletedAt !== undefined && this.deletedAt >= at) {
      return Promise.resolve("deleted");
    }
    this.owedSince ??= at;
    return Promise.resolve("owed");
  }

  settle(owedSince: string): Promise<void> {
    if (this.owedSince === owedSince) this.owedSince = undefined;
    return Promise.resolve();
  }
}

describe("Update, Reset and the User's sign-ins", () => {
  function machineHost(options: { now?: () => Date } = {}) {
    const storage = new MemoryStorage();
    // Before the in-memory host's viewer sessions expire, so a viewer the
    // Update mints is a live one.
    const now = options.now ?? (() => new Date("2023-11-14T22:00:00.000Z"));
    const computers = createFakeComputerHostV1({
      now: () => now().getTime(),
    });
    const vault = new MemoryLoginVault();
    const host = {
      storage,
      configured: true,
      providerLabel: "Fake Computer",
      now,
      loginVault: () => vault,
      openComputer: (userId: string, botId: string, _effectId: string) =>
        computers.open(
          { userId },
          { botId },
          { providerId: computers.id, generation: 1 },
        ),
    };
    const machine = computers.computerFor({ userId: "user-1" });
    return { storage, computers, machine, vault, host };
  }

  test("an Update keeps the sign-ins, replaces the machine and puts them back", async () => {
    const { storage, computers, machine, vault, host } = machineHost();
    machine.signIns = ["mail.example", "bank.example"];
    machine.checkpoints.push({
      id: "old-checkpoint",
      createdAt: "2023-11-01T00:00:00.000Z",
      signIns: [],
    });
    const contribution = createComputerBotBackendContribution(host);

    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("updateComputer", "update-1"),
      ),
    ).toMatchObject({ version: 2, type: "updateComputer", status: "accepted" });
    // Admitted, and the card says what is under way before anything ran.
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "updating",
      progress: {
        kind: "update",
        steps: [
          { id: "keeping-sign-ins", status: "active" },
          { id: "replacing", status: "pending" },
          { id: "preparing", status: "pending" },
          { id: "restoring-sign-ins", status: "pending" },
        ],
      },
    });
    await contribution.settleScheduledWork();

    expect(computers.calls).toContain("replace:user-1");
    // The fresh machine has the sign-ins the old one had, and nothing owes
    // them any more.
    expect(machine.signIns).toEqual(["mail.example", "bank.example"]);
    expect(fakeLoginNamesV1(vault.held!.state)).toEqual([
      "mail.example",
      "bank.example",
    ]);
    expect(vault.owedSince).toBeUndefined();
    // Its first checkpoint is where a Reset of it goes.
    expect(machine.checkpoints).toHaveLength(1);
    const projected = await contribution.read("user-1", "scout");
    expect(projected).toMatchObject({
      phase: "ready",
      checkpoint: { version: 1, createdAt: machine.checkpoints[0]!.createdAt },
    });
    expect(projected.viewerSession?.url).toContain("viewer.invalid");
    expect(storage.values.has(COMPUTER_PENDING_CONNECT_KEY)).toBe(false);
    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("updateComputer", "update-1"),
      ),
    ).toMatchObject({ version: 1, status: "applied" });
  });

  test("a Reset goes back to the checkpoint and keeps the newer sign-ins", async () => {
    const { computers, machine, vault, host } = machineHost();
    machine.signIns = ["old.example"];
    const contribution = createComputerBotBackendContribution(host);
    await contribution.execute(
      "user-1",
      "scout",
      command("saveCheckpoint", "checkpoint-1"),
    );
    const saved = machine.checkpoints[0]!;
    machine.signIns = ["old.example", "new.example"];

    await contribution.execute(
      "user-1",
      "scout",
      command("resetComputer", "reset-1"),
    );
    await contribution.settleScheduledWork();

    expect(computers.calls).toContain("reset:scout");
    // The machine went back; the sign-ins made since came back with it.
    expect(machine.signIns).toEqual(["old.example", "new.example"]);
    expect(vault.owedSince).toBeUndefined();
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "ready",
      checkpoint: { createdAt: saved.createdAt },
    });
  });

  test("a Reset with nothing to go back to changes nothing and owes nothing", async () => {
    const { machine, vault, host } = machineHost();
    machine.signIns = ["mail.example"];
    const contribution = createComputerBotBackendContribution(host);

    await contribution.execute(
      "user-1",
      "scout",
      command("resetComputer", "reset-1"),
    );
    await contribution.settleScheduledWork();

    expect(vault.owedSince).toBeUndefined();
    expect(machine.signIns).toEqual(["mail.example"]);
    expect(await contribution.read("user-1", "scout")).toMatchObject({
      phase: "error",
      message: "This Computer has no checkpoint to reset to yet",
    });
    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("resetComputer", "reset-1"),
      ),
    ).toMatchObject({ status: "rejected" });
  });

  test("an Update is refused while another start is pending, never folded into it", async () => {
    const { computers, host } = machineHost();
    const contribution = createComputerBotBackendContribution(host);
    await contribution.execute("user-1", "scout", command("connect", "c-1"));

    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("updateComputer", "update-1"),
      ),
    ).toMatchObject({
      version: 1,
      status: "rejected",
      failure: "The Computer is already starting. Try again once it is ready.",
    });
    // A connect asked for during an Update is the Update's own connect.
    await contribution.settleScheduledWork();
    await contribution.execute(
      "user-1",
      "scout",
      command("updateComputer", "update-2"),
    );
    expect(
      await contribution.execute("user-1", "scout", command("connect", "c-2")),
    ).toMatchObject({ version: 2, type: "connect", status: "accepted" });
    await contribution.settleScheduledWork();
    expect(
      computers.calls.filter((call) => call === "replace:user-1"),
    ).toHaveLength(1);
  });

  test("a replay after eviction resumes rather than replacing the machine again", async () => {
    const { computers, machine, vault, host, storage } = machineHost();
    machine.signIns = ["mail.example"];
    const evicted = createComputerBotBackendContribution({
      ...host,
      openComputer: async (userId, botId, effectId) => {
        const session = await host.openComputer(userId, botId, effectId);
        // The object is evicted while the new machine comes up.
        return {
          ...session,
          presence: { connect: () => new Promise<never>(() => undefined) },
        };
      },
    });
    await evicted.execute("user-1", "scout", command("updateComputer", "u-1"));
    void evicted.settleScheduledWork();
    for (let wait = 0; wait < 200; wait += 1) {
      const pending = storage.values.get(COMPUTER_PENDING_CONNECT_KEY) as
        { machineAt?: string } | undefined;
      if (pending?.machineAt) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const cold = createComputerBotBackendContribution(host);
    await cold.settleScheduledWork();

    expect(
      computers.calls.filter((call) => call.startsWith("replace")),
    ).toEqual(["replace:user-1"]);
    expect(machine.signIns).toEqual(["mail.example"]);
    expect(vault.owedSince).toBeUndefined();
    expect(
      await cold.execute("user-1", "scout", command("updateComputer", "u-1")),
    ).toMatchObject({ version: 1, status: "applied" });
  });

  test("an Update whose new machine never came up leaves the sign-ins owed to the next open", async () => {
    const { machine, vault, host } = machineHost();
    machine.signIns = ["mail.example"];
    const failing = createComputerBotBackendContribution({
      ...host,
      openComputer: async (userId, botId, effectId) => {
        const session = await host.openComputer(userId, botId, effectId);
        return {
          ...session,
          presence: {
            connect: () => Promise.reject(new Error("no answer in time")),
          },
        };
      },
    });
    await failing.execute("user-1", "scout", command("updateComputer", "u-1"));
    await failing.settleScheduledWork();
    expect(vault.owedSince).toBeDefined();
    expect(machine.signIns).toEqual([]);

    const warm = createComputerBotBackendContribution(host);
    await warm.execute("user-1", "scout", command("connect", "c-1"));
    await warm.settleScheduledWork();

    expect(machine.signIns).toEqual(["mail.example"]);
    expect(vault.owedSince).toBeUndefined();
  });

  /**
   * "Delete my Computer" as the User's object runs it: the kept sign-ins are
   * forgotten on both sides of the teardown.
   */
  async function deleteComputer(
    computers: ReturnType<typeof createFakeComputerHostV1>,
    vault: MemoryLoginVault,
    at: string,
  ): Promise<void> {
    vault.forget(at);
    await computers.teardown({ userId: "user-1" });
    vault.forget(at);
  }

  /** Whether anything opened the Computer after its last teardown. */
  function openedAfterTeardown(calls: readonly string[]): boolean {
    const torn = calls.lastIndexOf("teardown:user-1");
    return calls.slice(torn + 1).some((call) => call.startsWith("open:"));
  }

  for (const when of ["overtakes the replace", "lands after the replace"]) {
    test(`a Delete my Computer that ${when} brings nothing back`, async () => {
      const { computers, machine, vault, host } = machineHost();
      machine.signIns = ["mail.example"];
      const contribution = createComputerBotBackendContribution({
        ...host,
        openComputer: async (userId, botId, effectId) => {
          const session = await host.openComputer(userId, botId, effectId);
          const replace = session.machine!.replace;
          return {
            ...session,
            machine: {
              ...session.machine!,
              replace: async (options) => {
                if (when === "overtakes the replace") {
                  await deleteComputer(
                    computers,
                    vault,
                    host.now().toISOString(),
                  );
                  await replace(options);
                } else {
                  await replace(options);
                  await deleteComputer(
                    computers,
                    vault,
                    host.now().toISOString(),
                  );
                }
              },
            },
          };
        },
      });

      await contribution.execute(
        "user-1",
        "scout",
        command("updateComputer", "update-1"),
      );
      await contribution.settleScheduledWork();

      expect(computers.calls).toContain("teardown:user-1");
      // No machine was opened for it, and no sign-in outlived the deletion.
      expect(openedAfterTeardown(computers.calls)).toBe(false);
      expect(
        computers.calls.filter((call) => call.startsWith("logins:restore")),
      ).toEqual([]);
      expect(vault.held).toBeUndefined();
      expect(vault.owedSince).toBeUndefined();
      expect(await contribution.read("user-1", "scout")).toMatchObject({
        phase: "error",
      });
      expect(
        await contribution.execute(
          "user-1",
          "scout",
          command("updateComputer", "update-1"),
        ),
      ).toMatchObject({ status: "rejected" });
    });
  }

  test("an Update or a Reset asked for before a Delete my Computer refuses to run", async () => {
    for (const type of ["updateComputer", "resetComputer"] as const) {
      const { computers, machine, vault, host } = machineHost();
      machine.signIns = ["mail.example"];
      const contribution = createComputerBotBackendContribution(host);
      await contribution.execute(
        "user-1",
        "scout",
        command("saveCheckpoint", "checkpoint-1"),
      );
      expect(
        await contribution.execute("user-1", "scout", command(type, "renew-1")),
      ).toMatchObject({ status: "accepted" });

      await deleteComputer(computers, vault, host.now().toISOString());
      await contribution.settleScheduledWork();

      expect(
        computers.calls.filter(
          (call) => call.startsWith("replace") || call.startsWith("reset"),
        ),
      ).toEqual([]);
      expect(openedAfterTeardown(computers.calls)).toBe(false);
      expect(vault.owedSince).toBeUndefined();
      expect(await contribution.read("user-1", "scout")).toMatchObject({
        phase: "error",
        message: expect.stringMatching(/deleted after this was asked for/),
      });
    }
  });

  test("handing the desktop back keeps the sign-ins made during it", async () => {
    const { machine, vault, host } = machineHost();
    const contribution = createComputerBotBackendContribution({
      ...host,
      newId: () => "owner-1",
    });
    await contribution.execute("user-1", "scout", command("takeControl", "t"));
    machine.signIns = ["mail.example"];

    await contribution.execute(
      "user-1",
      "scout",
      command("releaseControl", "r"),
    );

    expect(vault.keeps).toEqual(["kept"]);
    expect(fakeLoginNamesV1(vault.held!.state)).toEqual(["mail.example"]);
  });

  test("a machine that has not had its sign-ins back is never captured in their place", async () => {
    const { machine, vault, host } = machineHost();
    vault.held = {
      state: fakeLoginsStateV1(["mail.example"]),
      count: 1,
      capturedAt: "2023-11-13T00:00:00.000Z",
    };
    vault.owedSince = "2023-11-13T12:00:00.000Z";
    machine.signIns = [];
    const contribution = createComputerBotBackendContribution({
      ...host,
      newId: () => "owner-1",
    });
    await contribution.execute("user-1", "scout", command("takeControl", "t"));

    await contribution.execute(
      "user-1",
      "scout",
      command("releaseControl", "r"),
    );

    expect(vault.keeps).toEqual(["owed"]);
    expect(fakeLoginNamesV1(vault.held.state)).toEqual(["mail.example"]);
  });

  test("a saved checkpoint is what the card says Reset returns to", async () => {
    const { machine, host } = machineHost({
      now: () => new Date("2026-09-24T03:00:00.000Z"),
    });
    const contribution = createComputerBotBackendContribution(host);

    expect(
      await contribution.execute(
        "user-1",
        "scout",
        command("saveCheckpoint", "checkpoint-1"),
      ),
    ).toMatchObject({ version: 1, status: "applied" });

    expect(machine.checkpoints).toHaveLength(1);
    expect((await contribution.read("user-1", "scout")).checkpoint).toEqual({
      version: 1,
      createdAt: "2026-09-24T03:00:00.000Z",
    });
  });
});
