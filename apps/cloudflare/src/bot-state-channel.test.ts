import { describe, expect, test } from "bun:test";
import {
  COMPUTER_CONNECT_START_DELAY_MS,
  createComputerBotBackendContribution,
} from "@frockbot/plugin-computer/bot";
import { BotStateChannel } from "./bot-state-channel.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, structuredClone(value));
    } else {
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

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarmAt);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    return Promise.resolve();
  }
}

describe("Bot-state channel Computer storage", () => {
  test("leaves the authority alarm armed immediately after connect admission", async () => {
    const storage = new MemoryStorage();
    const state = {
      storage,
      getWebSockets: () => [],
    } as unknown as DurableObjectState;
    const channel = new BotStateChannel(state);
    const now = new Date("2026-09-03T00:00:00.000Z");
    const computer = createComputerBotBackendContribution({
      storage: channel.computerStorage,
      configured: true,
      providerLabel: "Fake Computer",
      openComputer: () => Promise.reject(new Error("alarm has not fired")),
      now: () => now,
    });
    channel.setAlarmRefresher(async (transaction) => {
      const deadlines = await computer.scheduledDeadlines(transaction);
      if (deadlines.length === 0) await transaction.deleteAlarm();
      else await transaction.setAlarm(Math.min(...deadlines));
    });

    expect(
      await computer.execute("user-1", "scout", {
        version: 1,
        commandId: "connect-1",
        botId: "scout",
        type: "connect",
      }),
    ).toMatchObject({ version: 2, status: "accepted" });

    expect(await storage.getAlarm()).toBe(
      now.getTime() + COMPUTER_CONNECT_START_DELAY_MS,
    );
  });
});

describe("Bot-state channel run observation", () => {
  function observedChannel(): {
    channel: BotStateChannel;
    storage: MemoryStorage;
    sent: string[];
    observed: DurableObjectState;
  } {
    const storage = new MemoryStorage();
    const sent: string[] = [];
    const socket = {
      deserializeAttachment: () => ({
        schemaVersion: 1,
        userId: "user-1",
        botId: "scout",
        lastSent: "0",
      }),
      serializeAttachment: () => undefined,
      send: (frame: string) => sent.push(frame),
      close: () => undefined,
    };
    const state = {
      storage,
      getWebSockets: () => [socket],
    } as unknown as DurableObjectState;
    const channel = new BotStateChannel(state);
    return { channel, storage, sent, observed: channel.observeRuns(state) };
  }

  /** The notice is appended after the write, so it lands a task later. */
  const settle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });

  test("a committed run write reaches an attached observer", async () => {
    const { storage, sent, observed } = observedChannel();

    await observed.storage.put("run:run-1", { status: "running" });
    await settle();

    expect(storage.values.get("run:run-1")).toEqual({ status: "running" });
    expect(sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { schemaVersion: 1, type: "state/event", cursor: "1", topic: "runs" },
    ]);
  });

  test("a run write inside a transaction is observed too", async () => {
    const { sent, observed } = observedChannel();

    await observed.storage.transaction(async (transaction) => {
      await transaction.put({ "active-run": "run-1" });
    });
    await settle();

    expect(sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { schemaVersion: 1, type: "state/event", cursor: "1", topic: "runs" },
    ]);
  });

  test("writes that are not run state say nothing", async () => {
    const { sent, observed } = observedChannel();

    await observed.storage.put("identity", { botId: "scout" });
    await observed.storage.transaction(async (transaction) => {
      await transaction.put("latest-events", []);
    });
    await settle();

    expect(sent).toEqual([]);
  });

  test("a burst of run writes is coalesced", async () => {
    const { sent, observed } = observedChannel();

    await Promise.all([
      observed.storage.put("run:run-1", { status: "running" }),
      observed.storage.put("run:run-1", { status: "running" }),
      observed.storage.put("run:run-1", { status: "completed" }),
    ]);
    await settle();

    // Fewer notices than writes, and never none: an observer only ever needs
    // to know that it should read again.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(3);
  });
});
