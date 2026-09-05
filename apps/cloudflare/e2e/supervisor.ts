// Keeping a `wrangler dev` alive for the length of a shard.
//
// The browser layer's servers are long-lived children of the Playwright
// `webServer` process, and when one of them dies the run does not merely lose
// a test — every later spec meets `net::ERR_CONNECTION_REFUSED`, because the
// page fixture navigates to an address nothing is listening on. One shard's
// crash therefore costs a whole shard's evidence.
//
// The crash that motivates this is not fully explained. Workerd prints
//
//   ✘ [ERROR] kj::getCaughtExceptionAsKj() = kj/async-io-unix.c++:186:
//     disconnected: ::write(...): Broken pipe
//
// mid-suite and the runtime is gone a few seconds later. Rather than wait for
// a root cause, this supervises the child: on an exit nobody asked for it
// starts a fresh one on the same port and the same `--persist-to` directory,
// waits for it to serve again, and prints the tail of what the dead one said.
// A spec in flight still fails; the ones after it do not.
import type { ChildProcess } from "node:child_process";

/** How many unexpected exits are tolerated inside `RESTART_WINDOW_MS`. */
export const MAX_RESTARTS = 5;

/**
 * The window the restart budget is counted over.
 *
 * A lifetime budget answers the wrong question. `wrangler dev` exits roughly
 * once every few minutes on a CI runner (its proxy treats one dropped
 * forwarded request as fatal — cloudflare/workers-sdk#15317), so a lifetime
 * count of five is really a ceiling on how long a shard may run: the long
 * shard spent it, and every spec after that met a server that was never
 * coming back. What the cap is for is telling a server that cannot come back
 * from one that keeps being knocked over, and that is a question about a
 * window, not about a whole run.
 */
export const RESTART_WINDOW_MS = 5 * 60_000;

/** Lines of the dead child's output printed when it exits unexpectedly. */
export const CRASH_TAIL_LINES = 60;

/** 1s, 2s, 4s, 8s, then 15s for every attempt after. */
export function restartDelayMs(attempt: number): number {
  if (attempt < 1) return 0;
  return Math.min(15_000, 1_000 * 2 ** (attempt - 1));
}

/**
 * The last `limit` lines a child printed.
 *
 * Bounded on purpose: a `wrangler dev` that has served a whole shard has
 * printed far more than anybody reads, and the interesting part of a crash is
 * always the end.
 */
export class OutputTail {
  readonly #limit: number;
  #lines: string[] = [];
  #partial = "";

  constructor(limit: number = CRASH_TAIL_LINES) {
    this.#limit = limit;
  }

  write(chunk: string): void {
    const text = this.#partial + chunk;
    const parts = text.split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) {
      this.#lines.push(line);
    }
    if (this.#lines.length > this.#limit) {
      this.#lines = this.#lines.slice(-this.#limit);
    }
  }

  lines(): string[] {
    return this.#partial === ""
      ? [...this.#lines]
      : [...this.#lines, this.#partial].slice(-this.#limit);
  }
}

export interface SuperviseOptions {
  /** How the child is named in the harness's own output. */
  label: string;
  /** Start a fresh child. Called once per start and once per restart. */
  spawnChild: () => ChildProcess;
  /** Resolves when the freshly started child serves again. */
  waitUntilReady: () => Promise<void>;
  /** Terminate a child and everything it spawned. */
  stopChild: (child: ChildProcess) => Promise<void>;
  /** Copy a chunk of the child's output somewhere durable. */
  forwardOutput: (child: ChildProcess, tail: OutputTail) => void;
  maxRestarts?: number;
  /** How long a restart counts against the budget. */
  windowMs?: number;
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  report?: (message: string) => void;
  /** The clock the window is measured on. */
  now?: () => number;
}

export interface SupervisedProcess {
  /** Start the first child and wait for it to be ready. Throws if it is not. */
  start(): Promise<void>;
  /** The child currently running, if any. */
  child(): ChildProcess | undefined;
  /** How many times the child has been restarted. */
  restarts(): number;
  /** Stop supervising and terminate the child. Idempotent. */
  stop(): Promise<void>;
}

/**
 * A first start that fails is a failure, not something to retry.
 *
 * If `wrangler dev` cannot bind its port or the artifact will not load, no
 * number of restarts changes that, and Playwright's own `webServer` timeout is
 * the right place for it to surface. Only an exit *after* the child has served
 * is treated as a crash worth recovering from.
 */
export function superviseProcess(options: SuperviseOptions): SupervisedProcess {
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
  const windowMs = options.windowMs ?? RESTART_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const delayMs = options.delayMs ?? restartDelayMs;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const report =
    options.report ?? ((message: string) => console.error(message));

  let current: ChildProcess | undefined;
  let tail = new OutputTail();
  let restarts = 0;
  let recent: number[] = [];
  let stopping = false;

  const attach = (child: ChildProcess): void => {
    child.once("exit", (code, signal) => {
      if (stopping || child !== current) return;
      current = undefined;
      report(
        `\n${options.label} exited unexpectedly (code ${code}, signal ${signal}). ` +
          `Last ${CRASH_TAIL_LINES} lines of its output:\n` +
          tail
            .lines()
            .map((line) => `  | ${line}`)
            .join("\n"),
      );
      void restart();
    });
  };

  const restart = async (): Promise<void> => {
    while (!stopping) {
      restarts += 1;
      const at = now();
      recent = [...recent, at].filter((when) => at - when < windowMs);
      if (recent.length > maxRestarts) {
        report(
          `${options.label} has crashed ${recent.length} times in the last ` +
            `${Math.round(windowMs / 1000)}s (${restarts} in this run); giving up. ` +
            `The rest of this shard will fail to connect.`,
        );
        return;
      }
      const wait = delayMs(recent.length);
      report(
        `Restarting ${options.label} (attempt ${recent.length}/${maxRestarts} ` +
          `in this window, ${restarts} in this run) in ${wait}ms.`,
      );
      await sleep(wait);
      if (stopping) return;
      try {
        tail = new OutputTail();
        const child = options.spawnChild();
        current = child;
        options.forwardOutput(child, tail);
        attach(child);
        await options.waitUntilReady();
        report(`${options.label} is serving again.`);
        return;
      } catch (error) {
        report(
          `${options.label} did not come back: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Whatever is left of that attempt must not linger on the port.
        const failed = current;
        current = undefined;
        if (failed) await options.stopChild(failed).catch(() => {});
      }
    }
  };

  return {
    async start(): Promise<void> {
      const child = options.spawnChild();
      current = child;
      options.forwardOutput(child, tail);
      // Until the first readiness check passes, an exit is a start-up failure
      // and must reject rather than trigger a restart.
      const startupFailure = new Promise<never>((_, fail) => {
        child.once("exit", (code) =>
          fail(new Error(`${options.label} exited early with code ${code}`)),
        );
        child.once("error", fail);
      });
      try {
        await Promise.race([options.waitUntilReady(), startupFailure]);
      } catch (error) {
        current = undefined;
        throw error;
      }
      child.removeAllListeners("exit");
      attach(child);
    },
    child: () => current,
    restarts: () => restarts,
    async stop(): Promise<void> {
      stopping = true;
      const child = current;
      current = undefined;
      if (child) await options.stopChild(child);
    },
  };
}
