// What a command becomes, with a fake laptop underneath.
//
// Every classification the agent makes about an op's result is here, which is
// the point of the split: `apps/desktop`'s host spawns and reads, and decides
// nothing, so the decisions are all provable in CI.

import { describe, expect, test } from "bun:test";
import type {
  DesktopMachineExecResult,
  DesktopMachineFileResult,
} from "@frockbot/desktop-core";
import type { MachineCommandV1, MachineOpV1 } from "@frockbot/machine-protocol";
import {
  createMachineDeviceRunnerV1,
  machineRefusalV1,
  type MachineDeviceHostV1,
} from "./device-runner.js";

const NOW = Date.parse("2026-09-01T00:00:05.000Z");

function commandFor(op: MachineOpV1): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId: "tool-0-1-0",
    machineId: "m-1",
    botId: "scout",
    runId: "run-1",
    turn: 1,
    approvalId: "tool-0-1-0",
    op,
    issuedAt: "2026-09-01T00:00:00.000Z",
    status: "claimed",
  };
}

function host(overrides: Partial<MachineDeviceHostV1> = {}): {
  host: MachineDeviceHostV1;
  execCalls: unknown[];
  readCalls: unknown[];
} {
  const execCalls: unknown[] = [];
  const readCalls: unknown[] = [];
  return {
    execCalls,
    readCalls,
    host: {
      identity: () => ({ label: "Laptop", platform: "macos" }),
      exec: (request) => {
        execCalls.push(request);
        return Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
        } satisfies DesktopMachineExecResult);
      },
      readFile: (request) => {
        readCalls.push(request);
        return Promise.resolve({
          bytesBase64: "aGk=",
          truncated: false,
        } satisfies DesktopMachineFileResult);
      },
      ...overrides,
    },
  };
}

function runner(
  fake: MachineDeviceHostV1,
  capabilities: Array<"exec" | "files"> = ["exec", "files"],
): ReturnType<typeof createMachineDeviceRunnerV1> {
  return createMachineDeviceRunnerV1({
    host: fake,
    capabilities,
    now: () => NOW,
  });
}

const signal = new AbortController().signal;

describe("machine device runner", () => {
  test("an exec that exits zero is ok, and the bounds are the op's", async () => {
    const requests: unknown[] = [];
    const fake = host({
      exec: (request) => {
        requests.push(request);
        return Promise.resolve({
          exitCode: 0,
          stdout: "hello\n",
          stderr: "",
          truncated: false,
          timedOut: false,
        });
      },
    });
    const report = await runner(fake.host).run(
      commandFor({
        kind: "exec",
        command: "echo hello",
        cwd: "/tmp",
        timeoutMs: 1_000,
        maxOutputBytes: 64,
      }),
      signal,
    );

    expect(report).toEqual({
      finishedAt: "2026-09-01T00:00:05.000Z",
      outcome: "ok",
      truncated: false,
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    expect(requests[0]).toEqual({
      command: "echo hello",
      cwd: "/tmp",
      timeoutMs: 1_000,
      maxOutputBytes: 64,
    });
  });

  test("a non-zero exit is an error, and a killed command is a timeout", async () => {
    const failing = host({
      exec: () =>
        Promise.resolve({
          exitCode: 2,
          stdout: "",
          stderr: "no such file\n",
          truncated: false,
          timedOut: false,
        }),
    });
    expect(
      await runner(failing.host).run(
        commandFor({
          kind: "exec",
          command: "cat missing",
          timeoutMs: 1_000,
          maxOutputBytes: 64,
        }),
        signal,
      ),
    ).toMatchObject({
      outcome: "error",
      exitCode: 2,
      stderr: "no such file\n",
    });

    const killed = host({
      exec: () =>
        Promise.resolve({
          stdout: "partial",
          stderr: "",
          truncated: true,
          timedOut: true,
        }),
    });
    const report = await runner(killed.host).run(
      commandFor({
        kind: "exec",
        command: "sleep 60",
        timeoutMs: 25,
        maxOutputBytes: 4,
      }),
      signal,
    );
    expect(report).toMatchObject({
      outcome: "timeout",
      truncated: true,
      message: "the command was killed after 25ms",
    });
    // A killed process has no exit code, and one is not invented.
    expect(report.exitCode).toBeUndefined();
  });

  test("a read answers base64 and carries truncation through", async () => {
    const fake = host({
      readFile: () =>
        Promise.resolve({ bytesBase64: "dHJ1bmM=", truncated: true }),
    });
    const report = await runner(fake.host).run(
      commandFor({ kind: "read", path: "/etc/hosts", maxBytes: 8 }),
      signal,
    );
    expect(report).toEqual({
      finishedAt: "2026-09-01T00:00:05.000Z",
      outcome: "ok",
      truncated: true,
      bytesBase64: "dHJ1bmM=",
    });
  });

  test("a copy to the Computer reads the machine's file", async () => {
    const fake = host();
    const report = await runner(fake.host).run(
      commandFor({
        kind: "copy-to-computer",
        path: "/Users/tim/notes.txt",
        workspacePath: "notes.txt",
      }),
      signal,
    );
    expect(report.outcome).toBe("ok");
    expect(fake.readCalls[0]).toMatchObject({ path: "/Users/tim/notes.txt" });
  });

  test("a copy from the Computer refuses visibly, because v1 carries no bytes", async () => {
    const fake = host();
    const report = await runner(fake.host).run(
      commandFor({
        kind: "copy-from-computer",
        path: "/Users/tim/notes.txt",
        workspacePath: "notes.txt",
      }),
      signal,
    );
    expect(report.outcome).toBe("refused");
    expect(report.message).toStartWith("Refused: ");
    expect(fake.readCalls).toEqual([]);
    expect(fake.execCalls).toEqual([]);
  });

  test("an op the agent never reported the capability for is refused, not run", async () => {
    const fake = host();
    const report = await runner(fake.host, ["files"]).run(
      commandFor({
        kind: "exec",
        command: "rm -rf /",
        timeoutMs: 1_000,
        maxOutputBytes: 64,
      }),
      signal,
    );
    expect(report.message).toBe(
      machineRefusalV1("this machine's agent does not offer shell execution"),
    );
    expect(fake.execCalls).toEqual([]);
  });

  test("a host that throws becomes an error result, never an escape", async () => {
    const fake = host({
      readFile: () => Promise.reject(new Error("ENOENT: no such file")),
    });
    expect(
      await runner(fake.host).run(
        commandFor({ kind: "read", path: "/nope", maxBytes: 8 }),
        signal,
      ),
    ).toMatchObject({ outcome: "error", message: "ENOENT: no such file" });
  });
});
