// The registered machine's hands: the one place a Bot's approved command
// becomes a process on somebody's laptop.
//
// It holds no policy. It does not decide what a non-zero exit means, what to
// report, when to retry, or whether the machine is allowed to do this at all —
// all of that is in `@frockbot/plugin-user-machine`, where it runs in CI. What
// is here is the part that cannot run anywhere but Node: spawning, killing,
// and reading bytes off a disk, each with a bound the caller named.
//
// It imports `electron` nowhere on purpose, so `bun test` can drive it against
// a real shell — the plan's "everything but actual `child_process` execution"
// is the honest floor, not the ceiling, and the truncation and timeout paths
// are cheap enough to prove for real.

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import {
  DesktopMachineHostCapability,
  type DesktopMachineExecRequest,
  type DesktopMachineExecResult,
  type DesktopMachineFileRequest,
  type DesktopMachineFileResult,
  type DesktopMachineIdentity,
} from "@frockbot/desktop-core";
import type { Context } from "cordis";

/** The protocol's three platforms, from Node's rather longer list. */
export function desktopMachinePlatformV1(
  platform: string,
): DesktopMachineIdentity["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/**
 * The machine's own name for itself.
 *
 * §2.16's example label is a Bonjour hostname (`Tims-M5-MacBook-Pro.local`),
 * so the hostname is what is reported. A host with no name is not an error —
 * the label is a human's handle on the row, not an identifier.
 */
export function desktopMachineLabelV1(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 200
    ? trimmed
    : "Unnamed machine";
}

/** The shell one command line is handed to, per platform. */
export function desktopMachineShellV1(platform: string): {
  file: string;
  args: string[];
} {
  return platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c"] }
    : { file: "/bin/sh", args: ["-c"] };
}

/**
 * A stream collector that stops at a bound and says that it did.
 *
 * Bounded on the *decoded* length, because that is what the protocol's
 * `maxOutputBytes` decoder checks on the way back in: a result that passed the
 * agent's bound and failed the wire's would be a command that ran and could
 * not be reported.
 */
export function createBoundedSinkV1(limit: number): {
  push(chunk: string): void;
  text(): string;
  truncated(): boolean;
} {
  let held = "";
  let cut = false;
  return {
    push(chunk: string): void {
      if (held.length >= limit) {
        if (chunk.length > 0) cut = true;
        return;
      }
      const room = limit - held.length;
      if (chunk.length > room) {
        held += chunk.slice(0, room);
        cut = true;
        return;
      }
      held += chunk;
    },
    text: () => held,
    truncated: () => cut,
  };
}

export interface NodeMachineHostOptionsV1 {
  /** `process.platform`, injected so a test can ask for another platform. */
  platform?: string;
  /** `os.hostname()`, injected for the same reason. */
  hostname?: string;
}

export class NodeMachineHostCapability extends DesktopMachineHostCapability {
  private readonly platform: string;
  private readonly host: string;

  constructor(ctx: Context, options: NodeMachineHostOptionsV1 = {}) {
    super(ctx);
    this.platform = options.platform ?? process.platform;
    this.host = options.hostname ?? hostname();
  }

  identity(): DesktopMachineIdentity {
    return {
      label: desktopMachineLabelV1(this.host),
      platform: desktopMachinePlatformV1(this.platform),
    };
  }

  /**
   * How long a killed command's streams are given to flush before the result
   * is returned anyway.
   *
   * A process that has exited can still leave its pipes open, because a
   * grandchild it spawned inherited them. Waiting on `close` in that case is
   * waiting on the grandchild, which is exactly the hang this grace period
   * exists to bound.
   */
  private static readonly FLUSH_GRACE_MS = 100;

  exec(
    request: DesktopMachineExecRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineExecResult> {
    signal.throwIfAborted();
    const shell = desktopMachineShellV1(this.platform);
    // A new process group, so a kill reaches everything the command started
    // and not just the shell that started it. Without this, `sh -c "sleep 30"`
    // survives its own shell's death on any platform whose `sh` forks rather
    // than execs, and the agent waits out the full sleep for a command it
    // already gave up on.
    const grouped = this.platform !== "win32";
    return new Promise<DesktopMachineExecResult>((resolve, reject) => {
      const child = spawn(shell.file, [...shell.args, request.command], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        // No inherited stdin: a command that waits for input would otherwise
        // hold the lease until the timeout for no reason.
        stdio: ["ignore", "pipe", "pipe"],
        detached: grouped,
      });
      const stdout = createBoundedSinkV1(request.maxOutputBytes);
      const stderr = createBoundedSinkV1(request.maxOutputBytes);
      let timedOut = false;
      let settled = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
        if (grouped && typeof child.pid === "number") {
          try {
            // The negative pid is the group: the shell, and whatever it ran.
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // The group is already gone, or this platform refused it; fall
            // through to killing the child alone rather than giving up.
          }
        }
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = (): void => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (flushTimer) clearTimeout(flushTimer);
        signal.removeEventListener("abort", onAbort);
        resolve({
          ...(code === null || timedOut ? {} : { exitCode: code }),
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated() || stderr.truncated(),
          timedOut,
        });
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (flushTimer) clearTimeout(flushTimer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      // `close` is the good case: the process ended *and* its output is all
      // here. `exit` is the bound: the process ended, so a result is owed
      // whatever is still holding a pipe open.
      child.once("close", (code) => settle(code));
      child.once("exit", (code) => {
        if (settled || flushTimer) return;
        flushTimer = setTimeout(
          () => settle(code),
          NodeMachineHostCapability.FLUSH_GRACE_MS,
        );
      });
    });
  }

  /**
   * One file, up to `maxBytes`.
   *
   * `maxBytes + 1` is read so truncation is a fact rather than a guess: a file
   * exactly at the bound is not truncated, and one byte past it is.
   */
  async readFile(
    request: DesktopMachineFileRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineFileResult> {
    signal.throwIfAborted();
    const handle = await open(request.path, "r");
    try {
      const buffer = Buffer.alloc(request.maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      const truncated = bytesRead > request.maxBytes;
      const bytes = buffer.subarray(
        0,
        truncated ? request.maxBytes : bytesRead,
      );
      return { bytesBase64: bytes.toString("base64"), truncated };
    } finally {
      await handle.close();
    }
  }
}
