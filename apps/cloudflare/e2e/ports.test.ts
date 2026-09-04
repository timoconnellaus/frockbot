// The port picker behind the browser layer's `webServer`.
//
// What these prove is the property the CI failure turned on: a port the
// harness hands out is never one the kernel will hand to somebody else out of
// its ephemeral range while the harness spends two minutes building before it
// binds.
import { describe, expect, test } from "bun:test";
import {
  PORT_RANGE_END,
  PORT_RANGE_START,
  inHarnessRange,
  probePortIsFree,
  reserveFreePort,
} from "./ports.ts";
import { createServer } from "node:net";

describe("the harness port range", () => {
  test("sits below every ephemeral range the harness runs on", () => {
    // Linux `ip_local_port_range` starts at 32768; macOS at 49152.
    expect(PORT_RANGE_END).toBeLessThan(32_768);
    // Above the well-known ports and the development ports `dev-stack.sh`
    // hard-codes (5173, 8787, 8788) and wrangler's default inspector (9229).
    expect(PORT_RANGE_START).toBeGreaterThan(9_229);
  });

  test("recognises what is inside it", () => {
    expect(inHarnessRange(PORT_RANGE_START)).toBe(true);
    expect(inHarnessRange(PORT_RANGE_END)).toBe(true);
    expect(inHarnessRange(46_625)).toBe(false);
    expect(inHarnessRange(0)).toBe(false);
  });
});

describe("reserveFreePort", () => {
  const alwaysFree = async () => true;

  test("only ever returns a port from the range", async () => {
    const taken = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      const port = await reserveFreePort({ probe: alwaysFree, taken });
      expect(inHarnessRange(port)).toBe(true);
    }
  });

  test("never hands the same port out twice", async () => {
    const taken = new Set<number>();
    const ports = new Set<number>();
    for (let index = 0; index < 100; index += 1) {
      ports.add(await reserveFreePort({ probe: alwaysFree, taken }));
    }
    expect(ports.size).toBe(100);
  });

  test("skips a port something is already listening on", async () => {
    const busy = 20_000;
    // Proposes the busy port first, then its neighbour.
    const proposals = [0, 0.9];
    const port = await reserveFreePort({
      start: busy,
      end: busy + 1,
      taken: new Set(),
      random: () => proposals.shift() ?? 0.9,
      probe: async (candidate) => candidate !== busy,
      attempts: 20,
    });
    expect(port).toBe(busy + 1);
  });

  test("gives up rather than looping when nothing in the range is free", async () => {
    await expect(
      reserveFreePort({
        taken: new Set(),
        probe: async () => false,
        attempts: 5,
      }),
    ).rejects.toThrow(/could not find a free port/);
  });

  test("rejects an empty range", async () => {
    await expect(
      reserveFreePort({ start: 20_000, end: 19_999, taken: new Set() }),
    ).rejects.toThrow(/range is empty/);
  });
});

describe("probePortIsFree", () => {
  test("answers false while a listener holds the port and true after", async () => {
    const server = createServer();
    const port = await new Promise<number>((done) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        done(typeof address === "object" && address ? address.port : 0);
      });
    });
    expect(await probePortIsFree(port)).toBe(false);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await probePortIsFree(port)).toBe(true);
  });
});
