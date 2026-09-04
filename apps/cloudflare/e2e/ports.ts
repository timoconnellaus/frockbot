// Port selection for the browser end-to-end harness.
//
// Why this is not `server.listen(0)`.
//
// `listen(0)` asks the kernel for a port out of its *ephemeral* range — on the
// GitHub Linux runners that is `net.ipv4.ip_local_port_range`, 32768–60999.
// The harness then closes that socket and only binds it again minutes later,
// after `artifact:build`, four `wrangler r2 object put --local` runs (each one
// a whole miniflare that binds ports of its own) and a Catalog publish. Every
// one of those, and every outbound connection the runner makes in between, is
// drawing from the same 32768–60999 pool, so the reserved number is not
// reserved at all — it is merely unused at the moment it was picked.
//
// That is the CI failure this module exists to remove:
//
//   ✘ [ERROR] *** Fatal uncaught kj::Exception: kj/async-io-unix.c++:941:
//     failed: ::bind(...): Address already in use; toString() = 127.0.0.1:46625
//   ✘ [ERROR] Address already in use (127.0.0.1:46625).
//
// 46625 was the app port of that shard (`/tmp/frockbot-e2e-46625`), taken by
// something else during the build window.
//
// The fix is to pick from a window the kernel's ephemeral allocator never
// hands out on its own — the same reasoning `scripts/dogfood/dev-stack.sh`
// applies when it hard-codes 8787/8788 — while still probing so two runs on
// one machine cannot collide.
import { createServer as createTcpServer } from "node:net";

/**
 * The window the harness draws from.
 *
 * Above the well-known and the common development ports (5173, 8787, 8788,
 * 9229) and below the lowest ephemeral range in use on the platforms this runs
 * on: Linux starts at 32768, macOS at 49152. Nothing in that window is ever
 * assigned by `listen(0)`, so a port that probes free stays free.
 */
export const PORT_RANGE_START = 12_000;
export const PORT_RANGE_END = 31_000;

/** How many candidates to try before giving up. */
export const PORT_ATTEMPTS = 200;

export interface ReservePortOptions {
  start?: number;
  end?: number;
  attempts?: number;
  /** Injected in tests. Returns a float in `[0, 1)`. */
  random?: () => number;
  /**
   * Ports this process has already handed out. Shared by default, so the three
   * ports one Playwright config reserves are always distinct even though none
   * of them is held open.
   */
  taken?: Set<number>;
  /** Injected in tests. Resolves true when nothing is listening on `port`. */
  probe?: (port: number) => Promise<boolean>;
}

/** Every port this process has handed out, so it never hands one out twice. */
const handedOut = new Set<number>();

/** True when `port` is in the window `reserveFreePort` draws from. */
export function inHarnessRange(
  port: number,
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
): boolean {
  return Number.isInteger(port) && port >= start && port <= end;
}

/**
 * Bind `port` on loopback and let go, without `SO_REUSEADDR`.
 *
 * `exclusive: true` is what makes this a real answer: without it Node sets
 * `SO_REUSEADDR`, and a bind that succeeds under `SO_REUSEADDR` says nothing
 * about whether workerd's own bind will.
 */
export function probePortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Choose a loopback port nothing is listening on, out of a range the kernel
 * will not later reassign to somebody else.
 *
 * The Playwright config reserves every port in its own process and hands them
 * to the harness through the environment, so the specs know each server's
 * address without the harness having to report it back.
 */
export async function reserveFreePort(
  options: ReservePortOptions = {},
): Promise<number> {
  const start = options.start ?? PORT_RANGE_START;
  const end = options.end ?? PORT_RANGE_END;
  const attempts = options.attempts ?? PORT_ATTEMPTS;
  const random = options.random ?? Math.random;
  const taken = options.taken ?? handedOut;
  const probe = options.probe ?? probePortIsFree;
  const span = end - start + 1;
  if (span <= 0) throw new Error("the port range is empty");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = start + Math.floor(random() * span);
    if (taken.has(port)) continue;
    if (!(await probe(port))) continue;
    taken.add(port);
    return port;
  }
  throw new Error(
    `could not find a free port in ${start}-${end} after ${attempts} attempts`,
  );
}
