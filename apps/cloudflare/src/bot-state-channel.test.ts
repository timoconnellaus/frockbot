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
