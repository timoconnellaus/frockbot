// The Apple Events helper under its profile, proved on macOS: built from its
// real source and signed with its real entitlements, it must run a script, and
// be refused a shell and any application but the one the profile names.
//
// The declared application itself cannot be proved here: an Apple Event to it
// needs the person's Automation consent, which only a person can give, so on CI
// it would wait on a prompt nobody answers. The Finder case instead names some
// other application in the profile, so it is the profile that refuses it; and
// where the runner already grants scripting Finder, naming Finder must run.

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAppleEventsV1 } from "./apple-events.ts";

const SOURCE = join(
  import.meta.dirname,
  "../../native/macos/AppleEventsHelper",
);
const OTHER = "com.example.not-finder";
const FINDER = "com.apple.finder";
// `get name` of an application is answered by AppleScript itself, without an
// Apple Event, so the probe must ask the application for something.
const PROBE = `tell application id "${FINDER}" to count windows`;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  }
}

describe.skipIf(process.platform !== "darwin")(
  "the Apple Events helper, sandboxed",
  () => {
    let helper = "";

    beforeAll(async () => {
      // Seatbelt matches real paths, and the temporary directory is a link.
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), "apple-events-")),
      );
      helper = join(dir, "apple-events");
      run("/usr/bin/xcrun", [
        "swiftc",
        "-O",
        "-o",
        helper,
        join(SOURCE, "main.swift"),
      ]);
      run("/usr/bin/codesign", [
        "-s",
        "-",
        "-f",
        "--entitlements",
        join(SOURCE, "AppleEventsHelper.entitlements"),
        helper,
      ]);
    }, 120_000);

    // A timeout would also reject, so each refusal must be the helper's own.
    const outcome = (bundleId: string, script: string) =>
      runAppleEventsV1(helper, bundleId, script, { timeoutMs: 40_000 }).then(
        (value) => `ran: ${value}`,
        (error: Error) => error.message,
      );

    test("runs a script that reaches nothing", async () => {
      expect(await outcome(OTHER, "return 1 + 1")).toBe("ran: 2");
    }, 60_000);

    test("refuses a shell", async () => {
      const refused = await outcome(OTHER, 'do shell script "echo hi"');
      expect(refused).not.toStartWith("ran:");
      expect(refused).not.toContain("did not finish");
    }, 60_000);

    test("refuses an application the profile does not name", async () => {
      const refused = await outcome(OTHER, PROBE);
      expect(refused).not.toStartWith("ran:");
      expect(refused).not.toContain("did not finish");
    }, 60_000);

    // Where this machine already lets a script reach Finder, as CI runners
    // do, the same script under a profile naming Finder must run: then the
    // refusal above is the profile's, not a missing consent.
    test("reaches the application the profile names", async () => {
      const bare = spawnSync("/usr/bin/osascript", ["-e", PROBE], {
        timeout: 20_000,
      });
      if (bare.status !== 0) return;
      expect(await outcome(FINDER, PROBE)).toStartWith("ran:");
    }, 60_000);
  },
);
