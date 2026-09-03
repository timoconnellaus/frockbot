import { describe, expect, test } from "bun:test";
import type {
  ComputerConnectionOptionsV1,
  ComputerControlLease,
  ComputerHandle,
} from "@frockbot/computer-core";
import { computerBotPathKeyV1, ComputerError } from "@frockbot/computer-core";
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
import { FakeWorkspace } from "./workspace-fixture.js";

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

  test("captures the current desktop when a live viewer closes, attributed to the User", async () => {
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
    expect(opens).toBe(2);
    expect(workspace.writes).toHaveLength(1);
    expect(workspace.writes[0]?.writer).toEqual({
      kind: "user",
      userId: "user-1",
    });
    expect((await contribution.read("user-1", "scout")).screenshots).toEqual([
      expect.objectContaining({
        path: expect.stringContaining("close-viewer"),
      }),
    ]);
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
    await createComputerBotBackendContribution(host).execute(
      "user-1",
      "scout",
      command("connect", "connect-before-eviction"),
    );

    const reconstructed = createComputerBotBackendContribution(host);
    const receipt = await reconstructed.execute(
      "user-1",
      "scout",
      command("closeViewer", "close-after-eviction"),
    );

    expect(receipt.status).toBe("applied");
    expect(opens).toBe(1);
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

    expect(workspace.lists).toHaveLength(1);
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

    expect(workspace.lists).toHaveLength(2);
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

    expect(workspace.lists).toHaveLength(3);
    expect(workspace.reads).toHaveLength(3);
  });

  test("a cold instance projects the same files as a warm instance", async () => {
    const storage = new MemoryStorage();
    const workspace = new FakeWorkspace();
    await workspace.write({
      path: {
        root: {
          kind: "package-declared",
          userId: "user-1",
          packageId: "computer",
          rootId: "screenshots",
        },
        path: `${computerBotPathKeyV1("scout")}/capture.png`,
      },
      bytes: png(),
      writer: { kind: "user", userId: "user-1" },
    });
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
    expect(workspace.lists).toHaveLength(2);
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
