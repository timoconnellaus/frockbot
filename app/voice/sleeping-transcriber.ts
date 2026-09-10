// A transcriber that stops listening when nobody is talking.
//
// The voice pipeline feeds every frame it receives to the transcriber for the
// whole call, and the STT provider bills every second it hears, silence
// included. This wrapper puts an upstream session to sleep — closes it — when
// the client says the room has gone quiet or after a bound of its own, and
// opens a fresh one on the next frame. Frames that arrive while the new
// session is still starting are held and drained in order once it is ready,
// so the pre-roll the client replays ahead of a wake reaches the model intact.
//
// The interfaces below are structurally identical to `@cloudflare/voice`'s
// `Transcriber`, `TranscriberSession` and `TranscriberSessionOptions`, so the
// wrapper is a drop-in there while this module imports nothing from the SDK.

export interface VoiceTranscriberSessionOptionsV1 {
  language?: string;
  onInterim?: (text: string) => void;
  onSpeechStart?: (text?: string) => void;
  onUtterance?: (transcript: string) => void;
  onFatalError?: (error: Error) => void;
}

export interface VoiceTranscriberSessionV1 {
  feed(chunk: ArrayBuffer): void;
  waitUntilReady?(): Promise<void>;
  updateAgentContext?(text: string): void;
  close(): void;
}

export interface VoiceTranscriberV1 {
  createSession(
    options?: VoiceTranscriberSessionOptionsV1,
  ): VoiceTranscriberSessionV1;
}

export type VoiceUpstreamStateV1 = "asleep" | "starting" | "awake";

export interface SleepingTranscriberOptionsV1 {
  /** No frame for this long while awake and the session sleeps by itself. */
  idleSleepMs: number;
  /** Frames held while a session starts; older ones are dropped first. */
  maxPendingBytes: number;
  /** Told of every state change, for the client's `voice/state` and metering. */
  onState?: (state: VoiceUpstreamStateV1, at: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SleepingTranscriberSessionV1 extends VoiceTranscriberSessionV1 {
  /** Close the upstream; keep the wrapper alive for the next frame. */
  sleep(): void;
  /** Open the upstream now, without waiting for a frame. */
  wake(): void;
  readonly state: VoiceUpstreamStateV1;
  /** Seconds the upstream has been awake over this session's lifetime. */
  awakeSeconds(): number;
}

/**
 * Wraps `inner` so that its sessions open lazily and close when idle.
 *
 * `createSession` returns one wrapper session per call; the wrapper opens an
 * inner session on the first frame (or `wake()`), forwards frames, and closes
 * the inner session on `sleep()`, on the idle bound, or on `close()`.
 */
export interface SleepingTranscriberV1 extends VoiceTranscriberV1 {
  createSession(
    sessionOptions?: VoiceTranscriberSessionOptionsV1,
  ): SleepingTranscriberSessionV1;
}

export function createSleepingTranscriberV1(
  inner: VoiceTranscriberV1,
  options: SleepingTranscriberOptionsV1,
): SleepingTranscriberV1 {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    createSession(sessionOptions = {}) {
      let state: VoiceUpstreamStateV1 = "asleep";
      let current: VoiceTranscriberSessionV1 | undefined;
      let generation = 0;
      let pending: ArrayBuffer[] = [];
      let pendingBytes = 0;
      let idleTimer: unknown;
      let closed = false;
      let awakeSince: number | undefined;
      let awakeTotalMs = 0;
      let agentContext: string | undefined;

      const setState = (next: VoiceUpstreamStateV1) => {
        if (state === next) return;
        const at = now();
        if (next === "awake") awakeSince = at;
        if (state === "awake" && awakeSince !== undefined) {
          awakeTotalMs += at - awakeSince;
          awakeSince = undefined;
        }
        state = next;
        options.onState?.(next, at);
      };

      const armIdle = () => {
        if (idleTimer !== undefined) clearTimer(idleTimer);
        idleTimer = setTimer(() => {
          idleTimer = undefined;
          sleep();
        }, options.idleSleepMs);
      };

      const sleep = () => {
        if (idleTimer !== undefined) {
          clearTimer(idleTimer);
          idleTimer = undefined;
        }
        generation += 1;
        const session = current;
        current = undefined;
        pending = [];
        pendingBytes = 0;
        session?.close();
        setState("asleep");
      };

      const hold = (chunk: ArrayBuffer) => {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        while (pendingBytes > options.maxPendingBytes && pending.length > 1) {
          pendingBytes -= pending.shift()!.byteLength;
        }
      };

      const wake = () => {
        if (closed || state !== "asleep") return;
        generation += 1;
        const mine = generation;
        setState("starting");
        let session: VoiceTranscriberSessionV1;
        try {
          session = inner.createSession({
            ...sessionOptions,
            onFatalError: (error) => {
              if (mine !== generation) return;
              sleep();
              sessionOptions.onFatalError?.(error);
            },
          });
        } catch (error) {
          setState("asleep");
          sessionOptions.onFatalError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
        }
        current = session;
        const ready = session.waitUntilReady?.() ?? Promise.resolve();
        ready.then(
          () => {
            if (mine !== generation || current !== session) return;
            if (agentContext !== undefined) {
              session.updateAgentContext?.(agentContext);
            }
            const held = pending;
            pending = [];
            pendingBytes = 0;
            for (const chunk of held) session.feed(chunk);
            setState("awake");
            armIdle();
          },
          (error: unknown) => {
            if (mine !== generation) return;
            sleep();
            sessionOptions.onFatalError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          },
        );
      };

      return {
        get state() {
          return state;
        },
        feed(chunk) {
          if (closed) return;
          if (state === "awake" && current) {
            current.feed(chunk);
            armIdle();
            return;
          }
          hold(chunk);
          if (state === "asleep") wake();
        },
        waitUntilReady() {
          // The wrapper is ready at once: audio is held until the upstream
          // is, and the pipeline must not wait on a session that opens only
          // when someone speaks.
          return Promise.resolve();
        },
        updateAgentContext(text) {
          agentContext = text;
          current?.updateAgentContext?.(text);
        },
        sleep,
        wake,
        awakeSeconds() {
          const live =
            state === "awake" && awakeSince !== undefined
              ? now() - awakeSince
              : 0;
          return (awakeTotalMs + live) / 1000;
        },
        close() {
          if (closed) return;
          closed = true;
          sleep();
        },
      };
    },
  };
}
