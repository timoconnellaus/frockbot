import {
  decodeBotStateChannelFrameV1,
  decodeBotStateCursorV1,
  type BotStateTopicV1,
} from "@frockbot/protocol";

export type BotStateChannelStatus =
  "connecting" | "open" | "fallback" | "hidden";

export interface BotStateChannelObserver {
  invalidate(topic: BotStateTopicV1 | undefined): Promise<void>;
  status(status: BotStateChannelStatus): void;
}

interface SocketLike {
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface BotStateChannelRuntime {
  origin(): string;
  createSocket(url: string): SocketLike;
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  readCursor(botId: string): string | undefined;
  writeCursor(botId: string, cursor: string): void;
}

interface Entry {
  readonly botId: string;
  readonly observers: Set<BotStateChannelObserver>;
  socket?: SocketLike;
  retry?: unknown;
  timeout?: unknown;
  token: number;
  attempt: number;
  status: BotStateChannelStatus;
  queue: Promise<void>;
  cursor?: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RETRY_MS = 30_000;

function browserRuntime(): BotStateChannelRuntime {
  return {
    origin: () => window.location.origin,
    createSocket: (url) => new WebSocket(url),
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    readCursor: (botId) => {
      try {
        return (
          sessionStorage.getItem(`frockbot:bot-state:v1:${botId}`) ?? undefined
        );
      } catch {
        return undefined;
      }
    },
    writeCursor: (botId, cursor) => {
      try {
        sessionStorage.setItem(`frockbot:bot-state:v1:${botId}`, cursor);
      } catch {
        // Cursor persistence is an optimization. A reset re-reads authority.
      }
    },
  };
}

export class BrowserBotStateChannel {
  private readonly entries = new Map<string, Entry>();
  private readonly stopVisibility: () => void;
  private disposed = false;

  constructor(
    private readonly runtime: BotStateChannelRuntime = browserRuntime(),
  ) {
    this.stopVisibility = runtime.onVisibilityChange(() =>
      this.visibilityChanged(),
    );
  }

  watch(botId: string, observer: BotStateChannelObserver): () => void {
    if (this.disposed) throw new Error("Bot-state channel is disposed");
    let entry = this.entries.get(botId);
    if (!entry) {
      entry = {
        botId,
        observers: new Set(),
        token: 0,
        attempt: 0,
        status: this.runtime.isVisible() ? "connecting" : "hidden",
        queue: Promise.resolve(),
      };
      this.entries.set(botId, entry);
    }
    entry.observers.add(observer);
    observer.status(entry.status);
    if (entry.observers.size === 1 && this.runtime.isVisible()) {
      this.connect(entry);
    }
    return () => {
      entry?.observers.delete(observer);
      if (entry && entry.observers.size === 0) {
        this.stopEntry(entry);
        this.entries.delete(botId);
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopVisibility();
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
  }

  private status(entry: Entry, status: BotStateChannelStatus): void {
    entry.status = status;
    for (const observer of entry.observers) observer.status(status);
  }

  private connect(entry: Entry): void {
    if (
      this.disposed ||
      entry.socket ||
      entry.observers.size === 0 ||
      !this.runtime.isVisible()
    ) {
      return;
    }
    this.clearRetry(entry);
    this.status(entry, "connecting");
    const url = new URL(
      `/api/bots/${encodeURIComponent(entry.botId)}/state-channel`,
      this.runtime.origin(),
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("version", "1");
    let cursor: string | undefined;
    try {
      const storedCursor = this.runtime.readCursor(entry.botId);
      cursor =
        storedCursor === undefined
          ? undefined
          : decodeBotStateCursorV1(storedCursor);
    } catch {
      // An invalid local cursor cannot be resumed. Omitting it makes the
      // server issue an explicit reset and the projection is re-read.
      cursor = undefined;
    }
    entry.cursor = cursor;
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const token = ++entry.token;
    let socket: SocketLike;
    try {
      socket = this.runtime.createSocket(url.toString());
    } catch {
      this.fail(entry, token);
      return;
    }
    entry.socket = socket;
    entry.timeout = this.runtime.setTimeout(
      () => this.fail(entry!, token),
      CONNECT_TIMEOUT_MS,
    );
    socket.onopen = () => {
      if (entry?.token !== token) return;
      // The protocol is established only after its ordered replay terminator.
      // A proxy which completes the upgrade but drops frames still falls back.
    };
    socket.onmessage = (event) => {
      if (entry?.token !== token) return;
      if (typeof event.data !== "string") {
        this.fail(entry, token);
        return;
      }
      let frame;
      try {
        frame = decodeBotStateChannelFrameV1(event.data);
      } catch {
        this.fail(entry, token);
        return;
      }
      entry.queue = entry.queue
        .then(async () => {
          if (entry!.token !== token) return;
          if (frame.type === "state/ready") {
            if (entry!.cursor !== frame.cursor) {
              throw new Error("Bot-state ready cursor is discontinuous");
            }
            this.clearConnectTimeout(entry!);
            entry!.attempt = 0;
            this.status(entry!, "open");
            return;
          }
          if (
            frame.type === "state/event" &&
            (entry!.cursor === undefined ||
              Number(frame.cursor) !== Number(entry!.cursor) + 1)
          ) {
            throw new Error("Bot-state event cursor is discontinuous");
          }
          await Promise.all(
            [...entry!.observers].map((observer) =>
              observer.invalidate(
                frame.type === "state/event" ? frame.topic : undefined,
              ),
            ),
          );
          if (entry!.token !== token) return;
          entry!.cursor = frame.cursor;
          this.runtime.writeCursor(entry!.botId, frame.cursor);
        })
        .catch(() => this.fail(entry!, token));
    };
    socket.onerror = () => this.fail(entry!, token);
    socket.onclose = () => this.fail(entry!, token);
  }

  private fail(entry: Entry, token: number): void {
    if (this.disposed || entry.token !== token) return;
    this.clearConnectTimeout(entry);
    const socket = entry.socket;
    entry.socket = undefined;
    entry.token += 1;
    try {
      socket?.close();
    } catch {
      // The polling fallback is already the recovery path.
    }
    if (!this.runtime.isVisible()) {
      this.status(entry, "hidden");
      return;
    }
    this.status(entry, "fallback");
    if (entry.retry !== undefined || entry.observers.size === 0) return;
    const delay = Math.min(1_000 * 2 ** entry.attempt, MAX_RETRY_MS);
    entry.attempt += 1;
    entry.retry = this.runtime.setTimeout(() => {
      entry.retry = undefined;
      this.connect(entry);
    }, delay);
  }

  private visibilityChanged(): void {
    for (const entry of this.entries.values()) {
      if (this.runtime.isVisible()) {
        this.connect(entry);
      } else {
        this.clearRetry(entry);
        this.clearConnectTimeout(entry);
        const socket = entry.socket;
        entry.socket = undefined;
        entry.token += 1;
        try {
          socket?.close(1000, "hidden");
        } catch {
          // It is only an observer.
        }
        this.status(entry, "hidden");
      }
    }
  }

  private clearRetry(entry: Entry): void {
    if (entry.retry !== undefined) this.runtime.clearTimeout(entry.retry);
    entry.retry = undefined;
  }

  private clearConnectTimeout(entry: Entry): void {
    if (entry.timeout !== undefined) this.runtime.clearTimeout(entry.timeout);
    entry.timeout = undefined;
  }

  private stopEntry(entry: Entry): void {
    this.clearRetry(entry);
    this.clearConnectTimeout(entry);
    entry.token += 1;
    try {
      entry.socket?.close(1000, "disposed");
    } catch {
      // It is only an observer.
    }
    entry.socket = undefined;
  }
}
