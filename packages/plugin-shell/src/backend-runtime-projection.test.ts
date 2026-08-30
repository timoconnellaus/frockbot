import { describe, expect, test } from "bun:test";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createShellBotBackendContribution,
  type ShellBotBackendHost,
} from "./backend.js";
import type { BotResidentExecution } from "./backend-execution.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ) as Array<[string, T]>,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

const user: UserSettingsViewV1 = {
  schemaVersion: 1,
  revision: 0,
  profile: { name: "User" },
  packages: [],
  connections: [],
};

function host(
  storage: MemoryStorage,
  execution: BotResidentExecution,
): ShellBotBackendHost {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: () => "user-id",
        get: () => ({
          readConfiguration: () => Promise.resolve(user),
        }),
      },
    } as unknown as ShellBotBackendHost["env"],
    execution,
  };
}

const identity = { userId: "user-1", botId: "primary" };
const turn = {
  ...identity,
  runId: "run-1",
  sessionId: "user-1:primary",
  acceptedAt: "2026-08-30T00:00:00.000Z",
  text: "hello",
};

describe("resident Bot runtime projection", () => {
  test("durably fails closed and retries the desired generation through alarm recovery", async () => {
    const storage = new MemoryStorage();
    let attempts = 0;
    const execution: BotResidentExecution = {
      project: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("fixture projection failure"))
          : Promise.resolve();
      },
      execute: () => Promise.reject(new Error("must not execute")),
      generation: () => undefined,
    };
    const contribution = createShellBotBackendContribution(
      host(storage, execution),
    );
    await contribution.materializeSettings(identity, { name: "Primary" });

    await expect(contribution.run(turn)).rejects.toThrow(
      "fixture projection failure",
    );
    expect(await contribution.readRuntimeProjection()).toEqual({
      schemaVersion: 1,
      desiredGeneration: 0,
      status: "failed",
      failure: "fixture projection failure",
    });
    expect(storage.alarmAt).toBeNumber();

    await contribution.alarm();
    expect(attempts).toBe(2);
    expect(await contribution.readRuntimeProjection()).toEqual({
      schemaVersion: 1,
      desiredGeneration: 0,
      status: "applied",
      appliedGeneration: 0,
    });
  });

  test("preserves active work when cold projection fails and retries before execution", async () => {
    const storage = new MemoryStorage();
    const settings = {
      ...initializeBotSettingsV1(identity.botId),
      profile: { name: "Primary" },
    };
    const run = {
      runId: turn.runId,
      commandFingerprint: botTurnCommandFingerprintV1(turn),
      sessionId: turn.sessionId,
      acceptedAt: turn.acceptedAt,
      input: turn.text,
      events: [],
      status: "running",
      phase: "admitted",
      configurationSnapshot: settings,
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      identity,
      "bot-configuration": settings,
      "runtime-projection": {
        schemaVersion: 1,
        desiredGeneration: 0,
        status: "applied",
        appliedGeneration: 0,
      },
      "active-run": turn.runId,
      [`run:${turn.runId}`]: run,
      "latest-events": [],
    });
    let projectionAttempts = 0;
    let executions = 0;
    const execution: BotResidentExecution = {
      project: () => {
        projectionAttempts += 1;
        return projectionAttempts === 1
          ? Promise.reject(new Error("cold projection failed"))
          : Promise.resolve();
      },
      execute: () => {
        executions += 1;
        return Promise.reject(new Error("fixture execution ended"));
      },
      generation: () => (projectionAttempts > 1 ? 0 : undefined),
    };
    const contribution = createShellBotBackendContribution(
      host(storage, execution),
    );

    await expect(contribution.alarm()).rejects.toThrow(
      "cold projection failed",
    );
    expect(executions).toBe(0);
    expect(await storage.get<string>("active-run")).toBe(turn.runId);
    expect(await storage.get<StoredRun>(`run:${turn.runId}`)).toMatchObject({
      status: "running",
    });
    expect(await contribution.readRuntimeProjection()).toEqual({
      schemaVersion: 1,
      desiredGeneration: 0,
      status: "failed",
      failedGeneration: 0,
      failure: "cold projection failed",
    });
    expect(storage.alarmAt).toBeNumber();

    await expect(contribution.alarm()).rejects.toThrow(
      "fixture execution ended",
    );
    expect(executions).toBe(1);
    expect(await storage.get<string>("active-run")).toBeUndefined();
    expect(await storage.get<StoredRun>(`run:${turn.runId}`)).toMatchObject({
      status: "failed",
      failure: "fixture execution ended",
    });
  });

  test("keeps the admitted generation while configuration advances", async () => {
    const storage = new MemoryStorage();
    const projected: number[] = [];
    let rejectExecution: ((error: Error) => void) | undefined;
    const executing = new Promise<never>((_resolve, reject) => {
      rejectExecution = reject;
    });
    const execution: BotResidentExecution = {
      project: (projection) => {
        if (projected.at(-1) !== projection.generation) {
          projected.push(projection.generation);
        }
        return Promise.resolve();
      },
      execute: () => executing,
      generation: () => projected.at(-1),
    };
    const contribution = createShellBotBackendContribution(
      host(storage, execution),
    );
    await contribution.materializeSettings(identity, { name: "Primary" });

    const running = contribution.run(turn);
    for (
      let attempt = 0;
      attempt < 100 && projected.length === 0;
      attempt += 1
    ) {
      await Bun.sleep(1);
    }
    expect(projected).toEqual([0]);
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
      botId: identity.botId,
      command: {
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "rename-1",
        expectedRevision: 0,
        botId: identity.botId,
        profile: { name: "Renamed" },
      },
    });

    expect(projected).toEqual([0]);
    expect(await contribution.readRuntimeProjection()).toEqual({
      schemaVersion: 1,
      desiredGeneration: 1,
      status: "pending",
    });

    rejectExecution?.(new Error("fixture turn ended"));
    await expect(running).rejects.toThrow("fixture turn ended");
    await contribution.alarm();
    expect(projected).toEqual([0, 1]);
    expect(await contribution.readRuntimeProjection()).toEqual({
      schemaVersion: 1,
      desiredGeneration: 1,
      status: "applied",
      appliedGeneration: 1,
    });
  });
});
