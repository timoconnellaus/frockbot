import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  APPLE_SCRIPT_BYTES_MAX_V1,
  APPLE_SCRIPT_OUTPUT_BYTES_MAX_V1,
  appleEventsCommandV1,
  appleEventsProfileV1,
  runAppleEventsV1,
  type AppleEventsSpawnV1,
} from "./apple-events.ts";

describe("the profile around one Apple Events run", () => {
  const profile = appleEventsProfileV1("com.apple.iChat");

  test("denies by default and admits events to the one named application", () => {
    expect(profile.split("\n").slice(0, 3)).toEqual([
      "(version 1)",
      "(deny default)",
      '(import "bsd.sb")',
    ]);
    expect(profile).toContain(
      '(allow appleevent-send (appleevent-destination "com.apple.iChat"))',
    );
    expect(profile.match(/appleevent-destination/g)).toHaveLength(1);
  });

  test("starts osascript and nothing else, and writes and connects nowhere", () => {
    expect(profile.match(/process-exec/g)).toEqual(["process-exec"]);
    expect(profile).toContain(
      '(allow process-exec (literal "/usr/bin/osascript"))',
    );
    for (const refused of [
      "process-fork",
      "file-write",
      "network",
      "/Users",
      "(allow default)",
    ]) {
      expect(profile).not.toContain(refused);
    }
  });

  test("refuses a bundle id that could break out of its literal", () => {
    for (const bundleId of [
      'com.apple.iChat") (allow default) ("',
      "com.apple.iChat\n",
      "iChat",
      "",
    ]) {
      expect(() => appleEventsProfileV1(bundleId)).toThrow(
        /not an application/,
      );
    }
  });

  test("the command is Seatbelt around AppleScript read from stdin", () => {
    const command = appleEventsCommandV1("com.apple.iChat");
    expect(command.command).toBe("/usr/bin/sandbox-exec");
    expect(command.args).toEqual([
      "-p",
      profile,
      "/usr/bin/osascript",
      "-l",
      "AppleScript",
      "-",
    ]);
    expect(command.env).toEqual({});
  });
});

interface Fake {
  spawn: AppleEventsSpawnV1;
  stdin(): string;
  killed(): string | undefined;
  calls: { command: string; args: string[] }[];
}

/** A process that answers once its stdin closes, unless it hangs. */
function fake(answer: {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}): Fake {
  let input = "";
  let signal: string | undefined;
  const calls: Fake["calls"] = [];
  return {
    calls,
    stdin: () => input,
    killed: () => signal,
    spawn: (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr });
      child.kill = (killSignal) => {
        signal = String(killSignal);
        queueMicrotask(() => child.emit("close", null, killSignal));
        return true;
      };
      stdin.on("data", (chunk: Buffer) => (input += chunk.toString("utf8")));
      stdin.on("finish", () => {
        if (answer.hang) return;
        if (answer.stdout) stdout.write(answer.stdout);
        if (answer.stderr) stderr.write(answer.stderr);
        setTimeout(() => child.emit("close", answer.code ?? 0, null), 5);
      });
      return child;
    },
  };
}

describe("running a script", () => {
  test("passes the script on stdin and answers its trimmed output", async () => {
    const process = fake({ stdout: "2\n" });
    expect(
      await runAppleEventsV1("com.apple.iChat", "return 1 + 1", process),
    ).toBe("2");
    expect(process.stdin()).toBe("return 1 + 1");
    expect(process.calls[0]!.args).toContain(
      appleEventsProfileV1("com.apple.iChat"),
    );
  });

  test("a failing script throws what osascript said", async () => {
    await expect(
      runAppleEventsV1(
        "com.apple.iChat",
        "error",
        fake({ stderr: "execution error: nope (-2700)\n", code: 1 }),
      ),
    ).rejects.toThrow("execution error: nope (-2700)");
  });

  test("a script that does not finish is killed", async () => {
    const process = fake({ hang: true });
    await expect(
      runAppleEventsV1("com.apple.iChat", "delay 100", {
        ...process,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("did not finish within 20ms");
    expect(process.killed()).toBe("SIGKILL");
  });

  test("too much output is refused and the process killed", async () => {
    const process = fake({
      stdout: "x".repeat(APPLE_SCRIPT_OUTPUT_BYTES_MAX_V1 + 1),
      hang: false,
    });
    await expect(
      runAppleEventsV1("com.apple.iChat", "big", process),
    ).rejects.toThrow("returned more than");
    expect(process.killed()).toBe("SIGKILL");
  });

  test("an oversized script or a bad bundle id never starts a process", async () => {
    const process = fake({});
    await expect(
      runAppleEventsV1(
        "com.apple.iChat",
        "x".repeat(APPLE_SCRIPT_BYTES_MAX_V1 + 1),
        process,
      ),
    ).rejects.toThrow("longer than");
    await expect(
      runAppleEventsV1('a") (allow default', "return 1", process),
    ).rejects.toThrow(/not an application/);
    expect(process.calls).toHaveLength(0);
  });
});
