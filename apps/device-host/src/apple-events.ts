// `appleEvents.run`, the one host binding a device module has (ADR 0037).
//
// The script never runs inside the app. The app holds Full Disk Access, and an
// in-process AppleScript could `do shell script` with it, or nest a `tell` to
// any other application. So each run is its own `osascript` under a Seatbelt
// profile generated for that run: it may start, and it may send Apple Events to
// the one application the module named — no fork, no other program, no
// network, no writes. macOS still asks the person, attributing the run to the
// app that started the host, before the first event reaches that application.
//
// Its proof is `apple-events.macos.test.ts`.

import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";

const OSASCRIPT = "/usr/bin/osascript";
export const APPLE_SCRIPT_BYTES_MAX_V1 = 64 * 1_024;
export const APPLE_SCRIPT_OUTPUT_BYTES_MAX_V1 = 256 * 1_024;
const APPLE_SCRIPT_TIMEOUT_MS_V1 = 30_000;
/** Enough of stderr to say why a script failed. */
const STDERR_BYTES_MAX = 4 * 1_024;

// Bundle ids are reverse-DNS; anything else could break out of its literal.
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * The Seatbelt profile around one run of `osascript`.
 *
 * Reads are system code only: what `osascript` and the AppleScript component
 * load, and nothing of the person's. Metadata is open because resolving any
 * path, the application's included, stats every directory above it. The mach
 * services are the ones an Apple Event crosses: the Apple Event server, Launch
 * Services to find the application by bundle id, and preferences for the
 * language it prints in.
 */
export function appleEventsProfileV1(bundleId: string): string {
  if (!BUNDLE_ID.test(bundleId)) {
    throw new Error(`not an application bundle id: ${bundleId}`);
  }
  return [
    "(version 1)",
    "(deny default)",
    '(import "bsd.sb")',
    `(allow process-exec (literal "${OSASCRIPT}"))`,
    "(allow signal (target self))",
    "(allow file-read*",
    '  (subpath "/System")',
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/share")',
    '  (subpath "/Library/ScriptingAdditions")',
    '  (subpath "/private/var/db/dyld")',
    `  (literal "${OSASCRIPT}"))`,
    "(allow file-read-metadata)",
    "(allow mach-lookup",
    '  (global-name "com.apple.coreservices.appleevents")',
    '  (global-name "com.apple.coreservices.launchservicesd")',
    '  (global-name "com.apple.CoreServices.coreservicesd")',
    '  (global-name "com.apple.lsd.mapdb")',
    '  (global-name "com.apple.cfprefsd.daemon")',
    '  (global-name "com.apple.cfprefsd.agent"))',
    "(allow user-preference-read",
    '  (preference-domain "kCFPreferencesAnyApplication")',
    '  (preference-domain "com.apple.osascript"))',
    `(allow appleevent-send (appleevent-destination "${bundleId}"))`,
    "",
  ].join("\n");
}

/** The whole command: Seatbelt around `osascript`, the script on stdin. */
export function appleEventsCommandV1(bundleId: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
} {
  return {
    command: "/usr/bin/sandbox-exec",
    // `-l AppleScript` so a module cannot switch to JavaScript for Automation.
    args: [
      "-p",
      appleEventsProfileV1(bundleId),
      OSASCRIPT,
      "-l",
      "AppleScript",
      "-",
    ],
    env: {},
    cwd: "/",
  };
}

export type AppleEventsSpawnV1 = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
) => ChildProcess;

const defaultSpawn: AppleEventsSpawnV1 = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });

/** Runs one script against `bundleId` and answers what it returned. */
export function runAppleEventsV1(
  bundleId: string,
  script: string,
  options: { spawn?: AppleEventsSpawnV1; timeoutMs?: number } = {},
): Promise<string> {
  if (Buffer.byteLength(script, "utf8") > APPLE_SCRIPT_BYTES_MAX_V1) {
    return Promise.reject(
      new Error(`the script is longer than ${APPLE_SCRIPT_BYTES_MAX_V1} bytes`),
    );
  }
  let command: ReturnType<typeof appleEventsCommandV1>;
  try {
    command = appleEventsCommandV1(bundleId);
  } catch (error) {
    return Promise.reject(error);
  }
  const timeoutMs = options.timeoutMs ?? APPLE_SCRIPT_TIMEOUT_MS_V1;
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? defaultSpawn)(
      command.command,
      command.args,
      { env: command.env, cwd: command.cwd },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let failure: string | undefined;
    const stop = (why: string) => {
      failure ??= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(`the script did not finish within ${timeoutMs}ms`),
      timeoutMs,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > APPLE_SCRIPT_OUTPUT_BYTES_MAX_V1) {
        stop(
          `the script returned more than ${APPLE_SCRIPT_OUTPUT_BYTES_MAX_V1} bytes`,
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_BYTES_MAX) {
        stderr = (stderr + chunk.toString("utf8")).slice(0, STDERR_BYTES_MAX);
      }
    });
    // A script that exits before reading all of stdin closes the pipe under us.
    child.stdin?.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) reject(new Error(failure));
      else if (code !== 0) {
        reject(
          new Error(stderr.trim() || `the script exited with code ${code}`),
        );
      } else resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin?.end(script, "utf8");
  });
}
