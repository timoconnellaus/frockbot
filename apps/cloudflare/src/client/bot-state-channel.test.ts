/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  BrowserBotStateChannel,
  type BotStateChannelRuntime,
} from "./bot-state-channel.js";

class FakeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({} as Event);
  }

  message(value: unknown): void {
    this.onmessage?.({ data: value } as MessageEvent<unknown>);
  }

  drop(): void {
    this.onclose?.({} as CloseEvent);
  }
}

class FakeRuntime implements BotStateChannelRuntime {
  visible = true;
  refuse = false;
  readonly sockets: { url: string; socket: FakeSocket }[] = [];
  readonly cursors = new Map<string, string>();
  readonly timers = new Map<number, () => void>();
  private nextTimer = 1;
  private visibility?: () => void;

  origin(): string {
    return "https://app.example";
  }

  createSocket(url: string): FakeSocket {
    if (this.refuse) throw new Error("proxy refused WebSockets");
    const socket = new FakeSocket();
    this.sockets.push({ url, socket });
    return socket;
  }

  isVisible(): boolean {
    return this.visible;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibility = listener;
    return () => {
      this.visibility = undefined;
    };
  }

  setTimeout(callback: () => void): number {
    const handle = this.nextTimer++;
    this.timers.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  readCursor(botId: string): string | undefined {
    return this.cursors.get(botId);
  }

  writeCursor(botId: string, cursor: string): void {
    this.cursors.set(botId, cursor);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibility?.();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("browser Bot-state channel", () => {
  test("enters fallback when the upgrade cannot be established", () => {
    const runtime = new FakeRuntime();
    runtime.refuse = true;
    const statuses: string[] = [];
    const channel = new BrowserBotStateChannel(runtime);

    channel.watch("scout", {
      invalidate: () => Promise.resolve(),
      status: (status) => statuses.push(status),
    });

    expect(statuses.at(-1)).toBe("fallback");
    expect(runtime.timers.size).toBe(1);
    channel.dispose();
  });

  test("falls back when an upgraded socket never completes its replay", () => {
    const runtime = new FakeRuntime();
    const statuses: string[] = [];
    const channel = new BrowserBotStateChannel(runtime);
    channel.watch("scout", {
      invalidate: () => Promise.resolve(),
      status: (status) => statuses.push(status),
    });
    runtime.sockets[0]?.socket.open();
    const timeout = [...runtime.timers.values()][0];
    if (!timeout) throw new Error("connection timeout was not armed");
    timeout();

    expect(statuses.at(-1)).toBe("fallback");
    expect(runtime.sockets[0]?.socket.closed).toBe(true);
    channel.dispose();
  });

  test("persists a cursor only after each invalidation is applied", async () => {
    const runtime = new FakeRuntime();
    runtime.cursors.set("scout", "4");
    const applied: (string | undefined)[] = [];
    const channel = new BrowserBotStateChannel(runtime);
    channel.watch("scout", {
      invalidate: async (topic) => {
        applied.push(topic);
      },
      status: () => {},
    });
    const opened = runtime.sockets[0];
    expect(opened?.url).toContain("cursor=4");
    opened?.socket.open();
    opened?.socket.message(
      JSON.stringify({
        schemaVersion: 1,
        type: "state/event",
        cursor: "5",
        topic: "computer",
      }),
    );
    opened?.socket.message(
      JSON.stringify({
        schemaVersion: 1,
        type: "state/reset",
        cursor: "8",
        reason: "gap",
      }),
    );
    await flush();
    await flush();
    await flush();

    expect(applied).toEqual(["computer", undefined]);
    expect(runtime.cursors.get("scout")).toBe("8");
    channel.dispose();
  });

  test("falls back and resumes from the last applied cursor on a live gap", async () => {
    const runtime = new FakeRuntime();
    runtime.cursors.set("scout", "4");
    const statuses: string[] = [];
    const channel = new BrowserBotStateChannel(runtime);
    channel.watch("scout", {
      invalidate: () => Promise.resolve(),
      status: (status) => statuses.push(status),
    });
    const opened = runtime.sockets[0];
    opened?.socket.open();
    opened?.socket.message(
      JSON.stringify({
        schemaVersion: 1,
        type: "state/event",
        cursor: "6",
        topic: "computer",
      }),
    );
    await flush();
    await flush();

    expect(statuses.at(-1)).toBe("fallback");
    expect(runtime.cursors.get("scout")).toBe("4");
    expect(opened?.socket.closed).toBe(true);
    channel.dispose();
  });

  test("a hidden tab holds no eager socket and reconnects when visible", () => {
    const runtime = new FakeRuntime();
    runtime.visible = false;
    const statuses: string[] = [];
    const channel = new BrowserBotStateChannel(runtime);
    channel.watch("scout", {
      invalidate: () => Promise.resolve(),
      status: (status) => statuses.push(status),
    });

    expect(runtime.sockets).toHaveLength(0);
    expect(statuses.at(-1)).toBe("hidden");
    runtime.setVisible(true);
    expect(runtime.sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe("connecting");
    channel.dispose();
  });
});
