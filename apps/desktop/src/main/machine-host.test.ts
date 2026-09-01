// The machine host, against a real shell and a real file.
//
// The plan calls `child_process` the untested surface. It is cheap enough to
// test on the two runners this repo has, so it is tested: what a killed
// command reports, what a bounded stream reports, and that a file read says
// whether it was cut. The classification of those facts lives in
// `@frockbot/plugin-user-machine` and is proved there.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import {
  NodeMachineHostCapability,
  createBoundedSinkV1,
  desktopMachineLabelV1,
  desktopMachinePlatformV1,
  desktopMachineShellV1,
} from "./machine-host.js";

const signal = new AbortController().signal;

function host(options: { platform?: string; hostname?: string } = {}): {
  host: NodeMachineHostCapability;
  dispose(): Promise<void>;
} {
  const ctx = new Context();
  const capability = new NodeMachineHostCapability(ctx, options);
  return {
    host: capability,
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}

describe("machine host identity", () => {
  test("Node's platforms become the protocol's three", () => {
    expect(desktopMachinePlatformV1("darwin")).toBe("macos");
    expect(desktopMachinePlatformV1("win32")).toBe("windows");
    expect(desktopMachinePlatformV1("freebsd")).toBe("linux");
  });

  test("a hostname is the label, and a nameless host still has one", () => {
    expect(desktopMachineLabelV1(" Tims-M5-MacBook-Pro.local ")).toBe(
      "Tims-M5-MacBook-Pro.local",
    );
    expect(desktopMachineLabelV1("   ")).toBe("Unnamed machine");
    expect(desktopMachineLabelV1("x".repeat(500))).toBe("Unnamed machine");
  });

  test("each platform gets the shell it actually has", () => {
    expect(desktopMachineShellV1("win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c"],
    });
    expect(desktopMachineShellV1("darwin")).toEqual({
      file: "/bin/sh",
      args: ["-c"],
    });
  });
});

describe("bounded sink", () => {
  test("stops at the bound and remembers that it did", () => {
    const sink = createBoundedSinkV1(5);
    sink.push("abc");
    expect(sink.truncated()).toBe(false);
    sink.push("defgh");
    expect(sink.text()).toBe("abcde");
    expect(sink.truncated()).toBe(true);
    sink.push("ijk");
    expect(sink.text()).toBe("abcde");
  });

  test("output exactly at the bound is not truncated", () => {
    const sink = createBoundedSinkV1(3);
    sink.push("abc");
    expect(sink.text()).toBe("abc");
    expect(sink.truncated()).toBe(false);
  });
});

describe("machine host execution", () => {
  test.skipIf(process.platform === "win32")(
    "a command's output and exit code come back",
    async () => {
      const mounted = host();
      const result = await mounted.host.exec(
        {
          command: "printf hello; printf oops 1>&2; exit 3",
          timeoutMs: 10_000,
          maxOutputBytes: 1_024,
        },
        signal,
      );
      expect(result).toEqual({
        exitCode: 3,
        stdout: "hello",
        stderr: "oops",
        truncated: false,
        timedOut: false,
      });
      await mounted.dispose();
    },
  );

  test.skipIf(process.platform === "win32")(
    "output past the bound is cut and said to be cut",
    async () => {
      const mounted = host();
      const result = await mounted.host.exec(
        {
          command: "printf 0123456789",
          timeoutMs: 10_000,
          maxOutputBytes: 4,
        },
        signal,
      );
      expect(result.stdout).toBe("0123");
      expect(result.truncated).toBe(true);
      await mounted.dispose();
    },
  );

  test.skipIf(process.platform === "win32")(
    "a command that outlives its timeout is killed and says so",
    async () => {
      const mounted = host();
      const started = Date.now();
      const result = await mounted.host.exec(
        { command: "sleep 30", timeoutMs: 200, maxOutputBytes: 64 },
        signal,
      );
      expect(result.timedOut).toBe(true);
      // Killed, so there is no exit code to report and none is invented.
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toBe("");
      // The whole point of the kill: the caller waits on the bound it asked
      // for, not on the command it gave up on. Asserted with a wide margin, so
      // this measures the kill and not the machine it runs on.
      expect(Date.now() - started).toBeLessThan(5_000);
      await mounted.dispose();
    },
    // Generous, because a loaded runner is slow, not broken. The assertion
    // above is what holds the behaviour; this only keeps a real hang from
    // being reported as a timeout with no message.
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "a command whose children outlive it does not hold the result open",
    async () => {
      // The defect this pins: killing the shell alone leaves a grandchild
      // holding the inherited stdout pipe, so `close` never fires and the
      // caller waits out the full sleep for a command already given up on.
      // The kill goes to the process group, and `exit` bounds the wait.
      const mounted = host();
      const started = Date.now();
      const result = await mounted.host.exec(
        {
          command: "(sleep 30 &) ; sleep 30",
          timeoutMs: 200,
          maxOutputBytes: 64,
        },
        signal,
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
      await mounted.dispose();
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "an aborted command is killed too",
    async () => {
      const mounted = host();
      const controller = new AbortController();
      const running = mounted.host.exec(
        { command: "sleep 30", timeoutMs: 30_000, maxOutputBytes: 64 },
        controller.signal,
      );
      controller.abort();
      const result = await running;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeUndefined();
      await mounted.dispose();
    },
    30_000,
  );
});

describe("machine host file reads", () => {
  test("a file under the bound comes back whole", async () => {
    const directory = mkdtempSync(join(tmpdir(), "machine-host-"));
    const file = join(directory, "notes.txt");
    writeFileSync(file, "hi");
    const mounted = host();
    try {
      expect(
        await mounted.host.readFile({ path: file, maxBytes: 8 }, signal),
      ).toEqual({
        bytesBase64: Buffer.from("hi").toString("base64"),
        truncated: false,
      });
    } finally {
      await mounted.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a file over the bound is cut at exactly the bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "machine-host-"));
    const file = join(directory, "big.txt");
    writeFileSync(file, "0123456789");
    const mounted = host();
    try {
      const result = await mounted.host.readFile(
        { path: file, maxBytes: 4 },
        signal,
      );
      expect(Buffer.from(result.bytesBase64, "base64").toString()).toBe("0123");
      expect(result.truncated).toBe(true);
    } finally {
      await mounted.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a missing file throws rather than answering with nothing", async () => {
    const mounted = host();
    await expect(
      mounted.host.readFile(
        { path: join(tmpdir(), "frockbot-absent-file"), maxBytes: 8 },
        signal,
      ),
    ).rejects.toThrow();
    await mounted.dispose();
  });
});
